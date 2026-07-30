#!/usr/bin/env node
import {
  applyToolBaseToConfig,
  isProductionToolBase,
  normalizeToolBase,
  rewriteApiUrl,
  DEFAULT_TOOL_BASE,
} from './lib/retell-tool-base.mjs';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

assert(normalizeToolBase('https://owneraitools.com/') === 'https://owneraitools.com', 'strip slash');
assert(isProductionToolBase(DEFAULT_TOOL_BASE), 'prod host');
assert(!isProductionToolBase('https://owneraitools-abc.vercel.app'), 'preview not prod');

assert(
  rewriteApiUrl('/api/demo-alert', 'https://preview.example.vercel.app') ===
    'https://preview.example.vercel.app/api/demo-alert',
  'path rewrite',
);
assert(
  rewriteApiUrl('https://owneraitools.com/api/retell-webhook', 'https://preview.example.vercel.app') ===
    'https://preview.example.vercel.app/api/retell-webhook',
  'prod absolute rewrite',
);

const cfg = applyToolBaseToConfig(
  {
    llm: {
      general_tools: [
        { name: 'send_demo_alert', url: 'https://owneraitools.com/api/demo-alert' },
        { name: 'other', url: 'https://hooks.example.com/x' },
      ],
    },
    agent: { webhook_url: 'https://owneraitools.com/api/retell-webhook' },
  },
  'https://my-preview.vercel.app',
);
assert(cfg.llm.general_tools[0].url === 'https://my-preview.vercel.app/api/demo-alert', 'tool 0');
assert(cfg.llm.general_tools[1].url === 'https://hooks.example.com/x', 'leave foreign host');
assert(cfg.agent.webhook_url === 'https://my-preview.vercel.app/api/retell-webhook', 'webhook');

console.log('test-retell-tool-base: PASS');
