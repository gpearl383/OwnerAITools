// Demo trial slot helpers for the Sales Console.
import { normalizePhone, normalizeEmail } from './leads.mjs';

export const VOICE_IDS = {
  female: '11labs-Grace',
  male: '11labs-Brian',
};

/**
 * Live Sales Trial Slot 1 agents live in Retell workspace `ownerai-demo`
 * (TRIAL_RETELL_API_KEY). Website demo uses RETELL_API_KEY — never mix.
 * Voice-only until SMS/A2P is registered on +15164755855.
 */
export const TRIAL_AGENT_DEFAULTS = {
  voiceAgentId: 'agent_47dc64ae3a12423f391d3e78b8',
  voiceLlmId: 'llm_8993dfcb658f37c0cb86b3ed8cc7',
  smsAgentId: null,
  smsLlmId: null,
};

/** Website demo / testing lines — never use as trial E.164. */
export const WEBSITE_DEMO_E164S = new Set(['+15169731973', '+15169613838']);

export function trialRetellApiKey() {
  return process.env.TRIAL_RETELL_API_KEY || null;
}

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return {
    url,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  };
}

export async function getSlotByKey(slotKey = 1) {
  const client = sb();
  if (!client) throw new Error('Supabase env vars missing');
  const qs = new URLSearchParams({
    select: '*',
    slot_key: `eq.${Number(slotKey) || 1}`,
    limit: '1',
  });
  const res = await fetch(`${client.url}/rest/v1/demo_slots?${qs}`, {
    headers: client.headers,
  });
  if (!res.ok) throw new Error(`demo_slots ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

export async function getActiveSlotByE164(e164) {
  const phone = normalizePhone(e164);
  if (!phone) return null;
  const client = sb();
  if (!client) return null;
  const qs = new URLSearchParams({
    select: '*',
    e164: `eq.${phone}`,
    status: 'eq.active',
    limit: '1',
  });
  const res = await fetch(`${client.url}/rest/v1/demo_slots?${qs}`, {
    headers: client.headers,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const slot = rows[0] || null;
  if (!slot) return null;
  return refreshExpired(slot);
}

export async function getSlotById(id) {
  const client = sb();
  if (!client || !id) return null;
  const qs = new URLSearchParams({
    select: '*',
    id: `eq.${id}`,
    limit: '1',
  });
  const res = await fetch(`${client.url}/rest/v1/demo_slots?${qs}`, {
    headers: client.headers,
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

/** Mark expired when past trial_ends_at; returns updated row. */
export async function refreshExpired(slot) {
  if (!slot || slot.status !== 'active' || !slot.trial_ends_at) return slot;
  if (new Date(slot.trial_ends_at).getTime() > Date.now()) return slot;
  return updateSlot(slot.id, { status: 'expired', updated_at: new Date().toISOString() });
}

export async function updateSlot(id, patch) {
  const client = sb();
  if (!client) throw new Error('Supabase env vars missing');
  const res = await fetch(`${client.url}/rest/v1/demo_slots?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...client.headers, Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`demo_slots update ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

export function publicSlot(slot) {
  if (!slot) return null;
  const ends = slot.trial_ends_at ? new Date(slot.trial_ends_at).getTime() : null;
  const daysLeft =
    slot.status === 'active' && ends
      ? Math.max(0, Math.ceil((ends - Date.now()) / (24 * 60 * 60 * 1000)))
      : null;
  return {
    id: slot.id,
    slotKey: slot.slot_key,
    e164: slot.e164 || null,
    status: slot.status,
    companyName: slot.company_name || '',
    greeting: slot.greeting || '',
    voice: slot.voice || 'female',
    language: slot.language || 'en',
    website: slot.website || '',
    ownerName: slot.owner_name || '',
    ownerPhone: slot.owner_phone || '',
    ownerEmail: slot.owner_email || '',
    trialDays: slot.trial_days || 14,
    trialStartedAt: slot.trial_started_at || null,
    trialEndsAt: slot.trial_ends_at || null,
    daysLeft,
    hasAgents: !!slot.retell_voice_agent_id,
  };
}

export function normalizeSlotInput(body = {}) {
  const companyName = String(body.companyName || body.company_name || '')
    .trim()
    .slice(0, 200);
  const greeting = String(body.greeting || '')
    .trim()
    .slice(0, 500);
  const voice = body.voice === 'male' ? 'male' : 'female';
  const language = String(body.language || 'en')
    .trim()
    .slice(0, 16) || 'en';
  const website = String(body.website || '')
    .trim()
    .slice(0, 500);
  const ownerName = String(body.ownerName || body.owner_name || '')
    .trim()
    .slice(0, 200);
  const ownerPhone = normalizePhone(body.ownerPhone || body.owner_phone);
  const ownerEmail = normalizeEmail(body.ownerEmail || body.owner_email);
  const trialDays = Math.min(90, Math.max(1, Number(body.trialDays || body.trial_days) || 14));
  const e164Raw = body.e164 || body.trialNumber || body.trial_number;
  const e164 = e164Raw ? normalizePhone(e164Raw) : null;

  return {
    companyName,
    greeting,
    voice,
    language,
    website: website || null,
    ownerName: ownerName || null,
    ownerPhone,
    ownerEmail,
    trialDays,
    e164,
  };
}

export function buildDynamicVariables(slot) {
  const company = slot.company_name || 'the business';
  const owner = slot.owner_name || 'the owner';
  const greeting =
    slot.greeting ||
    `Thanks for calling ${company}. This is the AI receptionist — how can I help?`;
  const disclosure =
    'This is a basic OwnerAI trial setup for a limited time. I can take messages and help callers reach the owner.';
  return {
    company_name: company,
    owner_name: owner,
    greeting,
    language: slot.language || 'en',
    website: slot.website || '',
    trial_disclosure: disclosure,
    trial_active: slot.status === 'active' ? 'true' : 'false',
  };
}

export function idleDynamicVariables() {
  return {
    company_name: 'OwnerAI Trial',
    owner_name: '',
    greeting:
      'This OwnerAI trial line is not assigned right now. Please call the sales team, or try again later.',
    language: 'en',
    website: '',
    trial_disclosure: '',
    trial_active: 'false',
  };
}

async function retellApi(method, path, body) {
  const key = trialRetellApiKey();
  if (!key) throw new Error('TRIAL_RETELL_API_KEY missing (ownerai-demo workspace)');
  const res = await fetch(`https://api.retellai.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Retell ${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/** Patch LLM default_dynamic_variables + begin_message; optionally agent voice. */
export async function paintRetellPersona(slot, { idle = false } = {}) {
  const llmId =
    slot.retell_voice_llm_id || process.env.TRIAL_VOICE_LLM_ID || TRIAL_AGENT_DEFAULTS.voiceLlmId;
  const voiceAgentId =
    slot.retell_voice_agent_id ||
    process.env.TRIAL_VOICE_AGENT_ID ||
    TRIAL_AGENT_DEFAULTS.voiceAgentId;
  const smsLlmId = process.env.TRIAL_SMS_LLM_ID || TRIAL_AGENT_DEFAULTS.smsLlmId || null;

  const vars = idle ? idleDynamicVariables() : buildDynamicVariables(slot);
  const begin = idle
    ? vars.greeting
    : slot.greeting ||
      `Thanks for calling ${slot.company_name || 'us'}. This is the AI receptionist — this call may be recorded. How can I help?`;

  if (llmId) {
    await retellApi('PATCH', `/update-retell-llm/${llmId}`, {
      default_dynamic_variables: vars,
      begin_message: begin,
    });
  }

  // SMS paint only when an SMS LLM is configured (voice-only until A2P).
  if (smsLlmId) {
    await retellApi('PATCH', `/update-retell-llm/${smsLlmId}`, {
      default_dynamic_variables: vars,
    });
  }

  if (voiceAgentId && !idle) {
    const voiceId = VOICE_IDS[slot.voice === 'male' ? 'male' : 'female'];
    await retellApi('PATCH', `/update-agent/${voiceAgentId}`, {
      voice_id: voiceId,
    });
  }

  return { vars, begin };
}

export function daysRemaining(slot) {
  if (!slot?.trial_ends_at || slot.status !== 'active') return null;
  return Math.max(0, Math.ceil((new Date(slot.trial_ends_at).getTime() - Date.now()) / 86400000));
}
