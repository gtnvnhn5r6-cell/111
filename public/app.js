/* ============================================================
   DeepSeek Chatbox — front-end application
   No framework, no build step.
   ============================================================ */

import { createZip, readZip } from './zip.js';

const SITE_CONFIG = window.DSC_CONFIG || {};
const PAGES_MODE = SITE_CONFIG.mode === 'pages';
const PAGES_API_BASE = String(SITE_CONFIG.apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const STORAGE = {
  settings: 'dsc.settings.v1',
  conversations: 'dsc.conversations.v1',
  active: 'dsc.active.v1',
  theme: 'dsc.theme.v1',
};

const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: '',
  model: 'deepseek-flash',
  deepThink: false,
  temperature: 1,
  systemPrompt: '',
};

const MAX_CONVERSATIONS = 80;
const BACKUP_FORMAT = 'deepseek-chatbox-backup';
const CONVERSATION_FORMAT = 'deepseek-chatbox-conversation';
const BACKUP_VERSION = 1;
const MAX_IMPORT_FILE_BYTES = 60 * 1024 * 1024;

const MODEL_META = {
  'deepseek-flash': { label: 'DeepSeek-V4.1-Flash', short: 'V4.1-Flash' },
  'deepseek-v4-pro': { label: 'DeepSeek-V4-Pro', short: 'V4-Pro' },
};

function normalizeModel(model) {
  if (model === 'deepseek-v4-pro') return 'deepseek-v4-pro';
  if (model === 'deepseek-flash' || model === 'deepseek-chat' || model === 'deepseek-reasoner') {
    return 'deepseek-flash';
  }
  return 'deepseek-flash';
}

/* ============================================================
   Small helpers
   ============================================================ */

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function readStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn('localStorage write failed', error);
    return false;
  }
}

function loadSettings() {
  const saved = readStorage(STORAGE.settings, {});
  return {
    ...DEFAULT_SETTINGS,
    ...(saved && typeof saved === 'object' ? saved : {}),
    temperature: Number.isFinite(Number(saved?.temperature)) ? Number(saved.temperature) : 1,
    model: normalizeModel(saved?.model),
    deepThink: Boolean(saved?.deepThink ?? saved?.model === 'deepseek-reasoner'),
  };
}

function normalizeMessage(message) {
  return {
    id: String(message.id || uid()),
    role: message.role,
    content: String(message.content || ''),
    reasoning: String(message.reasoning || ''),
    model: normalizeModel(message.model),
    deepThink: Boolean(message.deepThink ?? message.model === 'deepseek-reasoner'),
    ts: Number(message.ts) || Date.now(),
    error: message.error ? String(message.error) : '',
    stopped: Boolean(message.stopped),
    tokens: message.tokens || null,
    thinkingMs: Number(message.thinkingMs) || 0,
  };
}

function normalizeTurnBranches(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const output = {};
  for (const [turnId, group] of Object.entries(raw)) {
    if (!group || !Array.isArray(group.branches)) continue;
    const branches = group.branches
      .map((branch) => {
        if (!branch?.user || !branch?.assistant) return null;
        const user = normalizeMessage(branch.user);
        const assistant = normalizeMessage(branch.assistant);
        if (user.role !== 'user' || assistant.role !== 'assistant') return null;
        if (!assistant.content && !assistant.reasoning && !assistant.error) return null;
        return {
          id: String(branch.id || uid()),
          label: String(branch.label || '回答版本').slice(0, 80) || '回答版本',
          createdAt: Number(branch.createdAt) || Date.now(),
          user,
          assistant,
        };
      })
      .filter(Boolean)
      .slice(-8);
    if (!branches.length) continue;
    const activeId = branches.some((branch) => branch.id === group.activeId)
      ? group.activeId
      : branches[branches.length - 1].id;
    output[String(turnId)] = { activeId, branches };
  }
  return output;
}

function normalizeConversation(conv) {
  if (!conv || typeof conv !== 'object' || !Array.isArray(conv.messages)) return null;
  const messages = conv.messages
    .filter((message) => message && ['user', 'assistant'].includes(message.role))
    .map(normalizeMessage);
  if (!messages.length) return null;
  const branches = (Array.isArray(conv.branches) ? conv.branches : [])
    .map((branch) => {
      if (!branch || !Array.isArray(branch.messages)) return null;
      const branchMessages = branch.messages
        .filter((message) => message && ['user', 'assistant'].includes(message.role))
        .map(normalizeMessage);
      if (!branchMessages.length) return null;
      return {
        id: String(branch.id || uid()),
        label: String(branch.label || '分支').slice(0, 80) || '分支',
        createdAt: Number(branch.createdAt) || Date.now(),
        messages: branchMessages,
      };
    })
    .filter(Boolean)
    .slice(-8);
  const turnBranches = normalizeTurnBranches(conv.turnBranches);
  // Older versions stored whole-conversation snapshots in `branches`.
  // Migrate their last user/assistant pair into the per-turn model so the
  // existing versions remain reachable after upgrading.
  for (const branch of branches) {
    let lastUserIndex = -1;
    for (let i = branch.messages.length - 1; i >= 0; i -= 1) {
      if (branch.messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) continue;
    const user = branch.messages[lastUserIndex];
    const assistant = branch.messages[lastUserIndex + 1];
    if (!assistant || assistant.role !== 'assistant') continue;
    const group = (turnBranches[user.id] ||= { activeId: '', branches: [] });
    if (!group.branches.some((item) => item.id === branch.id)) {
      group.branches.push({
        id: branch.id,
        label: branch.label,
        createdAt: branch.createdAt,
        user,
        assistant,
      });
    }
  }
  for (const [turnId, group] of Object.entries(turnBranches)) {
    const userIndex = messages.findIndex((message) => message.id === turnId && message.role === 'user');
    const user = userIndex >= 0 ? messages[userIndex] : null;
    const assistant = userIndex >= 0 ? messages[userIndex + 1] : null;
    if (user && assistant?.role === 'assistant' && assistant.content) {
      const currentId = `current:${turnId}`;
      let currentBranch = group.branches.find(
        (item) => item.id === currentId || item.assistant.id === assistant.id,
      );
      if (!currentBranch) {
        currentBranch = {
          id: currentId,
          label: '当前回答',
          createdAt: Date.now(),
          user,
          assistant,
        };
        group.branches.push(currentBranch);
      }
      group.activeId = currentBranch.id;
    }
    group.branches = group.branches.slice(-8);
    if (!group.branches.some((item) => item.id === group.activeId)) {
      group.activeId = group.branches[group.branches.length - 1]?.id || '';
    }
  }
  return {
    id: String(conv.id || uid()),
    title: String(conv.title || '新对话').slice(0, 200) || '新对话',
    createdAt: Number(conv.createdAt) || Date.now(),
    updatedAt: Number(conv.updatedAt) || Number(conv.createdAt) || Date.now(),
    messages,
    branches,
    turnBranches,
    currentBranchLabel: String(conv.currentBranchLabel || '主分支').slice(0, 80) || '主分支',
  };
}

function loadConversations() {
  const raw = readStorage(STORAGE.conversations, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeConversation)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function formatTime(ts) {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function icon(id, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

/* ============================================================
   State
   ============================================================ */

const state = {
  settings: loadSettings(),
  conversations: loadConversations(),
  activeId: localStorage.getItem(STORAGE.active) || null,
  search: '',
  tocTurnId: null,
  serverKey: false,
  serverBase: 'https://api.deepseek.com',
  streaming: null,
  demo: new URLSearchParams(location.search).has('demo'),
  paintQueued: false,
};

if (!state.conversations.some((conv) => conv.id === state.activeId)) {
  state.activeId = state.conversations[0]?.id || null;
}

const dom = {
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  closeSidebar: $('#closeSidebar'),
  menuBtn: $('#menuBtn'),
  newChat: $('#newChat'),
  search: $('#search'),
  convList: $('#convList'),
  settingsBtn: $('#settingsBtn'),
  keyState: $('#keyState'),
  modelBtn: $('#modelBtn'),
  modelLabel: $('#modelLabel'),
  modelMenu: $('#modelMenu'),
  themeBtn: $('#themeBtn'),
  exportBtn: $('#exportBtn'),
  dataMenu: $('#dataMenu'),
  tocBtn: $('#tocBtn'),
  tocPanel: $('#tocPanel'),
  tocList: $('#tocList'),
  tocCount: $('#tocCount'),
  tocClose: $('#tocClose'),
  tocBranches: $('#tocBranches'),
  tocBranchList: $('#tocBranchList'),
  tocBranchCount: $('#tocBranchCount'),
  zipInput: $('#zipInput'),
  exportZipBtn: $('#exportZipBtn'),
  importZipBtn: $('#importZipBtn'),
  chatScroll: $('#chatScroll'),
  welcome: $('#welcome'),
  messages: $('#messages'),
  welcomeKeyHint: $('#welcomeKeyHint'),
  composer: $('#composer'),
  input: $('#input'),
  inputHint: $('#inputHint'),
  sendBtn: $('#sendBtn'),
  thinkToggle: $('#thinkToggle'),
  settingsModal: $('#settingsModal'),
  apiKeyInput: $('#apiKeyInput'),
  toggleKey: $('#toggleKey'),
  baseUrlInput: $('#baseUrlInput'),
  modelSelect: $('#modelSelect'),
  tempInput: $('#tempInput'),
  tempValue: $('#tempValue'),
  systemPromptInput: $('#systemPromptInput'),
  testBtn: $('#testBtn'),
  testResult: $('#testResult'),
  saveSettingsBtn: $('#saveSettingsBtn'),
  clearDataBtn: $('#clearDataBtn'),
  serverKeyBadge: $('#serverKeyBadge'),
  toastWrap: $('#toastWrap'),
};

/* ============================================================
   Toasts
   ============================================================ */

function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.innerHTML = `${icon(type === 'error' ? 'i-alert' : 'i-check')}<span>${escapeHtml(message)}</span>`;
  dom.toastWrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, 2400);
}

/* ============================================================
   Theme
   ============================================================ */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE.theme, theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#13151b' : '#ffffff';
}

function initTheme() {
  const fromQuery = new URLSearchParams(location.search).get('theme');
  if (fromQuery === 'dark' || fromQuery === 'light') {
    applyTheme(fromQuery);
    return;
  }
  const saved = localStorage.getItem(STORAGE.theme);
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light');
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

/* ============================================================
   Markdown renderer
   Deliberately small: headings, lists, quotes, tables, code,
   links, bold/italic/strike. Everything is escaped first.
   ============================================================ */

function renderInline(raw) {
  let text = escapeHtml(raw);

  const codeSpans = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const token = `\u0003C${codeSpans.length}\u0004`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const url = safeUrl(href.replace(/&amp;/g, '&'));
    if (!url) return label;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  text = text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(（])\*([^*\n]+)\*(?=$|[\s)）.,!?;:，。！？；：])/g, '$1<em>$2</em>');

  text = text.replace(/\u0003C(\d+)\u0004/g, (_match, index) => codeSpans[Number(index)] || '');
  return text;
}

