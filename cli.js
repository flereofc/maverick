#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.2.0';
const DEFAULT_BASE = 'https://api.navy';
const HISTORY_LIMIT = 40;

const PRESETS = {
  navy: 'https://api.navy',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
};

const CONFIG_DIR = path.join(os.homedir(), '.maverick');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const isTTY = process.stdout.isTTY === true;
const noColor = !!process.env.NO_COLOR || !isTTY;

function paint(code, s) {
  return noColor ? String(s) : `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const RESET = '\x1b[0m';
const INVERT = '\x1b[7m';

function visibleLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function loadConfig() {
  const defaults = { baseUrl: DEFAULT_BASE, model: 'gpt-5.2', key: '', system: '', temperature: 0.7 };
  try {
    return Object.assign(defaults, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return defaults;
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return true;
  } catch {
    return false;
  }
}

let cfg = loadConfig();
cfg.baseUrl = process.env.MAVERICK_BASE_URL || cfg.baseUrl || DEFAULT_BASE;
cfg.model = process.env.MAVERICK_MODEL || cfg.model || 'gpt-5.2';
if (process.env.MAVERICK_API_KEY) cfg.key = process.env.MAVERICK_API_KEY;

let temperature = typeof cfg.temperature === 'number' ? cfg.temperature : 0.7;
let systemPrompt = cfg.system || '';
let history = [];
let lastMatches = [];
let modelsCache = null;

function argsParse(argv) {
  const out = { help: false, plain: false, prompt: null, junk: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--plain' || a === '-P') out.plain = true;
    else if (a === '-p' || a === '--prompt') out.prompt = argv[++i] ?? '';
    else out.junk.push(a);
  }
  return out;
}

const args = argsParse(process.argv.slice(2));

function printHelp() {
  const L = (c, d) => console.log('  ' + green(c.padEnd(22)) + dim(d));
  console.log(bold(`maverick cli v${VERSION}`) + dim('  — bring your own key, any OpenAI-compatible provider'));
  console.log('');
  console.log(bold('usage'));
  console.log('  ' + green('maverick') + dim('                 fullscreen TUI chat'));
  console.log('  ' + green('maverick --plain') + dim('           classic prompt mode'));
  console.log('  ' + green('maverick -p "prompt"') + dim('      one-shot answer, then exit'));
  console.log('');
  console.log(bold('chat commands'));
  L('/key <apikey>', 'save your API key');
  L('/provider <name|url>', 'navy · openrouter · openai · groq · or full URL');
  L('/model <id>', 'switch model (exact id)');
  L('/find <query>', 'search models, then /model <number>');
  L('/system <text|off>', 'set the system prompt');
  L('/temp <0-2>', 'set temperature');
  L('/new', 'start a fresh conversation');
  L('/image <prompt>', 'generate an image (saves a file)');
  L('/save [file]', 'export this conversation as JSON');
  L('/config', 'show current settings');
  L('/exit', 'leave');
  console.log('');
  console.log(bold('keys'));
  console.log('  ' + dim('enter send · pgup/pgdn scroll · ctrl+c stop generation · ctrl+c twice quit'));
  console.log('');
  console.log(bold('files & env'));
  console.log('  ' + dim('config: ~/.maverick/config.json'));
  console.log('  ' + dim('env: MAVERICK_API_KEY · MAVERICK_BASE_URL · MAVERICK_MODEL · MAVERICK_TUI=0'));
}

function resolveUpstream(baseUrl, suffix, method, headers) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const mod = u.protocol === 'http:' ? http : https;
  let basePath = u.pathname.replace(/\/+$/, '');
  if (/\/v1$/i.test(basePath)) basePath = basePath.replace(/\/v1$/i, '');
  const options = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'http:' ? 80 : 443),
    path: basePath + suffix,
    method,
    headers,
  };
  return { mod, options };
}

function parseErrorBody(raw) {
  try {
    const j = JSON.parse(raw);
    if (j.error && j.error.message) return j.error.message;
  } catch { }
  return null;
}

async function fetchModels() {
  const upstream = resolveUpstream(cfg.baseUrl, '/v1/models', 'GET', {
    Accept: 'application/json',
    ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
  });
  if (!upstream) throw new Error('Invalid base URL: ' + cfg.baseUrl);
  return new Promise((resolve, reject) => {
    const req = upstream.mod.request(upstream.options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(parseErrorBody(data) || `HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(data).data || []);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getModels(force) {
  if (modelsCache && !force) return Promise.resolve(modelsCache);
  return fetchModels().then((list) => {
    modelsCache = list;
    return list;
  });
}

