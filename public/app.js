'use strict';

const DEFAULT_MODEL = 'gpt-5.2';
const NAVY_DASHBOARD = 'https://api.navy/dashboard';
const MAX_ATTACHMENTS = 4;

const LS = {
  key: 'maverick.apiKey',
  base: 'maverick.baseUrl',
  model: 'maverick.model',
  system: 'maverick.system',
  temp: 'maverick.temp',
  theme: 'maverick.theme',
  chats: 'maverick.chats.v1',
  active: 'maverick.active',
  modelsCache: 'maverick.modelsCache',
};

const $ = (id) => document.getElementById(id);

const PROVIDER_OF = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', xai: 'xAI',
  deepseek: 'DeepSeek', meta: 'Meta', mistral: 'Mistral', cohere: 'Cohere',
  'z-ai': 'Z.AI', moonshotai: 'Moonshot AI', alibaba: 'Alibaba', nvidia: 'NVIDIA',
  xiaomi: 'Xiaomi', minimax: 'MiniMax', perplexity: 'Perplexity',
  nousresearch: 'Nous Research', venice: 'Venice', navyai: 'Navy', pruna: 'Pruna',
};

const GROUP_ORDER = ['OpenAI', 'Anthropic', 'Google', 'xAI', 'DeepSeek', 'Mistral', 'Meta', 'Cohere', 'Z.AI', 'Moonshot AI', 'Alibaba', 'NVIDIA', 'Xiaomi', 'MiniMax', 'Perplexity', 'Nous Research', 'Venice', 'Navy', 'Other'];

function providerOf(m) {
  const key = String(m.owned_by || '').toLowerCase();
  if (PROVIDER_OF[key]) return PROVIDER_OF[key];
  const id = String(m.id || '').toLowerCase();
  if (id.startsWith('gpt') || id.startsWith('o3') || id.startsWith('o4')) return 'OpenAI';
  if (id.startsWith('claude')) return 'Anthropic';
  if (id.startsWith('gemini') || id.startsWith('gemma') || id.startsWith('nano-banana')) return 'Google';
  if (id.startsWith('grok')) return 'xAI';
  if (id.startsWith('deepseek')) return 'DeepSeek';
  if (id.startsWith('llama')) return 'Meta';
  if (id.startsWith('mistral') || id.startsWith('codestral')) return 'Mistral';
  if (id.startsWith('command') || id.startsWith('c4ai')) return 'Cohere';
  if (id.startsWith('glm')) return 'Z.AI';
  if (id.startsWith('kimi')) return 'Moonshot AI';
  if (id.startsWith('qwen')) return 'Alibaba';
  if (id.startsWith('nemotron')) return 'NVIDIA';
  if (id.startsWith('mimo')) return 'Xiaomi';
  if (id.startsWith('minimax')) return 'MiniMax';
  if (id.startsWith('sonar')) return 'Perplexity';
  if (id.startsWith('hermes')) return 'Nous Research';
  if (id.startsWith('venice')) return 'Venice';
  if (id.includes('uncensored') || id.includes('schizogpt') || id.includes('revenant') || id.includes('emotional') || id.includes('laborratse')) return 'Navy';
  return 'Other';
}

function isChatModel(m) {
  if (!m || typeof m.id !== 'string') return false;
  if (isImageModel(m)) return false;
  if (m.supports_streaming === false) return false;
  if (m.endpoint && m.endpoint !== '/v1/chat/completions') return false;
  if (/(embedding|transcrib|tts|whisper|flux|veo|moderation|search-api|scrib|eleven)/i.test(m.id)) return false;
  return true;
}

function isImageModel(m) {
  if (!m || typeof m.id !== 'string') return false;
  if (/veo/i.test(m.id)) return false;
  const arch = m.architecture;
  if (arch && Array.isArray(arch.output_modalities) && arch.output_modalities.includes('image')) return true;
  if (m.endpoint === '/v1/images/generations') return true;
  return false;
}

function humanizeCtx(n) {
  if (!n || n <= 0) return '';
  if (n >= 1e6) {
    const v = (n / 1e6).toFixed(2).replace(/\.?0+$/, '');
    return v + 'M ctx';
  }
  if (n >= 1000) return Math.round(n / 1000) + 'K ctx';
  return String(n) + ' ctx';
}

const state = {
  apiKey: localStorage.getItem(LS.key) || '',
  baseUrl: localStorage.getItem(LS.base) || 'https://api.navy',
  model: localStorage.getItem(LS.model) || DEFAULT_MODEL,
  system: localStorage.getItem(LS.system) || '',
  temp: parseFloat(localStorage.getItem(LS.temp)) || 0.7,
  theme: localStorage.getItem(LS.theme) || 'dark',
  chats: [],
  activeId: localStorage.getItem(LS.active) || null,
  models: [],
  streaming: false,
  abort: null,
  pendingImages: [],
  convQuery: '',
};

try { state.chats = JSON.parse(localStorage.getItem(LS.chats) || '[]') || []; } catch { state.chats = []; }

function save() {
  try {
    localStorage.setItem(LS.chats, JSON.stringify(state.chats));
    localStorage.setItem(LS.active, state.activeId || '');
  } catch { }
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(LS.theme, theme);
}

