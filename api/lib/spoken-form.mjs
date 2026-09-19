// Normalize spoken / TTS-friendly digit and address strings into compact form.
// Voice agents often pass "five one six … three one four … four zero zero zero"
// into tool args; this converts those runs into numerals before SMS body building.
// Narrow: only converts ≥2 consecutive digit-words (or known street idioms),
// so business names like "Five Star Plumbing" are left alone.

const DIGITS = {
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

const DIGIT_WORD = 'zero|oh|one|two|three|four|five|six|seven|eight|nine';
const DIGIT_RUN_RE = new RegExp(
  `(?:\\b(?:${DIGIT_WORD})\\b\\s*[….,\\-]?\\s*){2,}`,
  'gi',
);

/**
 * Convert runs of spoken digit words into numerals.
 * @param {unknown} raw
 * @returns {string | null | undefined} Same type as input when null/undefined; else string
 */
export function normalizeSpokenDigits(raw) {
  if (raw == null) return raw;
  let s = String(raw);

  // Replace multi-digit spoken runs ("five one six …") with numerals.
  s = s.replace(DIGIT_RUN_RE, (run) => {
    const digits = run
      .toLowerCase()
      .replace(new RegExp(`\\b(?:${DIGIT_WORD})\\b`, 'g'), (w) => DIGITS[w] || '')
      .replace(/[^\d]/g, '');
    return digits || run;
  });

  // Common street-number idioms ("one twenty-three" → "123").
  const teens = {
    ten: '10',
    eleven: '11',
    twelve: '12',
    thirteen: '13',
    fourteen: '14',
    fifteen: '15',
    sixteen: '16',
    seventeen: '17',
    eighteen: '18',
    nineteen: '19',
  };
  const tens = {
    twenty: '2',
    thirty: '3',
    forty: '4',
    fifty: '5',
    sixty: '6',
    seventy: '7',
    eighty: '8',
    ninety: '9',
  };
  // "one twenty-three" / "one twenty three"
  s = s.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine)\s+(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\s]?(zero|oh|one|two|three|four|five|six|seven|eight|nine)?\b/gi,
    (_m, hundreds, ten, ones) => {
      const h = DIGITS[hundreds.toLowerCase()] || '';
      const t = tens[ten.toLowerCase()] || '';
      const o = ones ? DIGITS[ones.toLowerCase()] || '0' : '0';
      return `${h}${t}${o}`;
    },
  );
  // "one hundred twenty three" is rare on this line — skip for now.
  // Teens after a hundreds digit word: "one twelve" → "112"
  s = s.replace(
    new RegExp(
      `\\b(${DIGIT_WORD})\\s+(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\\b`,
      'gi',
    ),
    (_m, a, teen) => `${DIGITS[a.toLowerCase()] || ''}${teens[teen.toLowerCase()] || ''}`,
  );

  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize the fields that commonly arrive in spoken form from the voice LLM.
 * Does not touch business_name or customer_name.
 * @param {Record<string, unknown>} args
 * @returns {Record<string, unknown>}
 */
export function normalizeDemoAlertArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  if (out.customer_phone != null) out.customer_phone = normalizeSpokenDigits(out.customer_phone);
  if (out.address != null) out.address = normalizeSpokenDigits(out.address);
  if (out.appointment != null) out.appointment = normalizeSpokenDigits(out.appointment);
  return out;
}