function streamChat(messages, handlers, opts) {
  const o = opts || {};
  const bodyObj = {
    model: cfg.model,
    messages,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (o.maxTokens) bodyObj.max_tokens = o.maxTokens;
  const body = JSON.stringify(bodyObj);
  const upstream = resolveUpstream(cfg.baseUrl, '/v1/chat/completions', 'POST', {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.key}`,
    Accept: 'text/event-stream',
  });
  if (!upstream) {
    handlers.error(new Error('Invalid base URL: ' + cfg.baseUrl));
    return () => { };
  }

  let stopped = false;
  const req = upstream.mod.request(upstream.options, (res) => {
    if (res.statusCode !== 200) {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        const msg = parseErrorBody(data) || `HTTP ${res.statusCode}`;
        let full = `${msg} [${hostLabel()}]`;
        if (/stealth|-exp|contributor|preview/i.test(cfg.model)) {
          full += dim('  ⚠ experimental model — switch with /find gpt');
        }
        handlers.error(new Error(full));
      });
      return;
    }
    let buf = '';
    let usage = null;
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta) {
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) handlers.reasoning(delta.reasoning_content);
          if (typeof delta.content === 'string' && delta.content) handlers.token(delta.content);
        }
        if (json.usage) usage = json.usage;
      }
    });
    res.on('end', () => handlers.done(usage, stopped));
  });
  req.on('error', (e) => {
    if (stopped) handlers.done(null, true);
    else handlers.error(e);
  });
  req.write(body);
  req.end();
  return () => {
    stopped = true;
    req.destroy();
  };
}

function imageMime(b64) {
  const head = b64.slice(0, 16);
  if (head.startsWith('/9j/')) return 'jpeg';
  if (head.startsWith('iVBOR')) return 'png';
  if (head.startsWith('R0lGOD')) return 'gif';
  if (head.startsWith('UklGR')) return 'webp';
  return 'png';
}

async function generateImage(prompt, modelOverride) {
  const imgModel = modelOverride || cfg.model;
  const body = JSON.stringify({ model: imgModel, prompt, n: 1, size: '1024x1024' });
  const upstream = resolveUpstream(cfg.baseUrl, '/v1/images/generations', 'POST', {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.key}`,
    Accept: 'application/json',
  });
  if (!upstream) throw new Error('Invalid base URL: ' + cfg.baseUrl);
  return new Promise((resolve, reject) => {
    const req = upstream.mod.request(upstream.options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(parseErrorBody(data) || `HTTP ${res.statusCode}`));
        try {
          const j = JSON.parse(data);
          const item = j.data && j.data[0];
          if (!item) return reject(new Error('No image returned.'));
          const ext = item.b64_json ? imageMime(item.b64_json) : 'png';
          const file = path.join(process.cwd(), `maverick-image-${Date.now()}.${ext}`);
          fs.writeFileSync(file, item.b64_json ? Buffer.from(item.b64_json, 'base64') : Buffer.from(item.url));
          resolve(file);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function wrapText(text, width) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('');
      continue;
    }
    const indentMatch = para.match(/^(\s*[•\-*] |\s*\d+\. )?(.*)$/);
    const bullet = indentMatch[1] || '';
    const words = indentMatch[2].split(/\s+/);
    let line = bullet;
    const pad = ' '.repeat(bullet.length);
    for (const word of words) {
      if (visibleLen(line) + visibleLen(word) + 1 > width && line.trim()) {
        out.push(line.replace(/\s+$/, ''));
        line = pad + word;
      } else {
        line += (line === bullet ? '' : ' ') + word;
      }
    }
    if (line.trim()) out.push(line);
  }
  return out.join('\n');
}

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, (_, x) => bold(x))
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1' + dim('$2'))
    .replace(/`([^`]+)`/g, (_, x) => green(x))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => (t === u ? dim(u) : `${t} ${dim('(' + u + ')')}`));
}

function renderMarkdown(md, width) {
  const parts = md.split(/```/);
  const out = [];
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      const nl = part.indexOf('\n');
      const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      out.push(dim('┌─ ' + (lang || 'code')));
      for (const line of code.replace(/\n$/, '').split('\n')) out.push('│ ' + line);
      out.push(dim('└──'));
      return;
    }
    let proseBlock = [];
    const flush = () => {
      if (proseBlock.length) {
        out.push(wrapText(proseBlock.join('\n'), width));
        proseBlock = [];
      }
    };
    for (const line of part.split('\n')) {
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flush();
        out.push(h[1].length <= 2 ? bold(h[2]) : h[2]);
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flush();
        out.push(dim('─'.repeat(Math.min(width, 36))));
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        out.push(dim('▏ ' + line.replace(/^\s*>\s?/, '')));
        continue;
      }
      proseBlock.push(line ? inlineMd(line) : line);
    }
    flush();
  });
  return out.join('\n');
}

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function hostLabel() {
  try {
    return new URL(cfg.baseUrl).hostname;
  } catch {
    return cfg.baseUrl;
  }
}

