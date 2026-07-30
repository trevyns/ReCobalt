"""
Minimal cobalt-compatible backend.

It speaks the same tiny API the frontend already calls (GET / to check
the server is alive, POST / to process a link) so nothing in index.html
has to change - just paste this server's URL into the "cobalt server"
box in the app's settings.

How it works:
  1. POST / receives {url, downloadMode, videoQuality, ...}
  2. yt-dlp resolves that link to a direct, best-matching media URL
  3. we hand back our OWN /api/stream/<token> link instead of the raw
     origin URL (so we can attach a proper filename + force a real
     "Save File" download instead of the browser just playing it)
  4. the frontend opens that link, and /api/stream/<token> proxies the
     bytes straight through from the origin to the browser

Scope, on purpose (this is meant to be the *easiest* working version):
  - always grabs a single already-muxed file (no ffmpeg merge step),
    so quality is capped at whatever the site serves progressively
  - audioFormat / audioBitrate / filenameStyle / youtubeVideoCodec /
    tiktokFullAudio / tiktokH265 are accepted but not acted on - you
    get the source's native format, not a transcode
  - no Cloudflare Turnstile / auth layer - this is meant to be YOUR
    server, not a public instance for strangers
See the write-up alongside this file for how to extend any of that.
"""
import os
import re
import time
import uuid
import threading

from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix
import requests
import yt_dlp

app = Flask(__name__)
# trust the X-Forwarded-Proto header Render (or any reverse proxy) sets,
# so stream links we generate come back as https:// and not http://
# -- an http:// link embedded in your https:// GitHub Pages site would
# get silently blocked by the browser as mixed content.
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
CORS(app)  # allow your GitHub Pages origin (or anywhere) to call this API

# ---------------------------------------------------------------------
# tiny in-memory "what does this token point to" cache. good enough for
# personal use; resets if the process restarts, which is fine because
# tokens are only ever meant to be used seconds after they're minted.
# ---------------------------------------------------------------------
CACHE = {}
CACHE_LOCK = threading.Lock()
CACHE_TTL = 900  # seconds a stream link stays valid


def _prune_cache():
    now = time.time()
    with CACHE_LOCK:
        for token in [t for t, v in CACHE.items() if v['expires'] < now]:
            del CACHE[token]


def _safe_filename(name, ext):
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', name or 'download').strip()
    return f"{(name or 'download')[:150]}.{ext or 'bin'}"


def _register_stream(info):
    """Cache a resolved format's direct URL + headers, return a link to
    our own /api/stream/<token> for it (plus the filename we picked)."""
    url = info.get('url')
    if not url:
        formats = info.get('formats') or []
        if formats:
            url = formats[-1].get('url')
    if not url:
        return None, None

    token = uuid.uuid4().hex
    filename = _safe_filename(info.get('title'), info.get('ext'))
    with CACHE_LOCK:
        CACHE[token] = {
            'url': url,
            'headers': info.get('http_headers') or {},
            'filename': filename,
            'expires': time.time() + CACHE_TTL,
        }
    return request.host_url.rstrip('/') + '/api/stream/' + token, filename


def _format_for(mode, quality):
    if mode == 'audio':
        return 'bestaudio/best'
    if mode == 'mute':
        return 'bestvideo/best'
    if quality and quality != 'max':
        return f'best[height<={quality}]/best'
    return 'best'


# reuse-friendly: these codes already have friendly copy in the
# frontend's own ERROR_MAP, so mapping to them gets a nicer message
# on-screen for free.
_ERROR_HINTS = (
    # multi-word phrases only - single short words like "age" false-match
    # inside unrelated text (e.g. "download API page" contains "age")
    ('private video', 'error.api.content.video.private'),
    ('confirm your age', 'error.api.content.video.age'),
    ('age-restricted', 'error.api.content.video.age'),
    ('video unavailable', 'error.api.content.video.unavailable'),
    ('has been removed', 'error.api.content.video.unavailable'),
    ('unsupported url', 'error.api.service.unsupported'),
    ('no extractor', 'error.api.service.unsupported'),
)


def _map_error(exc):
    msg = str(exc).lower()
    for needle, code in _ERROR_HINTS:
        if needle in msg:
            return code
    return 'error.api.fetch.fail'


@app.route('/', methods=['GET'])
def server_info():
    # this is what the frontend's probe() checks for on boot
    return jsonify({'cobalt': {'version': '1.0.0-flask-lite'}})


@app.route('/', methods=['POST'])
def process():
    _prune_cache()
    body = request.get_json(silent=True) or {}
    url = (body.get('url') or '').strip()
    mode = body.get('downloadMode', 'auto')
    quality = body.get('videoQuality', 'max')

    if not url.startswith(('http://', 'https://')):
        return jsonify({'status': 'error', 'error': {'code': 'error.api.link.invalid'}})

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'noplaylist': True,
        'format': _format_for(mode, quality),
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            data = ydl.extract_info(url, download=False)
    except Exception as e:
        return jsonify({'status': 'error', 'error': {'code': _map_error(e)}})

    if not data:
        return jsonify({'status': 'error', 'error': {'code': 'error.api.fetch.fail'}})

    entries = [e for e in (data.get('entries') or []) if e]
    if len(entries) == 1:
        data, entries = entries[0], []

    # multiple items in one post (carousel, multi-photo tweet, etc.)
    if entries:
        picker = []
        for entry in entries[:50]:
            stream_url, _ = _register_stream(entry)
            if not stream_url:
                continue
            picker.append({
                'type': 'video' if entry.get('vcodec') not in (None, 'none') else 'photo',
                'url': stream_url,
                'thumb': entry.get('thumbnail'),
            })
        if not picker:
            return jsonify({'status': 'error', 'error': {'code': 'error.api.fetch.fail'}})
        return jsonify({'status': 'picker', 'picker': picker})

    stream_url, filename = _register_stream(data)
    if not stream_url:
        return jsonify({'status': 'error', 'error': {'code': 'error.api.fetch.fail'}})
    return jsonify({'status': 'tunnel', 'url': stream_url, 'filename': filename})


@app.route('/api/stream/<token>', methods=['GET'])
def stream(token):
    with CACHE_LOCK:
        entry = CACHE.get(token)
    if not entry or entry['expires'] < time.time():
        return jsonify({'error': 'this link expired - go back and download again'}), 404

    upstream = requests.get(entry['url'], headers=entry['headers'], stream=True, timeout=30)

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    resp = Response(stream_with_context(generate()),
                     content_type=upstream.headers.get('Content-Type', 'application/octet-stream'))
    resp.headers['Content-Disposition'] = f'attachment; filename="{entry["filename"]}"'
    if 'Content-Length' in upstream.headers:
        resp.headers['Content-Length'] = upstream.headers['Content-Length']
    return resp


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
