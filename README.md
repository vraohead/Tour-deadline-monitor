# Headout Interaction Tags

Interaction tag taxonomy + classifier API for Headout's Zendesk support tickets.

## What's here

```
taxonomy/
  interaction_tags.json   ← single source of truth for the NEW L1::L2::L3 taxonomy
api/
  taxonomy.js             ← taxonomy loader (used by classifier and HTTP endpoints)
  classifier.js           ← OpenAI-powered classifier (call from anywhere)
  server.js               ← Express API server (deploy to Vercel, Railway, Render…)
scripts/
  test_classify.js        ← quick smoke test
.env.example              ← copy to .env and fill in your keys
vercel.json               ← one-click Vercel deployment config
```

## Taxonomy format

`taxonomy/interaction_tags.json` is a JSON file — easy for a human or AI to read and edit.
It has a flat `tags` array; each tag looks like:

```json
{
  "full_tag": "cancellation_request::customer_related::flight_train_cancellation",
  "l1": "cancellation_request",
  "l2": "customer_related",
  "l3": "flight_train_cancellation",
  "intent": "Customer's flight or train was canceled, affecting plans.",
  "trip_stage": "Any",
  "definition": "Customer's flight or train was canceled, affecting plans.",
  "minded_equivalent_tag": "",
  "easy_tag_category": "cancellation_request__customer_related__flight_train_cancellation"
}
```

**To add or edit a tag:** open `taxonomy/interaction_tags.json`, find the right place in the
`tags` array, and add/edit the object. The `full_tag` must be `l1::l2` or `l1::l2::l3`
in `lower_snake_case`. Commit the change and redeploy.

**To let an AI edit taxonomy:** point it at the raw GitHub URL of `interaction_tags.json`
(or at `GET /taxonomy`) and ask it to add/remove entries. It can propose a diff or edit
the file directly in a PR.

## API endpoints

### `GET /health`
Returns current taxonomy version and tag count.

### `GET /taxonomy`
Returns the full taxonomy. Query params:
- `?format=list` (default) — full array of tag objects
- `?format=names` — just the `full_tag` strings
- `?format=prompt` — newline-separated, ready to paste into a prompt

### `GET /taxonomy/:l1`
Tags for a single L1 category (e.g. `/taxonomy/cancellation_request`).

### `POST /classify`
Classify a ticket. Body:
```json
{
  "ticket_id":  "12345",
  "subject":    "Need to cancel my booking",
  "channel":    "email",
  "tags":       ["minded_email"],
  "minded_tag": "cancellation_request__customer_related__change_of_plans",
  "transcript": "Customer: Hi, I need to cancel…\nAgent: …",
  "created_at": "2026-08-22T10:00:00Z"
}
```

Response includes `full_tag`, `l1`/`l2`/`l3`, `confidence`, `recommended_action`,
`evidence`, `taxonomy_gap`, and cost details.

### `POST /zendesk/webhook`
Same as `/classify` but accepts the Zendesk trigger webhook payload and returns a
`zendesk_update` object you can pass straight to the Zendesk Update Ticket API.

## Zendesk trigger setup

1. In Zendesk Admin → Webhooks, create a webhook pointing at `https://YOUR_DOMAIN/zendesk/webhook`
   with `Content-Type: application/json` and `Authorization: Bearer YOUR_API_SECRET`.

2. Create a Trigger (or Automation) with condition **Tags | Contains | minded** and action
   **Notify webhook** with JSON body:
   ```json
   {
     "ticket_id":  "{{ticket.id}}",
     "subject":    "{{ticket.title}}",
     "channel":    "{{ticket.via}}",
     "minded_tag": "{{ticket.ticket_field_360023704091}}",
     "tags":       "{{ticket.tags}}"
   }
   ```
   Replace `360023704091` with your actual Minded Tag custom field ID.

3. The API will respond with the recommended `full_tag`. Wire a second step (or use a
   Zendesk webhook action app) to write the returned tag back to the ticket field.

## Hosting options

### Vercel (recommended — free, serverless, zero ops)
```bash
npm i -g vercel
vercel                      # follow the prompts
vercel env add OPENAI_API_KEY production
vercel env add API_SECRET production
vercel --prod               # deploy to production
```
Your URL will be `https://headout-interaction-tags.vercel.app` (or a custom domain).

### Railway / Render / Fly.io
All support `npm start` directly. Set the env variables in their dashboard.

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm ci --omit=dev
COPY . .
CMD ["node", "api/server.js"]
```

## Local development
```bash
cp .env.example .env    # fill in OPENAI_API_KEY
npm install
npm run dev             # starts with --watch
# test classify:
node scripts/test_classify.js
```

## AI-friendliness

The taxonomy is intentionally stored as plain JSON so an AI can:
- **Read it in one tool call** — `GET /taxonomy` or the raw GitHub URL
- **Propose additions** — ask it to append a new tag object to `tags[]` and open a PR
- **Search it** — `GET /taxonomy/:l1` to scope context to one category
- **Use it in a prompt** — `GET /taxonomy?format=prompt` returns a numbered list ready for injection

The classifier (`api/classifier.js`) also uses structured JSON output so its response
is directly machine-parseable without regex.
