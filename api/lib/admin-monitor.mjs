// Administrative monitoring emails — OwnerAI ops copy of every lead/call summary.
// Always targets OWNERAI_ADMIN_EMAIL (default info@owneraitools.com).
// Skips when the admin address is the same as the client notify address (no duplicate).

const DEFAULT_ADMIN = 'info@owneraitools.com';

export function adminMonitorEmail() {
  return (process.env.OWNERAI_ADMIN_EMAIL || DEFAULT_ADMIN).trim().toLowerCase();
}

export function clientNotifyEmail() {
  return (process.env.OWNERAI_NOTIFY_EMAIL || DEFAULT_ADMIN).trim().toLowerCase();
}

export function clientLabel() {
  return (
    process.env.OWNERAI_CLIENT_NAME ||
    process.env.OWNERAI_CLIENT_SLUG ||
    'client'
  ).trim();
}

/**
 * Send the admin monitoring copy of a client-facing summary email.
 * Best-effort — never throws.
 *
 * @param {{ subject: string, html: string }} opts
 */
export async function sendAdminMonitorEmail({ subject, html }) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const to = adminMonitorEmail();
    const clientTo = clientNotifyEmail();
    if (!apiKey) {
      console.warn('admin monitor email skipped — RESEND_API_KEY missing');
      return { skipped: true, reason: 'no_resend' };
    }
    if (to === clientTo) {
      return { skipped: true, reason: 'same_as_client' };
    }

    const from = process.env.OWNERAI_RESEND_FROM || 'OwnerAI <info@owneraitools.com>';
    const label = clientLabel();
    const adminSubject = `[Admin Monitor · ${label}] ${subject}`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: adminSubject,
        html: `<p style="font:12px/1.4 system-ui,sans-serif;color:#666;margin:0 0 12px">
          Administrative monitoring copy for <strong>${escapeHtml(label)}</strong>.
          Client notify: ${escapeHtml(clientTo)}.
        </p>${html}`,
      }),
    });

    if (!res.ok) {
      console.error('admin monitor email failed:', res.status, await res.text());
      return { ok: false };
    }
    return { ok: true, ...(await res.json()) };
  } catch (err) {
    console.error('admin monitor email error:', err.message);
    return { ok: false, error: err.message };
  }
}

function escapeHtml(v) {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