function renderCodeBlock(block) {
  const lang = block.lang ? block.lang.slice(0, 24) : 'text';
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(
    lang,
  )}</span><button class="code-copy" type="button" data-copy-code>${icon(
    'i-copy',
  )}<span>复制</span></button></div><pre><code>${escapeHtml(block.code)}</code></pre></div>`;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

function renderMarkdown(source) {
  if (!source) return '';
  let text = String(source).replace(/\r\n?/g, '\n');

  const codeBlocks = [];
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    const token = `\u0001CB${codeBlocks.length}\u0002`;
    codeBlocks.push({
      lang: String(lang || '').trim().split(/\s+/)[0],
      code: String(code).replace(/\n$/, ''),
    });
    return `\n${token}\n`;
  });

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  const startsBlock = (line) =>
    /^\s*$/.test(line) ||
    /^#{1,4}\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*(?:[-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line) ||
    /^\u0001CB\d+\u0002$/.test(line.trim()) ||
    (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]));

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    const codeMatch = line.trim().match(/^\u0001CB(\d+)\u0002$/);
    if (codeMatch) {
      out.push(renderCodeBlock(codeBlocks[Number(codeMatch[1])]));
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(
        `<blockquote><p>${renderInline(quote.join('\n')).replace(/\n/g, '<br />')}</p></blockquote>`,
      );
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const headHtml = header
        .map(
          (cell, index) =>
            `<th${aligns[index] ? ` style="text-align:${aligns[index]}"` : ''}>${renderInline(
              cell,
            )}</th>`,
        )
        .join('');
      const bodyHtml = rows
        .map(
          (row) =>
            `<tr>${header
              .map(
                (_cell, index) =>
                  `<td${aligns[index] ? ` style="text-align:${aligns[index]}"` : ''}>${renderInline(
                    row[index] || '',
                  )}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('');
      out.push(
        `<div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
      );
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items = [];
      while (i < lines.length) {
        const item = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (item && /\d/.test(item[2]) === ordered) {
          items.push(item[3]);
          i += 1;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (i < lines.length && !startsBlock(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return out.join('\n');
}

/* ============================================================
   Conversations
   ============================================================ */

function activeConversation() {
  return state.conversations.find((conv) => conv.id === state.activeId) || null;
}

function hasApiKey() {
  return Boolean(state.settings.apiKey || state.serverKey);
}

function updateKeyState() {
  const configured = Boolean(state.settings.apiKey);
  const available = hasApiKey();
  dom.keyState.textContent = configured
    ? 'API Key 已配置'
    : state.serverKey
      ? '已使用服务端 Key'
      : '未配置 API Key';
  dom.keyState.classList.toggle('ok', available);
  dom.keyState.classList.toggle('warn', !available);
  dom.welcomeKeyHint.hidden = available;
  dom.serverKeyBadge.hidden = !state.serverKey;
  dom.input.placeholder = available ? '给 DeepSeek 发送消息' : '请先在设置中配置 API Key';
}

function persist() {
  const saved = writeStorage(STORAGE.conversations, state.conversations.slice(0, MAX_CONVERSATIONS));
  try {
    if (state.activeId) localStorage.setItem(STORAGE.active, state.activeId);
    else localStorage.removeItem(STORAGE.active);
  } catch (error) {
    console.warn('localStorage active write failed', error);
  }
  return saved;
}

function saveSettings() {
  writeStorage(STORAGE.settings, state.settings);
}

function titleFrom(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 30 ? `${clean.slice(0, 30)}…` : clean || '新对话';
}

function groupLabel(ts) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(new Date(ts).getFullYear(), new Date(ts).getMonth(), new Date(ts).getDate()).getTime();
  const diff = Math.round((today - day) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff <= 7) return '近 7 天';
  return '更早';
}

function renderSidebar() {
  const query = state.search.trim().toLowerCase();
  const conversations = state.conversations
    .filter((conv) => {
      if (!query) return true;
      if (conv.title.toLowerCase().includes(query)) return true;
      return conv.messages.some((message) => message.content.toLowerCase().includes(query));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  dom.convList.innerHTML = '';
  if (!conversations.length) {
    const empty = document.createElement('div');
    empty.className = 'conv-empty';
    empty.textContent = query ? '没有找到匹配的对话' : '还没有对话记录\n开始你的第一次对话吧';
    dom.convList.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const conv of conversations) {
    const label = groupLabel(conv.updatedAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(conv);
  }

  for (const [label, items] of groups) {
    const group = document.createElement('div');
    group.className = 'conv-group';
    const title = document.createElement('div');
    title.className = 'conv-group-label';
    title.textContent = label;
    group.appendChild(title);

    for (const conv of items) {
      const item = document.createElement('div');
      item.className = `conv-item${conv.id === state.activeId ? ' active' : ''}`;
      item.dataset.id = conv.id;
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `打开对话：${conv.title}`);
      item.innerHTML = `<span class="conv-title">${escapeHtml(conv.title)}</span><button class="conv-delete" type="button" aria-label="删除对话" title="删除">${icon(
        'i-trash',
      )}</button>`;
      group.appendChild(item);
    }
    dom.convList.appendChild(group);
  }
}

function renderActions(message, isLastAssistant) {
  if (message.role === 'user') {
    return `<button class="msg-action" type="button" data-action="copy">${icon(
      'i-copy',
    )}<span>复制</span></button><button class="msg-action" type="button" data-action="edit">${icon(
      'i-edit',
    )}<span>修改</span></button>`;
  }

  const model = MODEL_META[message.model]?.short || 'AI';
  return `<button class="msg-action" type="button" data-action="copy">${icon(
    'i-copy',
  )}<span>复制</span></button><button class="msg-action" type="button" data-action="regenerate">${icon(
    'i-refresh',
  )}<span>重新生成</span></button><span class="msg-model-tag">${escapeHtml(model)}</span>`;
}

function reasoningLabel(message) {
  if (message.streaming && !message.content) return '正在深度思考…';
  const seconds = Math.max(1, Math.round((message.thinkingMs || 0) / 1000));
  return `已深度思考 · 用时 ${seconds} 秒`;
}

function createMessageElement(message, isLastAssistant, turnId = null) {
  const article = document.createElement('article');
  article.className = `msg ${message.role}`;
  article.dataset.msgId = message.id;
  if (turnId) article.dataset.turnId = turnId;

  if (message.role === 'user') {
    article.innerHTML = `<div class="msg-avatar">我</div><div class="msg-body"><div class="user-bubble">${escapeHtml(
      message.content,
    )}</div><div class="msg-actions">${renderActions(message, false)}</div></div>`;
    return article;
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  const turnNav = document.createElement('div');
  turnNav.innerHTML = turnId ? turnNavHtml(activeConversation(), turnId, message.id) : '';
  if (turnNav.firstElementChild) body.appendChild(turnNav.firstElementChild);

  const reasoning = document.createElement('details');
  reasoning.className = 'reasoning';
  reasoning.hidden = true;
  reasoning.innerHTML = `<summary>${icon('i-brain')}<span class="reasoning-label">正在深度思考…</span>${icon(
    'i-chevron',
    'icon chev',
  )}</summary><div class="reasoning-body"></div>`;
  reasoning.addEventListener('toggle', () => {
    reasoning.dataset.userToggled = 'true';
  });

  const content = document.createElement('div');
  content.className = 'assistant-content markdown';

  const cursor = document.createElement('span');
  cursor.className = 'typing-cursor';
  cursor.hidden = true;

  const error = document.createElement('div');
  error.className = 'error-card';
  error.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML = renderActions(message, isLastAssistant);

  body.append(reasoning, content, cursor, error, actions);

  article.innerHTML = `<div class="msg-avatar">${icon('i-whale')}</div>`;
  article.appendChild(body);

  paintAssistant(article, message, isLastAssistant);
  return article;
}

function paintAssistant(article, message, isLastAssistant) {
  if (message.role !== 'assistant') return;
  const reasoning = $('.reasoning', article);
  const label = $('.reasoning-label', article);
  const reasoningBody = $('.reasoning-body', article);
  const content = $('.assistant-content', article);
  const cursor = $('.typing-cursor', article);
  const error = $('.error-card', article);
  const actions = $('.msg-actions', article);

  const showReasoning = Boolean(message.reasoning) || Boolean(message.streaming && message.deepThink);
  reasoning.hidden = !showReasoning;
  if (showReasoning) {
    reasoning.classList.toggle('thinking', Boolean(message.streaming && !message.content));
    label.textContent = reasoningLabel(message);
    reasoningBody.textContent = message.reasoning || '正在思考…';
    if (message.streaming && message.content && !reasoning.dataset.userToggled) {
      reasoning.open = false;
    } else if (message.streaming && !message.content) {
      reasoning.open = true;
    }
  }

  content.innerHTML = renderMarkdown(message.content);
  cursor.hidden = !message.streaming;
  if (message.streaming && message.content) content.appendChild(cursor);

  if (message.error) {
    error.hidden = false;
    error.dataset.message = message.error;
    error.innerHTML = `${icon('i-alert')}<div><strong>请求失败</strong>${escapeHtml(
      message.error,
    )}<div><button type="button" data-action="regenerate">重试</button></div></div>`;
  } else {
    error.hidden = true;
    error.innerHTML = '';
  }

  actions.innerHTML = renderActions(message, isLastAssistant);
  actions.style.visibility = message.streaming ? 'hidden' : '';
}

function renderConversation({ keepScroll = false } = {}) {
  const conv = activeConversation();
  const hasMessages = Boolean(conv && conv.messages.length);

  dom.welcome.hidden = hasMessages;
  dom.messages.hidden = !hasMessages;
  dom.messages.innerHTML = '';

  if (!hasMessages) {
    document.title = 'DeepSeek Chatbox';
    renderToc();
    return;
  }

  const lastAssistantId = [...conv.messages].reverse().find((m) => m.role === 'assistant')?.id;
  const fragment = document.createDocumentFragment();
  let turnId = null;
  for (const message of conv.messages) {
    if (message.role === 'user') turnId = message.id;
    fragment.appendChild(createMessageElement(message, message.id === lastAssistantId, message.role === 'assistant' ? turnId : null));
  }
  dom.messages.appendChild(fragment);

  document.title = `${conv.title} · DeepSeek Chatbox`;
  renderToc();
  if (!keepScroll) requestAnimationFrame(() => scrollToBottom(true));
}

function tocPreview(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 72 ? `${clean.slice(0, 72)}…` : clean || '（空提问）';
}

function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}

function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function ensureTurnGroup(conv, turnId) {
  if (!conv.turnBranches || typeof conv.turnBranches !== 'object') conv.turnBranches = {};
  if (!conv.turnBranches[turnId]) conv.turnBranches[turnId] = { activeId: '', branches: [] };
  if (!Array.isArray(conv.turnBranches[turnId].branches)) conv.turnBranches[turnId].branches = [];
  return conv.turnBranches[turnId];
}

function userIndexById(conv, turnId) {
  return conv.messages.findIndex((message) => message.id === turnId && message.role === 'user');
}

function turnPairAt(conv, userIndex) {
  const user = conv.messages[userIndex];
  const assistant = conv.messages[userIndex + 1];
  if (!user || user.role !== 'user' || !assistant || assistant.role !== 'assistant') return null;
  return { user, assistant };
}

function saveTurnBranch(conv, userIndex, label) {
  const pair = turnPairAt(conv, userIndex);
  if (!pair) return null;
  const group = ensureTurnGroup(conv, pair.user.id);
  let branch = group.branches.find((item) => item.assistant.id === pair.assistant.id);
  if (branch) {
    branch.user = cloneMessage(pair.user);
    branch.assistant = cloneMessage(pair.assistant);
  } else {
    branch = {
      id: uid(),
      label: label || `版本 ${group.branches.length + 1}`,
      createdAt: Date.now(),
      user: cloneMessage(pair.user),
      assistant: cloneMessage(pair.assistant),
    };
    group.branches.push(branch);
  }
  if (group.branches.length > 8) group.branches.splice(0, group.branches.length - 8);
  group.activeId = branch.id;
  return branch;
}

function createTurnBranch(conv, userIndex, assistant, label) {
  const user = conv.messages[userIndex];
  if (!user || user.role !== 'user' || !assistant) return null;
  const group = ensureTurnGroup(conv, user.id);
  const branch = {
    id: uid(),
    label: label || `版本 ${group.branches.length + 1}`,
    createdAt: Date.now(),
    user: cloneMessage(user),
    assistant: cloneMessage(assistant),
  };
  group.branches.push(branch);
  if (group.branches.length > 8) group.branches.splice(0, group.branches.length - 8);
  group.activeId = branch.id;
  return branch;
}

function syncTurnBranch(conv, assistant) {
  const index = conv.messages.findIndex((message) => message.id === assistant.id);
  if (index < 1) return;
  const pair = turnPairAt(conv, index - 1);
  const group = pair ? conv.turnBranches?.[pair.user.id] : null;
  if (!group) return;
  const branch =
    group.branches.find((item) => item.assistant.id === assistant.id) ||
    group.branches.find((item) => item.id === group.activeId);
  if (!branch) return;
  branch.user = cloneMessage(pair.user);
  branch.assistant = cloneMessage(assistant);
  group.activeId = branch.id;
}

function removeTurnBranch(conv, assistantId) {
  if (!conv.turnBranches) return;
  for (const [turnId, group] of Object.entries(conv.turnBranches)) {
    group.branches = group.branches.filter((branch) => branch.assistant.id !== assistantId);
    if (!group.branches.length) {
      delete conv.turnBranches[turnId];
    } else if (!group.branches.some((branch) => branch.id === group.activeId)) {
      group.activeId = group.branches[group.branches.length - 1].id;
    }
  }
}

function pruneTurnBranches(conv) {
  if (!conv.turnBranches) return;
  const turnIds = new Set(conv.messages.filter((message) => message.role === 'user').map((message) => message.id));
  for (const turnId of Object.keys(conv.turnBranches)) {
    if (!turnIds.has(turnId)) delete conv.turnBranches[turnId];
  }
}

function getTurnBranchInfo(conv, turnId, assistantId) {
  const group = turnId ? conv?.turnBranches?.[turnId] : null;
  const branches = group?.branches || [];
  let index = branches.findIndex((branch) => branch.assistant.id === assistantId);
  if (index < 0 && group?.activeId) index = branches.findIndex((branch) => branch.id === group.activeId);
  return { count: Math.max(1, branches.length), index: Math.max(0, index), branches, group };
}

function turnNavHtml(conv, turnId, assistantId) {
  const info = getTurnBranchInfo(conv, turnId, assistantId);
  const prevDisabled = info.index <= 0 ? ' disabled' : '';
  const nextDisabled = info.index >= info.count - 1 ? ' disabled' : '';
  return `<div class="turn-nav" data-turn-id="${escapeHtml(turnId || '')}" aria-label="回答版本"><button class="turn-arrow" type="button" data-turn-dir="-1" aria-label="上一个版本"${prevDisabled}>${icon(
    'i-chevron',
    'icon chev turn-chev-left',
  )}</button><span class="turn-count">${info.index + 1}/${info.count}</span><button class="turn-arrow" type="button" data-turn-dir="1" aria-label="下一个版本"${nextDisabled}>${icon(
    'i-chevron',
    'icon chev turn-chev-right',
  )}</button></div>`;
}

function switchTurnBranch(turnId, target) {
  if (state.streaming) {
    toast('请先停止当前生成，再切换版本', 'error');
    return;
  }
  const conv = activeConversation();
  if (!conv || !turnId) return;
  const userIndex = userIndexById(conv, turnId);
  if (userIndex < 0) return;
  const group = conv.turnBranches?.[turnId];
  if (!group || group.branches.length < 2) return;

  saveTurnBranch(conv, userIndex);
  let currentIndex = group.branches.findIndex((branch) => branch.id === group.activeId);
  if (currentIndex < 0) currentIndex = 0;
  let nextIndex = currentIndex;
  if (typeof target === 'number') nextIndex = currentIndex + target;
  else nextIndex = group.branches.findIndex((branch) => branch.id === target);
  if (nextIndex < 0 || nextIndex >= group.branches.length || nextIndex === currentIndex) return;

  const branch = group.branches[nextIndex];
  group.activeId = branch.id;
  conv.messages[userIndex] = cloneMessage(branch.user);
  conv.messages[userIndex + 1] = cloneMessage(branch.assistant);
  if (conv.messages[userIndex].id !== turnId) conv.messages[userIndex].id = turnId;
  conv.updatedAt = Date.now();
  state.tocTurnId = turnId;

  persist();
  renderConversation({ keepScroll: true });
  renderSidebar();
  renderToc();
}

function renderBranchList(conv, turnId) {
  const group = turnId ? conv?.turnBranches?.[turnId] : null;
  const branches = group?.branches || [];
  dom.tocBranches.hidden = branches.length < 2;
  if (branches.length < 2) {
    dom.tocBranchList.innerHTML = '';
    dom.tocBranchCount.textContent = '';
    return;
  }
  dom.tocBranchCount.textContent = `${branches.length} 个版本`;
  const activeId = branches.some((branch) => branch.id === group.activeId)
    ? group.activeId
    : branches[branches.length - 1].id;
  dom.tocBranchList.innerHTML = branches
    .map(
      (branch, index) =>
        `<button class="toc-branch${branch.id === activeId ? ' current' : ''}" type="button" data-branch-id="${escapeHtml(
          branch.id,
        )}"><span class="toc-branch-dot"></span><span class="toc-branch-label">${escapeHtml(
          branch.label,
        )}</span><span class="toc-branch-meta">${index + 1}/${branches.length}</span></button>`,
    )
    .join('');
}

function renderToc() {
  const conv = activeConversation();
  const questions = conv ? conv.messages.filter((message) => message.role === 'user') : [];
  dom.tocCount.textContent = questions.length ? `${questions.length} 个提问` : '';
  if (!questions.length) {
    dom.tocList.innerHTML = '<div class="toc-empty">还没有提问</div>';
    state.tocTurnId = null;
  } else {
    dom.tocList.innerHTML = questions
      .map(
        (message, index) =>
          `<button class="toc-item" type="button" data-toc-id="${escapeHtml(message.id)}"><span class="toc-index">${
            index + 1
          }</span><span class="toc-text">${escapeHtml(tocPreview(message.content))}</span></button>`,
      )
      .join('');
    if (!questions.some((message) => message.id === state.tocTurnId)) {
      state.tocTurnId = questions[questions.length - 1].id;
    }
    syncTocActive();
  }
  renderBranchList(conv, state.tocTurnId);
}

function syncTocActive() {
  if (!dom.tocPanel || dom.tocPanel.hidden) return;
  const threshold = dom.chatScroll.getBoundingClientRect().top + 84;
  const questions = [...dom.messages.querySelectorAll('.msg.user')];
  let activeId = questions[0]?.dataset.msgId || '';
  for (const article of questions) {
    if (article.getBoundingClientRect().top <= threshold) activeId = article.dataset.msgId;
  }
  dom.tocList.querySelectorAll('.toc-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tocId === activeId);
  });
  if (activeId && activeId !== state.tocTurnId) {
    state.tocTurnId = activeId;
    renderBranchList(activeConversation(), activeId);
  }
}

function jumpToTocMessage(messageId) {
  const article = [...dom.messages.querySelectorAll('.msg.user')].find(
    (item) => item.dataset.msgId === messageId,
  );
  if (!article) return;
  state.tocTurnId = messageId;
  renderBranchList(activeConversation(), messageId);
  const scroller = dom.chatScroll;
  const top =
    scroller.scrollTop +
    article.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    18;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  article.classList.remove('msg-flash');
  requestAnimationFrame(() => article.classList.add('msg-flash'));
  setTimeout(() => article.classList.remove('msg-flash'), 1800);
  if (window.matchMedia('(max-width: 900px)').matches) toggleToc(false);
}

function toggleToc(force) {
  const open = typeof force === 'boolean' ? force : dom.tocPanel.hidden;
  dom.tocPanel.hidden = !open;
  dom.tocBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    toggleModelMenu(false);
    toggleDataMenu(false);
    renderToc();
    requestAnimationFrame(syncTocActive);
  }
}

function beginEditMessage(article, message) {
  if (state.streaming) {
    toast('请先停止当前生成，再修改提问', 'error');
    return;
  }
  if (!hasApiKey()) {
    toast('请先配置 DeepSeek API Key', 'error');
    openSettings();
    return;
  }
  const bubble = article.querySelector('.user-bubble');
  if (!bubble || article.classList.contains('editing')) return;
  if (!dom.tocPanel.hidden) toggleToc(false);

  const conv = activeConversation();
  const index = conv ? conv.messages.findIndex((item) => item.id === message.id) : -1;
  const trailing = conv ? conv.messages.length - index - 1 : 0;

  article.classList.add('editing');
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = `<textarea class="edit-input" rows="3" aria-label="修改提问"></textarea><div class="edit-hint"></div><div class="edit-actions"><button class="edit-btn" type="button" data-edit-action="cancel">取消</button><button class="edit-btn primary" type="button" data-edit-action="save">保存并重新生成</button></div>`;
  bubble.replaceWith(box);

  const textarea = box.querySelector('.edit-input');
  const hint = box.querySelector('.edit-hint');
  const saveBtn = box.querySelector('[data-edit-action="save"]');
  textarea.value = message.content;
  hint.textContent = trailing
    ? `保存后会把当前这轮对话保留为版本（含之后 ${trailing} 条消息），并从修改后的提问重新生成。`
    : '保存后会把当前回答保留为版本，并重新生成。';

  const autosize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };
  textarea.addEventListener('input', autosize);
  autosize();
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  box.querySelector('[data-edit-action="cancel"]').addEventListener('click', () => {
    renderConversation({ keepScroll: true });
  });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const saved = await saveEditedMessage(message.id, textarea.value);
    if (!saved) saveBtn.disabled = false;
  });
}

