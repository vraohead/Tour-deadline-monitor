/**
 * Taxonomy loader — reads interaction_tags.json once and caches it.
 * This is the single source of truth for the tag list that the classifier
 * prompt and the /taxonomy endpoint both read from.
 */

const fs = require('fs');
const path = require('path');

let _cached = null;

function loadTaxonomy() {
  if (_cached) return _cached;
  const file = path.join(__dirname, '..', 'taxonomy', 'interaction_tags.json');
  _cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  return _cached;
}

function getTags() {
  return loadTaxonomy().tags;
}

/**
 * Formats the full taxonomy as a numbered list suitable for injecting into a
 * classifier prompt. Stable ordering keeps the prompt deterministic across runs.
 */
function taxonomyPromptText() {
  const tags = getTags();
  return tags
    .map((tag, i) =>
      `${i + 1}. ${tag.full_tag}` +
      ` | intent=${tag.intent}` +
      ` | trip_stage=${tag.trip_stage}` +
      ` | definition=${tag.definition}` +
      (tag.minded_equivalent_tag ? ` | legacy_minded_tag=${tag.minded_equivalent_tag}` : '')
    )
    .join('\n');
}

/**
 * Returns the taxonomy entry that exactly matches full_tag (case/whitespace
 * insensitive), or null if not found.
 */
function findTag(fullTag) {
  if (!fullTag) return null;
  const normalized = fullTag.trim().toLowerCase().replace(/\s*::\s*/g, '::');
  return getTags().find(t => t.full_tag.toLowerCase() === normalized) || null;
}

module.exports = { loadTaxonomy, getTags, taxonomyPromptText, findTag };