const FALLBACK_MODELS = [
  { id: 'gpt-5.2', owned_by: 'openai', context_window: 128000 },
  { id: 'gpt-5', owned_by: 'openai', context_window: 128000 },
  { id: 'gpt-4o', owned_by: 'openai', context_window: 128000 },
  { id: 'claude-opus-4.5', owned_by: 'anthropic', context_window: 200000 },
  { id: 'claude-sonnet-4.5', owned_by: 'anthropic', context_window: 200000 },
  { id: 'gemini-2.5-pro', owned_by: 'google', context_window: 1000000 },
  { id: 'deepseek-chat', owned_by: 'deepseek', context_window: 128000 },
  { id: 'grok-4', owned_by: 'xai', context_window: 256000 },
  { id: 'llama-3.3-70b-instruct', owned_by: 'meta', context_window: 128000 },
  { id: 'mistral-large-latest', owned_by: 'mistral', context_window: 128000 },
  { id: 'kimi-k3', owned_by: 'moonshotai', context_window: 128000 },
  { id: 'glm-5.2', owned_by: 'z-ai', context_window: 128000 },
  { id: 'qwen3.5-397b-a17b', owned_by: 'alibaba', context_window: 128000 },
  { id: 'command-a-plus', owned_by: 'cohere', context_window: 256000 },
  { id: 'sonar-pro', owned_by: 'perplexity', context_window: 200000 },
  { id: 'gpt-image-1.5', owned_by: 'openai', endpoint: '/v1/images/generations' },
  { id: 'flux.1-schnell', owned_by: 'blackforest', endpoint: '/v1/images/generations' },
];

async function loadModels() {
  try {
    const headers = { 'Accept': 'application/json', 'x-base-url': state.baseUrl };
    if (state.apiKey) headers['x-api-key'] = state.apiKey;
    const res = await fetch('/api/models', { headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = (data.data || []).filter((m) => isChatModel(m) || isImageModel(m)).sort((a, b) => a.id.localeCompare(b.id));
    if (list.length) {
      state.models = list;
      try { localStorage.setItem(LS.modelsCache, JSON.stringify(list)); } catch { }
    }
  } catch (e) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(LS.modelsCache) || 'null'); } catch { }
    state.models = (cached && cached.length) ? cached : FALLBACK_MODELS;
  }
  if (!state.models.some((m) => m.id === state.model)) {
    if (state.models.length) state.model = pickDefaultModel(state.models);
  }
  renderModelButton();
  renderModelPanel('');
  updateComposerMode();
}

function pickDefaultModel(models) {
  const isOpenRouter = /openrouter/i.test(state.baseUrl);
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

function renderModelButton() {
  $('model-btn-name').textContent = state.model;
}

function renderModelPanel(query) {
  const listEl = $('model-list');
  listEl.innerHTML = '';
  const q = (query || '').trim().toLowerCase();

  const groups = new Map();
  for (const m of state.models) {
    if (q && !(m.id.toLowerCase().includes(q) || providerOf(m).toLowerCase().includes(q))) continue;
    const g = providerOf(m);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }

  const order = [...GROUP_ORDER.filter((g) => groups.has(g)), ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g))];
  let count = 0;

  for (const g of order) {
    const items = groups.get(g);
    count += items.length;
    const label = document.createElement('div');
    label.className = 'model-group-label';
    label.textContent = g;
    listEl.appendChild(label);

    for (const m of items) {
      const row = document.createElement('div');
      row.className = 'model-item' + (m.id === state.model ? ' active' : '');
      row.tabIndex = 0;

      const name = document.createElement('span');
      name.className = 'model-item-name';
      name.textContent = m.id;

      const meta = document.createElement('span');
      meta.className = 'model-item-meta';
      const ctx = humanizeCtx(m.context_window || m.context_length);
      if (ctx) {
        const c = document.createElement('span');
        c.className = 'model-badge';
        c.textContent = ctx;
        meta.appendChild(c);
      }
      if (m.premium) {
        const p = document.createElement('span');
        p.className = 'model-badge premium';
        p.textContent = 'premium';
        meta.appendChild(p);
      }
      if (m.supports_vision) {
        const v = document.createElement('span');
        v.className = 'model-badge';
        v.textContent = 'vision';
        meta.appendChild(v);
      }
      if (m.supports_reasoning) {
        const r = document.createElement('span');
        r.className = 'model-badge';
        r.textContent = 'reasoning';
        meta.appendChild(r);
      }
      if (isImageModel(m)) {
        const im = document.createElement('span');
        im.className = 'model-badge';
        im.textContent = 'image';
        meta.appendChild(im);
      }
      if (typeof m.id === 'string' && m.id.endsWith(':free')) {
        const fr = document.createElement('span');
        fr.className = 'model-badge premium';
        fr.textContent = 'free';
        meta.appendChild(fr);
      }

      row.append(name, meta);
      row.onclick = () => selectModel(m.id);
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectModel(m.id); } };
      listEl.appendChild(row);
    }
  }

  if (!count) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = 'No models match "' + query + '"';
    listEl.appendChild(empty);
  }
  $('model-count').textContent = count + ' chat models · ' + state.models.length + ' total';
}

function selectModel(id) {
  state.model = id;
  localStorage.setItem(LS.model, id);
  if (/stealth|-exp|contributor|preview/i.test(id)) {
    toast('Heads up: this model is experimental and may output nonsense.', 'info');
  }
  renderModelButton();
  updateComposerMode();
  closeModelPanel();
}

function openModelPanel() {
  const panel = $('model-panel');
  panel.hidden = false;
  renderModelPanel('');
  $('model-search').value = '';
  requestAnimationFrame(() => $('model-search').focus());
  document.addEventListener('click', onOutsideClick);
}

function closeModelPanel() {
  $('model-panel').hidden = true;
  document.removeEventListener('click', onOutsideClick);
}

function onOutsideClick(e) {
  const panel = $('model-panel');
  if (panel.hidden) return;
  if (!panel.contains(e.target) && !$('model-btn').contains(e.target)) closeModelPanel();
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
}

function currentChat() {
  return state.chats.find((c) => c.id === state.activeId) || null;
}

function chatTitle(c) {
  const first = c.messages.find((m) => m.role === 'user');
  if (!first) return 'New conversation';
  const t = first.content.replace(/\s+/g, ' ').trim();
  return t.length > 42 ? t.slice(0, 42) + '…' : t;
}

