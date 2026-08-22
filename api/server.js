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

const express = require('express');
const { loadTaxonomy, getTags, findTag } = require('./taxonomy');
const { classifyTicket } = require('./classifier');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));

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

    // Write the classified tag back to the Zendesk ticket automatically
    let writeBack = null;
    if (result.full_tag && process.env.ZENDESK_EMAIL && process.env.ZENDESK_TOKEN && process.env.ZENDESK_SUBDOMAIN) {
      writeBack = await writeTagToZendesk(ticket_id, result.full_tag);
    }

    res.json({
      ticket_id,
      classified_tag: result.full_tag,
      l1: result.l1, l2: result.l2, l3: result.l3,
      confidence: result.confidence,
      taxonomy_gap: result.taxonomy_gap,
      write_back: writeBack,
      result
    });
  } catch (err) {
    console.error('/zendesk/webhook error:', err.message);
    res.status(500).json({ error: err.message });
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

// ── Zendesk tag write-back ────────────────────────────────────────────────

async function writeTagToZendesk(ticketId, fullTag) {
  const subdomain  = process.env.ZENDESK_SUBDOMAIN;
  const email      = process.env.ZENDESK_EMAIL;
  const token      = process.env.ZENDESK_TOKEN;
  const fieldId    = process.env.MINDED_TAG_FIELD_ID;
  const cred       = Buffer.from(`${email}/token:${token}`).toString('base64');

  if (!fieldId) {
    return { ok: false, error: 'MINDED_TAG_FIELD_ID env var not set' };
  }

  const easyTag = fullTag.replace(/::/g, '__');
  const body = {
    ticket: {
      custom_fields: [{ id: Number(fieldId), value: fullTag }],
      additional_tags: [easyTag]
    }
  };

  const res = await fetch(
    `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Basic ${cred}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  }

  return { ok: true, ticket_id: ticketId, field_id: fieldId, value: fullTag };
}

// ── start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const tax = loadTaxonomy();
  console.log(`Headout Interaction Tag API running on port ${PORT}`);
  console.log(`Taxonomy: v${tax.version} · ${tax.total_tags} tags · ${tax.l1_categories.length} L1 categories`);
});

module.exports = app;