async function saveEditedMessage(messageId, rawText) {
  if (state.streaming) return false;
  const text = String(rawText || '').trim();
  if (!text) {
    toast('提问不能为空', 'error');
    return false;
  }

  const conv = activeConversation();
  if (!conv) return false;
  const index = conv.messages.findIndex((message) => message.id === messageId);
  if (index < 0 || conv.messages[index].role !== 'user') return false;

  const trailing = conv.messages.length - index - 1;
  if (
    trailing &&
    !confirm(
      `修改这条提问会把当前这轮对话保留为一个版本，并从修改后的提问重新生成。继续吗？`,
    )
  ) {
    return false;
  }
  if (!hasApiKey()) {
    toast('请先配置 DeepSeek API Key', 'error');
    openSettings();
    return false;
  }

  const existingBranches = conv.turnBranches?.[messageId]?.branches || [];
  const editCount = existingBranches.filter(
    (branch) => branch.label === '修改后' || branch.label.startsWith('修改后 '),
  ).length;
  saveTurnBranch(conv, index, '修改前');
  conv.messages = conv.messages.slice(0, index + 1);
  const userMessage = conv.messages[index];
  userMessage.content = text;
  userMessage.ts = Date.now();
  if (!conv.messages.slice(0, index).some((message) => message.role === 'user')) {
    conv.title = titleFrom(text);
  }

  const assistant = createAssistantMessage();
  conv.messages.push(assistant);
  createTurnBranch(conv, index, assistant, editCount ? `修改后 ${editCount + 1}` : '修改后');
  pruneTurnBranches(conv);
  state.tocTurnId = userMessage.id;
  conv.updatedAt = Date.now();
  persist();
  renderSidebar();
  renderConversation();
  toast('旧回答已保留为版本，可在回答上方切换');
  await streamAssistant(conv, assistant);
  return true;
}

