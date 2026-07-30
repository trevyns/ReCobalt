/* cobalt mini-backend — zero dependencies, node 18+ only.
   run:  node server.js
   ─ serves index.html at /
   ─ built-in engine: soundcloud · reddit · streamable · direct media links
   ─ if full cobalt is running on :9000 (docker compose up -d), it is
     auto-detected and ALL services route to it automatically.          */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const PORT   = process.env.PORT || 8080;
const COBALT = process.env.COBALT_URL || 'http://localhost:9000';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* ---------------- tiny http helpers ---------------- */
function fetchRaw(url, { headers = {}, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'user-agent': UA, accept: '*/*', ...headers },
      timeout: 12000,
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchRaw(new URL(res.headers.location, url).toString(), { headers, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), finalUrl: url }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
async function fetchJSON(url, opts) {
  const r = await fetchRaw(url, opts);
  if (r.status >= 400) throw new Error('http ' + r.status);
  return JSON.parse(r.text);
}
const httpErr   = (status, code) => { const e = new Error(code); e.httpStatus = status; e.code = code; return e; };
const sanitize  = s => (s || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 180);
const sendJSON  = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const errJSON   = code => ({ status: 'error', error: { code } });

/* ---------------- soundcloud ---------------- */
let scClientId = null, scIdTime = 0;
async function soundcloudClientId() {
  if (scClientId && Date.now() - scIdTime < 3600_000) return scClientId;
  const home = await fetchRaw('https://soundcloud.com/');
  const scripts = [...home.text.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
  for (const src of scripts.slice(0, 8)) {
    try {
      const js = await fetchRaw(src);
      const m = js.text.match(/client_id\s*[:=]\s*"([A-Za-z0-9]{32})"/);
      if (m) { scClientId = m[1]; scIdTime = Date.now(); return scClientId; }
    } catch {}
  }
  if (scClientId) return scClientId;               // stale beats none
  throw new Error('soundcloud client_id not found');
}
async function soundcloud(url) {
  const id = await soundcloudClientId();
  const track = await fetchJSON(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${id}`);
  if (track.kind !== 'track') throw httpErr(400, 'error.api.content.video.unavailable');
  const t = track.media?.transcodings || [];
  const pick = t.find(x => x.format?.protocol === 'progressive' && x.format?.mime_prefix === 'audio/mpeg')
            || t.find(x => x.format?.protocol === 'progressive');
  if (!pick) throw httpErr(400, 'error.api.fetch.fail');
  const stream = await fetchJSON(`${pick.url}?client_id=${id}`);
  return {
    status: 'redirect',
    url: stream.url,
    filename: sanitize(`${track.user?.username || 'soundcloud'} - ${track.title}`) + '.mp3',
  };
}

/* ---------------- reddit ---------------- */
async function reddit(url) {
  const u = new URL(url);
  let p = u.pathname.replace(/\/+$/, '');
  if (!p.endsWith('.json')) p += '.json';
  const json = await fetchJSON(`https://www.reddit.com${p}?raw_json=1`);
  const post = (Array.isArray(json) ? json[0] : json)?.data?.children?.[0]?.data;
  if (!post) throw httpErr(400, 'error.api.link.invalid');

  const video = post.secure_media?.reddit_video?.fallback_url || post.media?.reddit_video?.fallback_url;
  if (video) return { status: 'redirect', url: video, filename: sanitize(post.title) + '.mp4' };

  if (post.is_gallery && post.media_metadata) {
    const ids = (post.gallery_data?.items || []).map(i => i.media_id);
    const picker = ids.map(mid => {
      const src = post.media_metadata[mid]?.s?.gif || post.media_metadata[mid]?.s?.u;
      return src ? { type: 'photo', url: decodeURIComponent(src) } : null;
    }).filter(Boolean);
    if (picker.length) return { status: 'picker', picker };
  }

  const img = post.url_overridden_by_dest;
  if (img && /\.(jpe?g|png|gif|webp)$/i.test(img))
    return { status: 'redirect', url: img, filename: sanitize(post.title) + img.slice(img.lastIndexOf('.')) };
  const preview = post.preview?.images?.[0]?.source?.url;
  if (preview) return { status: 'redirect', url: decodeURIComponent(preview), filename: sanitize(post.title) + '.jpg' };

  throw httpErr(400, 'error.api.fetch.fail');
}

/* ---------------- streamable & direct files ---------------- */
async function streamable(url) {
  const id = new URL(url).pathname.split('/').filter(Boolean)[0];
  const j = await fetchJSON(`https://api.streamable.com/videos/${id}`);
  const file = j.files?.mp4 || j.files?.['mp4-mobile'];
  if (!file?.url) throw httpErr(400, 'error.api.fetch.fail');
  const src = file.url.startsWith('//') ? 'https:' + file.url : file.url;
  return { status: 'redirect', url: src, filename: sanitize(j.title || id) + '.mp4' };
}
const MEDIA_EXT = /\.(mp4|webm|mov|mkv|mp3|m4a|wav|ogg|opus|gif|jpe?g|png|webp)$/i;
function direct(url) {
  const p = new URL(url).pathname;
  if (!MEDIA_EXT.test(p)) return null;
  return { status: 'redirect', url, filename: decodeURIComponent(p.split('/').pop()) };
}

/* ---------------- dispatcher ---------------- */
async function miniEngine(rawUrl) {
  const host = new URL(rawUrl).hostname.replace(/^(www|m|old|new|np)\./, '');

  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    const real = host === 'on.soundcloud.com' ? (await fetchRaw(rawUrl)).finalUrl : rawUrl;
    try { return await soundcloud(real); }
    catch (e) {                                     // stale client_id → re-scrape once
      if (/40[13]/.test(e.message)) { scClientId = null; return soundcloud(real); }
      throw e;
    }
  }
  if (host === 'reddit.com') return reddit(rawUrl);
  if (host === 'redd.it')    return reddit('https://www.reddit.com/comments/' + new URL(rawUrl).pathname.slice(1));
  if (host === 'streamable.com') return streamable(rawUrl);

  const d = direct(rawUrl);
  if (d) return d;
  throw httpErr(400, 'error.local.needs_full_cobalt');
}

/* ---------------- full-cobalt detection + proxy ---------------- */
let cobaltAlive = false;
function probeCobalt() {
  const cu = new URL(COBALT);
  const req = http.get({ hostname: cu.hostname, port: cu.port || 80, path: '/', timeout: 3000 }, res => {
    const was = cobaltAlive;
    cobaltAlive = res.statusCode === 200;
    res.resume();
    if (cobaltAlive && !was) console.log('  ✓ full cobalt detected at ' + COBALT + ' — every service unlocked');
    if (!cobaltAlive && was) console.log('  ✗ full cobalt went offline — back to the built-in engine');
  });
  req.on('error', () => { cobaltAlive = false; });
  req.on('timeout', () => req.destroy());
}
function proxyToCobalt(req, res) {
  const cu = new URL(COBALT);
  const proxy = http.request({
    hostname: cu.hostname, port: cu.port || 80,
    path: req.url.replace(/^\/api/, '') || '/',
    method: req.method,
    headers: { ...req.headers, host: cu.host },
  }, up => {
    for (const h of Object.keys(up.headers))
      if (h.toLowerCase().startsWith('access-control-')) delete up.headers[h];
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  proxy.on('error', () => sendJSON(res, 502, errJSON('error.local.backend.down')));
  req.pipe(proxy);
}

/* ---------------- server ---------------- */
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url === '/' || req.url === '/index.html') {
    try {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    } catch { res.writeHead(500); res.end('index.html not found next to server.js'); }
    return;
  }

  if (req.url.startsWith('/api')) {
    if (cobaltAlive) return proxyToCobalt(req, res);
    if (req.method === 'GET')
      return sendJSON(res, 200, { cobalt: { version: 'mini-1.0', name: 'built-in mini engine' } });
    if (req.method === 'POST') {
      let data = '';
      req.on('data', c => { data += c; if (data.length > 20000) req.destroy(); });
      req.on('end', async () => {
        let body; try { body = JSON.parse(data); } catch { return sendJSON(res, 400, errJSON('error.api.invalid_body')); }
        if (!body?.url) return sendJSON(res, 400, errJSON('error.api.link.invalid'));
        try {
          sendJSON(res, 200, await miniEngine(body.url.trim()));
        } catch (e) {
          sendJSON(res, e.httpStatus || 500, errJSON(e.code || 'error.api.fetch.fail'));
        }
      });
      return;
    }
  }

  res.writeHead(404); res.end('not found');
}).listen(PORT, '0.0.0.0', () => {
  const lan = (() => {
    for (const list of Object.values(os.networkInterfaces()))
      for (const i of list || [])
        if (i.family === 'IPv4' && !i.internal) return i.address;
    return 'localhost';
  })();
  console.log('  ┌ cobalt mini-backend');
  console.log('  │  webapp    → http://localhost:' + PORT);
  console.log('  │  phone     → http://' + lan + ':' + PORT + '   (same wifi)');
  console.log('  │  built-in  → soundcloud · reddit · streamable · direct files');
  console.log('  └  full cobalt on :9000 → auto-detected when you run: docker compose up -d');
});
probeCobalt();
setInterval(probeCobalt, 30000);