function relTime(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return 'now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h';
  const dt = new Date(ts);
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderSidebar() {
  const listEl = $('conv-list');
  listEl.innerHTML = '';
  const q = (state.convQuery || '').trim().toLowerCase();
  const sorted = [...state.chats]
    .filter((c) => !q || chatTitle(c).toLowerCase().includes(q))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = q ? 'No chats found' : 'No conversations yet';
    listEl.appendChild(empty);
    return;
  }

  for (const c of sorted) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.activeId ? ' active' : '');
    item.title = chatTitle(c);

    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = chatTitle(c);
    title.title = chatTitle(c);

    const time = document.createElement('span');
    time.style.cssText = 'font-size:11px;color:var(--text-faint);flex-shrink:0;font-family:var(--font-mono);';
    time.textContent = relTime(c.updatedAt || c.createdAt || Date.now());

    const del = document.createElement('button');
    del.className = 'conv-del';
    del.title = 'Delete conversation';
    del.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h12M8.5 6V4.5h3V6M6.5 6l.7 9.5h5.6l.7-9.5"/></svg>';
    del.onclick = (e) => {
      e.stopPropagation();
      if (del.classList.contains('confirming')) {
        deleteChat(c.id);
      } else {
        del.classList.add('confirming');
        del.textContent = 'Delete?';
        setTimeout(() => { del.classList.remove('confirming'); del.textContent = ''; del.innerHTML = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h12M8.5 6V4.5h3V6M6.5 6l.7 9.5h5.6l.7-9.5"/></svg>'; }, 2600);
      }
    };

    item.append(title, time, del);
    item.onclick = () => selectChat(c.id);
    listEl.appendChild(item);
  }
}

function selectChat(id) {
  if (state.streaming) return;
  state.activeId = id;
  save();
  renderSidebar();
  renderChat();
}

function newChat() {
  if (state.streaming) return;
  const c = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  state.chats.unshift(c);
  state.activeId = c.id;
  save();
  renderSidebar();
  renderChat();
  $('input').focus();
}

function deleteChat(id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.activeId === id) state.activeId = state.chats.length ? state.chats[0].id : null;
  save();
  renderSidebar();
  renderChat();
}

function renderChat() {
  const chat = currentChat();
  const msgsEl = $('messages');
  const emptyEl = $('empty-state');
  msgsEl.innerHTML = '';

  $('topbar-title').textContent = chat ? chatTitle(chat) : 'New conversation';

  if (!chat || !chat.messages.length) {
    emptyEl.style.display = 'flex';
    msgsEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  msgsEl.style.display = 'block';
  for (const m of chat.messages) msgsEl.appendChild(renderMessage(m));
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function renderMessage(msg) {
  const div = document.createElement('div');
  div.className = 'msg ' + (msg.role === 'user' ? 'user' : msg.role === 'error' ? 'error' : 'assistant');

  if (msg.role === 'user') {
    const b = document.createElement('div');
    b.className = 'bubble';
    if (Array.isArray(msg.images) && msg.images.length) {
      const row = document.createElement('div');
      row.className = 'msg-images';
      for (const src of msg.images) {
        const im = document.createElement('img');
        im.src = src;
        im.alt = 'attached image';
        im.loading = 'lazy';
        row.appendChild(im);
      }
      b.appendChild(row);
    }
    if (msg.content) b.appendChild(document.createTextNode(msg.content));
    div.appendChild(b);
    return div;
  }

  if (msg.role === 'error') {
    const b = document.createElement('div');
    b.className = 'msg-body';
    b.textContent = msg.content;
    div.appendChild(b);
    return div;
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const chip = document.createElement('span');
  chip.className = 'model-chip';
  chip.textContent = msg.model || state.model;
  meta.appendChild(chip);
  if (msg.usage && (msg.usage.total_tokens || 0) > 0) {
    const tok = document.createElement('span');
    tok.textContent = msg.usage.total_tokens + ' tok';
    meta.appendChild(tok);
  }
  div.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'msg-body';

  if (msg.reasoning) {
    const wrap = document.createElement('div');
    wrap.className = 'think collapsed';
    wrap.innerHTML =
      '<div class="think-head">' +
      '<svg class="think-spark" viewBox="0 0 24 24" width="15" height="15"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>' +
      '<span class="think-label">Thought</span><svg class="think-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div>' +
      '<div class="think-trace"><div class="think-trace-inner"><span class="think-line"></span><div class="think-rows"></div></div></div>';
    const rowsEl = wrap.querySelector('.think-rows');
    for (const line of msg.reasoning.split('\n')) {
      const row = document.createElement('div');
      row.className = 'think-row';
      row.textContent = line;
      rowsEl.appendChild(row);
    }
    wrap.querySelector('.think-head').addEventListener('click', () => wrap.classList.toggle('collapsed'));
    body.appendChild(wrap);
  }

  const content = document.createElement('div');
  content.className = 'msg-content';
  content.innerHTML = renderMarkdown(msg.content || '');
  body.appendChild(content);

  if (msg.image) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'msg-image';
    const a = document.createElement('a');
    a.href = msg.image;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const img = document.createElement('img');
    img.src = msg.image;
    img.alt = msg.content || 'generated image';
    img.loading = 'lazy';
    a.appendChild(img);
    imgWrap.appendChild(a);
    body.appendChild(imgWrap);
  }

  div.appendChild(body);
  enhanceCodeBlocks(div);
  return div;
}

try { marked.use({ gfm: true, breaks: true }); } catch { }

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, style, link, meta, form').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const attr of [...n.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || (attr.value && /^\s*javascript:/i.test(attr.value))) n.removeAttribute(attr.name);
    }
  });
  doc.querySelectorAll('a').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  return doc.body.innerHTML;
}

function renderMarkdown(text) {
  if (!text) return '';
  try {
    return sanitizeHtml(marked.parse(text));
  } catch {
    const el = document.createElement('div');
    el.textContent = text;
    return el.innerHTML;
  }
}

