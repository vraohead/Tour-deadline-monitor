/**
 * Interaction Tag Classifier
 *
 * Calls OpenAI with the full taxonomy and returns the best-matching
 * L1::L2::L3 tag for a Zendesk support ticket. Used by both the
 * live /classify endpoint (called from Zendesk webhooks) and the
 * backtest pipeline.
 *
 * Environment variables required:
 *   OPENAI_API_KEY
 *   OPENAI_MODEL   (optional, defaults to gpt-4.1-nano)
 */

const OpenAI = require('openai');
const { taxonomyPromptText, findTag } = require('./taxonomy');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const INPUT_USD_PER_1M  = 0.10;
const OUTPUT_USD_PER_1M = 0.40;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_COMMENTS = 30;

/**
 * Classify a single ticket.
 *
 * @param {object} ticket
 *   @param {string}   ticket.id
 *   @param {string}   ticket.subject
 *   @param {string}   ticket.channel
 *   @param {string[]} ticket.tags           - Zendesk tags array
 *   @param {string}   ticket.mindedTag      - current raw Minded custom-field value
 *   @param {string}   ticket.transcript     - full conversation text
 *   @param {string}   [ticket.createdAt]
 *
 * @returns {Promise<ClassifyResult>}
 */
async function classifyTicket(ticket) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const taxonomyText = taxonomyPromptText();

  const transcript = clip(ticket.transcript || '', MAX_TRANSCRIPT_CHARS);
  const subject    = redactPII(ticket.subject || '');
  const transcriptClean = redactPII(transcript);

  const userPrompt = `Evaluate this Headout support ticket against the NEW interaction-tag taxonomy.

RULES
- Choose exactly one existing NEW full tag as the best current classification.
- existing_tag_full_tag must exactly equal one line's L1::L2::L3 value in the taxonomy list.
- taxonomy_gap is true ONLY when no existing tag can represent the primary contact reason.
- A mismatch with the legacy Minded tag alone is not a taxonomy gap.
- Suggest at most one genuinely missing new tag (needed: false if none).
- Use lower_snake_case for suggested L1, L2, L3 values.
- Evidence must be short paraphrases — no personal information.
- Return at most 4 evidence snippets.

NEW TAXONOMY
${taxonomyText}

TICKET
Channel: ${ticket.channel || 'unknown'}
Subject: ${subject}
Zendesk tags: ${(ticket.tags || []).join(', ')}
Current Minded tag: ${ticket.mindedTag || 'none'}
Created: ${ticket.createdAt || ''}

TRANSCRIPT
${transcriptClean || '[none]'}`;

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: 'You are a precise support-taxonomy evaluator for Headout. Return only data matching the supplied JSON schema.'
      },
      { role: 'user', content: userPrompt }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'interaction_tag_evaluation',
        strict: true,
        schema: classificationSchema()
      }
    }
  });

  const content = response.choices[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);

  const matchedTag = findTag(parsed.existing_tag_full_tag);
  const tokensIn   = response.usage?.prompt_tokens     || 0;
  const tokensOut  = response.usage?.completion_tokens || 0;

  return {
    tag:             matchedTag || null,
    full_tag:        parsed.existing_tag_full_tag,
    l1:              matchedTag?.l1 || '',
    l2:              matchedTag?.l2 || '',
    l3:              matchedTag?.l3 || '',
    confidence:      parsed.confidence,
    recommended_action: parsed.recommended_action,
    mismatch_reason: parsed.mismatch_reason,
    evidence:        parsed.evidence_snippets || [],
    taxonomy_gap:    parsed.taxonomy_gap,
    taxonomy_gap_reason: parsed.taxonomy_gap_reason,
    suggested_new_tag:   parsed.suggested_new_tag,
    model:           MODEL,
    model_response_id: response.id,
    tokens_input:    tokensIn,
    tokens_output:   tokensOut,
    cost_usd:        (tokensIn / 1e6) * INPUT_USD_PER_1M + (tokensOut / 1e6) * OUTPUT_USD_PER_1M,
    prompt_chars:    userPrompt.length,
    raw_response:    content
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  const first = Math.floor(maxChars * 0.55);
  const last  = Math.floor(maxChars * 0.45);
  return text.slice(0, first) + '\n\n[… transcript clipped …]\n\n' + text.slice(text.length - last);
}

function redactPII(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[CARD]')
    .replace(/\+\d[\d\s().-]{7,}\d/g, '[PHONE]')
    .replace(/\b\d{10,15}\b/g, '[NUM]');
}

function classificationSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'existing_tag_full_tag','recommended_action','confidence',
      'mismatch_reason','evidence_snippets','taxonomy_gap',
      'taxonomy_gap_reason','suggested_new_tag'
    ],
    properties: {
      existing_tag_full_tag: { type: 'string' },
      recommended_action:    { type: 'string', enum: ['KEEP','RETAG','ADD_NEW_TAXONOMY','REVIEW'] },
      confidence:            { type: 'number' },
      mismatch_reason:       { type: 'string' },
      evidence_snippets:     { type: 'array', items: { type: 'string' } },
      taxonomy_gap:          { type: 'boolean' },
      taxonomy_gap_reason:   { type: 'string' },
      suggested_new_tag: {
        type: 'object',
        additionalProperties: false,
        required: ['needed','l1','l2','l3','intent','trip_stage','definition',
                   'minded_equivalent_tag','easy_tag_category','rationale','gap_reason'],
        properties: {
          needed:               { type: 'boolean' },
          l1:                   { type: 'string' },
          l2:                   { type: 'string' },
          l3:                   { type: 'string' },
          intent:               { type: 'string' },
          trip_stage:           { type: 'string' },
          definition:           { type: 'string' },
          minded_equivalent_tag:{ type: 'string' },
          easy_tag_category:    { type: 'string' },
          rationale:            { type: 'string' },
          gap_reason:           { type: 'string' }
        }
      }
    }
  };
}

module.exports = { classifyTicket };