function maskKey(k) {
  if (!k) return dim('not set');
  return k.slice(0, 10) + '…' + k.slice(-4);
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function termWidth() {
  return Math.max(40, Math.min(process.stdout.columns || 100, 110));
}

function makeConsoleSpinner(label) {
  if (!isTTY) return { tick() { }, stop() { } };
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write('\r' + dim(SPIN_FRAMES[i++ % SPIN_FRAMES.length] + ' ' + label) + '\x1b[K');
  }, 90);
  return {
    stop() {
      clearInterval(timer);
      process.stdout.write('\r\x1b[K');
    },
  };
}

function isImageModel(m) {
  if (!m || typeof m.id !== 'string') return false;
  if (/veo/i.test(m.id)) return false;
  const arch = m.architecture;
  if (arch && Array.isArray(arch.output_modalities) && arch.output_modalities.includes('image')) return true;
  if (m.endpoint === '/v1/images/generations') return true;
  return false;
}

function looksLikeImagePrompt(text) {
  const t = text.toLowerCase();
  if (/(diagram|chart|graph|flowchart|blueprint|schematic|screenshot|ascii|architecture)/.test(t)) return false;
  if (/\b(image|images|picture|pictures|photo|photos|photorealistic|artwork|illustration|logo|logos|icon|icons|wallpaper|drawing|painting|portrait|poster|banner|thumbnail|mascot)\b/i.test(text) && /\b(draw|paint|sketch|generate|create|make|render|show|give|design)\b/i.test(text)) return true;
  if (/^\s*(draw|paint|sketch|illustrate)\b/i.test(text)) return true;
  if (/\b(draw|paint|generate|create|make)\s+(me\s+)?(a|an|the)?\s*(cute|realistic|3d|pixel|anime|photorealistic|cyberpunk|fantasy|medieval|futuristic|watercolor|oil)/i.test(text)) return true;
  return false;
}

async function pickImageModel() {
  const cands = (modelsCache || (await getModels().catch(() => []))).filter(isImageModel);
  if (!cands.length) return null;
  const prefer = cands.find((m) => /flux\.1-schnell/i.test(m.id)) || cands.find((m) => /flux/i.test(m.id)) || cands.find((m) => /gpt-image-1/i.test(m.id)) || cands[0];
  return prefer.id;
}

function pickDefault(models) {
  const isOpenRouter = /openrouter/i.test(cfg.baseUrl);
  const wanted = isOpenRouter
    ? ['deepseek/deepseek-chat', 'deepseek/deepseek-chat-v3-0324:free', 'openai/gpt-5.2']
    : ['gpt-5.2', 'openai/gpt-5.2', 'openai/gpt-4o'];
  for (const w of wanted) {
    const hit = models.find((m) => m.id === w);
    if (hit) return hit.id;
  }
  const groups = isOpenRouter
    ? [/^deepseek\//, /^openai\//, /^anthropic\//, /^google\//, /^meta-llama\//, /^mistralai\//, /^qwen\//]
    : [/^openai\//, /^anthropic\//, /^google\//, /^deepseek\//, /^meta-llama\//, /^mistralai\//, /^qwen\//];
  for (const g of groups) {
    const hit = models.find((m) => g.test(m.id) && !/stealth|-exp|contributor|preview/i.test(m.id));
    if (hit) return hit.id;
  }
  const clean = models.find((m) => !/stealth|-exp|contributor|preview/i.test(m.id));
  return clean ? clean.id : models[0].id;
}

let sessionTokens = 0;
let currentAbort = null;

function buildMessages(userText) {
  const msgs = [];
  if (systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt.trim() });
  for (const m of history) msgs.push({ role: m.role, content: m.content });
  msgs.push({ role: 'user', content: userText });
  return msgs;
}

function makePlainUi() {
  let spinner = null;
  return {
    kind: 'plain',
    init() { },
    refresh() { },
    destroy() { },
    spin(on, label) {
      if (on && !spinner) spinner = makeConsoleSpinner(label);
      if (!on && spinner) {
        spinner.stop();
        spinner = null;
      }
    },
    out(text) {
      this.spin(false);
      for (const l of String(text).split('\n')) console.log(l);
    },
    md(text) {
      this.spin(false);
      console.log(renderMarkdown(text, termWidth()));
    },
    async readLoop(onSubmit) {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: green('❯ '),
        terminal: isTTY,
      });
      rl.prompt();
      const queue = [];
      let processing = false;
      let closing = false;
      let ctrlCArmed = false;
      rl.on('SIGINT', () => {
        if (currentAbort) {
          currentAbort();
          return;
        }
        if (ctrlCArmed) {
          console.log(dim('\nbye 👋'));
          process.exit(0);
        }
        ctrlCArmed = true;
        console.log('');
        rl.write(null, { ctrl: true, name: 'u' });
        rl.prompt();
        console.log(dim('(ctrl+c again to quit)'));
        setTimeout(() => (ctrlCArmed = false), 2500);
      });
      async function drain() {
        if (processing) return;
        processing = true;
        while (queue.length) {
          await onSubmit(queue.shift());
          if (isTTY) rl.prompt();
        }
        processing = false;
        if (closing) {
          console.log(dim('bye 👋'));
          process.exit(0);
        }
      }
      rl.on('line', (line) => {
        queue.push(line);
        drain();
      });
      rl.on('close', () => {
        if (isTTY) {
          console.log(dim('\nbye 👋'));
          process.exit(0);
        }
        closing = true;
        if (!processing) {
          console.log(dim('bye 👋'));
          process.exit(0);
        }
      });
    },
  };
}