function enhanceCodeBlocks(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.dataset.enhanced) return;
    pre.dataset.enhanced = '1';
    const code = pre.querySelector('code');
    if (!code) return;

    const langMatch = (code.className || '').match(/language-([\w+-]+)/);
    const lang = langMatch ? langMatch[1] : '';
    if (lang && window.hljs && hljs.getLanguage && hljs.getLanguage(lang)) {
      try { hljs.highlightElement(code); } catch { }
    }

    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.parentNode.insertBefore(wrap, pre);

    const head = document.createElement('div');
    head.className = 'code-head';

    const lbl = document.createElement('span');
    lbl.textContent = lang || 'code';

    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.textContent = 'Copy';
    btn.onclick = () => copyText(code.textContent, btn);

    head.append(lbl, btn);
    wrap.append(head, pre);
  });
}

function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const old = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = old; btn.classList.remove('copied'); }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { }
  ta.remove();
}

function buildMessages(chat) {
  const msgs = [];
  if (state.system.trim()) msgs.push({ role: 'system', content: state.system.trim() });
  for (const m of chat.messages) {
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
      const parts = [];
      if (m.content && m.content.trim()) parts.push({ type: 'text', text: m.content });
      for (const src of m.images) parts.push({ type: 'image_url', image_url: { url: src } });
      msgs.push({ role: 'user', content: parts });
    } else if (m.role === 'user' || m.role === 'assistant') {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  return msgs;
}

function isImageMode() {
  const m = state.models.find((x) => x.id === state.model);
  return !!(m && isImageModel(m));
}

function updateComposerMode() {
  const input = $('input');
  if (isImageMode()) {
    input.placeholder = 'Describe the image you want to generate…';
    $('composer-hint').textContent = 'Image generation';
  } else {
    input.placeholder = 'Type your message…';
    $('composer-hint').textContent = '';
  }
}

function looksLikeImagePrompt(text) {
  const t = text.toLowerCase();
  if (/(diagram|chart|graph|flowchart|blueprint|schematic|screenshot|ascii|architecture)/.test(t)) return false;
  if (/\b(image|images|picture|pictures|photo|photos|photorealistic|artwork|illustration|logo|logos|icon|icons|wallpaper|drawing|painting|portrait|poster|banner|thumbnail|mascot)\b/i.test(text) && /\b(draw|paint|sketch|generate|create|make|render|show|give|design)\b/i.test(text)) return true;
  if (/^\s*(draw|paint|sketch|illustrate)\b/i.test(text)) return true;
  if (/\b(draw|paint|generate|create|make)\s+(me\s+)?(a|an|the)?\s*(cute|realistic|3d|pixel|anime|photorealistic|cyberpunk|fantasy|medieval|futuristic|watercolor|oil)/i.test(text)) return true;
  return false;
}

function pickImageModelId() {
  const cands = state.models.filter(isImageModel);
  if (!cands.length) return null;
  const saved = localStorage.getItem('maverick.imageModel');
  if (saved && cands.some((m) => m.id === saved)) return saved;
  const prefer = cands.find((m) => /flux\.1-schnell/i.test(m.id)) || cands.find((m) => /flux/i.test(m.id)) || cands.find((m) => /gpt-image-1/i.test(m.id)) || cands[0];
  try { localStorage.setItem('maverick.imageModel', prefer.id); } catch { }
  return prefer.id;
}

async function sendImageMessage(prompt, modelOverride) {
  const imgModel = modelOverride || state.model;
  const input = $('input');
  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.chats.unshift(chat);
    state.activeId = chat.id;
  }

  chat.messages.push({ role: 'user', content: prompt, ts: Date.now() });
  chat.updatedAt = Date.now();

  const aIdx = chat.messages.length;
  chat.messages.push({ role: 'assistant', content: 'Generating image…', model: imgModel, ts: Date.now() });

  input.value = '';
  autoResize();
  save();
  renderSidebar();
  renderChat();
  scrollToBottom(true);

  const imgMsgEl = $('messages').children[aIdx];
  const loaderStop = imgMsgEl ? showPixelLoader(imgMsgEl.querySelector('.msg-content'), 'Generating image') : null;

  state.streaming = true;
  $('send-btn').hidden = true;
  $('stop-btn').hidden = false;

  const controller = new AbortController();
  state.abort = controller;

  const mobj = state.models.find((x) => x.id === imgModel);
  const viaChatRoute = !!(mobj && mobj.architecture && Array.isArray(mobj.architecture.output_modalities) && mobj.architecture.output_modalities.includes('image'));

  try {
    const res = viaChatRoute
      ? await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': state.apiKey, 'x-base-url': state.baseUrl },
          body: JSON.stringify({ model: imgModel, messages: [{ role: 'user', content: prompt }], stream: false }),
          signal: controller.signal,
        })
      : await fetch('/api/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': state.apiKey, 'x-base-url': state.baseUrl },
          body: JSON.stringify({ model: imgModel, prompt, n: 1, size: '1024x1024' }),
          signal: controller.signal,
        });

    if (!res.ok) {
      let message = 'Image request failed (HTTP ' + res.status + ').';
      try {
        const j = await res.json();
        if (j.error && j.error.message) message = j.error.message;
      } catch { }
      if (res.status === 401 || res.status === 403) toast('API key rejected — check it in Settings.', 'error');
      else toast(message, 'error');
      chat.messages[aIdx] = { role: 'error', content: message, ts: Date.now() };
      save();
      renderChat();
      return;
    }

    const data = await res.json();
    let image = null;
    if (viaChatRoute) {
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      if (msg && Array.isArray(msg.images) && msg.images.length && msg.images[0] && msg.images[0].image_url) {
        image = msg.images[0].image_url.url;
      } else if (msg && typeof msg.content === 'string') {
        const match = msg.content.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+|data:image\/[^)\s]+)\)/);
        if (match) image = match[1];
      }
    } else {
      const item = data && data.data && data.data[0];
      if (item) {
        image = item.b64_json
          ? 'data:' + imageMime(item.b64_json) + ';base64,' + item.b64_json
          : item.url;
      }
    }
    if (!image) throw new Error('No image returned by the API.');

    chat.messages[aIdx] = {
      role: 'assistant',
      content: prompt,
      image: image,
      model: imgModel,
      ts: Date.now(),
    };
    chat.updatedAt = Date.now();
  } catch (err) {
    if (err.name === 'AbortError') {
      chat.messages[aIdx] = { role: 'assistant', content: '(stopped)', model: imgModel, ts: Date.now() };
      toast('Generation stopped.', 'info');
    } else {
      console.error(err);
      chat.messages[aIdx] = { role: 'error', content: 'Image generation failed: ' + err.message, ts: Date.now() };
      toast('Image generation failed.', 'error');
    }
  } finally {
    if (loaderStop) loaderStop();
    state.streaming = false;
    state.abort = null;
    $('send-btn').hidden = false;
    $('stop-btn').hidden = true;
    save();
    renderSidebar();
    renderChat();
    scrollToBottom(true);
  }
}

