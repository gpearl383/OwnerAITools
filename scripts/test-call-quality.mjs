#!/usr/bin/env node
// Unit test for api/lib/call-quality.mjs using a synthetic Sep-10-shaped
// transcript (postmortem: 14 overlaps, 18 gaps >1.5s, ~15.5s tool silence).

import {
  computeCallQuality,
  QUALITY_THRESHOLDS,
} from '../api/lib/call-quality.mjs';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

/**
 * Build timed utterances that reproduce the Sep-10 postmortem shape.
 * Times are seconds from call start.
 */
function buildSep10Fixture() {
  const utterances = [];
  let t = 0;

  // Opening exchange — a few normal turns
  utterances.push({
    role: 'agent',
    content: 'Thanks for calling OwnerAI',
    words: [{ word: 'Thanks', start: t, end: t + 0.3 }],
    start: t,
    end: (t = 2.0),
  });
  utterances.push({
    role: 'user',
    content: 'Hi what do you do',
    words: [{ word: 'Hi', start: t + 0.2, end: t + 0.4 }],
    start: t + 0.2,
    end: (t = 4.0),
  });

  // 18 agent responses with >1.5s silence after caller finishes
  for (let i = 0; i < 18; i++) {
    const userStart = t + 0.3;
    const userEnd = userStart + 1.0;
    utterances.push({
      role: 'user',
      content: `user turn ${i}`,
      words: [{ word: 'user', start: userStart, end: userStart + 0.2 }],
      start: userStart,
      end: userEnd,
    });
    // Gap >1.5s (use 2.0s for most; one 4.0s mid-call)
    const gap = i === 10 ? 4.0 : 2.0;
    const agentStart = userEnd + gap;
    const agentEnd = agentStart + 1.2;
    utterances.push({
      role: 'agent',
      content: `agent turn ${i} with enough words`,
      words: [{ word: 'agent', start: agentStart, end: agentStart + 0.2 }],
      start: agentStart,
      end: agentEnd,
    });
    t = agentEnd;
  }

  // 14 overlapping role transitions
  for (let i = 0; i < 14; i++) {
    const userStart = t;
    const userEnd = userStart + 1.5;
    // Agent starts 0.4s before user finishes → overlap
    const agentStart = userEnd - 0.4;
    const agentEnd = agentStart + 1.0;
    utterances.push({
      role: 'user',
      content: `overlap user ${i}`,
      words: [{ word: 'overlap', start: userStart, end: userStart + 0.2 }],
      start: userStart,
      end: userEnd,
    });
    utterances.push({
      role: 'agent',
      content: i % 3 === 0 ? 'Of' : `overlap agent ${i} words here`,
      words: [{ word: 'Of', start: agentStart, end: agentStart + 0.2 }],
      start: agentStart,
      end: agentEnd,
    });
    t = Math.max(userEnd, agentEnd) + 0.1;
  }

  // Extra agent fragments (stranded short utterances)
  for (let i = 0; i < 4; i++) {
    const a1 = t;
    const a2 = a1 + 0.4;
    utterances.push({
      role: 'agent',
      content: 'If you',
      words: [{ word: 'If', start: a1, end: a1 + 0.1 }],
      start: a1,
      end: a1 + 0.3,
    });
    utterances.push({
      role: 'agent',
      content: 'Glad you are interested in more',
      words: [{ word: 'Glad', start: a2, end: a2 + 0.1 }],
      start: a2,
      end: a2 + 1.0,
    });
    t = a2 + 1.2;
  }

  // Tool silence window ~15.5s (send_demo_alert) — agent silent until after tool
  const toolStart = t + 1;
  const beforeEnd = toolStart - 0.1;
  utterances.push({
    role: 'user',
    content: 'gpearl383 at gmail dot com',
    words: [{ word: 'gpearl', start: t, end: t + 0.5 }],
    start: t,
    end: beforeEnd,
  });
  // No agent speech during tool — next agent after 15.5s
  const afterStart = toolStart + 15.5;
  utterances.push({
    role: 'agent',
    content: 'Sent the sample to your email',
    words: [{ word: 'Sent', start: afterStart, end: afterStart + 0.2 }],
    start: afterStart,
    end: afterStart + 2.0,
  });

  const toolCalls = [
    {
      name: 'send_demo_alert',
      start: toolStart,
      end: toolStart + 15.5,
      arguments: { prospect_email: 'gpearl383@gmail.com', business_name: 'KK Cleaning' },
    },
  ];

  return { transcript_object: utterances, tool_calls: toolCalls };
}

const fixture = buildSep10Fixture();
const metrics = computeCallQuality(fixture);

console.log('call-quality metrics:', JSON.stringify(metrics, null, 2));

assert(metrics.overlap_events === 14, `expected 14 overlaps, got ${metrics.overlap_events}`);
assert(
  metrics.long_silence_gaps >= 18,
  `expected >=18 long gaps, got ${metrics.long_silence_gaps}`,
);
assert(
  metrics.tool_call_silence_s >= 15 && metrics.tool_call_silence_s <= 17,
  `expected ~15.5s tool silence, got ${metrics.tool_call_silence_s}`,
);
assert(metrics.failed === true, 'Sep-10 shaped call must fail quality gate');
assert(
  metrics.flags.some((f) => f.startsWith('tool_silence_')),
  'expected tool_silence flag',
);
assert(
  metrics.flags.some((f) => f.startsWith('overlaps_')),
  'expected overlaps flag',
);
assert(
  metrics.agent_fragment_count > QUALITY_THRESHOLDS.maxAgentFragments,
  `expected fragments > ${QUALITY_THRESHOLDS.maxAgentFragments}, got ${metrics.agent_fragment_count}`,
);
// Email was sent without spaced read-back before tool → should flag
assert(
  metrics.email_read_back_ok === false,
  `expected email_read_back_ok false, got ${metrics.email_read_back_ok}`,
);

// Clean call should pass
const clean = computeCallQuality({
  transcript_object: [
    {
      role: 'agent',
      content: 'Thanks for calling OwnerAI how can I help',
      start: 0,
      end: 2,
      words: [{ word: 'Thanks', start: 0, end: 0.3 }],
    },
    {
      role: 'user',
      content: 'I want a sample email',
      start: 2.3,
      end: 4,
      words: [{ word: 'I', start: 2.3, end: 2.4 }],
    },
    {
      role: 'agent',
      content: 'Sure that is G E O F F at owneraitools dot com — is that right?',
      start: 4.5,
      end: 7,
      words: [{ word: 'Sure', start: 4.5, end: 4.7 }],
    },
    {
      role: 'user',
      content: 'Yes',
      start: 7.2,
      end: 7.5,
      words: [{ word: 'Yes', start: 7.2, end: 7.4 }],
    },
    {
      role: 'agent',
      content: 'One sec sending your sample right now',
      start: 7.8,
      end: 9.5,
      words: [{ word: 'One', start: 7.8, end: 7.9 }],
    },
    {
      role: 'agent',
      content: 'Sent the owner email',
      start: 10,
      end: 11.5,
      words: [{ word: 'Sent', start: 10, end: 10.2 }],
    },
  ],
  tool_calls: [
    {
      name: 'send_demo_alert',
      start: 8.0,
      end: 10.0,
      arguments: { prospect_email: 'geoff@owneraitools.com', send_text: false },
    },
  ],
});
assert(clean.failed === false, `clean call should pass, flags=${clean.flags.join(',')}`);
assert(clean.email_read_back_ok === true, 'clean call should have email read-back ok');

console.log('test-call-quality: PASS');
