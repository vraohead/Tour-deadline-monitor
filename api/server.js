/**
 * Headout Interaction Tag API Server
 *
 * Endpoints
 * ─────────
 * GET  /health              → liveness check
 * GET  /taxonomy            → full taxonomy list (for AI context injection)
 * GET  /taxonomy/:l1        → tags filtered by L1 category
 * POST /classify            → classify a ticket and return the best tag
 * POST /zendesk/webhook     → same as /classify but accepts a Zendesk webhook
 *                             payload and returns Zendesk-flavoured JSON
 *
 * Environment variables
 * ─────────────────────
 * OPENAI_API_KEY    required
 * API_SECRET        optional — if set, all POST requests must send this in
 *                   the Authorization header: "Bearer <API_SECRET>"
 * PORT              optional, defaults to 3000
 *
 * Quick start
 * ───────────
 *   cp .env.example .env   # fill in OPENAI_API_KEY
 *   npm start
 */

require('dotenv').config();

const path    = require('path');
const express = require('express');
const { loadTaxonomy, getTags, findTag, taxonomyPromptText, saveTaxonomyViaGithub } = require('./taxonomy');
const { classifyTicket } = require('./classifier');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── auth middleware ────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // no secret configured → open
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${secret}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── routes ─────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  const tax = loadTaxonomy();
  res.json({ status: 'ok', taxonomy_version: tax.version, total_tags: tax.total_tags });
});

/**
 * GET /taxonomy
 * Returns the full tag list. Useful for letting an AI agent reference the
 * current taxonomy before classifying a ticket in its own reasoning step.
 *
 * Query params:
 *   ?format=list   (default) full array of tag objects
 *   ?format=names  just the full_tag strings
 *   ?format=prompt newline-separated prompt-ready text
 */
app.get('/taxonomy', (req, res) => {
  const tax  = loadTaxonomy();
  const fmt  = req.query.format || 'list';
  const tags = getTags();

  if (fmt === 'names') {
    return res.json({ version: tax.version, tags: tags.map(t => t.full_tag) });
  }
  if (fmt === 'prompt') {
    const text = tags
      .map((t, i) => `${i + 1}. ${t.full_tag} | intent=${t.intent} | trip_stage=${t.trip_stage}`)
      .join('\n');
    return res.type('text/plain').send(text);
  }
  res.json(tax);
});

/**
 * GET /taxonomy/:l1
 * Tags for one L1 category.
 */
app.get('/taxonomy/:l1', (req, res) => {
  const l1   = req.params.l1.toLowerCase();
  const tags = getTags().filter(t => t.l1.toLowerCase() === l1);
  if (!tags.length) return res.status(404).json({ error: `No tags found for L1: ${l1}` });
  res.json({ l1, count: tags.length, tags });
});

/**
 * POST /classify
 * Body: {
 *   ticket_id:    string,
 *   subject:      string,
 *   channel:      string,
 *   tags:         string[],       // existing Zendesk tags
 *   minded_tag:   string,         // current Minded custom-field value
 *   transcript:   string,         // full conversation text
 *   created_at:   string          // ISO date
 * }
 *
 * Returns: ClassifyResult (see api/classifier.js)
 */
