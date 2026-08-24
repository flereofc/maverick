# Maverick

A local AI chat client for the [Navy API](https://api.navy/dashboard) — an OpenAI-compatible API with **150+ models** (OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral, Meta and more).

Bring your own API key. It stays in your browser and is sent only to api.navy. No accounts, no telemetry, no server-side storage.

> © 2026 flere. All rights reserved — see [License & Copyright](#license--copyright) below.

## Features

- 💬 Streaming chat with Markdown + syntax-highlighted code blocks (copy button included)
- 🔀 Model picker: searchable, grouped by provider, shows context window / premium / reasoning badges — default model is `gpt-5.2`
- 🧠 Reasoning display for models that stream `reasoning_content`
- 🗂 Conversation history saved in your browser (localStorage), with auto-titles
- ⚙️ Settings: API key, system prompt, temperature, light/dark theme
- 🖥️ Built-in **CLI** — streaming terminal chat with slash commands, model search, image generation and one-shot mode
- 🧼 Zero runtime dependencies — works offline once served, no npm install needed

## Requirements

- [Node.js](https://nodejs.org) 16 or newer

## Run it

```bash
git clone https://github.com/flereofc/maverick
cd maverick
npm start
```

Then open **http://localhost:3000**.

(If you don't want npm, `node server.js` works the same.)

## Troubleshooting

`localhost` is always **your own machine** — every person runs their own server after cloning.

| Problem | Fix |
|---|---|
| `'node'` / `'npm' is not recognized` | Install Node.js (16+) from [nodejs.org](https://nodejs.org), then reopen the terminal |
| Browser shows `Not found` on localhost:3000 | The `public/` folder is missing from your clone — verify the repo contains all files, then `git pull` |
| `EADDRINUSE: port 3000 in use` | Another app is using port 3000 — run `$env:PORT=3001; npm start` (PowerShell) or `PORT=3001 npm start` (macOS/Linux) |
| `Cannot find module …` | You are not inside the repo folder — `cd` into the folder that contains `package.json` |
| Page loads but is unstyled / API errors | You opened `index.html` directly from the file system — always run it through `npm start` |

## CLI

Maverick also ships a zero-dependency terminal client with a **fullscreen TUI** — status bar, scrolling transcript, boxed input:

```bash
npm run cli
```

(or `node cli.js`; use `--plain` or `MAVERICK_TUI=0` for the classic prompt mode)

**One-shot mode** (great for scripting):

```bash
node cli.js -p "explain database indexes in one paragraph"
```

**First run:** `/key sk-your-key` → `/provider openrouter` → `/find claude` → `/model 3`

| Command | What it does |
|---|---|
| `/key <key>` | save your API key |
| `/provider <name\|url>` | navy · openrouter · openai · groq · or full URL |
| `/find <query>` | search models (then `/model <number>`) |
| `/model <id\|number>` | switch model |
| `/system <text>` / `/temp <0-2>` | system prompt / temperature |
| `/max <tokens>` / `/max off` | cap reply length (auto-caps on low credit anyway) |
| `/image <prompt>` | generate an image, saved to disk |
| `/new` / `/save [file]` / `/config` / `/exit` | housekeeping |

**TUI keys:** `enter` send · `pgup/pgdn` scroll transcript · `↑/↓` input history · `ctrl+c` stop generation (twice quits) · `esc` stop/clear

Streaming answers render as Markdown-lite; token usage prints after every reply and totals in the status bar. Config lives in `~/.maverick/config.json`; env overrides: `MAVERICK_API_KEY`, `MAVERICK_BASE_URL`, `MAVERICK_MODEL`.

## Get an API key

1. Go to https://api.navy/dashboard
2. Create an account and generate an API key
3. Open Maverick → **Settings** (gear icon) → paste your key

Keys can also be rotated any time — the app reads the current key on every request.

## How it works

- `server.js` (zero-dependency Node) serves `public/` and proxies three endpoints:
  - `POST /api/chat` → `https://api.navy/v1/chat/completions` (streaming, SSE)
  - `POST /api/image` → `https://api.navy/v1/images/generations`
  - `GET /api/models` → `https://api.navy/v1/models`
- Your key is passed as `x-api-key` to the local server and forwarded as `Authorization: Bearer …` to api.navy. It never touches any other host.

## Project layout

```
maverick/
├── server.js          # static server + API proxy
├── package.json
└── public/
    ├── index.html     # app shell
    ├── style.css      # light/dark theme
    ├── app.js         # chat logic
    └── vendor/        # marked + highlight.js (bundled locally)
```

## Notes

- The model list is fetched live from api.navy on startup; if that fails it falls back to a cached list, then a small built-in list.
- If a model you pick isn't listed, it still sends the request — the API will tell you if it's invalid.
- Keyboard: `Enter` send · `Shift+Enter` newline · `Ctrl/Cmd+K` model picker · `Ctrl+N` new chat · `Esc` close.

## License & Copyright

Copyright © 2026 flere. All rights reserved.

Permission is granted to use, fork, and modify this software for personal, non-commercial use, provided that **all** of the following are true:

- You give clear credit to the original author and link back to this repository.
- You do **not** claim the project, its design, or its source code as your own work.
- You do **not** remove or alter this copyright notice.
- You do **not** sell or commercially redistribute the code or substantial portions of it, rebranded or otherwise.

Any redistribution must prominently attribute the original author and link to the official repository. If you build on this project and share your version, state plainly that it is based on Maverick by flere.

Any use not covered above requires prior written permission from the author.