function imageMime(b64) {
  const head = b64.slice(0, 16);
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('iVBOR')) return 'image/png';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

async function sendMessage() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || state.streaming) return;

  if (!state.apiKey) {
    toast('Add your API key in Settings first.', 'error');
    openSettings();
    return;
  }

  if (isImageMode()) return sendImageMessage(text);

  const images = state.pendingImages.slice();
  if (images.length && !modelSupportsVision()) {
    toast('This model does not support image input — pick a model with the vision badge.', 'error');
    return;
  }

  if (!images.length) {
    const autoImgModel = pickImageModelId();
    if (autoImgModel && looksLikeImagePrompt(text)) {
      toast('Image request — generating with ' + autoImgModel, 'info');
      return sendImageMessage(text, autoImgModel);
    }
  }

  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    state.chats.unshift(chat);
    state.activeId = chat.id;
  }

  chat.messages.push({ role: 'user', content: text, images: images.length ? images : undefined, ts: Date.now() });
  chat.updatedAt = Date.now();
  state.pendingImages = [];
  renderAttachStrip();

  const aIdx = chat.messages.length;
  chat.messages.push({ role: 'assistant', content: '', model: state.model, ts: Date.now() });

  input.value = '';
  autoResize();
  save();
  renderSidebar();
  renderChat();
  scrollToBottom(true);

  const msgEl = $('messages').children[aIdx] || renderMessage(chat.messages[aIdx]);
  await streamChat(chat, aIdx, msgEl);
}

const PIXEL_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3), c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

function pixelGrid(round) {
  const grid = document.createElement('span');
  grid.className = 'pixel-grid';
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('span');
    cell.className = 'pixel-cell' + (round ? ' round' : '');
    cell.style.animationDelay = PIXEL_DELAYS[i] + 'ms';
    grid.appendChild(cell);
  }
  return grid;
}

function showPixelLoader(root, label) {
  const wrap = document.createElement('div');
  wrap.className = 'pixel-loader';
  wrap.append(pixelGrid(false));
  const shimmer = document.createElement('span');
  shimmer.className = 'shimmer-text';
  shimmer.textContent = label || 'Churning';
  const timer = document.createElement('span');
  timer.className = 'pixel-timer';
  wrap.append(shimmer, timer);
  root.innerHTML = '';
  root.appendChild(wrap);
  const start = Date.now();
  const int = setInterval(() => {
    const total = (Date.now() - start) / 1000;
    timer.textContent = total < 60 ? total.toFixed(1) + 's' : Math.floor(total / 60) + 'm ' + (total % 60).toFixed(1) + 's';
  }, 100);
  return () => clearInterval(int);
}

function buildThinking() {
  const root = document.createElement('div');
  root.className = 'think';
  root.innerHTML =
    '<button type="button" class="think-head" aria-expanded="true">' +
    '<svg class="think-spark" viewBox="0 0 24 24" width="15" height="15"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>' +
    '<span class="think-label shimmer-text">Thinking</span>' +
    '<span class="think-timer">0.0s</span>' +
    '<svg class="think-chev" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
    '</button>' +
    '<div class="think-trace"><div class="think-trace-inner"><span class="think-line"></span><div class="think-rows"></div></div></div>';
  const head = root.querySelector('.think-head');
  const label = root.querySelector('.think-label');
  const timer = root.querySelector('.think-timer');
  const rowsEl = root.querySelector('.think-rows');
  const start = Date.now();
  let expanded = true;
  const int = setInterval(() => {
    const total = (Date.now() - start) / 1000;
    timer.textContent = total < 60 ? total.toFixed(1) + 's' : Math.floor(total / 60) + 'm ' + (total % 60).toFixed(1) + 's';
  }, 100);
  const setExpanded = (open) => {
    expanded = open;
    root.classList.toggle('collapsed', !open);
    head.setAttribute('aria-expanded', String(open));
  };
  head.addEventListener('click', () => setExpanded(!expanded));
  return {
    root,
    setReasoning(text) {
      rowsEl.innerHTML = '';
      for (const line of text.split('\n')) {
        const row = document.createElement('div');
        row.className = 'think-row';
        row.textContent = line;
        rowsEl.appendChild(row);
      }
      setExpanded(true);
    },
    done() {
      clearInterval(int);
      const total = (Date.now() - start) / 1000;
      label.classList.remove('shimmer-text');
      label.textContent = 'Thought for ' + (total < 60 ? total.toFixed(1) + 's' : Math.floor(total / 60) + 'm ' + (total % 60).toFixed(1) + 's');
      setExpanded(false);
    },
    abort() {
      clearInterval(int);
    },
  };
}

