// Daily digest cron target for OwnerAI agent health monitor.
//
//   GET|POST /api/monitor-digest
// Auth: Authorization: Bearer <CRON_SECRET> (Vercel Cron sets this when
// CRON_SECRET is configured in the project env).
//
// Separate from /api/monitor so the 5-minute probe cron cannot trigger digests.

import { runMonitor } from './monitor.mjs';

export async function GET(request) {
  return runMonitor(request, { mode: 'digest' });
}

export async function POST(request) {
  return runMonitor(request, { mode: 'digest' });
}