function switchConversation(id) {
  if (state.streaming) stopStreaming();
  state.activeId = id;
  persist();
  renderSidebar();
  renderConversation();
  closeSidebar();
}

function deleteConversation(id) {
  const conv = state.conversations.find((item) => item.id === id);
  if (!conv) return;
  if (!confirm(`删除对话「${conv.title}」？此操作无法撤销。`)) return;
  if (state.streaming?.convId === id) stopStreaming();
  state.conversations = state.conversations.filter((item) => item.id !== id);
  if (state.activeId === id) state.activeId = state.conversations[0]?.id || null;
  persist();
  renderSidebar();
  renderConversation();
  toast('对话已删除');
}

function newChat() {
  if (state.streaming) stopStreaming();
  state.activeId = null;
  persist();
  renderSidebar();
  renderConversation();
  closeSidebar();
  dom.input.focus();
}

/* ============================================================
   Sidebar / mobile drawer
   ============================================================ */

function openSidebar() {
  dom.sidebar.classList.add('open');
  dom.scrim.hidden = false;
}

function closeSidebar() {
  dom.sidebar.classList.remove('open');
  dom.scrim.hidden = true;
}

/* ============================================================
   Model & composer controls
   ============================================================ */

function setModel(model) {
  state.settings.model = normalizeModel(model);
  saveSettings();
  updateModelUI();
}

