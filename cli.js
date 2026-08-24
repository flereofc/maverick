#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const VERSION = '1.1.0';
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
  return noColor ? s : `\x1b[${code}m${s}\x1b[0m`;
}
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);

function visibleLen(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function loadConfig() {
  const defaults = {
    baseUrl: DEFAULT_BASE,
    model: 'gpt-5.2',
    key: '',
    system: '',
    temperature: 0.7,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return Object.assign(defaults, raw);
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
  const out = { help: false, prompt: null, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-p' || a === '--prompt') out.prompt = argv[++i] ?? '';
    else out.errors.push(a);
  }
  return out;
}

const args = argsParse(process.argv.slice(2));

function printHelp() {
  const L = (c, d) => console.log('  ' + green(c.padEnd(22)) + dim(d));
  console.log(bold(`maverick cli v${VERSION}`) + dim('  — bring your own key, any OpenAI-compatible provider'));
  console.log('');
  console.log(bold('usage'));
  console.log('  ' + green('maverick') + dim('                 interactive chat'));
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
  L('/exit', 'leave (ctrl+d works too)');
  console.log('');
  console.log(bold('keys'));
  console.log('  ' + dim('enter send · ctrl+c stop generation / quit · ctrl+d quit'));
  console.log('');
  console.log(bold('files & env'));
  console.log('  ' + dim('config: ~/.maverick/config.json'));
  console.log('  ' + dim('env: MAVERICK_API_KEY · MAVERICK_BASE_URL · MAVERICK_MODEL'));
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

function fail(msg, hint) {
  console.error(red('✗ ' + msg));
  if (hint) console.error(dim('  ' + hint));
  process.exitCode = 1;
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

function streamChat(messages, handlers) {
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  });
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
      res.on('end', () => handlers.error(new Error(parseErrorBody(data) || `HTTP ${res.statusCode}`)));
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

async function generateImage(prompt) {
  const body = JSON.stringify({ model: cfg.model, prompt, n: 1, size: '1024x1024' });
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

function wrap(text, width) {
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
      out.push(dim('┌─' + (lang || 'code') + ' ' + '─'.repeat(Math.max(4, width - lang.length - 6))));
      for (const line of code.replace(/\n$/, '').split('\n')) out.push('│ ' + line);
      out.push(dim('└' + '─'.repeat(width - 1)));
      return;
    }
    const lines = part.split('\n');
    let proseBlock = [];
    const flush = () => {
      if (proseBlock.length) {
        out.push(wrap(proseBlock.join('\n'), width));
        proseBlock = [];
      }
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flush();
        const level = h[1].length;
        const styled = level <= 2 ? bold(h[2]) : h[2];
        out.push((level <= 2 ? styled : bold(styled)) );
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flush();
        out.push(dim('─'.repeat(Math.min(width, 40))));
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        out.push(dim('▏ ') + dim(line.replace(/^\s*>\s?/, '')));
        continue;
      }
      proseBlock.push(line ? inlineMd(line) : line);
    }
    flush();
  });
  return out.join('\n');
}

