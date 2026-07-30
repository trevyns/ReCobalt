# cobalt fork — shareable media downloader

one-file frontend + zero-dependency backend for [cobalt](https://github.com/imputnet/cobalt).

## the github pages rule (read this first)

GitHub Pages serves **static files only** — it cannot run node.js or docker. So:

- **frontend** → github pages ✅ (free, shareable)
- **backend** → anywhere that runs node over https ✅ — *not* pages ❌

## share with friends — the `?api=` link

1. host the backend somewhere with https:
   - **one-click:** push this repo → [render.com](https://render.com) → *new → blueprint* → pick the repo → it reads `render.yaml` and deploys `server.js` (free tier; sleeps when idle, first open takes ~30s)
   - **from your pc:** `cloudflared tunnel --url http://localhost:8080` → free https url (pc stays on)
   - **any vps:** `docker compose up -d && npm start` behind caddy/nginx
2. share one link:

       https://YOUR-USERNAME.github.io/cobalt-fork/?api=https://YOUR-BACKEND-URL

   friends open it and it works — no setup, no server hunting.

## run locally (just you)

    node server.js

http://localhost:8080 — phone on same wifi: the terminal prints the address.
built-in engine: **soundcloud, reddit, streamable, direct files** — no bot checks.
add `docker compose up -d` to unlock every service (auto-detected, zero config).

## files

| file | purpose |
|---|---|
| `index.html` | entire frontend; supports `?api=` share links |
| `server.js` | zero-dependency backend: serves page, downloads media, proxies full cobalt when present |
| `package.json` / `render.yaml` | one-click https deploy |
| `docker-compose.yml` | optional full cobalt engine |