function updateModelUI() {
  const model = normalizeModel(state.settings.model);
  dom.modelLabel.textContent = MODEL_META[model]?.label || 'DeepSeek';
  dom.thinkToggle.setAttribute('aria-pressed', String(Boolean(state.settings.deepThink)));
  dom.thinkToggle.title = state.settings.deepThink
    ? '已开启深度思考：使用更强的推理力度'
    : '开启深度思考：模型会先推理再回答';
  $$('.model-option', dom.modelMenu).forEach((option) => {
    option.classList.toggle('selected', option.dataset.model === model);
  });
  dom.modelSelect.value = model;
}

function toggleDeepThink() {
  if (state.streaming) {
    toast('请等待当前回答完成后再切换', 'error');
    return;
  }
  state.settings.deepThink = !state.settings.deepThink;
  saveSettings();
  updateModelUI();
  toast(state.settings.deepThink ? '已开启深度思考' : '已关闭深度思考');
}

function toggleModelMenu(force) {
  const open = typeof force === 'boolean' ? force : dom.modelMenu.hidden;
  dom.modelMenu.hidden = !open;
  dom.modelBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    toggleDataMenu(false);
    toggleToc(false);
  }
}

function toggleDataMenu(force) {
  const open = typeof force === 'boolean' ? force : dom.dataMenu.hidden;
  dom.dataMenu.hidden = !open;
  dom.exportBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    toggleModelMenu(false);
    toggleToc(false);
  }
}

function autosizeInput() {
  dom.input.style.height = 'auto';
  const next = Math.min(dom.input.scrollHeight, 200);
  dom.input.style.height = `${Math.max(26, next)}px`;
  updateComposerHint();
}

function updateComposerHint() {
  const hasText = Boolean(dom.input.value.trim());
  dom.inputHint.textContent = hasText ? 'Enter 发送 · Shift + Enter 换行' : '';
  dom.sendBtn.disabled = !hasText && !state.streaming;
}

/* ============================================================
   Streaming
   ============================================================ */

function historyForApi(conv, excludeId) {
  const messages = [];
  if (state.settings.systemPrompt.trim()) {
    messages.push({ role: 'system', content: state.settings.systemPrompt.trim() });
  }
  for (const message of conv.messages) {
    if (message.id === excludeId || message.error) continue;
    if (!message.content.trim()) continue;
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function setStreamingUI(active) {
  dom.sendBtn.classList.toggle('streaming', active);
  dom.sendBtn.setAttribute('aria-label', active ? '停止生成' : '发送');
  updateComposerHint();
}

function queuePaint(convId, messageId) {
  if (state.paintQueued) return;
  state.paintQueued = true;
  requestAnimationFrame(() => {
    state.paintQueued = false;
    const conv = state.conversations.find((item) => item.id === convId);
    const message = conv?.messages.find((item) => item.id === messageId);
    const article = dom.messages.querySelector(`[data-msg-id="${CSS.escape(messageId)}"]`);
    if (!message || !article) return;
    const lastAssistantId = [...conv.messages].reverse().find((m) => m.role === 'assistant')?.id;
    paintAssistant(article, message, message.id === lastAssistantId);
    scrollToBottom();
  });
}

function scrollToBottom(force = false) {
  const el = dom.chatScroll;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 180;
  if (force || near) el.scrollTop = el.scrollHeight;
}

function ensureAssistantElement(conv, message) {
  let article = dom.messages.querySelector(`[data-msg-id="${CSS.escape(message.id)}"]`);
  if (!article) {
    dom.welcome.hidden = true;
    dom.messages.hidden = false;
    article = createMessageElement(message, true);
    dom.messages.appendChild(article);
    scrollToBottom(true);
  }
  return article;
}

async function streamAssistant(conv, assistant) {
  if (PAGES_MODE && !state.settings.apiKey.trim()) {
    toast('请先在设置中填写 API Key', 'error');
    return;
  }

  const controller = new AbortController();
  state.streaming = { convId: conv.id, msgId: assistant.id, controller };
  assistant.streaming = true;
  assistant.startedAt = Date.now();
  setStreamingUI(true);
  ensureAssistantElement(conv, assistant);

  const headers = { 'Content-Type': 'application/json' };
  if (state.settings.apiKey.trim()) headers.Authorization = `Bearer ${state.settings.apiKey.trim()}`;
  if (!PAGES_MODE && state.settings.baseUrl.trim()) headers['x-api-base'] = state.settings.baseUrl.trim();

  const deepThink = Boolean(assistant.deepThink);
  const body = {
    model: assistant.model,
    messages: historyForApi(conv, assistant.id),
    temperature: state.settings.temperature,
    reasoning_effort: deepThink ? 'high' : 'none',
  };
  if (PAGES_MODE) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  try {
    const response = await fetch(chatEndpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let message = `请求失败（HTTP ${response.status}）`;
      try {
        const payload = await response.json();
        message = payload?.error?.message || message;
      } catch {
        /* non-JSON error */
      }
      throw new Error(message);
    }

    if (!response.body) throw new Error('当前浏览器不支持流式响应。');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let firstContentAt = 0;
    let finished = false;

    const handleEvent = (raw) => {
      const dataLines = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) return;

      const data = dataLines.join('\n');
      if (data === '[DONE]') {
        finished = true;
        return;
      }

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        return;
      }

      if (payload?.error) {
        throw new Error(payload.error.message || 'DeepSeek API 返回错误。');
      }

      const choice = payload?.choices?.[0];
      if (choice?.delta) {
        if (choice.delta.reasoning_content && deepThink) {
          assistant.reasoning += choice.delta.reasoning_content;
        }
        if (choice.delta.content) {
          if (!firstContentAt) firstContentAt = Date.now();
          assistant.content += choice.delta.content;
        }
        if (choice.finish_reason) finished = true;
        queuePaint(conv.id, assistant.id);
      }

      if (payload?.usage) {
        assistant.tokens = {
          prompt: payload.usage.prompt_tokens,
          completion: payload.usage.completion_tokens,
          total: payload.usage.total_tokens,
        };
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleEvent(event);
        boundary = buffer.indexOf('\n\n');
      }
      if (finished) break;
    }

    if (buffer.trim()) handleEvent(buffer);

    if (!assistant.content && !assistant.reasoning) {
      throw new Error('模型没有返回内容，请稍后重试。');
    }

    assistant.streaming = false;
    assistant.thinkingMs = assistant.thinkingMs || (firstContentAt ? firstContentAt - assistant.startedAt : Date.now() - assistant.startedAt);
    assistant.updatedAt = Date.now();
    syncTurnBranch(conv, assistant);
    conv.updatedAt = Date.now();
    persist();
    renderConversation({ keepScroll: true });
    renderSidebar();
    scrollToBottom();
  } catch (error) {
    assistant.streaming = false;
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    if (aborted) {
      assistant.stopped = true;
      if (!assistant.content && !assistant.reasoning) {
        conv.messages = conv.messages.filter((item) => item.id !== assistant.id);
        removeTurnBranch(conv, assistant.id);
      } else {
        syncTurnBranch(conv, assistant);
      }
      conv.updatedAt = Date.now();
      persist();
      renderConversation({ keepScroll: true });
      renderSidebar();
      toast('已停止生成');
    } else {
      assistant.error = error.message || '未知错误';
      syncTurnBranch(conv, assistant);
      conv.updatedAt = Date.now();
      persist();
      renderConversation({ keepScroll: true });
      renderSidebar();
      toast(assistant.error, 'error');
    }
  } finally {
    if (state.streaming?.msgId === assistant.id) state.streaming = null;
    setStreamingUI(false);
    updateComposerHint();
  }
}

function createAssistantMessage() {
  return {
    id: uid(),
    role: 'assistant',
    content: '',
    reasoning: '',
    model: state.settings.model,
    deepThink: Boolean(state.settings.deepThink),
    ts: Date.now(),
    streaming: true,
    startedAt: Date.now(),
  };
}

