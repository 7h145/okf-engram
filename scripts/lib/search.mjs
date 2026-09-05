const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "why", "with",
]);

export function tokenize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((token) => token && !STOPWORDS.has(token));
}

function tokenHits(queryTokens, text) {
  const tokens = new Set(tokenize(text));
  return queryTokens.reduce((sum, token) => sum + (tokens.has(token) ? 1 : 0), 0);
}

export function scoreConcept(query, item) {
  const queryNorm = query.normalize("NFKC").toLocaleLowerCase("en-US").trim();
  const queryTokens = tokenize(queryNorm);
  if (!queryTokens.length) return 0;
  const { envelope, concept, id } = item;
  const title = String(envelope.title ?? "").toLocaleLowerCase("en-US");
  const idText = id.toLocaleLowerCase("en-US");
  let score = 0;
  if (title === queryNorm || idText === queryNorm) score += 100;
  else {
    if (title.includes(queryNorm)) score += 40;
    if (idText.includes(queryNorm)) score += 30;
  }
  score += tokenHits(queryTokens, title) * 12;
  score += tokenHits(queryTokens, idText) * 10;
  score += tokenHits(queryTokens, envelope.tags.join(" ")) * 8;
  score += tokenHits(queryTokens, envelope.description) * 5;
  score += tokenHits(queryTokens, concept.body) * 1;
  score += tokenHits(queryTokens, JSON.stringify(concept.data.sources ?? [])) * 0.5;
  return score;
}

export function searchConcepts(query, concepts, { limit = 10, includeDeprecated = false } = {}) {
  return concepts
    .filter((item) => includeDeprecated || item.envelope.status !== "deprecated")
    .map((item) => ({ ...item.envelope, score: scoreConcept(query, item) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}