async function streamChat(chat, idx, msgEl) {
  state.streaming = true;
  $('send-btn').hidden = true;
  $('stop-btn').hidden = false;
  $('composer-hint').textContent = '';

  const contentEl = msgEl.querySelector('.msg-content');
  const metaEl = msgEl.querySelector('.msg-meta');
  const controller = new AbortController();
  state.abort = controller;

  const think = buildThinking();
  think.root.hidden = true;
  msgEl.querySelector('.msg-body').insertBefore(think.root, contentEl);

  let content = '';
  let reasoning = '';
  let usage = null;
  let rafPending = false;

  const paint = () => {
    rafPending = false;
    if (reasoning) {
      think.root.hidden = false;
      think.setReasoning(reasoning);
    }
    contentEl.innerHTML = renderMarkdown(content);
    scrollToBottom(false);
  };

  const schedulePaint = () => {
    if (!rafPending) { rafPending = true; requestAnimationFrame(paint); }
  };

  let attemptCap = null;

  const doFetch = () => {
    const bodyObj = {
      model: state.model,
      messages: buildMessages(chat),
      temperature: state.temp,
    };
    if (attemptCap) bodyObj.max_tokens = attemptCap;
    return fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': state.apiKey,
        'x-base-url': state.baseUrl,
      },
      body: JSON.stringify(bodyObj),
      signal: controller.signal,
    });
  };

  try {
    let res = await doFetch();

    if (!res.ok) {
      let message = 'Request failed (HTTP ' + res.status + ').';
      try {
        const j = await res.json();
        if (j.error && j.error.message) message = j.error.message;
      } catch { }
      const afford = message.match(/can only afford (\d+)/i);
      if (attemptCap === null && afford && parseInt(afford[1], 10) > 264) {
        attemptCap = parseInt(afford[1], 10) - 64;
        toast('Credit limit — capping this reply to ' + attemptCap + ' tokens.', 'info');
        res = await doFetch();
      }
    }

    if (!res.ok) {
      let message = 'Request failed (HTTP ' + res.status + ').';
      try {
        const j = await res.json();
        if (j.error && j.error.message) message = j.error.message;
      } catch { }
      if (res.status === 401 || res.status === 403) toast('API key rejected — check it in Settings.', 'error');
      else toast(message, 'error');
      chat.messages[idx] = { role: 'error', content: message, ts: Date.now() };
      save();
      renderChat();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { buf = ''; break; }

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta) {
          if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
          if (typeof delta.content === 'string') content += delta.content;
        }
        if (json.usage) usage = json.usage;
        schedulePaint();
      }
    }

    if (rafPending) await new Promise((r) => requestAnimationFrame(() => { paint(); r(); }));
    paint();
    think.done();

    chat.messages[idx] = { role: 'assistant', content: content, reasoning: reasoning || null, model: state.model, usage: usage, ts: Date.now() };
    chat.updatedAt = Date.now();

    if (metaEl && usage && usage.total_tokens) {
      const tok = document.createElement('span');
      tok.textContent = usage.total_tokens + ' tok';
      metaEl.appendChild(tok);
    }

    enhanceCodeBlocks(msgEl);
  } catch (err) {
    if (err.name === 'AbortError') {
      think.abort();
      chat.messages[idx] = { role: 'assistant', content: content || '(stopped)', reasoning: reasoning || null, model: state.model, usage: usage, ts: Date.now() };
      toast('Generation stopped.', 'info');
    } else {
      think.abort();
      console.error(err);
      chat.messages[idx] = { role: 'error', content: 'Network error: ' + err.message, ts: Date.now() };
      toast('Network error — could not reach the local server.', 'error');
    }
  } finally {
    state.streaming = false;
    state.abort = null;
    $('send-btn').hidden = false;
    $('stop-btn').hidden = true;
    save();
    renderSidebar();
    scrollToBottom(true);
  }
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1024;
        let w = img.width;
        let h = img.height;
        if (w > max || h > max) {
          const scale = Math.min(max / w, max / h);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Could not read image'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  const list = [...files].filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!list.length) return;
  const room = MAX_ATTACHMENTS - state.pendingImages.length;
  if (room <= 0) {
    toast('Up to ' + MAX_ATTACHMENTS + ' images per message.', 'info');
    return;
  }
  const slice = list.slice(0, room);
  for (const f of slice) {
    try {
      const dataUrl = await readImageFile(f);
      state.pendingImages.push(dataUrl);
    } catch {
      toast('Could not read image file.', 'error');
    }
  }
  if (list.length > room) toast('Up to ' + MAX_ATTACHMENTS + ' images per message.', 'info');
  renderAttachStrip();
}

function renderAttachStrip() {
  const strip = $('attach-strip');
  strip.innerHTML = '';
  if (!state.pendingImages.length) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  state.pendingImages.forEach((src, i) => {
    const t = document.createElement('div');
    t.className = 'attach-thumb';
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'attachment';
    const rm = document.createElement('button');
    rm.className = 'attach-remove';
    rm.type = 'button';
    rm.title = 'Remove';
    rm.innerHTML = '<svg viewBox="0 0 20 20" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>';
    rm.onclick = () => {
      state.pendingImages.splice(i, 1);
      renderAttachStrip();
    };
    t.append(img, rm);
    strip.appendChild(t);
  });
}

function modelSupportsVision() {
  const m = state.models.find((x) => x.id === state.model);
  if (!m) return true;
  if (m.supports_vision === false) return false;
  const arch = m.architecture;
  if (arch && Array.isArray(arch.input_modalities)) return arch.input_modalities.includes('image');
  return true;
}