async function sendMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || state.streaming) return;

  if (!hasApiKey()) {
    toast('请先配置 DeepSeek API Key', 'error');
    openSettings();
    return;
  }

  let conv = activeConversation();
  if (!conv) {
    conv = {
      id: uid(),
      title: titleFrom(text),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.conversations.unshift(conv);
    state.activeId = conv.id;
  }

  const userMessage = {
    id: uid(),
    role: 'user',
    content: text,
    ts: Date.now(),
    model: state.settings.model,
  };
  const assistant = createAssistantMessage();

  conv.messages.push(userMessage, assistant);
  conv.updatedAt = Date.now();
  if (conv.title === '新对话' || !conv.title) conv.title = titleFrom(text);
  if (conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = titleFrom(text);

  dom.input.value = '';
  autosizeInput();
  state.activeId = conv.id;
  persist();
  renderSidebar();
  renderConversation({ keepScroll: true });
  scrollToBottom(true);

  await streamAssistant(conv, assistant);
}

function stopStreaming() {
  state.streaming?.controller.abort();
}

async function regenerate(targetId = null) {
  if (state.streaming) return;
  const conv = activeConversation();
  if (!conv || !conv.messages.length) return;
  if (!hasApiKey()) {
    toast('请先配置 DeepSeek API Key', 'error');
    openSettings();
    return;
  }

  let targetIndex = -1;
  if (targetId) {
    targetIndex = conv.messages.findIndex((message) => message.id === targetId);
  } else {
    for (let i = conv.messages.length - 1; i >= 0; i -= 1) {
      if (conv.messages[i].role === 'assistant') {
        targetIndex = i;
        break;
      }
    }
  }

  let userIndex = -1;
  const start = targetIndex >= 0 ? targetIndex - 1 : conv.messages.length - 1;
  for (let i = start; i >= 0; i -= 1) {
    if (conv.messages[i].role === 'user') {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return;

  const userMessage = conv.messages[userIndex];
  const existingBranches = conv.turnBranches?.[userMessage.id]?.branches || [];
  const regenCount = existingBranches.filter((branch) => branch.label.startsWith('重新生成')).length;
  saveTurnBranch(conv, userIndex, '原始回答');
  conv.messages = conv.messages.slice(0, userIndex + 1);
  const assistant = createAssistantMessage();
  conv.messages.push(assistant);
  createTurnBranch(conv, userIndex, assistant, regenCount ? `重新生成 ${regenCount + 1}` : '重新生成');
  pruneTurnBranches(conv);
  state.tocTurnId = userMessage.id;
  conv.updatedAt = Date.now();
  persist();
  renderSidebar();
  renderConversation({ keepScroll: true });
  toast('旧回答已保留为版本，可用回答上方的箭头切换');
  await streamAssistant(conv, assistant);
}

/* ============================================================
   Settings modal
   ============================================================ */

let lastFocusedBeforeModal = null;

function openSettings() {
  lastFocusedBeforeModal = document.activeElement;
  dom.apiKeyInput.value = state.settings.apiKey;
  dom.apiKeyInput.type = 'password';
  dom.baseUrlInput.value = state.settings.baseUrl;
  dom.modelSelect.value = state.settings.model;
  dom.tempInput.value = String(state.settings.temperature);
  dom.tempValue.textContent = Number(state.settings.temperature).toFixed(1);
  dom.systemPromptInput.value = state.settings.systemPrompt;
  dom.testResult.textContent = '';
  dom.testResult.className = 'test-result';
  dom.serverKeyBadge.hidden = !state.serverKey;
  dom.settingsModal.hidden = false;
  setTimeout(() => dom.apiKeyInput.focus(), 40);
}

function closeSettings() {
  dom.settingsModal.hidden = true;
  lastFocusedBeforeModal?.focus?.();
}

function normalizeBaseUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function apiBaseForPages(explicitBase) {
  const candidate = explicitBase === undefined ? state.settings.baseUrl : explicitBase;
  return normalizeBaseUrl(candidate) || PAGES_API_BASE;
}

function chatEndpoint() {
  return PAGES_MODE ? `${apiBaseForPages()}/chat/completions` : '/api/chat';
}

function modelsEndpoint(explicitBase) {
  return PAGES_MODE ? `${apiBaseForPages(explicitBase)}/models` : '/api/models';
}

async function testConnection() {
  const base = normalizeBaseUrl(dom.baseUrlInput.value);
  if (base === null) {
    dom.testResult.textContent = 'API 地址格式不正确';
    dom.testResult.className = 'test-result err';
    return;
  }

  dom.testBtn.disabled = true;
  dom.testBtn.textContent = '连接中…';
  dom.testResult.textContent = '';
  dom.testResult.className = 'test-result';

  const headers = {};
  const key = dom.apiKeyInput.value.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (!PAGES_MODE && base) headers['x-api-base'] = base;

  if (PAGES_MODE && !key) {
    dom.testResult.textContent = '请先填写 API Key';
    dom.testResult.className = 'test-result err';
    dom.testBtn.disabled = false;
    dom.testBtn.textContent = '测试连接';
    return;
  }

  try {
    const response = await fetch(modelsEndpoint(base), { headers });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      const names = Array.isArray(payload.data)
        ? payload.data.map((model) => model.id).filter(Boolean)
        : [];
      dom.testResult.textContent = names.length
        ? `连接成功 · ${names.slice(0, 3).join(' / ')}`
        : '连接成功';
      dom.testResult.className = 'test-result ok';
    } else {
      dom.testResult.textContent = payload?.error?.message || `连接失败（HTTP ${response.status}）`;
      dom.testResult.className = 'test-result err';
    }
  } catch (error) {
    dom.testResult.textContent = `连接失败：${error.message}`;
    dom.testResult.className = 'test-result err';
  } finally {
    dom.testBtn.disabled = false;
    dom.testBtn.textContent = '测试连接';
  }
}

function saveSettingsFromModal() {
  const base = normalizeBaseUrl(dom.baseUrlInput.value);
  if (base === null) {
    toast('API 地址格式不正确', 'error');
    dom.baseUrlInput.focus();
    return;
  }

  state.settings.apiKey = dom.apiKeyInput.value.trim();
  state.settings.baseUrl = base;
  state.settings.model = normalizeModel(dom.modelSelect.value);
  state.settings.temperature = Number(dom.tempInput.value);
  state.settings.systemPrompt = dom.systemPromptInput.value.trim();

  saveSettings();
  updateModelUI();
  updateKeyState();
  closeSettings();
  toast('设置已保存');
}

function clearAllData() {
  if (!confirm('清除所有本地对话与设置？此操作无法撤销。')) return;
  Object.values(STORAGE).forEach((key) => localStorage.removeItem(key));
  state.conversations = [];
  state.activeId = null;
  state.settings = { ...DEFAULT_SETTINGS };
  closeSettings();
  renderSidebar();
  renderConversation();
  updateModelUI();
  updateKeyState();
  toast('本地数据已清除');
}

/* ============================================================
   Copy / export
   ============================================================ */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('已复制到剪贴板');
    } catch {
      toast('复制失败，请手动选择文本', 'error');
    }
    area.remove();
  }
}

function copyCode(button) {
  const code = $('pre code', button.closest('.code-block'))?.textContent || '';
  copyText(code);
}

function exportConversation() {
  const conv = activeConversation();
  if (!conv || !conv.messages.length) {
    toast('当前没有可导出的对话', 'error');
    return;
  }

  const lines = [`# ${conv.title}`, '', `> 导出自 DeepSeek Chatbox · ${new Date().toLocaleString()}`, ''];
  for (const message of conv.messages) {
    if (message.role === 'user') {
      lines.push('## 我', '', message.content, '');
    } else {
      lines.push(`## ${MODEL_META[message.model]?.label || 'DeepSeek'}`, '');
      if (message.reasoning) {
        lines.push('<details><summary>深度思考过程</summary>', '', message.reasoning, '', '</details>', '');
      }
      lines.push(message.content || '（无内容）', '');
    }
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, `${conv.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || 'deepseek-chatbox'}.md`);
  toast('对话已导出为 Markdown');
}

/* ============================================================
   ZIP backup / restore
   ============================================================ */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function backupStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function backupReadme(count, exportedAt) {
  return [
    'DeepSeek Chatbox 对话备份',
    '========================',
    '',
    `导出时间：${exportedAt}`,
    `对话数量：${count}`,
    '',
    '目录说明：',
    '  manifest.json          备份清单（格式版本、对话摘要、文件对应关系）',
    '  conversations/*.json   每个对话一个 JSON 文件，包含完整消息与思考过程',
    '',
    '导入方式：',
    '  打开 DeepSeek Chatbox → 右上角「导入 / 导出」→「导入对话 ZIP」',
    '  导入会与浏览器里已有的对话合并，不会删除现有记录。',
    '',
    '注意：备份里可能包含聊天内容，请妥善保管，不要上传到公开位置。',
    '',
  ].join('\r\n');
}

