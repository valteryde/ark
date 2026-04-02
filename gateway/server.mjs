/**
 * Serves ../dist (Vite build) and proxies /api/* and /ws/* to BACKEND_URL.
 * For Docker Compose, set BACKEND_URL=http://your-api:3000 (service name + internal port).
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import httpProxy from 'http-proxy';
import sirv from 'sirv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');

const BACKEND = process.env.BACKEND_URL ?? 'http://127.0.0.1:3000';
const PORT = Number(process.env.PORT ?? 8080);

const staticHandler = sirv(distDir, { dev: false, single: true, etag: true });
const proxy = httpProxy.createProxyServer({
  target: BACKEND,
  changeOrigin: true,
  ws: true,
});

proxy.on('error', (_err, _req, res) => {
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway');
  }
});

function shouldProxy(url) {
  return url.startsWith('/api') || url.startsWith('/ws');
}

const server = createServer((req, res) => {
  const url = req.url?.split('?')[0] ?? '/';
  if (shouldProxy(url)) {
    proxy.web(req, res, {}, () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad gateway');
      }
    });
    return;
  }
  staticHandler(req, res, () => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url?.split('?')[0] ?? '';
  if (url.startsWith('/ws')) {
    proxy.ws(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Ark gateway listening on http://0.0.0.0:${PORT} (proxy → ${BACKEND})`);
});
