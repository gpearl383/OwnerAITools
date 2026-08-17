/** Detect speech-game / jailbreak-mutated names (oink, piggy, repeated nonsense). */
const JOKE_TOKENS = new Set(['oink', 'piggy', 'oinks', 'piggies']);

/** Tokens that look like speech-game fillers when repeated. */
const NONSENSE_FILLERS = new Set([
  'oink',
  'piggy',
  'oinks',
  'piggies',
  'blah',
  'blarg',
  'asdf',
  'qwerty',
  'xyzzy',
  'moo',
  'baa',
  'meow',
  'woof',
]);

export function isMutatedJokeName(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return false;
  const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const jokeHits = tokens.filter((t) => JOKE_TOKENS.has(t)).length;
  if (jokeHits >= 2) return true;
  const fillerHits = tokens.filter((t) => NONSENSE_FILLERS.has(t)).length;
  if (fillerHits >= 3) return true;
  // Same short token repeated 3+ times (e.g. "na na na na")
  if (tokens.length >= 3) {
    const counts = new Map();
    for (const t of tokens) {
      if (t.length <= 6) counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const n of counts.values()) {
      if (n >= 3) return true;
    }
  }
  // Compact forms like "geoinkoinkoink" without spaces
  const compact = raw.replace(/[^a-z0-9]/g, '');
  const oinkCount = (compact.match(/oink/g) || []).length;
  const piggyCount = (compact.match(/piggy/g) || []).length;
  return oinkCount >= 2 || piggyCount >= 2;
}