function exportAllZip() {
  if (state.streaming) {
    toast('请先停止当前生成，再导出备份', 'error');
    return;
  }

  const conversations = state.conversations
    .slice(0, MAX_CONVERSATIONS)
    .map(normalizeConversation)
    .filter(Boolean);
  if (!conversations.length) {
    toast('还没有可导出的对话', 'error');
    return;
  }

  const now = new Date();
  const exportedAt = now.toISOString();
  const files = [];
  const manifestItems = [];

  conversations.forEach((conv, index) => {
    const file = `conversations/${String(index + 1).padStart(3, '0')}.json`;
    files.push({
      name: file,
      data: JSON.stringify(
        { format: CONVERSATION_FORMAT, version: BACKUP_VERSION, conversation: conv },
        null,
        2,
      ),
    });
    manifestItems.push({
      file,
      id: conv.id,
      title: conv.title,
      messages: conv.messages.length,
      createdAt: new Date(conv.createdAt).toISOString(),
      updatedAt: new Date(conv.updatedAt).toISOString(),
    });
  });

  files.unshift(
    {
      name: 'manifest.json',
      data: JSON.stringify(
        {
          format: BACKUP_FORMAT,
          version: BACKUP_VERSION,
          app: 'DeepSeek Chatbox',
          exportedAt,
          conversationCount: conversations.length,
          conversations: manifestItems,
        },
        null,
        2,
      ),
    },
    { name: 'README.txt', data: backupReadme(conversations.length, now.toLocaleString()) },
  );

  try {
    const blob = createZip(files);
    downloadBlob(blob, `deepseek-chatbox-backup-${backupStamp(now)}.zip`);
    toast(`已导出 ${conversations.length} 个对话（ZIP）`);
  } catch (error) {
    toast(`导出失败：${error.message || '未知错误'}`, 'error');
  }
}

function fragmentText(fragments, type) {
  return fragments
    .filter((fragment) => fragment && fragment.type === type && typeof fragment.content === 'string')
    .map((fragment) => fragment.content.trim())
    .filter(Boolean)
    .join('\n\n');
}

function fragmentFileNote(fragments) {
  const files = fragments
    .filter((fragment) => fragment && fragment.type === 'FILE' && Array.isArray(fragment.files))
    .flatMap((fragment) => fragment.files)
    .filter(Boolean);
  if (!files.length) return '';
  const names = files.slice(0, 3).map((file) => String(file.file_name || '附件'));
  const suffix = files.length > 3 ? ` 等 ${files.length} 个` : '';
  return `\n\n_[附件：${names.join('、')}${suffix}]_`;
}

// Chatbox's JSON export uses `chat_sessions/*.json`, uppercase roles and
// `fragments` (REQUEST / RESPONSE / THINK / FILE) instead of `content`.
function convertExternalChatSession(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages)) return null;
  if (!value.messages.some((message) => Array.isArray(message?.fragments))) return null;

  const messages = [];
  for (const raw of value.messages) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fragments)) continue;
    const role = String(raw.role || '').toLowerCase();
    if (role !== 'user' && role !== 'assistant') continue;

    const content =
      role === 'user'
        ? fragmentText(raw.fragments, 'REQUEST') + fragmentFileNote(raw.fragments)
        : fragmentText(raw.fragments, 'RESPONSE');
    const reasoning = role === 'assistant' ? fragmentText(raw.fragments, 'THINK') : '';
    if (!content.trim() && !reasoning.trim()) continue;

    const think = raw.fragments.find((fragment) => fragment && fragment.type === 'THINK');
    const elapsed = Number(think?.elapsed_secs);
    const timestamp = Date.parse(raw.inserted_at) || 0;
    messages.push({
      id: String(raw.id ?? uid()),
      role,
      content,
      reasoning,
      model: 'deepseek-flash',
      deepThink: Boolean(raw.thinking_enabled || reasoning),
      ts: timestamp || Date.now(),
      error: '',
      stopped: false,
      tokens: null,
      thinkingMs: Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed * 1000) : 0,
    });
  }
  if (!messages.length) return null;

  const createdAt = Date.parse(value.inserted_at) || messages[0].ts || Date.now();
  const updatedAt = Date.parse(value.updated_at) || messages[messages.length - 1].ts || createdAt;
  return {
    id: String(value.id || uid()),
    title: String(value.title || '导入的对话').slice(0, 200) || '导入的对话',
    createdAt,
    updatedAt,
    messages,
  };
}

function collectBackupConversations(value, output) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectBackupConversations(item, output));
    return;
  }
  if (!value || typeof value !== 'object') return;

  if (value.format === CONVERSATION_FORMAT && value.conversation) {
    collectBackupConversations(value.conversation, output);
    return;
  }
  if (value.format === BACKUP_FORMAT && Array.isArray(value.conversations)) {
    value.conversations.forEach((item) => collectBackupConversations(item, output));
    return;
  }
  if (Array.isArray(value.chat_sessions)) {
    value.chat_sessions.forEach((item) => collectBackupConversations(item, output));
    return;
  }

  const external = convertExternalChatSession(value);
  if (external) {
    output.push(external);
    return;
  }
  if (Array.isArray(value.messages)) {
    output.push(value);
    return;
  }
  if (Array.isArray(value.conversations)) {
    value.conversations.forEach((item) => collectBackupConversations(item, output));
  }
}

async function readBackupEntries(file) {
  const lower = file.name.toLowerCase();

  if (lower.endsWith('.json')) {
    return [{ name: file.name, text: await file.text() }];
  }
  if (!lower.endsWith('.zip') && !/zip/i.test(file.type)) {
    throw new Error('请选择 .zip 或 .json 备份文件');
  }

  const entries = await readZip(file, {
    maxEntries: 500,
    maxFileSize: 20 * 1024 * 1024,
    maxTotalSize: 100 * 1024 * 1024,
  });
  const decoder = new TextDecoder('utf-8');
  const texts = [];
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/').toLowerCase();
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('__macosx/') || name.includes('/__macosx/')) continue;
    texts.push({ name: entry.name, text: decoder.decode(entry.data) });
  }
  return texts;
}