app.post('/classify', requireAuth, async (req, res) => {
  try {
    const { ticket_id, subject, channel, tags, minded_tag, transcript, created_at } = req.body;
    if (!transcript && !subject) {
      return res.status(400).json({ error: 'Provide at least a transcript or subject.' });
    }

    const result = await classifyTicket({
      id:        ticket_id,
      subject:   subject || '',
      channel:   channel || 'unknown',
      tags:      tags || [],
      mindedTag: minded_tag || '',
      transcript: transcript || '',
      createdAt: created_at || ''
    });

    res.json({ ticket_id, ...result });
  } catch (err) {
    console.error('/classify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /zendesk/webhook
 *
 * Accepts the payload that a Zendesk trigger sends when a ticket is created
 * or updated. The trigger should be configured with a webhook JSON body like:
 *
 *   {
 *     "ticket_id":  "{{ticket.id}}",
 *     "subject":    "{{ticket.title}}",
 *     "channel":    "{{ticket.via}}",
 *     "minded_tag": "{{ticket.ticket_field_<MINDED_TAG_FIELD_ID>}}",
 *     "tags":       "{{ticket.tags}}"
 *   }
 *
 * The transcript is fetched from Zendesk inside the handler.
 * When ZENDESK_EMAIL and ZENDESK_TOKEN are set, comments are fetched
 * automatically; otherwise transcript is expected in the body.
 *
 * Response: Zendesk-style object that can be used with the Update Ticket API.
 */
app.post('/zendesk/webhook', requireAuth, async (req, res) => {
  try {
    const {
      ticket_id, subject, channel, tags: rawTags,
      minded_tag, transcript: bodyTranscript, created_at
    } = req.body;

    if (!ticket_id) return res.status(400).json({ error: 'ticket_id required' });

    const tags = typeof rawTags === 'string'
      ? rawTags.split(',').map(s => s.trim()).filter(Boolean)
      : (rawTags || []);

    // Optionally fetch comments from Zendesk if credentials are configured
    let transcript = bodyTranscript || '';
    if (!transcript && process.env.ZENDESK_EMAIL && process.env.ZENDESK_TOKEN && process.env.ZENDESK_SUBDOMAIN) {
      transcript = await fetchZendeskTranscript(ticket_id);
    }

    const result = await classifyTicket({
      id: ticket_id, subject: subject || '',
      channel: channel || 'unknown',
      tags, mindedTag: minded_tag || '',
      transcript, createdAt: created_at || ''
    });

    // Return both the raw result and a ready-to-use Zendesk update payload
    res.json({
      ticket_id,
      result,
      zendesk_update: {
        ticket: {
          custom_fields: [
            // Replace FIELD_ID with your actual Zendesk custom field ID
            {
              id:    process.env.MINDED_TAG_FIELD_ID || 'REPLACE_WITH_FIELD_ID',
              value: result.full_tag
            }
          ],
          additional_tags: [result.full_tag?.replace(/::/g, '__')].filter(Boolean)
        }
      }
    });
  } catch (err) {
    console.error('/zendesk/webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /taxonomy
 * Body: { tags: TagObject[] }
 * Saves the updated taxonomy to GitHub and invalidates the in-memory cache.
 * Requires GITHUB_TOKEN env var.
 */
app.put('/taxonomy', async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array' });
    const result = await saveTaxonomyViaGithub(tags);
    res.json(result);
  } catch (err) {
    console.error('PUT /taxonomy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /taxonomy/ai-edit
 * Body: { prompt: string }
 * Sends the current taxonomy + prompt to OpenAI and returns proposed changes.
 * Does NOT save — the client must call PUT /taxonomy to persist.
 */
app.post('/taxonomy/ai-edit', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const currentTags = getTags();
    const tagList = taxonomyPromptText();
    const model = process.env.OPENAI_MODEL || 'gpt-4.1-nano';

    const systemMsg = `You are a taxonomy editor for Headout's Zendesk support tag system.
The taxonomy uses an L1::L2::L3 hierarchy. Each tag has: full_tag, l1, l2, l3, intent, trip_stage, definition, easy_tag_category, minded_equivalent_tag.
easy_tag_category is l1__l2__l3 (double underscores). trip_stage must be one of: Any, Pre-trip, During trip, Post-trip.
Only make changes explicitly asked for. Return valid JSON.`;

    const userMsg = `Current taxonomy (${currentTags.length} tags):\n${tagList}\n\nRequested change: ${prompt}\n\nReturn JSON: { "explanation": "...", "changes": [{"action":"add"|"modify"|"remove","full_tag":"..."}], "updated_tags": [...full tag array after changes...] }`;

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: userMsg }],
      }),
    });
    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      throw new Error(`OpenAI error (${openaiRes.status}): ${err.slice(0, 300)}`);
    }
    const aiData = await openaiRes.json();
    const parsed = JSON.parse(aiData.choices[0].message.content);
    res.json({
      explanation:  parsed.explanation  || '',
      changes:      parsed.changes      || [],
      updated_tags: parsed.updated_tags || currentTags,
      tokens_input:  aiData.usage?.prompt_tokens     || 0,
      tokens_output: aiData.usage?.completion_tokens || 0,
    });
  } catch (err) {
    console.error('POST /taxonomy/ai-edit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/data
 * Query params: ?page=1&per_page=20
 * Returns classified tickets from Zendesk (tickets with the interaction tag custom field set).
 * Requires ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_TOKEN env vars.
 */
app.get('/api/data', async (req, res) => {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email     = process.env.ZENDESK_EMAIL;
  const token     = process.env.ZENDESK_TOKEN;
  const fieldId   = process.env.MINDED_TAG_FIELD_ID;

  if (!subdomain || !email || !token) {
    return res.json({ ok: false, error: 'Zendesk credentials not configured' });
  }

  const page    = Math.max(1, parseInt(req.query.page  || '1',  10));
  const perPage = Math.min(100, parseInt(req.query.per_page || '20', 10));
  const cred    = Buffer.from(`${email}/token:${token}`).toString('base64');
  const headers = { Authorization: `Basic ${cred}`, 'Content-Type': 'application/json' };

  try {
    const query = fieldId
      ? `custom_field_${fieldId}:*`
      : `tags:interaction_tag`;
    const url = `https://${subdomain}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc&page=${page}&per_page=${perPage}`;
    const zdRes = await fetch(url, { headers });
    if (!zdRes.ok) throw new Error(`Zendesk search failed: ${zdRes.status}`);
    const zdData = await zdRes.json();

    const results = (zdData.results || []).map(t => {
      const tagField = fieldId
        ? (t.custom_fields || []).find(f => String(f.id) === String(fieldId))
        : null;
      return {
        ticket_id:       t.id,
        subject:         t.subject,
        status:          t.status,
        created_at:      t.created_at,
        interaction_tag: tagField?.value || null,
        url:             `https://${subdomain}.zendesk.com/agent/tickets/${t.id}`,
      };
    });

    res.json({ ok: true, total: zdData.count || 0, page, per_page: perPage, results });
  } catch (err) {
    console.error('GET /api/data error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ── Zendesk comment fetcher ────────────────────────────────────────────────

async function fetchZendeskTranscript(ticketId) {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email     = process.env.ZENDESK_EMAIL;
  const token     = process.env.ZENDESK_TOKEN;
  const cred      = Buffer.from(`${email}/token:${token}`).toString('base64');

  const res = await fetch(
    `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}/comments.json?sort_order=asc`,
    { headers: { Authorization: `Basic ${cred}`, 'Content-Type': 'application/json' } }
  );
  if (!res.ok) throw new Error(`Zendesk comments fetch failed: ${res.status}`);
  const data = await res.json();

  return (data.comments || [])
    .slice(0, 30)
    .map(c => `[${c.public ? 'PUBLIC' : 'INTERNAL'} | ${c.created_at} | author ${c.author_id}]\n${c.plain_body || c.body || ''}`)
    .join('\n\n---\n\n');
}

// ── start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const tax = loadTaxonomy();
  console.log(`Headout Interaction Tag API running on port ${PORT}`);
  console.log(`Taxonomy: v${tax.version} · ${tax.total_tags} tags · ${tax.l1_categories.length} L1 categories`);
});

module.exports = app;
