// Unit checks for spoken → compact email normalization.
import { normalizeSpokenEmail, resolveEmail, validEmail } from '../api/lib/spoken-email.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const cases = [
  ['G E O F F at O W N E R A I T O O L S dot com', 'geoff@owneraitools.com'],
  ['G P E A R L three eight three at g-mail dot com', 'gpearl383@gmail.com'],
  ['geoff@owneraitools.com', 'geoff@owneraitools.com'],
  ['G E O F F at O W N - E R A I T - O O L S dot com', 'geoff@owneraitools.com'],
  ['G P E A R L three eight three at g mail dot com', 'gpearl383@gmail.com'],
];

for (const [input, expected] of cases) {
  const got = normalizeSpokenEmail(input);
  assert(got === expected, `normalize(${JSON.stringify(input)}) => ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
  assert(validEmail(got) === expected, `validEmail after normalize for ${input}`);
  assert(resolveEmail(input).email === expected, `resolveEmail(${input})`);
}

assert(normalizeSpokenEmail('') === null, 'empty → null');
assert(normalizeSpokenEmail(null) === null, 'null → null');
assert(resolveEmail('not an email at all').email === null, 'garbage → null email');
assert(
  resolveEmail('G E O F F at O W N E R A I T O O L S dot com').normalized === 'geoff@owneraitools.com',
  'resolve exposes normalized',
);

console.log(`ok — ${cases.length} spoken-email cases + edge checks`);
