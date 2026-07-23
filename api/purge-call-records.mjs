// Daily purge of call_records + Storage objects older than 120 days.
// User-facing /api/call links already expire at 30 days; this job removes the
// underlying transcript/recording to control storage cost and retention.
//
//   GET|POST /api/purge-call-records
// Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron sets this when
// CRON_SECRET is configured in the project env).
//
// Required env vars:
//   CRON_SECRET
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const RETENTION_DAYS = 120;
const BATCH = 50;

function unauthorized() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorized(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

async function purgeOnce() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const qs = new URLSearchParams({
    select: 'id,recording_path',
    created_at: `lt.${cutoff}`,
    order: 'created_at.asc',
    limit: String(BATCH),
  });

  const list = await fetch(`${url}/rest/v1/call_records?${qs}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!list.ok) throw new Error(`list ${list.status}: ${await list.text()}`);
  const rows = await list.json();
  if (!rows.length) return { deleted: 0, storageRemoved: 0 };

  let storageRemoved = 0;
  const paths = rows.map((r) => r.recording_path).filter(Boolean);
  if (paths.length) {
    // Supabase Storage batch delete: DELETE /object/{bucket} with a JSON array of paths.
    const rem = await fetch(`${url}/storage/v1/object/call-recordings`, {
      method: 'DELETE',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(paths),
    });
    if (rem.ok) {
      storageRemoved = paths.length;
    } else {
      console.error('storage batch delete failed:', rem.status, await rem.text());
      for (const path of paths) {
        const one = await fetch(
          `${url}/storage/v1/object/call-recordings/${encodeURIComponent(path)}`,
          { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` } }
        );
        if (one.ok || one.status === 404) storageRemoved += 1;
        else console.error('storage delete failed:', path, one.status, await one.text());
      }
    }
  }

  const ids = rows.map((r) => r.id);
  const del = await fetch(
    `${url}/rest/v1/call_records?id=in.(${ids.map(encodeURIComponent).join(',')})`,
    {
      method: 'DELETE',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
    }
  );
  if (!del.ok) throw new Error(`delete rows ${del.status}: ${await del.text()}`);

  return { deleted: rows.length, storageRemoved, cutoff };
}

async function handle(request) {
  if (!authorized(request)) return unauthorized();
  try {
    // Drain up to a few batches so a backlog clears without one huge timeout.
    let totalDeleted = 0;
    let totalStorage = 0;
    let cutoff = null;
    for (let i = 0; i < 10; i++) {
      const r = await purgeOnce();
      cutoff = r.cutoff || cutoff;
      totalDeleted += r.deleted;
      totalStorage += r.storageRemoved;
      if (r.deleted < BATCH) break;
    }
    return new Response(
      JSON.stringify({ ok: true, deleted: totalDeleted, storageRemoved: totalStorage, cutoff }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('purge-call-records failed:', err.message);
    return new Response(JSON.stringify({ error: 'Purge failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export const GET = handle;
export const POST = handle;
