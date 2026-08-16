/** Detect speech-game / jailbreak-mutated names (oink, piggy, etc.). */
const JOKE_TOKENS = new Set(['oink', 'piggy', 'oinks', 'piggies']);

export function isMutatedJokeName(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return false;
  const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const jokeHits = tokens.filter((t) => JOKE_TOKENS.has(t)).length;
  if (jokeHits >= 2) return true;
  // Compact forms like "geoinkoinkoink" without spaces
  const compact = raw.replace(/[^a-z0-9]/g, '');
  const oinkCount = (compact.match(/oink/g) || []).length;
  const piggyCount = (compact.match(/piggy/g) || []).length;
  return oinkCount >= 2 || piggyCount >= 2;
}
