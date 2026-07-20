// Local preview server for owneraitools.com development.
//
// Serves the static site with Vercel-style clean URLs (/privacy → privacy.html)
// and mounts the real /api/chat handler so the chatbot works locally.
//
// Usage:
//   node scripts/dev-server.mjs
//   → http://localhost:8090
//
// For live chat replies, ANTHROPIC_API_KEY must be in the environment, e.g.:
//   set -a && source ~/.claude/.env && set +a && node scripts/dev-server.mjs
// Without it the site still renders; the chat widget shows its fallback message.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.PORT || 8090;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.xml': 'text/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(pathname, res) {
  // Clean-URL resolution, mirroring vercel.json ("cleanUrls": true):
  // try the path as-is, then with .html, then /index.html.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const candidates =
    safe === '/'
      ? ['index.html']
      : [safe.slice(1), safe.slice(1) + '.html', join(safe.slice(1), 'index.html')];

  for (const rel of candidates) {
    try {
      const data = await readFile(join(ROOT, rel));
      res.writeHead(200, {
        'Content-Type': MIME[extname(rel)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
      return true;
    } catch {
      /* try next candidate */
    }
  }
  return false;
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const { POST } = await import('../api/chat.mjs');
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = new Request(`http://localhost:${PORT}/api/chat`, {
        method: 'POST',
        headers: req.headers,
        body,
      });
      const response = await POST(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (err) {
      console.error('api/chat error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  if (await serveStatic(url.pathname, res)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}).listen(PORT, () => {
  console.log(`OwnerAI Tools dev server → http://localhost:${PORT}`);
  console.log(
    process.env.ANTHROPIC_API_KEY
      ? 'Chat API: live (ANTHROPIC_API_KEY found)'
      : 'Chat API: fallback only (no ANTHROPIC_API_KEY in env)'
  );
});
