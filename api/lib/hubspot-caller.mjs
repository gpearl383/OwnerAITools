/**
 * HubSpot phone → first-name greeting for the OwnerAI demo voice line.
 * Only firstname leaves this module for the spoken greeting.
 */
import { normalizePhone } from './leads.mjs';

export const DEMO_VOICE_E164 = '+15169731973';

const FIRST_NAME_RE = /^[A-Za-z][A-Za-z\s'-]{0,28}[A-Za-z]$|^[A-Za-z]$/;
const HUBSPOT_SEARCH_URL = 'https://api.hubapi.com/crm/v3/objects/contacts/search';
const DEFAULT_TIMEOUT_MS = 2000;

export function isUsableFirstName(v) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 30) return false;
  return FIRST_NAME_RE.test(s);
}

export function namedGreeting(firstName) {
  const name = String(firstName ?? '').trim();
  if (!isUsableFirstName(name)) return null;
  return `Hi ${name}, thanks for calling OwnerAI, what can I help you with today?`;
}

export function phonesMatch(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return Boolean(na && nb && na === nb);
}

function contactPhones(contact) {
  const props = contact?.properties || {};
  return [props.phone, props.mobilephone].filter(Boolean);
}

/**
 * Keep a spoken name only when exactly one contact matches the caller ID
 * and has a usable firstname.
 */
export function pickNamedCaller(fromNumber, contacts) {
  const want = normalizePhone(fromNumber);
  if (!want || !Array.isArray(contacts)) return null;

  const matches = contacts.filter((c) =>
    contactPhones(c).some((p) => phonesMatch(want, p))
  );
  if (matches.length !== 1) return null;

  const contact = matches[0];
  const firstName = String(contact?.properties?.firstname ?? '').trim();
  if (!isUsableFirstName(firstName)) return null;

  return {
    firstName,
    contactId: contact.id != null ? String(contact.id) : null,
  };
}

export function buildCallInboundResponse(firstName) {
  const greeting = namedGreeting(firstName);
  if (!greeting) return { call_inbound: {} };
  return {
    call_inbound: {
      dynamic_variables: { caller_first_name: String(firstName).trim() },
      agent_override: {
        retell_llm: {
          begin_message: greeting,
        },
      },
    },
  };
}

/**
 * Search HubSpot contacts by phone / mobilephone. Failures return [].
 * @param {string} fromNumber
 * @param {{ token?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 */
export async function searchContactsByPhone(fromNumber, opts = {}) {
  const token = opts.token ?? process.env.OWNERAI_DEMO_HUBSPOT_TOKEN;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const phone = normalizePhone(fromNumber);
  if (!token || !phone) return [];

  const digits = phone.replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;

  const body = {
    filterGroups: [
      {
        filters: [
          { propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: last10 },
        ],
      },
      {
        filters: [
          {
            propertyName: 'mobilephone',
            operator: 'CONTAINS_TOKEN',
            value: last10,
          },
        ],
      },
    ],
    properties: ['firstname', 'phone', 'mobilephone'],
    limit: 10,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(HUBSPOT_SEARCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.error('hubspot-caller: search failed', res.status);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch (err) {
    console.error('hubspot-caller: search error', err?.message || err);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a first name for a demo-line inbound call, or null.
 */
export async function resolveCallerFirstName(fromNumber, opts = {}) {
  const contacts = await searchContactsByPhone(fromNumber, opts);
  const picked = pickNamedCaller(fromNumber, contacts);
  return picked?.firstName ?? null;
}
