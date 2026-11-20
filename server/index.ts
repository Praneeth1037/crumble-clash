/**
 * Crumble Clash server: serves the game (through Vite while developing, from dist/ in production) and runs private
 * online rooms over a WebSocket at /ws. Rooms live in memory, so run a single instance.
 *
 *   npm run dev     development, with hot reload, on http://localhost:5190
 *   npm start       production, after `npm run build`
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { PHYSICS } from '../shared/config';
import { RoomHub, type HubOptions } from './rooms';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export async function startServer({ port = Number(process.env.PORT) || 5190, host = process.env.HOST || '0.0.0.0', production = process.env.NODE_ENV === 'production', hub: hubOptions = {} as HubOptions } = {}) {
  const hub = new RoomHub(hubOptions);
  let vite: import('vite').ViteDevServer | undefined;
  const dist = resolve(root, 'dist');

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify({ ok: true, rooms: hub.rooms.size })); }
    if (vite) return vite.middlewares(req, res, () => { res.writeHead(404); res.end('Not found'); });
    // Production: static files from dist/, with the app shell for any other path.
    let path = resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (!path.startsWith(dist + sep) && path !== dist) { res.writeHead(403); return res.end(); }
    try {
      if (url.pathname === '/' || !extname(path)) path = resolve(dist, 'index.html');
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(body);
    } catch { res.writeHead(404); res.end('Not found'); }
  });

  if (!production) {
    const { createServer: createVite } = await import('vite');
    vite = await createVite({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  }

  // Game sockets live at /ws. Other upgrade requests (Vite's hot reload while developing) are left alone.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url || '/', 'http://localhost').pathname !== '/ws') return;
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', socket => {
    const client = hub.connect(message => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); });
    socket.on('message', data => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(data)); } catch { return client.send({ type: 'error', code: 'bad-request', message: 'That message was not understood.' }); }
      hub.handle(client, parsed);
    });
    socket.on('close', () => hub.disconnect(client));
    socket.on('error', () => socket.close());
  });

  // Fixed-step game loop: catch up in whole steps so the simulation runs at the same rate whatever the timer jitter.
  let last = performance.now(), carry = 0;
  const loop = setInterval(() => {
    const now = performance.now(); carry = Math.min(carry + (now - last) / 1000, 0.25); last = now;
    while (carry >= PHYSICS.fixedStep) { hub.tick(PHYSICS.fixedStep); carry -= PHYSICS.fixedStep; }
  }, 1000 / 120);

  await new Promise<void>(done => server.listen(port, host, done));
  const close = async () => { clearInterval(loop); for (const c of wss.clients) c.terminate(); wss.close(); await vite?.close(); await new Promise(r => server.close(r)); };
  return { server, hub, close, port: (server.address() as { port: number }).port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fast = process.env.CRUMBLE_FAST === '1';
  const { port } = await startServer({ hub: {
    reconnectSeconds: Number(process.env.CRUMBLE_RECONNECT) || undefined,
    match: fast ? { countdown: 1, roundOverSeconds: 0.8 } : {},
  } });
  const lan = Object.values(networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => `http://${n!.address}:${port}`);
  console.log(`Crumble Clash running on http://localhost:${port}`);
  for (const url of lan) console.log(`  on your network: ${url}`);
}
