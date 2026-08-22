/**
 * Taxonomy loader — reads interaction_tags.csv and caches it in memory.
 * Edit taxonomy/interaction_tags.csv (in GitHub or Excel/Sheets) to add/remove/change tags.
 */

const fs   = require('fs');
const path = require('path');

let _cached = null;

// Minimal RFC-4180 CSV parser — handles quoted fields with embedded commas/newlines/quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false, i = 0;
  const flush = () => { row.push(field); field = ''; };
  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQuote = false; i++; continue; }
      field += ch;
    } else {
      if (ch === '"')  { inQuote = true; i++; continue; }
      if (ch === ',')  { flush(); i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { flush(); rows.push(row); row = []; i++; continue; }
      field += ch;
    }
    i++;
  }
  flush();
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function loadTaxonomy() {
  if (_cached) return _cached;

  const file = path.join(__dirname, '..', 'taxonomy', 'interaction_tags.csv');
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const [header, ...data] = rows;
  const idx = k => header.indexOf(k);

  const tags = data.map(r => ({
    full_tag:              r[idx('full_tag')]              || '',
    l1:                    r[idx('l1')]                    || '',
    l2:                    r[idx('l2')]                    || '',
    l3:                    r[idx('l3')]                    || '',
    intent:                r[idx('intent')]                || '',
    trip_stage:            r[idx('trip_stage')]            || '',
    definition:            r[idx('definition')]            || '',
    minded_equivalent_tag: r[idx('minded_equivalent_tag')] || '',
    easy_tag_category:     r[idx('easy_tag_category')]     || '',
  })).filter(t => t.full_tag);

  const l1s = [...new Set(tags.map(t => t.l1))];

  _cached = {
    version:       '2026-08-22',
    description:   'Headout interaction tag taxonomy. Edit taxonomy/interaction_tags.csv to change tags.',
    total_tags:    tags.length,
    l1_categories: l1s,
    tags,
  };
  return _cached;
}

function getTags() {
  return loadTaxonomy().tags;
}

function taxonomyPromptText() {
  return getTags()
    .map((t, i) =>
      `${i + 1}. ${t.full_tag}` +
      ` | intent=${t.intent}` +
      ` | trip_stage=${t.trip_stage}` +
      ` | definition=${t.definition}` +
      (t.minded_equivalent_tag ? ` | legacy_minded_tag=${t.minded_equivalent_tag}` : '')
    )
    .join('\n');
}

function findTag(fullTag) {
  if (!fullTag) return null;
  const normalized = fullTag.trim().toLowerCase().replace(/\s*::\s*/g, '::');
  return getTags().find(t => t.full_tag.toLowerCase() === normalized) || null;
}

module.exports = { loadTaxonomy, getTags, taxonomyPromptText, findTag };