function renderUsageStats() {
  const el = $('usage-stats');
  if (!el) return;
  let reqs = 0;
  let promptTok = 0;
  let completionTok = 0;
  let totalTok = 0;
  const byModel = {};
  for (const c of state.chats) {
    for (const m of c.messages) {
      if (m.role === 'assistant' && m.usage && m.usage.total_tokens) {
        reqs++;
        promptTok += m.usage.prompt_tokens || 0;
        completionTok += m.usage.completion_tokens || 0;
        totalTok += m.usage.total_tokens || 0;
        const key = m.model || 'unknown';
        if (!byModel[key]) byModel[key] = { tok: 0, reqs: 0 };
        byModel[key].tok += m.usage.total_tokens;
        byModel[key].reqs++;
      }
    }
  }
  el.innerHTML = '';
  const rows = [
    ['Requests', String(reqs)],
    ['Prompt tokens', promptTok.toLocaleString()],
    ['Completion tokens', completionTok.toLocaleString()],
    ['Total tokens', totalTok.toLocaleString()],
  ];
  for (const [label, val] of rows) {
    const row = document.createElement('div');
    row.className = 'usage-row';
    const l = document.createElement('span');
    l.className = 'u-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'u-val';
    v.textContent = val;
    row.append(l, v);
    el.appendChild(row);
  }
  const entries = Object.entries(byModel).sort((a, b) => b[1].tok - a[1].tok).slice(0, 5);
  if (entries.length) {
    const head = document.createElement('div');
    head.className = 'usage-head';
    head.textContent = 'By model';
    el.appendChild(head);
    for (const [name, s] of entries) {
      const row = document.createElement('div');
      row.className = 'usage-row dim';
      const l = document.createElement('span');
      l.className = 'u-label';
      l.textContent = name;
      const v = document.createElement('span');
      v.className = 'u-val';
      v.textContent = s.tok.toLocaleString() + ' tok · ' + s.reqs + ' req';
      row.append(l, v);
      el.appendChild(row);
    }
  }
  if (!reqs) {
    const empty = document.createElement('div');
    empty.className = 'usage-empty';
    empty.textContent = 'No usage recorded yet.';
    el.appendChild(empty);
  }
}

function stopStream() {
  if (state.abort) state.abort.abort();
}

function autoResize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
}

let stickToBottom = true;

function updateScrollButton() {
  const msgsEl = $('messages');
  const nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 140;
  stickToBottom = nearBottom;
  $('scroll-down-btn').hidden = nearBottom;
}

function scrollToBottom(force) {
  const msgsEl = $('messages');
  if (force) stickToBottom = true;
  if (stickToBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  updateScrollButton();
}

function openSettings() {
  const root = $('drawer-root');
  root.innerHTML = `
    <div class="drawer-backdrop">
      <div class="drawer" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="drawer-head">
          <h2>Settings</h2>
          <button class="icon-btn" id="settings-close" title="Close (Esc)"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg></button>
        </div>
        <div class="drawer-body">
          <div class="field">
            <label class="field-label" for="set-base">API base URL</label>
            <input class="text-input" id="set-base" type="text" placeholder="https://api.navy" autocomplete="off" spellcheck="false">
            <p class="field-hint">Any OpenAI-compatible provider works — Navy, OpenRouter, Groq, a local Ollama, etc. Default: https://api.navy</p>
            <div class="preset-row">
              <button class="btn preset" data-url="https://api.navy">Navy</button>
              <button class="btn preset" data-url="https://openrouter.ai/api/v1">OpenRouter</button>
              <button class="btn preset" data-url="https://api.openai.com/v1">OpenAI</button>
              <button class="btn preset" data-url="https://api.groq.com/openai/v1">Groq</button>
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="set-key">API key</label>
            <div class="key-row">
              <input class="text-input" id="set-key" type="password" placeholder="sk-navy-…" autocomplete="off" spellcheck="false">
              <button class="icon-btn small" id="key-vis" title="Show / hide">
                <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 10s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5z"/><circle cx="10" cy="10" r="2.2"/></svg>
              </button>
            </div>
            <p class="field-hint">Navy keys: <a href="${NAVY_DASHBOARD}" target="_blank" rel="noopener">api.navy/dashboard</a> · OpenRouter keys: <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Stored only in your browser.</p>
          </div>

          <div class="field">
            <label class="field-label" for="set-system">System prompt</label>
            <textarea class="text-area" id="set-system" placeholder="Optional instructions the model always follows…" spellcheck="false"></textarea>
          </div>

          <div class="field">
            <label class="field-label" for="set-temp">Temperature</label>
            <div class="temp-row">
              <input type="range" id="set-temp" min="0" max="2" step="0.1">
              <span class="temp-val" id="temp-val"></span>
            </div>
          </div>

          <div class="field">
            <label class="field-label">Appearance</label>
            <div class="seg" id="theme-seg">
              <button data-theme="light">Light</button>
              <button data-theme="dark">Dark</button>
            </div>
          </div>

          <div class="field">
            <label class="field-label">Token usage</label>
            <div id="usage-stats" class="usage"></div>
          </div>

          <div class="field">
            <label class="field-label">Data</label>
            <div class="data-row">
              <button class="btn danger" id="clear-chats">Clear all conversations</button>
            </div>
          </div>
        </div>
        <div class="drawer-foot">
          <button class="btn-primary" id="settings-done">Done</button>
        </div>
      </div>
    </div>`;

  const keyInput = $('set-key');
  keyInput.value = state.apiKey;
  const baseInput = $('set-base');
  baseInput.value = state.baseUrl;
  $('set-system').value = state.system;

  root.querySelectorAll('.preset').forEach((b) => {
    b.onclick = () => {
      baseInput.value = b.dataset.url;
      if (typeof baseInput.onchange === 'function') baseInput.onchange();
    };
  });

  const tempInput = $('set-temp');
  tempInput.value = state.temp;
  $('temp-val').textContent = state.temp.toFixed(1);
  tempInput.oninput = () => {
    state.temp = parseFloat(tempInput.value);
    localStorage.setItem(LS.temp, String(state.temp));
    $('temp-val').textContent = state.temp.toFixed(1);
  };

  const seg = $('theme-seg');
  [...seg.children].forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === state.theme);
    b.onclick = () => {
      applyTheme(b.dataset.theme);
      [...seg.children].forEach((x) => x.classList.toggle('active', x === b));
    };
  });

  let keyVisible = false;
  $('key-vis').onclick = () => {
    keyVisible = !keyVisible;
    keyInput.type = keyVisible ? 'text' : 'password';
  };

  baseInput.onchange = () => {
    state.baseUrl = baseInput.value.trim().replace(/\/+$/, '') || 'https://api.navy';
    localStorage.setItem(LS.base, state.baseUrl);
    loadModels();
  };

  $('set-key').onchange = () => {
    state.apiKey = keyInput.value.trim();
    localStorage.setItem(LS.key, state.apiKey);
    updateKeyStatus();
    loadModels();
  };
  $('set-system').onchange = () => {
    state.system = $('set-system').value;
    localStorage.setItem(LS.system, state.system);
  };

  const clearBtn = $('clear-chats');
  clearBtn.onclick = () => {
    if (clearBtn.classList.contains('confirming')) {
      state.chats = [];
      state.activeId = null;
      save();
      renderSidebar();
      renderChat();
      toast('All conversations cleared.', 'ok');
      closeSettings();
    } else {
      clearBtn.classList.add('confirming');
      clearBtn.textContent = 'Sure? Click again';
      setTimeout(() => { clearBtn.classList.remove('confirming'); clearBtn.textContent = 'Clear all conversations'; }, 2600);
    }
  };

  const close = () => closeSettings();
  $('settings-close').onclick = close;
  $('settings-done').onclick = close;
  root.querySelector('.drawer-backdrop').onclick = (e) => {
    if (e.target === e.currentTarget) close();
  };

  renderUsageStats();
  keyInput.focus();
}

