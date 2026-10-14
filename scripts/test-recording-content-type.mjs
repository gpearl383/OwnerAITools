#!/usr/bin/env node
import { recordingContentType } from '../api/lib/recording-content-type.mjs';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

assert(recordingContentType(null) === 'audio/wav', 'null defaults to audio/wav');
assert(recordingContentType('') === 'audio/wav', 'empty defaults to audio/wav');
assert(recordingContentType('audio/wav') === 'audio/wav', 'plain wav');
assert(
  recordingContentType('audio/wav; codecs=1') === 'audio/wav',
  'strips codec parameter',
);
assert(recordingContentType(' audio/mpeg ; charset=binary') === 'audio/mpeg', 'trims and strips');
assert(recordingContentType(';') === 'audio/wav', 'bare semicolon defaults');

console.log('test-recording-content-type: PASS');
