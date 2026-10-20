/**
 * Keys used to verify X-Retell-Signature.
 * Prefer the dedicated webhook signing key when set; fall back to the API key
 * only when RETELL_WEBHOOK_KEY is unset (local / first-time setup).
 */
export function retellVerifyKeys({
  webhookKey = process.env.RETELL_WEBHOOK_KEY,
  apiKey = process.env.RETELL_API_KEY,
} = {}) {
  if (webhookKey) return [webhookKey];
  if (apiKey) return [apiKey];
  return [];
}

/**
 * Trial workspace verification — never accept the website RETELL_API_KEY.
 * Prefer TRIAL_RETELL_WEBHOOK_KEY when set; else TRIAL_RETELL_API_KEY.
 */
export function trialRetellVerifyKeys({
  webhookKey = process.env.TRIAL_RETELL_WEBHOOK_KEY,
  apiKey = process.env.TRIAL_RETELL_API_KEY,
} = {}) {
  if (webhookKey) return [webhookKey];
  if (apiKey) return [apiKey];
  return [];
}