async function importChatArchive(file) {
  if (!file) return;
  if (state.streaming) {
    toast('请先停止当前生成，再导入备份', 'error');
    return;
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    toast('备份文件太大（最多 60 MB）', 'error');
    return;
  }

  let entries;
  try {
    entries = await readBackupEntries(file);
  } catch (error) {
    toast(`读取失败：${error.message || '不是有效的 ZIP'}`, 'error');
    return;
  }

  const rawConversations = [];
  let invalidEntries = 0;
  for (const entry of entries) {
    const base = entry.name.replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (base === 'manifest.json') continue;
    try {
      const parsed = JSON.parse(entry.text);
      const found = [];
      collectBackupConversations(parsed, found);
      if (!found.length) invalidEntries += 1;
      rawConversations.push(...found);
    } catch {
      invalidEntries += 1;
    }
  }

  const imported = [];
  const seen = new Set();
  for (const raw of rawConversations) {
    const conv = normalizeConversation(raw);
    if (!conv || seen.has(conv.id)) {
      invalidEntries += 1;
      continue;
    }
    seen.add(conv.id);
    imported.push(conv);
  }

  if (!imported.length) {
    toast('ZIP 里没有找到可导入的对话', 'error');
    return;
  }

  const byId = new Map(state.conversations.map((conv) => [conv.id, conv]));
  const next = state.conversations.slice();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let limitSkipped = 0;

  for (const conv of imported) {
    const existing = byId.get(conv.id);
    if (existing) {
      if (conv.updatedAt > existing.updatedAt) {
        const index = next.findIndex((item) => item.id === existing.id);
        if (index >= 0) next[index] = conv;
        byId.set(conv.id, conv);
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    if (next.length >= MAX_CONVERSATIONS) {
      limitSkipped += 1;
      continue;
    }
    next.push(conv);
    byId.set(conv.id, conv);
    added += 1;
  }

  if (!added && !updated) {
    const detail = skipped ? `，已跳过 ${skipped} 个重复或较旧的对话` : '';
    toast(`没有新的对话可导入${detail}`, 'error');
    return;
  }

  const summary = [
    `找到 ${imported.length} 个对话：新增 ${added} 个，更新 ${updated} 个。`,
    skipped ? `跳过 ${skipped} 个重复或较旧的对话。` : '',
    limitSkipped ? `因最多保留 ${MAX_CONVERSATIONS} 个对话，忽略 ${limitSkipped} 个。` : '',
    '',
    '导入会与现有对话合并，不会删除已有记录。继续吗？',
  ]
    .filter(Boolean)
    .join('\n');
  if (!confirm(summary)) return;

  const previous = state.conversations;
  const previousActive = state.activeId;
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  state.conversations = next;
  if (!state.activeId || !next.some((conv) => conv.id === state.activeId)) {
    state.activeId = next[0]?.id || null;
  }

  if (!persist()) {
    state.conversations = previous;
    state.activeId = previousActive;
    toast('导入失败：浏览器本地存储空间不足，请先清理旧对话', 'error');
    return;
  }

  renderSidebar();
  renderConversation();
  const details = [`新增 ${added} 个`, updated ? `更新 ${updated} 个` : '', invalidEntries ? `忽略 ${invalidEntries} 个无效或重复条目` : '']
    .filter(Boolean)
    .join('，');
  toast(`导入完成：${details}`);
}

/* ============================================================
   Demo preview (open /?demo=1 to see a populated conversation)
   ============================================================ */

function maybeSeedDemo() {
  if (!state.demo || state.conversations.length) return;
  const now = Date.now();
  const conv = {
    id: 'demo-conversation',
    title: '用三句话解释大语言模型',
    createdAt: now - 120000,
    updatedAt: now,
    messages: [
      {
        id: 'demo-user',
        role: 'user',
        content: '用三句话解释一下什么是大语言模型，再给我一个 Python 小例子。',
        ts: now - 110000,
        model: 'deepseek-flash',
        deepThink: true,
      },
      {
        id: 'demo-assistant',
        role: 'assistant',
        model: 'deepseek-flash',
        deepThink: true,
        reasoning:
          '用户希望用三句话解释大语言模型，并且要一个 Python 小例子。\n\n先给出三个关键点：大规模文本训练、预测下一个词、具备通用语言能力。然后写一个调用 DeepSeek API 的最小示例，并解释代码。',
        thinkingMs: 4200,
        content: `大语言模型（LLM）可以这样理解：

1. **规模很大**：它在海量文本上训练，见过大量语言模式。
2. **本质是预测**：根据上文预测下一个最可能的词，逐字生成回答。
3. **能力通用**：同一个模型可以写代码、翻译、总结和推理。

下面是一个调用 DeepSeek API 的最小 Python 示例：

\`\`\`python
from openai import OpenAI

client = OpenAI(
    api_key="sk-...",
    base_url="https://api.deepseek.com",
)

response = client.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "你是一位简洁的中文助手。"},
        {"role": "user", "content": "用一句话解释什么是大语言模型。"},
    ],
)

print(response.choices[0].message.content)
\`\`\`

> 提示：把 \`api_key\` 换成你自己的 Key，不要把它硬编码到公开仓库里。`,
        ts: now - 100000,
        tokens: { prompt: 42, completion: 268, total: 310 },
      },
    ],
  };
  state.conversations = [conv];
  state.activeId = conv.id;
}

/* ============================================================
   Event wiring
   ============================================================ */

function wireEvents() {
  dom.newChat.addEventListener('click', newChat);
  dom.menuBtn.addEventListener('click', openSidebar);
  dom.closeSidebar.addEventListener('click', closeSidebar);
  dom.scrim.addEventListener('click', closeSidebar);
  dom.themeBtn.addEventListener('click', toggleTheme);
  dom.exportBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDataMenu();
  });
  dom.tocBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleToc();
  });
  dom.tocClose.addEventListener('click', () => toggleToc(false));
  dom.tocList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-toc-id]');
    if (!item) return;
    jumpToTocMessage(item.dataset.tocId);
  });
  dom.tocBranchList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-branch-id]');
    if (!item) return;
    switchTurnBranch(state.tocTurnId, item.dataset.branchId);
  });
  let tocScrollFrame = 0;
  dom.chatScroll.addEventListener(
    'scroll',
    () => {
      if (tocScrollFrame) return;
      tocScrollFrame = requestAnimationFrame(() => {
        tocScrollFrame = 0;
        syncTocActive();
      });
    },
    { passive: true },
  );
  dom.dataMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-data-action]');
    if (!item) return;
    toggleDataMenu(false);
    const action = item.dataset.dataAction;
    if (action === 'export-zip') exportAllZip();
    if (action === 'export-md') exportConversation();
    if (action === 'import-zip') dom.zipInput.click();
  });
  dom.zipInput.addEventListener('change', async () => {
    const file = dom.zipInput.files?.[0];
    dom.zipInput.value = '';
    if (file) await importChatArchive(file);
  });
  dom.exportZipBtn.addEventListener('click', exportAllZip);
  dom.importZipBtn.addEventListener('click', () => dom.zipInput.click());
  dom.settingsBtn.addEventListener('click', openSettings);
  dom.welcomeKeyHint.addEventListener('click', openSettings);

  dom.search.addEventListener('input', () => {
    state.search = dom.search.value;
    renderSidebar();
  });

  dom.convList.addEventListener('click', (event) => {
    const item = event.target.closest('.conv-item');
    if (!item) return;
    if (event.target.closest('.conv-delete')) {
      event.stopPropagation();
      deleteConversation(item.dataset.id);
      return;
    }
    switchConversation(item.dataset.id);
  });

  dom.convList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const item = event.target.closest('.conv-item');
    if (!item || event.target !== item) return;
    event.preventDefault();
    switchConversation(item.dataset.id);
  });

  dom.modelBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleModelMenu();
  });

  dom.modelMenu.addEventListener('click', (event) => {
    const option = event.target.closest('.model-option');
    if (!option) return;
    setModel(option.dataset.model);
    toggleModelMenu(false);
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.model-wrap')) toggleModelMenu(false);
    if (!event.target.closest('.data-wrap')) toggleDataMenu(false);
    if (!event.target.closest('.toc-wrap')) toggleToc(false);
  });

  dom.thinkToggle.addEventListener('click', toggleDeepThink);

  dom.input.addEventListener('input', autosizeInput);
  dom.input.addEventListener('compositionstart', () => {
    dom.input.dataset.composing = 'true';
  });
  dom.input.addEventListener('compositionend', () => {
    delete dom.input.dataset.composing;
  });
  dom.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || dom.input.dataset.composing === 'true') return;
    event.preventDefault();
    dom.composer.requestSubmit();
  });

  dom.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.streaming) {
      stopStreaming();
      return;
    }
    sendMessage(dom.input.value);
  });

  $$('.suggestion').forEach((button) => {
    button.addEventListener('click', () => {
      dom.input.value = button.dataset.prompt || '';
      autosizeInput();
      dom.input.focus();
    });
  });

  dom.messages.addEventListener('click', (event) => {
    const codeButton = event.target.closest('[data-copy-code]');
    if (codeButton) {
      copyCode(codeButton);
      return;
    }

    const turnArrow = event.target.closest('[data-turn-dir]');
    if (turnArrow) {
      const nav = turnArrow.closest('.turn-nav');
      if (nav) switchTurnBranch(nav.dataset.turnId, Number(turnArrow.dataset.turnDir));
      return;
    }

    const action = event.target.closest('.msg-action, [data-action="regenerate"]');
    if (!action) return;
    const article = action.closest('.msg');
    if (!article) return;
    const conv = activeConversation();
    const message = conv?.messages.find((item) => item.id === article.dataset.msgId);
    if (!message) return;

    if (action.dataset.action === 'copy') copyText(message.content);
    if (action.dataset.action === 'edit') beginEditMessage(article, message);
    if (action.dataset.action === 'regenerate') regenerate(message.id);
  });

  // Settings
  $$('[data-close-settings]').forEach((el) => el.addEventListener('click', closeSettings));
  dom.toggleKey.addEventListener('click', () => {
    dom.apiKeyInput.type = dom.apiKeyInput.type === 'password' ? 'text' : 'password';
    dom.toggleKey.setAttribute(
      'aria-label',
      dom.apiKeyInput.type === 'password' ? '显示 API Key' : '隐藏 API Key',
    );
  });
  dom.tempInput.addEventListener('input', () => {
    dom.tempValue.textContent = Number(dom.tempInput.value).toFixed(1);
  });
  dom.testBtn.addEventListener('click', testConnection);
  dom.saveSettingsBtn.addEventListener('click', saveSettingsFromModal);
  dom.clearDataBtn.addEventListener('click', clearAllData);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!dom.settingsModal.hidden) closeSettings();
      if (!dom.modelMenu.hidden) toggleModelMenu(false);
      if (!dom.dataMenu.hidden) toggleDataMenu(false);
      if (!dom.tocPanel.hidden) toggleToc(false);
      closeSidebar();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      dom.search.focus();
    }
  });
}

/* ============================================================
   Boot
   ============================================================ */

async function checkHealth() {
  if (PAGES_MODE) {
    state.serverKey = false;
    state.serverBase = PAGES_API_BASE;
    updateKeyState();
    return;
  }
  try {
    const response = await fetch('/api/health');
    if (!response.ok) return;
    const payload = await response.json();
    state.serverKey = Boolean(payload.hasServerKey);
    state.serverBase = payload.baseUrl || state.serverBase;
  } catch {
    /* offline or static host */
  }
  updateKeyState();
}

function boot() {
  initTheme();
  maybeSeedDemo();
  wireEvents();
  updateModelUI();
  updateKeyState();
  renderSidebar();
  renderConversation();
  autosizeInput();
  checkHealth();

  if (!state.demo && window.matchMedia('(min-width: 901px)').matches) {
    setTimeout(() => dom.input.focus(), 80);
  }
}

boot();
