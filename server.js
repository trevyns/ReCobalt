/* cobalt webapp glue — serves index.html and proxies /api to a cobalt instance.
   run:  node server.js        (requires node 18+, nothing to install)
   env:  COBALT_URL (default http://localhost:9000), PORT (default 8080)     */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const COBALT = process.env.COBALT_URL || 'http://localhost:9000';
const PORT   = process.env.PORT || 8080;
const target = new URL(COBALT);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* the frontend */
  if (req.url === '/' || req.url === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    } catch {
      res.writeHead(500); res.end('index.html not found next to server.js');
    }
    return;
  }

  /* everything under /api → cobalt */
  if (req.url.startsWith('/api')) {
    const proxy = http.request({
      hostname: target.hostname,
      port: target.port,
      path: req.url.replace(/^\/api/, '') || '/',
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, up => {
      for (const h of Object.keys(up.headers))       // avoid duplicate CORS headers
        if (h.toLowerCase().startsWith('access-control-')) delete up.headers[h];
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    proxy.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: { code: 'error.local.backend.down' } }));
    });
    req.pipe(proxy);
    return;
  }

  res.writeHead(404); res.end('not found');
}).listen(PORT, '0.0.0.0', () => {
  console.log('cobalt webapp  →  http://localhost:' + PORT);
  console.log('proxying /api  →  ' + COBALT);
  console.log('on your phone:    http://YOUR-PC-LAN-IP:' + PORT);
});