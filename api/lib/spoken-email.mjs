// Normalize spoken / TTS-friendly email strings into compact addresses.
// Voice agents often pass "G E O F F at O W N E R A I T O O L S dot com"
// into tools; this converts that to geoff@owneraitools.com before validation.

const DIGIT_WORDS = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/**
 * @param {unknown} raw
 * @returns {string | null} Compact lowercase email, or null if empty/unusable
 */
export function normalizeSpokenEmail(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // Already compact — leave structure alone (still lowercased/trimmed).
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s;

  // Spoken digits → numerals (word boundaries).
  s = s.replace(
    /\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g,
    (w) => DIGIT_WORDS[w] || w,
  );

  // "g mail" / "g-mail" → gmail (before stripping separators).
  s = s.replace(/\bg[\s\-]*mail\b/g, 'gmail');

  // Word "at" / "dot" as separators.
  s = s.replace(/\bat\b/g, '@');
  s = s.replace(/\bdot\b/g, '.');

  // Drop spaces and hyphens used as letter separators (keep @ and .).
  s = s.replace(/[\s\-]+/g, '');

  // Collapse accidental repeats from messy ASR.
  s = s.replace(/@{2,}/g, '@').replace(/\.{2,}/g, '.');

  return s || null;
}

/**
 * @param {unknown} raw
 * @returns {string | null} Valid email or null
 */
export function validEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/**
 * Normalize spoken form then validate.
 * @param {unknown} raw
 * @returns {{ email: string | null, normalized: string | null, raw: string | null }}
 */
export function resolveEmail(raw) {
  const rawStr = raw == null || String(raw).trim() === '' ? null : String(raw).trim();
  const normalized = normalizeSpokenEmail(raw);
  const email = validEmail(normalized);
  return { email, normalized, raw: rawStr };
}