function makeTuiUi() {
  const stdout = process.stdout;
  const stdin = process.stdin;
  let lines = [];
  let wrappedCache = [];
  let wrapWidth = 0;
  let scrollFromBottom = 0;
  let input = '';
  let cursor = 0;
  let inputHistory = [];
  let histIdx = -1;
  let spinnerOn = false;
  let spinnerLabel = '';
  let spinFrame = 0;
  let dirty = true;
  let running = true;
  let pendingMd = null;
  let pendingStart = 0;
  let ctrlCArmedAt = 0;
  let notice = '';
  let noticeUntil = 0;
  let submit = async () => { };

  function width() {
    return stdout.columns || 100;
  }
  function height() {
    return stdout.rows || 30;
  }

  function pushLine(t) {
    for (const piece of String(t).split('\n')) lines.push(piece);
    dirty = true;
  }

  function ansiWrap(line, w) {
    const max = Math.max(10, w - 1);
    if (visibleLen(line) <= max) return [line];
    const rows = [];
    let cur = '';
    let curLen = 0;
    let curSgr = '';
    const re = /\x1b\[[0-9;]*m|[\s\S]/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const tok = m[0];
      if (/^\x1b\[/.test(tok)) {
        cur += tok;
        if (tok === RESET) curSgr = '';
        else curSgr = tok;
        continue;
      }
      if (curLen >= max) {
        rows.push(cur + RESET);
        cur = curSgr;
        curLen = 0;
      }
      cur += tok;
      curLen++;
    }
    if (cur.trim()) rows.push(cur);
    if (!rows.length) rows.push('');
    return rows;
  }

  function wrappedAll() {
    const w = width();
    if (w !== wrapWidth) {
      wrapWidth = w;
      wrappedCache = [];
    }
    while (wrappedCache.length < lines.length) {
      const idx = wrappedCache.length;
      wrappedCache[idx] = ansiWrap(lines[idx], w);
    }
    if (wrappedCache.length > lines.length) wrappedCache.length = lines.length;
    const flat = [];
    for (let i = 0; i < lines.length; i++) {
      for (const r of wrappedCache[i]) flat.push(r);
    }
    return flat;
  }

  function pendingReplace(rendered) {
    lines.length = pendingStart;
    wrappedCache.length = Math.min(wrappedCache.length, pendingStart);
    for (const l of rendered) lines.push(l);
    dirty = true;
  }

  let renderTimer = null;
  function ensureTimer() {
    if (renderTimer) return;
    renderTimer = setInterval(() => {
      if (!running) return;
      if (spinnerOn) {
        spinFrame++;
        dirty = true;
      }
      if (notice && Date.now() > noticeUntil) {
        notice = '';
        dirty = true;
      }
      if (dirty) {
        dirty = false;
        draw();
      }
    }, 40);
  }

  function draw() {
    const w = width();
    const h = height();
    const viewH = Math.max(3, h - 5);

    const all = wrappedAll().map((l) => (visibleLen(l) > w - 1 ? l : l));

    const spinChar = spinnerOn ? SPIN_FRAMES[spinFrame % SPIN_FRAMES.length] + ' ' + spinnerLabel : '';
    let bar =
      ' maverick ' +
      dim('▸ ' + hostLabel()) +
      ' ' +
      dim('▸') +
      ' ' +
      cfg.model +
      ' ' +
      dim('▸ temp ' + temperature.toFixed(1)) +
      ' ' +
      dim('▸ ' + fmtNum(sessionTokens) + ' tok');
    if (spinChar) bar += '   ' + spinChar;
    if (notice) bar += '   ' + yellow(notice);
    const barVisible = visibleLen(bar.replace(/\x1b\[[0-9;]*m/g, ''));
    const pad = Math.max(0, w - barVisible);
    let frame = '\x1b[H';
    frame += INVERT + (bar + ' '.repeat(pad)).slice(0, w) + RESET + '\n';

    let start = all.length - viewH - scrollFromBottom;
    if (start < 0) start = 0;
    let end = start + viewH;
    if (end > all.length) end = all.length;
    const bodyLines = all.slice(start, end);
    for (let i = 0; i < viewH; i++) {
      const l = bodyLines[i] ?? '';
      frame += '\x1b[K' + l + '\x1b[K\n';
    }

    const topBorder = dim('╭' + '─'.repeat(w - 2) + '╮');
    const botBorder = dim('╰' + '─'.repeat(w - 2) + '╯');
    const promptStr = green('❯ ') + input;
    const innerW = w - 4;
    const vis = promptStr.length <= innerW ? promptStr : promptStr.slice(promptStr.length - innerW);
    const padIn = Math.max(0, innerW - visibleLen(vis));
    frame += topBorder + '\n';
    frame += '│ ' + vis + ' '.repeat(padIn) + ' │\n';
    frame += botBorder + '\n';

    const foot = dim(' enter send · pgup/pgdn history · ctrl+c stop · twice quit · /help ');
    frame += '\x1b[K' + foot.slice(0, w);

    let col = 4 + Math.min(cursor, innerW - 2);
    frame += '\x1b[' + (h - 2) + ';' + col + 'H';
    stdout.write(frame);
  }

  function onKeyDown(s) {
    if (s.startsWith('\x1b[') || s.startsWith('\x1bO')) {
      const seq = s;
      if (/^\x1b\[[0-9]*A/.test(seq)) {
        if (histIdx < inputHistory.length - 1) {
          histIdx++;
          input = inputHistory[inputHistory.length - 1 - histIdx] || '';
          cursor = input.length;
        }
      } else if (/^\x1b\[[0-9]*B/.test(seq)) {
        if (histIdx > 0) {
          histIdx--;
          input = inputHistory[inputHistory.length - 1 - histIdx] || '';
          cursor = input.length;
        } else {
          histIdx = -1;
          input = '';
          cursor = 0;
        }
      } else if (/^\x1b\[[0-9]*C/.test(seq)) {
        cursor = Math.min(input.length, cursor + 1);
      } else if (/^\x1b\[[0-9]*D/.test(seq)) {
        cursor = Math.max(0, cursor - 1);
      } else if (/^\x1b\[[0-9]*H/.test(seq) || seq === '\x1bOH') {
        cursor = 0;
      } else if (/^\x1b\[[0-9]*F/.test(seq) || seq === '\x1bOF') {
        cursor = input.length;
      } else if (/^\x1b\[5~/.test(seq)) {
        scrollFromBottom += height() - 6;
        dirty = true;
        return;
      } else if (/^\x1b\[6~/.test(seq)) {
        scrollFromBottom = Math.max(0, scrollFromBottom - (height() - 6));
        dirty = true;
        return;
      }
      dirty = true;
      return;
    }
    if (s === '\x1b') {
      if (currentAbort) {
        currentAbort();
        return;
      }
      input = '';
      cursor = 0;
      dirty = true;
      return;
    }
    if (s === '\r' || s === '\n') {
      const text = input.trim();
      input = '';
      cursor = 0;
      if (text) {
        inputHistory.push(text);
        histIdx = -1;
        submit(text);
      } else {
        dirty = true;
      }
      return;
    }
    if (s === '\x7f' || s === '\x08') {
      if (cursor > 0) {
        input = input.slice(0, cursor - 1) + input.slice(cursor);
        cursor--;
      }
      dirty = true;
      return;
    }
    if (s === '\x03') {
      if (currentAbort) {
        currentAbort();
        return;
      }
      if (input) {
        input = '';
        cursor = 0;
        dirty = true;
        return;
      }
      if (Date.now() - ctrlCArmedAt < 2500) {
        shutdown();
        console.log(dim('bye 👋'));
        process.exit(0);
      }
      ctrlCArmedAt = Date.now();
      notice = 'ctrl+c again to quit';
      noticeUntil = Date.now() + 2500;
      dirty = true;
      return;
    }
    if (s === '\x15') {
      input = '';
      cursor = 0;
      dirty = true;
      return;
    }
    if (s === '\x04') {
      shutdown();
      console.log(dim('\nbye 👋'));
      process.exit(0);
    }
    if (s.charCodeAt(0) < 32) {
      dirty = true;
      return;
    }
    input = input.slice(0, cursor) + s + input.slice(cursor);
    cursor += s.length;
    dirty = true;
  }

  function shutdown() {
    if (!running) return;
    running = false;
    if (renderTimer) clearInterval(renderTimer);
    try {
      stdin.setRawMode(false);
    } catch { }
    stdin.pause();
    stdout.write('\x1b[?1049l\x1b[?25h\x1b[0m');
  }
  process.on('exit', () => {
    if (running) shutdown();
  });

  return {
    kind: 'tui',
    init() {
      stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
      try {
        stdin.setRawMode(true);
      } catch {
        throw new Error('raw mode unavailable');
      }
      stdin.resume();
      stdin.on('data', (chunk) => {
        let s = chunk.toString('utf8');
        while (s.length) {
          const esc = s.match(/^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/);
          if (esc) {
            onKeyDown(esc[0]);
            s = s.slice(esc[0].length);
          } else {
            onKeyDown(s[0]);
            s = s.slice(1);
          }
        }
      });
      stdout.on('resize', () => {
        wrapWidth = 0;
        dirty = true;
      });
      ensureTimer();
      dirty = true;
      draw();
    },
    refresh() {
      dirty = true;
    },
    destroy: shutdown,
    spin(on, label) {
      spinnerOn = on;
      spinnerLabel = label || '';
      dirty = true;
    },
    out(text) {
      this.spin(false);
      pendingMd = null;
      for (const l of String(text).split('\n')) pushLine(l);
    },
    md(text) {
      this.spin(false);
      pendingMd = null;
      for (const l of renderMarkdown(text, Math.min(termWidth(), 96)).split('\n')) pushLine(l);
    },
    beginStream() {
      pendingMd = '';
      pendingStart = lines.length;
      pushLine('');
      dirty = true;
    },
    streamToken(t) {
      pendingMd += t;
      pendingReplace(
        renderMarkdown(pendingMd, Math.min(termWidth(), 96)).split('\n')
      );
    },
    streamReasoning(t) {
      pendingMd += dim(t);
      pendingReplace(
        renderMarkdown(pendingMd, Math.min(termWidth(), 96)).split('\n')
      );
    },
    endStream() {
      if (pendingMd !== null) {
        pendingReplace(renderMarkdown(pendingMd, Math.min(termWidth(), 96)).split('\n'));
      }
      pendingMd = null;
      dirty = true;
    },
    async readLoop(onSubmit) {
      submit = onSubmit;
    },
  };
}

let submitHandler = async () => { };

async function runCommand(raw) {
  const space = raw.indexOf(' ');
  const cmd = (space >= 0 ? raw.slice(0, space) : raw).toLowerCase();
  const arg = space >= 0 ? raw.slice(space + 1).trim() : '';
  switch (cmd) {
    case '/help':
      printHelp();
      return;
    case '/exit':
    case '/quit':
      console.log(dim('bye 👋'));
      process.exit(0);
    case '/key':
      if (!arg) {
        ui.out(red('usage: /key <apikey>'));
        return;
      }
      cfg.key = arg.trim();
      saveConfig(cfg)
        ? ui.out(green('✓ key saved → ') + maskKey(cfg.key))
        : ui.out(red('could not write config file'));
      return;
    case '/provider': {
      if (!arg) {
        ui.out(dim('current: ') + cfg.baseUrl);
        ui.out(dim('presets: ') + Object.keys(PRESETS).join(', '));
        return;
      }
      const lower = arg.toLowerCase();
      const url = PRESETS[lower] || (/^https?:\/\//i.test(arg) ? arg : null);
      if (!url) {
        ui.out(red('Unknown provider. Use navy, openrouter, openai, groq or a full URL.'));
        return;
      }
      cfg.baseUrl = url;
      modelsCache = null;
      saveConfig(cfg);
      ui.refresh();
      ui.out(green('✓ provider → ') + url);
      try {
        ui.spin(true, 'loading models');
        const list = await getModels(true);
        ui.spin(false);
        ui.out(dim(`  ${list.length} models · current model: ${cfg.model}`));
        if (!list.some((m) => m.id === cfg.model)) {
          cfg.model = pickDefault(list);
          saveConfig(cfg);
          ui.out(dim(`  switched default model → ${cfg.model}`));
        }
        ui.refresh();
      } catch (e) {
        ui.spin(false);
        ui.out(red('  could not list models: ') + e.message);
      }
      return;
    }
    case '/model': {
      if (!arg) {
        ui.out(dim('current model: ') + cfg.model + dim('  (' + hostLabel() + ')'));
        ui.out(dim('search with /find <query>'));
        return;
      }
      const num = parseInt(arg, 10);
      let id = arg;
      if (String(num) === arg && lastMatches[num - 1]) {
        id = lastMatches[num - 1].id;
      } else {
        const list = await getModels().catch(() => []);
        if (!list.some((m) => m.id === arg)) {
          const hit = list.find((m) => m.id.toLowerCase().includes(arg.toLowerCase()));
          if (hit) id = hit.id;
          else {
            ui.out(red('No model matching "' + arg + '". Try /find ' + arg));
            return;
          }
        }
      }
      cfg.model = id;
      saveConfig(cfg);
      ui.refresh();
      ui.out(green('✓ model → ') + id);
      return;
    }
    case '/find':
    case '/models': {
      let list = [];
      try {
        ui.spin(true, 'loading models');
        list = await getModels();
        ui.spin(false);
      } catch (e) {
        ui.spin(false);
        ui.out(red('✗ ' + e.message));
        return;
      }
      const q = (cmd === '/find' ? arg : '').toLowerCase();
      const matches = list.filter((m) => m.id.toLowerCase().includes(q)).slice(0, 20);
      lastMatches = matches;
      if (!matches.length) {
        ui.out(dim('no matches for "' + query0(arg) + '"'));
        return;
      }
      ui.out(dim(matches.length + ' matches — switch with /model <number>:'));
      const rows = matches.map((m, i) => {
        const badges = [ctxBadge(m) && dim(ctxBadge(m) + ' ctx'), /:free$/.test(m.id) ? yellow('free') : '']
          .filter(Boolean)
          .join(' ');
        const marker = m.id === cfg.model ? green('●') : dim('○');
        return ` ${marker} ${bold(String(i + 1).padStart(2))}  ${m.id}${badges ? '  ' + badges : ''}`;
      });
      ui.out(rows.join('\n'));
      return;
    }
    case '/system':
      systemPrompt = arg === 'off' ? '' : arg;
      cfg.system = systemPrompt;
      saveConfig(cfg);
      ui.out(systemPrompt ? green('✓ system prompt set') : dim('system prompt off'));
      return;
    case '/temp': {
      const t = parseFloat(arg);
      if (isNaN(t) || t < 0 || t > 2) {
        ui.out(red('usage: /temp <0-2>'));
        return;
      }
      temperature = t;
      cfg.temperature = t;
      saveConfig(cfg);
      ui.refresh();
      ui.out(green('✓ temperature → ') + t);
      return;
    }
    case '/max': {
      if (!arg || arg === 'off') {
        delete cfg.maxTokens;
        saveConfig(cfg);
        ui.out(dim('max_tokens cap off (provider default)'));
        return;
      }
      const n = parseInt(arg, 10);
      if (isNaN(n) || n < 16) {
        ui.out(red('usage: /max <tokens> · or /max off'));
        return;
      }
      cfg.maxTokens = n;
      saveConfig(cfg);
      ui.refresh();
      ui.out(green('✓ max_tokens → ') + n);
      return;
    }
    case '/new':
      history = [];
      ui.out(dim('fresh conversation.'));
      return;
    case '/image': {
      if (!arg) {
        ui.out(red('usage: /image <description>'));
        return;
      }
      if (!cfg.key) {
        ui.out(red('No API key. Set one with /key <apikey>'));
        return;
      }
      ui.spin(true, 'generating image');
      try {
        const im = await pickImageModel();
        if (!im) {
          ui.spin(false);
          ui.out(red('No image-capable model on this provider.'));
          return;
        }
        const file = await generateImage(arg, im);
        ui.spin(false);
        ui.out(green('✓ saved ') + file);
      } catch (e) {
        ui.spin(false);
        ui.out(red('✗ ' + e.message));
      }
      return;
    }
    case '/save': {
      const target = arg || path.join(process.cwd(), `maverick-chat-${Date.now()}.json`);
      const payload = {
        exportedAt: new Date().toISOString(),
        provider: cfg.baseUrl,
        model: cfg.model,
        system: systemPrompt,
        messages: history,
      };
      try {
        fs.writeFileSync(target, JSON.stringify(payload, null, 2));
        ui.out(green('✓ saved ') + target);
      } catch (e) {
        ui.out(red('✗ ' + e.message));
      }
      return;
    }
    case '/config':
      ui.out(
        [
          ['provider', cfg.baseUrl],
          ['model', cfg.model],
          ['key', maskKey(cfg.key)],
          ['temperature', String(temperature)],
          ['max_tokens', cfg.maxTokens ? String(cfg.maxTokens) : dim('auto')],
          ['system', systemPrompt ? systemPrompt.slice(0, 60) + (systemPrompt.length > 60 ? '…' : '') : dim('off')],
          ['history', history.length + ' messages'],
          ['config file', CONFIG_FILE],
        ]
          .map(([k, v]) => '  ' + dim(k.padEnd(12)) + v)
          .join('\n')
      );
      return;
    default:
      ui.out(red(`unknown command "${cmd}"`) + dim(' — /help for the list'));
  }
}

function query0(s) {
  return s || '';
}

function ctxBadge(m) {
  const n = m.context_window || m.context_length;
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

async function chatTurn(text, ui) {
  return new Promise((resolve) => {
    let attempts = 0;

    const attempt = (capTokens) => {
      const messages = buildMessages(text);
      let answer = '';
      const opts = {};
      if (capTokens) opts.maxTokens = capTokens;
      else if (cfg.maxTokens) opts.maxTokens = cfg.maxTokens;

      currentAbort = streamChat(messages, {
        token(t) {
          answer += t;
          if (ui.streamToken) ui.streamToken(t);
          else process.stdout.write(t);
        },
        reasoning(t) {
          if (ui.streamReasoning) ui.streamReasoning(dim(t));
          else process.stdout.write(dim(t));
        },
        done(usage, wasStopped) {
          currentAbort = null;
          resolve({ answer, usage, stopped: wasStopped });
        },
        error(err) {
          currentAbort = null;
          const m = err.message || '';
          const afford = m.match(/can only afford (\d+)/i);
          if (!capTokens && afford && attempts < 2) {
            attempts++;
            const cap = Math.max(200, parseInt(afford[1], 10) - 64);
            ui.out(yellow('⚠ credit limit — capping this reply to ' + cap + ' tokens'));
            attempt(cap);
            return;
          }
          resolve({ answer: '', usage: null, error: m });
        },
      }, opts);
    };

    attempt(null);
  });
}

submitHandler = async function (raw) {
  const text = raw.trim();
  if (!text) return;
  if (text.startsWith('/')) {
    await runCommand(text);
    return;
  }
  if (!cfg.key) {
    ui.out(red('✗ no API key.') + dim(' run /key <apikey> first.'));
    return;
  }

  if (looksLikeImagePrompt(text)) {
    const im = await pickImageModel().catch(() => null);
    if (im) {
      ui.out(dim('🎨 image request — using ' + im));
      ui.spin(true, 'generating image');
      try {
        const file = await generateImage(text, im);
        ui.spin(false);
        ui.out(green('✓ saved ') + file);
      } catch (e) {
        ui.spin(false);
        ui.out(red('✗ ' + e.message));
      }
      return;
    }
  }

  history.push({ role: 'user', content: text });
  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);

  if (ui.beginStream) ui.beginStream();

  const result = await chatTurn(text, ui);

  if (ui.endStream) ui.endStream();

  if (result.usage && result.usage.total_tokens) sessionTokens += result.usage.total_tokens;

  if (result.answer) {
    history.push({ role: 'assistant', content: result.answer });
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
  }
  if (result.usage && result.usage.total_tokens) {
    const u = result.usage;
    ui.out(dim(`─ ${fmtNum(u.total_tokens)} tok` + (u.prompt_tokens ? ` (in ${fmtNum(u.prompt_tokens)} · out ${fmtNum(u.completion_tokens)})` : '')));
  }
  if (result.stopped) ui.out(dim('(stopped)'));
  if (result.error) ui.out(red('✗ ' + result.error));
  ui.refresh();
};

let ui = null;

(async function main() {
  if (args.help) return printHelp();
  if (args.junk.length) console.log(yellow('ignoring unknown arguments: ') + args.junk.join(' '));
  if (args.prompt !== null) {
    if (!cfg.key) {
      fail('No API key configured.', 'Run: node cli.js  → then /key sk-your-key  ·  or set MAVERICK_API_KEY');
      return;
    }
    history = [];
    const result = await chatTurn(args.prompt, {
      token: (t) => process.stdout.write(t),
      reasoning: (t) => process.stdout.write(dim(t)),
    });
    process.stdout.write('\n');
    if (result.usage && result.usage.total_tokens) {
      console.log(dim(`─ ${fmtNum(result.usage.total_tokens)} tok`));
    }
    return;
  }

  const wantTui = isTTY && !args.plain && process.env.MAVERICK_TUI !== '0';
  if (wantTui) {
    try {
      ui = makeTuiUi();
      ui.init();
    } catch {
      ui = makePlainUi();
      ui.init();
      console.log(yellow('TUI unavailable — plain mode.'));
    }
  } else {
    ui = makePlainUi();
    ui.init();
  }

  if (!cfg.key) {
    ui.out(yellow('⚠ no API key yet — run: ') + green('/key sk-your-key'));
    ui.out(dim('navy: api.navy/dashboard · openrouter: openrouter.ai/keys'));
  }
  ui.out(dim(`/help commands · ${wantTui ? 'pgup/pgdn scroll · ' : ''}/exit to leave`));

  await ui.readLoop(async (line) => {
    await submitHandler(line);
  });
})();

function fail(msg, hint) {
  console.error(red('✗ ' + msg));
  if (hint) console.error(dim('  ' + hint));
  process.exitCode = 1;
}
