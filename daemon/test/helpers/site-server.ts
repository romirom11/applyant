// Serves test/fixtures/sites over HTTP on 127.0.0.1, plus a few dynamic routes.
// `altOrigin` is the same server under "localhost", i.e. a different origin (cross-origin iframes).
// Pages can name either origin: {{ORIGIN}} · {{ALT_ORIGIN}}.
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITES = fileURLToPath(new URL('../fixtures/sites', import.meta.url));

export interface SiteServer {
  origin: string;
  altOrigin: string;
  /** Every request that could have written something (non-GET), in order. */
  writes: Array<{ method: string; path: string; body: string }>;
  url(path: string): string;
  close(): Promise<void>;
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location });
  res.end();
}

export async function startSiteServer(): Promise<SiteServer> {
  let port = 0;
  const writes: SiteServer['writes'] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Submissions, autosaves, uploads: fixture forms send them here, Read must never.
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        writes.push({ method: req.method ?? '', path, body: body.slice(0, 2000) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    if (path === '/redirect-home' || path === '/apply-home') return redirect(res, '/');
    if (path === '/jobs/42') return redirect(res, '/jobs?error=true');
    if (path === '/jobs') return send(res, 'job-list.html');
    if (path === '/flaky') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('try later');
    }
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!/^[a-z0-9-]+\.html$/.test(file) || !existsSync(join(SITES, file))) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Not found</title><h1>Page not found</h1>');
    }
    return send(res, file);
  });
  const send = (res: ServerResponse, file: string) => {
    const html = readFileSync(join(SITES, file), 'utf8')
      .replaceAll('{{ALT_ORIGIN}}', `http://localhost:${port}`)
      .replaceAll('{{ORIGIN}}', `http://127.0.0.1:${port}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    altOrigin: `http://localhost:${port}`,
    writes,
    url: (path) => `${origin}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
