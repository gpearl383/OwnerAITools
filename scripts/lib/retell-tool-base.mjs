// Rewrite Retell tool + webhook URLs onto a configurable API base.
// Default production base: https://owneraitools.com

export const DEFAULT_TOOL_BASE = 'https://owneraitools.com';

export function normalizeToolBase(raw) {
  const base = String(raw || DEFAULT_TOOL_BASE).trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(base)) {
    throw new Error(`RETELL_TOOL_BASE_URL must be https://… (got ${raw || '(empty)'})`);
  }
  return base;
}

export function isProductionToolBase(base) {
  try {
    return new URL(normalizeToolBase(base)).hostname === 'owneraitools.com';
  } catch {
    return false;
  }
}

/** Rewrite absolute or path-only URLs onto toolBase; leave unrelated hosts alone only if already absolute non-OwnerAI? — always rewrite path or owneraitools.com. */
export function rewriteApiUrl(url, toolBase) {
  const base = normalizeToolBase(toolBase);
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('/')) return `${base}${url}`;
  try {
    const u = new URL(url);
    if (u.hostname === 'owneraitools.com' || u.hostname.endsWith('.vercel.app')) {
      return `${base}${u.pathname}${u.search}`;
    }
    // Already absolute to some other host — leave as-is.
    return url;
  } catch {
    return url;
  }
}

/** Deep-clone retell config JSON and rewrite llm.general_tools[].url + agent.webhook_url. */
export function applyToolBaseToConfig(config, toolBase = DEFAULT_TOOL_BASE) {
  const out = JSON.parse(JSON.stringify(config || {}));
  const tools = out.llm?.general_tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (t && typeof t.url === 'string') t.url = rewriteApiUrl(t.url, toolBase);
    }
  }
  if (out.agent && typeof out.agent.webhook_url === 'string') {
    out.agent.webhook_url = rewriteApiUrl(out.agent.webhook_url, toolBase);
  }
  return out;
}
