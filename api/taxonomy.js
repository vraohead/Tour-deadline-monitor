/**
 * Taxonomy loader — reads interaction_tags.json and caches it in memory.
 * Edit taxonomy/interaction_tags.json (via GitHub or the web UI) to add/remove/change tags.
 */

const fs   = require('fs');
const path = require('path');

let _cached = null;

function loadTaxonomy() {
  if (_cached) return _cached;

  const file = path.join(__dirname, '..', 'taxonomy', 'interaction_tags.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Support both raw array and the envelope format
  const tags = Array.isArray(data) ? data : (data.tags || []);
  const filtered = tags.filter(t => t && t.full_tag);

  const l1s = [...new Set(filtered.map(t => t.l1))];

  _cached = {
    version:       data.version || new Date().toISOString().slice(0, 10),
    description:   data.description || 'Headout interaction tag taxonomy.',
    total_tags:    filtered.length,
    l1_categories: l1s,
    tags:          filtered,
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

/**
 * Save updated tags array back to the repo via the GitHub Contents API.
 * Requires env vars: GITHUB_TOKEN, GITHUB_REPO (default: vraohead/interaction-tags)
 *
 * @param {Array} tags - array of tag objects
 * @returns {Promise<{ok: boolean, version: string, total_tags: number}>}
 */
async function saveTaxonomyViaGithub(tags) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN env var is not set — cannot save to GitHub.');

  const repo    = process.env.GITHUB_REPO || 'vraohead/interaction-tags';
  const apiBase = `https://api.github.com/repos/${repo}/contents/taxonomy/interaction_tags.json`;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:        'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Step 1: GET the current file to obtain its SHA
  const getRes = await fetch(apiBase, { headers });
  if (!getRes.ok) {
    const msg = await getRes.text();
    throw new Error(`GitHub GET failed (${getRes.status}): ${msg.slice(0, 300)}`);
  }
  const fileInfo = await getRes.json();
  const sha = fileInfo.sha;

  // Step 2: Build the new envelope
  const l1s    = [...new Set(tags.map(t => t.l1))];
  const version = new Date().toISOString().slice(0, 10);
  const envelope = {
    version,
    description: 'Headout interaction tag taxonomy (NEW). L1::L2::L3 hierarchy for classifying Zendesk support tickets.',
    total_tags: tags.length,
    l1_categories: l1s,
    tags,
  };

  const content = Buffer.from(JSON.stringify(envelope, null, 2) + '\n').toString('base64');

  // Step 3: PUT the updated file
  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `Update taxonomy: ${tags.length} tags (${version})`,
      content,
      sha,
    }),
  });

  if (!putRes.ok) {
    const msg = await putRes.text();
    throw new Error(`GitHub PUT failed (${putRes.status}): ${msg.slice(0, 300)}`);
  }

  // Invalidate cache so next load reads fresh data
  _cached = null;

  return { ok: true, version, total_tags: tags.length };
}

module.exports = { loadTaxonomy, getTags, taxonomyPromptText, findTag, saveTaxonomyViaGithub };
