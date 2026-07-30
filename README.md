# cobalt fork — single-file webapp + mini backend

A one-file frontend for the [cobalt](https://github.com/imputnet/cobalt) media downloader,
plus the smallest possible backend — zero dependencies, no npm install.

## quick start (one command)

    node server.js

Open http://localhost:8080 — the terminal prints the exact address for your phone (same wifi).

The built-in engine downloads **soundcloud, reddit, streamable and direct media links**
immediately — no docker, no bot checks, no rate limits.

## unlock every service (optional)

    docker compose up -d

server.js auto-detects the full cobalt engine on port 9000 and routes all services
(youtube, tiktok, instagram, twitter/x, …) to it. zero config changes.

## files

| file | purpose |
|---|---|
| `index.html` | the entire frontend (also runs standalone on github pages) |
| `server.js` | zero-dependency backend: serves the page, downloads media, proxies to full cobalt when present |
| `docker-compose.yml` | one-file definition of the official cobalt api |

## github pages

Settings → Pages → branch `main`, folder `root`.
Pages hosts the frontend only — downloads still need a backend reachable over https
(e.g. `cloudflared tunnel --url http://localhost:8080` gives you a free https url
that covers both page and backend).