function closeSettings() {
  $('drawer-root').innerHTML = '';
}

function updateKeyStatus() {
  const dot = $('key-dot');
  const label = $('key-status-label');
  if (state.apiKey) {
    dot.className = 'dot ok';
    label.textContent = 'Key set';
  } else {
    dot.className = 'dot';
    label.textContent = 'Add API key';
  }
}

function toast(message, type = 'info') {
  const root = $('toast-root');
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : type === 'ok' ? ' ok' : '');
  t.textContent = message;
  root.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s ease, transform .3s ease';
    t.style.opacity = '0';
    t.style.transform = 'translateY(6px)';
    setTimeout(() => t.remove(), 320);
  }, 3400);
}

function init() {
  applyTheme(state.theme || 'dark');
  updateKeyStatus();
  renderSidebar();
  renderChat();
  renderModelButton();
  loadModels();

  $('new-chat-btn').onclick = newChat;
  $('empty-new-btn').onclick = newChat;
  $('settings-btn').onclick = openSettings;
  $('key-status-btn').onclick = openSettings;
  $('theme-toggle').onclick = () => applyTheme(state.theme === 'light' ? 'dark' : 'light');

  const wsBtn = $('workspace-btn');
  const wsMenu = $('workspace-menu');
  const toggleWs = (open) => {
    wsMenu.hidden = !open;
    wsBtn.setAttribute('aria-expanded', String(open));
  };
  wsBtn.onclick = (e) => {
    e.stopPropagation();
    toggleWs(wsMenu.hidden);
  };
  document.addEventListener('pointerdown', (e) => {
    if (!wsMenu.hidden && !wsMenu.contains(e.target) && !wsBtn.contains(e.target)) toggleWs(false);
  });
  wsMenu.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      toggleWs(false);
      if (act === 'settings') openSettings();
      else if (act === 'home') newChat();
      else if (act === 'invite') toast('Invite users — demo only in this build.', 'info');
    };
  });

  const collapseSidebar = (collapsed) => {
    document.getElementById('sidebar').dataset.collapsed = String(collapsed);
    try { localStorage.setItem('maverick.sidebar', collapsed ? '1' : '0'); } catch { }
  };
  $('sidebar-collapse').onclick = () => collapseSidebar(true);
  $('sidebar-expand').onclick = () => collapseSidebar(false);
  if (localStorage.getItem('maverick.sidebar') === '1') collapseSidebar(true);

  const searchBox = $('search-box');
  const convSearch = $('conv-search');
  const openSearch = (open) => {
    searchBox.hidden = !open;
    $('search-toggle').hidden = open;
    $('chats-label').style.opacity = open ? '0' : '1';
    if (open) {
      requestAnimationFrame(() => convSearch.focus());
    } else {
      convSearch.value = '';
      state.convQuery = '';
      renderSidebar();
    }
  };
  $('search-toggle').onclick = () => openSearch(true);
  $('search-close').onclick = () => openSearch(false);
  convSearch.addEventListener('input', () => {
    state.convQuery = convSearch.value;
    renderSidebar();
  });
  convSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') openSearch(false);
  });
  $('home-btn').onclick = newChat;

  const input = $('input');
  input.addEventListener('input', autoResize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  $('send-btn').onclick = sendMessage;
  $('stop-btn').onclick = stopStream;
  $('attach-btn').onclick = () => $('file-input').click();
  $('file-input').addEventListener('change', (e) => {
    addImageFiles(e.target.files);
    e.target.value = '';
  });
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) files.push(it.getAsFile());
    }
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  });
  $('model-btn').onclick = (e) => {
    e.stopPropagation();
    $('model-panel').hidden ? openModelPanel() : closeModelPanel();
  };
  $('model-panel-close').onclick = closeModelPanel;
  $('model-search').addEventListener('input', (e) => renderModelPanel(e.target.value));
  $('model-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('model-list').querySelector('.model-item');
      if (first) first.click();
    }
  });

  $('menu-btn').onclick = () => document.body.classList.toggle('sidebar-open');
  document.getElementById('main').addEventListener('click', (e) => {
    if (document.body.classList.contains('sidebar-open') && window.innerWidth <= 760) {
      if (!e.target.closest('#sidebar')) document.body.classList.remove('sidebar-open');
    }
  });

  $('messages').addEventListener('scroll', () => updateScrollButton());
  $('scroll-down-btn').onclick = () => {
    const m = $('messages');
    m.style.scrollBehavior = 'smooth';
    m.scrollTop = m.scrollHeight;
    m.style.scrollBehavior = 'auto';
    $('scroll-down-btn').hidden = true;
  };

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openModelPanel();
    }
    if (e.key === 'Escape') {
      if (state.streaming) {
        stopStream();
        toast('Generation stopped.', 'info');
        return;
      }
      if (!$('model-panel').hidden) closeModelPanel();
      else if ($('drawer-root').innerHTML) closeSettings();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
