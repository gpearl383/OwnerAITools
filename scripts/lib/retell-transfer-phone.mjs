// Resolve and validate the demo-line live-transfer destination at Retell push time.
// The LLM never chooses a number — config stores env:OWNERAI_TRANSFER_PHONE only.

export const TRANSFER_PHONE_PLACEHOLDER = 'env:OWNERAI_TRANSFER_PHONE';

export const DEMO_LINE = '+15169731973';
export const TESTING_LINE = '+15169613838';
export const GOOGLE_VOICE_LINE = '+15163662711';
export const PERSONAL_CELL = '+15165079380';

export const FORBIDDEN_TRANSFER_NUMBERS = new Set([
  DEMO_LINE,
  TESTING_LINE,
  GOOGLE_VOICE_LINE,
  PERSONAL_CELL,
]);

const EMERGENCY_DIGITS = new Set(['911', '112', '999', '000']);

export function normalizeE164(raw) {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  return null;
}

export function isEmergencyNumber(raw) {
  const compact = String(raw ?? '').replace(/[^\d+]/g, '');
  const digitsOnly = compact.replace(/^\+/, '').replace(/^1(?=\d{3}$)/, '');
  if (EMERGENCY_DIGITS.has(digitsOnly)) return true;
  if (EMERGENCY_DIGITS.has(compact.replace(/^\+/, ''))) return true;
  return false;
}

export function resolveTransferPhone(raw, env = process.env) {
  let value = raw;
  if (value === TRANSFER_PHONE_PLACEHOLDER) {
    value = env?.OWNERAI_TRANSFER_PHONE;
    if (!value) {
      throw new Error(
        'OWNERAI_TRANSFER_PHONE is not set. Add OWNERAI_TRANSFER_PHONE=+1… to OwnerAITools/.env.local',
      );
    }
  }
  if (isEmergencyNumber(value)) {
    throw new Error(`emergency number is not allowed as a live-transfer destination: ${value}`);
  }
  const e164 = normalizeE164(value);
  if (!e164) {
    throw new Error(`OWNERAI_TRANSFER_PHONE must be E.164 (got ${value || '(empty)'})`);
  }
  if (isEmergencyNumber(e164)) {
    throw new Error(`emergency number is not allowed as a live-transfer destination: ${e164}`);
  }
  if (FORBIDDEN_TRANSFER_NUMBERS.has(e164)) {
    throw new Error(`forbidden live-transfer destination: ${e164}`);
  }
  return e164;
}

export function applyTransferPhoneToConfig(config, env = process.env) {
  const out = JSON.parse(JSON.stringify(config || {}));
  const tools = out.llm?.general_tools;
  if (!Array.isArray(tools)) return out;
  for (const t of tools) {
    const dest = t?.transfer_destination;
    if (dest && dest.number === TRANSFER_PHONE_PLACEHOLDER) {
      dest.number = resolveTransferPhone(TRANSFER_PHONE_PLACEHOLDER, env);
    }
  }
  return out;
}

/** On pull, never write the live destination into git. */
export function redactTransferPhone(config) {
  const out = JSON.parse(JSON.stringify(config || {}));
  const tools = out.llm?.general_tools;
  if (!Array.isArray(tools)) return out;
  for (const t of tools) {
    const dest = t?.transfer_destination;
    if (dest && dest.type === 'predefined' && dest.number) {
      dest.number = TRANSFER_PHONE_PLACEHOLDER;
    }
  }
  return out;
}
