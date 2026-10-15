import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { compute, clampInputs } = require(join(root, 'assets/missed-call-calculator.js'));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sample = compute({ missed: 10, called: 6, pickup: 3, hired: 2, value: 600 });
assert(sample.kept === 1, 'sample keeps 1 job');
assert(sample.lostJobs === 9, 'sample loses 9 jobs');
assert(sample.never === 4, '4 never called back');
assert(sample.silent === 3, '3 no pickup');
assert(sample.hired === 2, '2 already hired');
assert(sample.lostMonth === 23400, `sample month should be 23400, got ${sample.lostMonth}`);
assert(sample.keptMonth === 2600, `kept month should be 2600, got ${sample.keptMonth}`);
assert(sample.offeringMonth === 26000, 'offering-style total is all missed');
assert(sample.lostYear === 280800, `year should be 280800, got ${sample.lostYear}`);

const clamped = clampInputs({ missed: 5, called: 9, pickup: 8, hired: 7, value: 600 });
assert(clamped.called === 5 && clamped.pickup === 5 && clamped.hired === 5 && clamped.clamped, 'later answers clamp to earlier');

const zero = compute({ missed: 0, called: 0, pickup: 0, hired: 0, value: 600 });
assert(zero.lostMonth === 0 && zero.kept === 0, 'zero missed → zero loss');

console.log('test-missed-call-calculator: PASS');
