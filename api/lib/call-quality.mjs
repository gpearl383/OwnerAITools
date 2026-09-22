// Post-call quality metrics from Retell transcript_object word timestamps.
// Used by the retell-webhook call_analyzed path to catch mechanical demo
// failures that Retell's call_successful / user_sentiment miss
// (see docs/ops/2026-09-10-demo-call-postmortem.md Failure 7 / action #9).

export const QUALITY_THRESHOLDS = {
  maxBetweenTurnSilenceS: 3,
  longSilenceGapS: 1.5,
  maxToolCallSilenceS: 3,
  maxOverlapEvents: 5,
  maxAgentFragments: 2,
};

const TOOL_NAMES = new Set([
  'send_demo_alert',
  'check_availability',
  'book_setup_call',
  'live_transfer',
]);

/**
 * Normalize a Retell transcript_object (or compatible) into timed utterances.
 * @param {unknown} transcriptObject
 * @returns {Array<{ role: string, content: string, start: number, end: number, words: Array<{word:string,start:number,end:number}> }>}
 */
export function normalizeUtterances(transcriptObject) {
  if (!Array.isArray(transcriptObject)) return [];
  const out = [];
  for (const raw of transcriptObject) {
    if (!raw || typeof raw !== 'object') continue;
    const role = String(raw.role || raw.speaker || '').toLowerCase();
    if (role !== 'agent' && role !== 'user' && role !== 'caller') continue;
    const normalizedRole = role === 'caller' ? 'user' : role;
    const content = String(raw.content || raw.text || '').trim();
    const words = Array.isArray(raw.words)
      ? raw.words
          .map((w) => ({
            word: String(w.word || w.text || '').trim(),
            start: Number(w.start ?? w.start_s ?? w.startSec),
            end: Number(w.end ?? w.end_s ?? w.endSec),
          }))
          .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
      : [];
    let start = Number(raw.start ?? raw.start_s ?? raw.startSec);
    let end = Number(raw.end ?? raw.end_s ?? raw.endSec);
    if (!Number.isFinite(start) && words.length) start = words[0].start;
    if (!Number.isFinite(end) && words.length) end = words[words.length - 1].end;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push({
      role: normalizedRole,
      content,
      start,
      end,
      words,
    });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Count overlapping speaker segments (role transitions with overlap).
 */
export function countOverlaps(utterances) {
  let overlaps = 0;
  for (let i = 1; i < utterances.length; i++) {
    const prev = utterances[i - 1];
    const cur = utterances[i];
    if (prev.role === cur.role) continue;
    if (cur.start < prev.end - 0.05) overlaps += 1;
  }
  return overlaps;
}

/**
 * Between-turn silence: end of user utterance → start of next agent utterance.
 */
export function betweenTurnGaps(utterances) {
  const gaps = [];
  for (let i = 0; i < utterances.length - 1; i++) {
    const cur = utterances[i];
    const next = utterances[i + 1];
    if (cur.role !== 'user' || next.role !== 'agent') continue;
    const gap = next.start - cur.end;
    if (gap >= 0) gaps.push(gap);
  }
  return gaps;
}

/**
 * Agent fragments: short agent utterances (<3 words) followed by another
 * agent utterance within 2s (talk-over stranded fragments).
 */
export function countAgentFragments(utterances) {
  let count = 0;
  for (let i = 0; i < utterances.length - 1; i++) {
    const cur = utterances[i];
    const next = utterances[i + 1];
    if (cur.role !== 'agent' || next.role !== 'agent') continue;
    const words = cur.content.split(/\s+/).filter(Boolean);
    if (words.length > 0 && words.length < 3 && next.start - cur.end <= 2) {
      count += 1;
    }
  }
  return count;
}

/**
 * Silence during tool turns: from last agent speech before a tool invocation
 * until the next agent speech after the tool result. Tool invocations may
 * appear as transcript entries with tool_calls, or as metadata on call.tool_calls.
 *
 * @param {Array} utterances
 * @param {Array<{ name?: string, start_timestamp?: number, start?: number, end?: number, end_timestamp?: number, arguments?: object|string }>} toolCalls
 */
export function maxToolCallSilence(utterances, toolCalls = []) {
  let maxSilence = 0;
  for (const tc of toolCalls) {
    const name = String(tc.name || tc.tool_name || '');
    if (!TOOL_NAMES.has(name)) continue;
    const tStart = Number(tc.start_timestamp ?? tc.start ?? tc.invoked_at_s);
    const tEnd = Number(tc.end_timestamp ?? tc.end ?? tc.completed_at_s);
    if (!Number.isFinite(tStart)) continue;
    // Prefer explicit tool duration; else measure agent gap around the tool time.
    if (Number.isFinite(tEnd) && tEnd >= tStart) {
      // Agent should be speaking during execution — measure quiet stretch
      // between last agent end before tool and first agent start after tool start.
      const before = [...utterances]
        .filter((u) => u.role === 'agent' && u.end <= tStart + 0.5)
        .pop();
      const after = utterances.find(
        (u) => u.role === 'agent' && u.start >= tStart - 0.1,
      );
      if (before && after) {
        const silence = Math.max(0, after.start - before.end);
        // If agent spoke a filler overlapping the tool window, silence is small.
        if (after.start <= tStart + 1.0) {
          maxSilence = Math.max(maxSilence, 0);
        } else {
          maxSilence = Math.max(maxSilence, silence);
        }
      } else if (Number.isFinite(tEnd)) {
        maxSilence = Math.max(maxSilence, tEnd - tStart);
      }
      continue;
    }
    // Fallback: large gap between consecutive agent turns near tool time
    for (let i = 0; i < utterances.length - 1; i++) {
      const a = utterances[i];
      const b = utterances[i + 1];
      if (a.role !== 'agent' || b.role !== 'agent') continue;
      if (a.end <= tStart + 1 && b.start >= tStart - 0.5) {
        maxSilence = Math.max(maxSilence, b.start - a.end);
      }
    }
  }
  return maxSilence;
}

/**
 * Email read-back check: before any send_demo_alert with prospect_email,
 * the immediately preceding agent utterance should spell the local-part
 * with spaced letters (e.g. "G E O F F").
 */
export function emailReadBackOk(utterances, toolCalls = []) {
  let checked = false;
  let ok = true;
  for (const tc of toolCalls) {
    const name = String(tc.name || tc.tool_name || '');
    if (name !== 'send_demo_alert') continue;
    let args = tc.arguments ?? tc.args ?? tc.tool_arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    const email = String(args.prospect_email || '').trim();
    if (!email || !email.includes('@')) continue;
    checked = true;
    const local = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
    if (local.length < 2) continue;
    const tStart = Number(tc.start_timestamp ?? tc.start ?? Infinity);
    const priorAgents = utterances.filter(
      (u) => u.role === 'agent' && u.end <= tStart + 0.5,
    );
    const prior = priorAgents[priorAgents.length - 1];
    if (!prior) {
      ok = false;
      continue;
    }
    // Look for spaced letter pattern covering most of the local part
    const spaced = prior.content.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
    const letters = local.toUpperCase().split('');
    // Require at least half the local-part letters appear as isolated tokens
    let hits = 0;
    for (const L of letters) {
      if (new RegExp(`(?:^|\\s)${L}(?:\\s|$)`).test(spaced)) hits += 1;
    }
    if (hits < Math.ceil(letters.length * 0.5)) ok = false;
  }
  return { checked, ok: checked ? ok : true };
}

/**
 * Compute full quality report for a call.
 * @param {{
 *   transcript_object?: unknown,
 *   transcriptObject?: unknown,
 *   tool_calls?: Array,
 *   toolCalls?: Array,
 * }} call
 */
export function computeCallQuality(call = {}) {
  const utterances = normalizeUtterances(
    call.transcript_object || call.transcriptObject || [],
  );
  const toolCalls = call.tool_calls || call.toolCalls || [];
  const gaps = betweenTurnGaps(utterances);
  const maxBetweenTurnSilenceS = gaps.length ? Math.max(...gaps) : 0;
  const longSilenceGaps = gaps.filter(
    (g) => g > QUALITY_THRESHOLDS.longSilenceGapS,
  ).length;
  const overlapEvents = countOverlaps(utterances);
  const toolCallSilenceS = maxToolCallSilence(utterances, toolCalls);
  const agentFragmentCount = countAgentFragments(utterances);
  const readBack = emailReadBackOk(utterances, toolCalls);

  const flags = [];
  if (maxBetweenTurnSilenceS > QUALITY_THRESHOLDS.maxBetweenTurnSilenceS) {
    flags.push(`max_silence_${maxBetweenTurnSilenceS.toFixed(1)}s`);
  }
  if (toolCallSilenceS > QUALITY_THRESHOLDS.maxToolCallSilenceS) {
    flags.push(`tool_silence_${toolCallSilenceS.toFixed(1)}s`);
  }
  if (overlapEvents > QUALITY_THRESHOLDS.maxOverlapEvents) {
    flags.push(`overlaps_${overlapEvents}`);
  }
  if (readBack.checked && !readBack.ok) {
    flags.push('email_readback_failed');
  }
  if (agentFragmentCount > QUALITY_THRESHOLDS.maxAgentFragments) {
    flags.push(`fragments_${agentFragmentCount}`);
  }

  return {
    max_between_turn_silence_s: round2(maxBetweenTurnSilenceS),
    long_silence_gaps: longSilenceGaps,
    overlap_events: overlapEvents,
    tool_call_silence_s: round2(toolCallSilenceS),
    email_read_back_ok: readBack.checked ? readBack.ok : null,
    agent_fragment_count: agentFragmentCount,
    flags,
    failed: flags.length > 0,
    utterance_count: utterances.length,
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Whether quality metrics should alert the founder.
 */
export function qualityShouldAlert(metrics) {
  return !!(metrics && metrics.failed);
}