const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function makeSpinner(label) {
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

function termWidth() {
  return Math.max(40, Math.min((process.stdout.columns || 100) - 2, 110));
}

function buildMessages(userText) {
  const msgs = [];
  if (systemPrompt.trim()) msgs.push({ role: 'system', content: systemPrompt.trim() });
  for (const m of history) msgs.push({ role: m.role, content: m.content });
  msgs.push({ role: 'user', content: userText });
  return msgs;
}

let currentAbort = null;

function chatTurn(text, onChunk) {
  return new Promise((resolve) => {
    const messages = buildMessages(text);
    const width = termWidth();
    const spinner = makeSpinner(dim('thinking'));
    let started = false;
    let reasoningHeaderPrinted = false;
    let answer = '';

    currentAbort = streamChat(messages, {
      token(t) {
        if (!started) {
          spinner.stop();
          started = true;
        }
        answer += t;
        onChunk(t);
      },
      reasoning(t) {
        if (!reasoningHeaderPrinted) {
          spinner.stop();
          started = true;
          reasoningHeaderPrinted = true;
          process.stdout.write(dim('· thinking\n'));
        }
        process.stdout.write(dim(t));
      },
      done(usage, wasStopped) {
        currentAbort = null;
        resolve({ answer, usage, stopped: wasStopped });
      },
      error(err) {
        currentAbort = null;
        spinner.stop();
        console.error(red('✗ ' + err.message));
        resolve({ answer: '', usage: null, error: true });
      },
    });
  });
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

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

async function cmdProvider(arg) {
  if (!arg) {
    console.log(dim('current: ') + cfg.baseUrl);
    console.log(dim('presets: ') + Object.keys(PRESETS).join(', '));
    return;
  }
  const lower = arg.toLowerCase();
  const url = PRESETS[lower] || ( /^https?:\/\//i.test(arg) ? arg : null);
  if (!url) return console.log(red('Unknown provider. Use navy, openrouter, openai, groq or a full URL.'));
  cfg.baseUrl = url;
  modelsCache = null;
  saveConfig(cfg);
  console.log(green('✓ provider → ') + url);
  try {
    const list = await getModels(true);
    console.log(dim(`  ${list.length} models available · current model: ${cfg.model}`));
    if (!list.some((m) => m.id === cfg.model)) {
      cfg.model = pickDefault(list);
      saveConfig(cfg);
      console.log(dim(`  switched default model → ${cfg.model}`));
    }
  } catch (e) {
    console.log(red('  could not list models: ') + e.message);
  }
}

function pickDefault(models) {
  for (const wanted of ['gpt-5.2', 'openai/gpt-5.2', 'openai/gpt-4o']) {
    const hit = models.find((m) => m.id === wanted);
    if (hit) return hit.id;
  }
  const groups = [/^openai\//, /^anthropic\//, /^google\//, /^deepseek\//, /^meta-llama\//, /^mistralai\//, /^qwen\//];
  for (const g of groups) {
    const hit = models.find((m) => g.test(m.id) && !/stealth|-exp|contributor|preview/i.test(m.id));
    if (hit) return hit.id;
  }
  const clean = models.find((m) => !/stealth|-exp|contributor|preview/i.test(m.id));
  return clean ? clean.id : models[0].id;
}

function ctxBadge(m) {
  const n = m.context_window || m.context_length;
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

async function cmdModel(arg) {
  if (!arg) {
    console.log(dim('current model: ') + cfg.model + dim('  (' + hostLabel() + ')'));
    console.log(dim('search with /find <query>'));
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
      else return console.log(red('No model matching "' + arg + '". Try /find ' + arg));
    }
  }
  cfg.model = id;
  saveConfig(cfg);
  console.log(green('✓ model → ') + id);
}

async function cmdFind(query) {
  const list = await getModels().catch((e) => {
    console.log(red('✗ ' + e.message));
    return [];
  });
  const q = (query || '').toLowerCase();
  const matches = list.filter((m) => m.id.toLowerCase().includes(q)).slice(0, 20);
  lastMatches = matches;
  if (!matches.length) return console.log(dim('no matches for "' + query + '"'));
  console.log(dim(matches.length + ' matches — switch with /model <number>:'));
  matches.forEach((m, i) => {
    const badges = [ctxBadge(m) && dim(ctxBadge(m) + ' ctx'), /:free$/.test(m.id) ? yellow('free') : '']
      .filter(Boolean)
      .join(' ');
    const marker = m.id === cfg.model ? green('●') : dim('○');
    console.log(` ${marker} ${bold(String(i + 1).padStart(2))}  ${m.id}${badges ? '  ' + badges : ''}`);
  });
}

async function cmdImage(prompt) {
  if (!prompt) return console.log(red('usage: /image <description>'));
  if (!cfg.key) return console.log(red('No API key. Set one with /key <apikey>'));
  const spinner = makeSpinner(dim('generating image'));
  try {
    const file = await generateImage(prompt);
    spinner.stop();
    console.log(green('✓ saved ') + file);
  } catch (e) {
    spinner.stop();
    console.log(red('✗ ' + e.message));
  }
}

function cmdSave(file) {
  const target = file || path.join(process.cwd(), `maverick-chat-${Date.now()}.json`);
  const payload = {
    exportedAt: new Date().toISOString(),
    provider: cfg.baseUrl,
    model: cfg.model,
    system: systemPrompt,
    messages: history,
  };
  try {
    fs.writeFileSync(target, JSON.stringify(payload, null, 2));
    console.log(green('✓ saved ') + target);
  } catch (e) {
    console.log(red('✗ ' + e.message));
  }
}

function showConfig() {
  const rows = [
    ['provider', cfg.baseUrl],
    ['model', cfg.model],
    ['key', maskKey(cfg.key)],
    ['temperature', String(temperature)],
    ['system', systemPrompt ? systemPrompt.slice(0, 60) + (systemPrompt.length > 60 ? '…' : '') : dim('off')],
    ['history', history.length + ' messages'],
    ['config file', CONFIG_FILE],
  ];
  for (const [k, v] of rows) console.log('  ' + dim(k.padEnd(12)) + v);
}

async function handleCommand(raw) {
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
      if (!arg) return console.log(red('usage: /key <apikey>'));
      cfg.key = arg.trim();
      saveConfig(cfg) ? console.log(green('✓ key saved → ') + maskKey(cfg.key)) : console.log(red('could not write config file'));
      return;
    case '/provider':
      return cmdProvider(arg);
    case '/model':
      return cmdModel(arg);
    case '/find':
      return cmdFind(arg);
    case '/models':
      return cmdFind('');
    case '/system':
      systemPrompt = arg === 'off' ? '' : arg;
      cfg.system = systemPrompt;
      saveConfig(cfg);
      console.log(systemPrompt ? green('✓ system prompt set') : dim('system prompt off'));
      return;
    case '/temp': {
      const t = parseFloat(arg);
      if (isNaN(t) || t < 0 || t > 2) return console.log(red('usage: /temp <0-2>'));
      temperature = t;
      cfg.temperature = t;
      saveConfig(cfg);
      console.log(green('✓ temperature → ') + t);
      return;
    }
    case '/new':
      history = [];
      console.log(dim('fresh conversation.'));
      return;
    case '/image':
      return cmdImage(arg);
    case '/save':
      return cmdSave(arg);
    case '/config':
      return showConfig();
    default:
      console.log(red(`unknown command "${cmd}"`) + dim(' — /help for the list'));
  }
}

function updatePrompt(rl) {
  rl.setPrompt(green('❯ ') + '');
}

async function repl() {
  if (!isTTY) console.log(dim('maverick ' + VERSION + ' (pipe mode)'));
  console.log(bold('maverick') + dim(` v${VERSION}`) + dim(` · ${hostLabel()} · ${cfg.model}`));
  if (!cfg.key) {
    console.log(yellow('⚠ no API key yet — run: ') + green('/key sk-your-key') + dim('  (navy: api.navy/dashboard · openrouter: openrouter.ai/keys)'));
  }
  console.log(dim('/help for commands · ctrl+c to stop or quit'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: green('❯ '),
    terminal: isTTY,
  });
  updatePrompt(rl);

  let ctrlCArmed = false;
  let closing = false;
  const queue = [];
  let processing = false;

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

  async function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      await handleCommand(text);
      return;
    }
    if (!cfg.key) {
      console.log(red('✗ no API key.') + dim(' run /key <apikey> first.'));
      return;
    }

    rl.pause();
    history.push({ role: 'user', content: text });
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);

    let column = 0;
    const result = await chatTurn(text, (t) => {
      for (const piece of t.split('\n')) {
        if (column + visibleLen(piece) > termWidth()) {
          process.stdout.write('\n');
          column = 0;
        }
        process.stdout.write(piece);
        column += visibleLen(piece);
      }
      if (t.endsWith('\n')) {
        process.stdout.write('\n');
        column = 0;
      }
    });

    process.stdout.write('\n\n');
    if (result.usage && result.usage.total_tokens) {
      const u = result.usage;
      console.log(
        dim(`─ ${fmtNum(u.total_tokens)} tok`) +
        dim(u.prompt_tokens ? ` (in ${fmtNum(u.prompt_tokens)} · out ${fmtNum(u.completion_tokens)})` : '')
      );
    }

    if (result.answer) {
      history.push({ role: 'assistant', content: result.answer });
      if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    }
    rl.resume();
  }

  async function drain() {
    if (processing) return;
    processing = true;
    while (queue.length) {
      await handleLine(queue.shift());
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

  rl.prompt();
}

async function oneShot(prompt) {
  if (!cfg.key) {
    fail('No API key configured.', 'Run: node cli.js  → then /key sk-your-key  ·  or set MAVERICK_API_KEY');
    return;
  }
  history = [];
  await chatTurn(prompt, (t) => process.stdout.write(t));
  process.stdout.write('\n');
}

(async function main() {
  if (args.help) return printHelp();
  if (args.errors.length) {
    console.log(yellow('ignoring unknown arguments: ') + args.errors.join(' '));
  }
  if (args.prompt !== null) return oneShot(args.prompt);
  return repl();
})();
