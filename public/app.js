/* ============================================================
   DeepSeek Chatbox — front-end application
   No framework, no build step.
   ============================================================ */

import { createZip, readZipEntries } from './zip.js';

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
  webSearch: false,
  temperature: 1,
  systemPrompt: '',
};

const MAX_CONVERSATIONS = 80;
const BACKUP_FORMAT = 'deepseek-chatbox-backup';
const CONVERSATION_FORMAT = 'deepseek-chatbox-conversation';
const BACKUP_VERSION = 1;
const MAX_IMPORT_FILE_BYTES = 200 * 1024 * 1024;
const MAX_IMPORT_FILE_SIZE = 100 * 1024 * 1024;
const MAX_IMPORT_TOTAL_SIZE = 300 * 1024 * 1024;
const MAX_IMPORT_ENTRIES = 2000;
const MAX_TURN_EDITS = 10;
const MAX_TURN_REGENS = 10;
const MAX_TURN_BRANCHES = 240;
const MAX_IMAGES = 4;
const MAX_HISTORY_IMAGES = 8;
const MAX_IMAGE_DIMENSION = 1600;
const IMAGE_QUALITY = 0.86;
const MAX_IMAGE_FILE_BYTES = 24 * 1024 * 1024;

const MODEL_META = {
  'deepseek-flash': {
    label: 'DeepSeek-V4.1-Flash',
    short: 'V4.1-Flash',
    contextWindow: 1048576,
    vision: true,
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek-V4-Pro',
    short: 'V4-Pro',
    contextWindow: 1048576,
    vision: false,
  },
};

const DEFAULT_CONTEXT_WINDOW = 1048576;

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

/* Conversations live in IndexedDB rather than localStorage: a long chat,
   branches and copied conversations can exceed the ~5 MB localStorage cap.
   localStorage is still used as a one-time migration source and as a
   fallback when IndexedDB is unavailable. */
const CONVERSATION_DB_NAME = 'dsc.chatbox.v1';
const CONVERSATION_DB_VERSION = 2;
const CONVERSATION_DB_STORE = 'conversations';
const CONVERSATION_DB_KEY = 'all';
const CONVERSATION_RECORD_STORE = 'conversation_records';

let conversationDbPromise = null;
let conversationWriteChain = Promise.resolve();
let conversationStoreFallback = false;
let conversationRevisions = new Map();

function conversationRevision(conv) {
  return [
    Number(conv?.updatedAt) || 0,
    conv?.messages?.length || 0,
    conv?.title || '',
    Object.keys(conv?.turnBranches || {}).length,
  ].join('|');
}

function rememberConversationRevisions(conversations) {
  conversationRevisions = new Map(
    conversations.map((conv) => [conv.id, conversationRevision(conv)]),
  );
}

function openConversationDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
  if (conversationDbPromise) return conversationDbPromise;
  conversationDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CONVERSATION_DB_NAME, CONVERSATION_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CONVERSATION_DB_STORE)) {
        db.createObjectStore(CONVERSATION_DB_STORE);
      }
      if (!db.objectStoreNames.contains(CONVERSATION_RECORD_STORE)) {
        db.createObjectStore(CONVERSATION_RECORD_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return conversationDbPromise;
}

async function readConversationRecords() {
  const db = await openConversationDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATION_RECORD_STORE, 'readonly');
    const request = tx.objectStore(CONVERSATION_RECORD_STORE).getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
  });
}

async function readLegacyConversations() {
  const db = await openConversationDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATION_DB_STORE, 'readonly');
    const request = tx.objectStore(CONVERSATION_DB_STORE).get(CONVERSATION_DB_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
  });
}

async function readConversationDb() {
  const records = await readConversationRecords();
  const legacy = await readLegacyConversations();
  if (Array.isArray(legacy) && legacy.length) {
    const merged = new Map(records.map((conv) => [conv.id, conv]));
    legacy.forEach((conv) => {
      if (conv?.id && !merged.has(conv.id)) merged.set(conv.id, conv);
    });
    const all = [...merged.values()];
    await writeConversationDb(all);
    return all;
  }
  return records;
}

async function writeConversationDb(conversations) {
  const db = await openConversationDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_RECORD_STORE, CONVERSATION_DB_STORE], 'readwrite');
    const records = tx.objectStore(CONVERSATION_RECORD_STORE);
    records.clear();
    conversations.forEach((conv) => records.put(conv));
    tx.objectStore(CONVERSATION_DB_STORE).delete(CONVERSATION_DB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
}

async function writeConversationChanges(changes, deletions) {
  const db = await openConversationDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATION_RECORD_STORE, 'readwrite');
    const records = tx.objectStore(CONVERSATION_RECORD_STORE);
    changes.forEach((conv) => records.put(conv));
    deletions.forEach((id) => records.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
}

async function putConversationRecord(conversation) {
  const db = await openConversationDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONVERSATION_RECORD_STORE, 'readwrite');
    tx.objectStore(CONVERSATION_RECORD_STORE).put(conversation);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  });
}

async function clearConversationDb() {
  const db = await openConversationDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_RECORD_STORE, CONVERSATION_DB_STORE], 'readwrite');
    tx.objectStore(CONVERSATION_RECORD_STORE).clear();
    tx.objectStore(CONVERSATION_DB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed'));
  });
}

function queueConversationSave() {
  const snapshot = state.conversations.slice(0, MAX_CONVERSATIONS);
  if (!('indexedDB' in window) || conversationStoreFallback) {
    return writeStorage(STORAGE.conversations, snapshot);
  }

  const ids = new Set(snapshot.map((conv) => conv.id));
  const changes = snapshot.filter(
    (conv) =>
      conv.id === state.activeId ||
      conversationRevision(conv) !== conversationRevisions.get(conv.id),
  );
  const deletions = [...conversationRevisions.keys()].filter((id) => !ids.has(id));

  if (!changes.length && !deletions.length) return true;

  conversationWriteChain = conversationWriteChain
    .catch(() => {})
    .then(async () => {
      try {
        await writeConversationChanges(changes, deletions);
        changes.forEach((conv) => {
          conversationRevisions.set(conv.id, conversationRevision(conv));
        });
        deletions.forEach((id) => conversationRevisions.delete(id));
      } catch (error) {
        conversationStoreFallback = true;
        console.warn('IndexedDB write failed; falling back to localStorage', error);
        if (!writeStorage(STORAGE.conversations, snapshot)) {
          toast('保存失败：浏览器存储空间不足，请先导出备份并清理旧对话', 'error');
        }
      }
    });
  return true;
}

function saveActiveConversationId() {
  try {
    if (state.activeId) localStorage.setItem(STORAGE.active, state.activeId);
    else localStorage.removeItem(STORAGE.active);
  } catch (error) {
    console.warn('localStorage active write failed', error);
  }
}

async function initConversationStore() {
  if (state.demo || !('indexedDB' in window)) return;
  try {
    const stored = await readConversationDb();
    let migrated = false;
    if (Array.isArray(stored) && stored.length) {
      state.conversations = stored
        .map(normalizeConversation)
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      rememberConversationRevisions(state.conversations);
    } else if (state.conversations.length) {
      await writeConversationDb(state.conversations.slice(0, MAX_CONVERSATIONS));
      rememberConversationRevisions(state.conversations);
      migrated = true;
    } else {
      rememberConversationRevisions(state.conversations);
    }
    localStorage.removeItem(STORAGE.conversations);
    if (!state.conversations.some((conv) => conv.id === state.activeId)) {
      state.activeId = state.conversations[0]?.id || null;
      saveActiveConversationId();
    }
    if (migrated) toast('对话已迁移到浏览器数据库，容量更大');
  } catch (error) {
    conversationStoreFallback = true;
    console.warn('IndexedDB unavailable; keeping localStorage storage', error);
  }
}

function loadSettings() {
  const saved = readStorage(STORAGE.settings, {});
  const model = normalizeModel(saved?.model);
  return {
    ...DEFAULT_SETTINGS,
    ...(saved && typeof saved === 'object' ? saved : {}),
    temperature: Number.isFinite(Number(saved?.temperature)) ? Number(saved.temperature) : 1,
    model,
    deepThink: Boolean(saved?.deepThink ?? saved?.model === 'deepseek-reasoner'),
    webSearch: model === 'deepseek-flash' && Boolean(saved?.webSearch),
  };
}

function normalizeSource(raw) {
  const citation = raw?.url_citation || raw;
  const url = safeUrl(citation?.url || '');
  if (!url) return null;
  const title = String(citation?.title || url).replace(/\s+/g, ' ').trim().slice(0, 160);
  return { url, title: title || url };
}

function normalizeSources(value) {
  const output = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const source = normalizeSource(raw);
    if (source && !output.some((item) => item.url === source.url)) output.push(source);
    if (output.length >= 8) break;
  }
  return output;
}

function normalizeImage(image) {
  if (!image || typeof image !== 'object') return null;
  const dataUrl = String(image.dataUrl || '');
  if (!/^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/=]+$/i.test(dataUrl)) return null;
  if (dataUrl.length > 36 * 1024 * 1024) return null;
  return {
    id: String(image.id || uid()),
    name: String(image.name || '图片').slice(0, 120) || '图片',
    dataUrl,
    width: Math.max(1, Number(image.width) || 1),
    height: Math.max(1, Number(image.height) || 1),
    size: Math.max(0, Number(image.size) || 0),
  };
}

function normalizeImages(input) {
  if (!Array.isArray(input)) return [];
  return input.map(normalizeImage).filter(Boolean).slice(0, MAX_IMAGES);
}

function normalizeMessage(message) {
  return {
    id: String(message.id || uid()),
    role: message.role,
    content: String(message.content || ''),
    reasoning: String(message.reasoning || ''),
    model: normalizeModel(message.model),
    deepThink: Boolean(message.deepThink ?? message.model === 'deepseek-reasoner'),
    webSearch: Boolean(message.webSearch),
    sources: normalizeSources(message.sources),
    images: normalizeImages(message.images),
    ts: Number(message.ts) || Date.now(),
    error: message.error ? String(message.error) : '',
    stopped: Boolean(message.stopped),
    tokens: message.tokens || null,
    thinkingMs: Number(message.thinkingMs) || 0,
  };
}

function questionKey(value) {
  const text = String(value || '').trim();
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `q${(hash >>> 0).toString(36)}-${text.length.toString(36)}`;
}

function inferBranchKind(branch) {
  if (['base', 'edit', 'regen'].includes(branch?.kind)) return branch.kind;
  const label = String(branch?.label || '');
  if (label.startsWith('修改')) return 'edit';
  if (label.startsWith('重新生成')) return 'regen';
  return 'base';
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
        const questionId = String(branch.questionId || questionKey(user.content));
        const tail = Array.isArray(branch.tail)
          ? branch.tail
              .filter((message) => message && ['user', 'assistant'].includes(message.role))
              .map(normalizeMessage)
          : undefined;
        return {
          id: String(branch.id || uid()),
          label: String(branch.label || '回答版本').slice(0, 80) || '回答版本',
          kind: inferBranchKind(branch),
          questionId,
          createdAt: Number(branch.createdAt) || Date.now(),
          user,
          assistant,
          ...(tail ? { tail } : {}),
        };
      })
      .filter(Boolean)
      .slice(-MAX_TURN_BRANCHES);
    if (!branches.length) continue;
    const activeId = branches.some((branch) => branch.id === group.activeId)
      ? group.activeId
      : branches[branches.length - 1].id;
    const activeByQuestion = {};
    if (group.activeByQuestion && typeof group.activeByQuestion === 'object') {
      for (const [qid, branchId] of Object.entries(group.activeByQuestion)) {
        if (branches.some((branch) => branch.id === branchId && branch.questionId === qid)) {
          activeByQuestion[qid] = branchId;
        }
      }
    }
    for (const branch of branches) {
      if (!activeByQuestion[branch.questionId]) activeByQuestion[branch.questionId] = branch.id;
    }
    const activeBranch = branches.find((branch) => branch.id === activeId);
    if (activeBranch) activeByQuestion[activeBranch.questionId] = activeId;
    output[String(turnId)] = { activeId, activeByQuestion, branches };
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
    const group = (turnBranches[user.id] ||= { activeId: '', activeByQuestion: {}, branches: [] });
    if (!group.activeByQuestion || typeof group.activeByQuestion !== 'object') group.activeByQuestion = {};
    if (!group.branches.some((item) => item.id === branch.id)) {
      const questionId = questionKey(user.content);
      const kind = inferBranchKind({ label: branch.label });
      group.branches.push({
        id: branch.id,
        label: branch.label,
        kind,
        questionId,
        createdAt: branch.createdAt,
        user,
        assistant,
      });
      if (!group.activeByQuestion[questionId]) group.activeByQuestion[questionId] = branch.id;
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
          kind: 'base',
          questionId: questionKey(user.content),
          createdAt: Date.now(),
          user,
          assistant,
        };
        group.branches.push(currentBranch);
      } else {
        currentBranch.user = user;
        currentBranch.assistant = assistant;
        if (!currentBranch.questionId) currentBranch.questionId = questionKey(user.content);
        if (!['base', 'edit', 'regen'].includes(currentBranch.kind)) {
          currentBranch.kind = inferBranchKind(currentBranch);
        }
      }
      if (!group.activeByQuestion || typeof group.activeByQuestion !== 'object') {
        group.activeByQuestion = {};
      }
      group.activeByQuestion[currentBranch.questionId] = currentBranch.id;
      group.activeId = currentBranch.id;
    }
    if (!group.activeByQuestion || typeof group.activeByQuestion !== 'object') group.activeByQuestion = {};
    group.branches = group.branches.slice(-MAX_TURN_BRANCHES);
    if (!group.branches.some((item) => item.id === group.activeId)) {
      group.activeId = group.branches[group.branches.length - 1]?.id || '';
    }
  }
  const normalized = {
    id: String(conv.id || uid()),
    title: String(conv.title || '新对话').slice(0, 200) || '新对话',
    createdAt: Number(conv.createdAt) || Date.now(),
    updatedAt: Number(conv.updatedAt) || Number(conv.createdAt) || Date.now(),
    messages,
    branches,
    turnBranches,
    currentBranchLabel: String(conv.currentBranchLabel || '主分支').slice(0, 80) || '主分支',
  };
  syncActiveBranchTails(normalized);
  return normalized;
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
  contextUpdatedAt: 0,
  pendingImages: [],
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
  clearBranchesBtn: $('#clearBranchesBtn'),
  branchClearModal: $('#branchClearModal'),
  branchClearSubtitle: $('#branchClearSubtitle'),
  branchClearStats: $('#branchClearStats'),
  branchClearOptions: $('#branchClearOptions'),
  branchClearConfirm: $('#branchClearConfirm'),
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
  contextMeter: $('#contextMeter'),
  contextTrack: $('#contextTrack'),
  contextFill: $('#contextFill'),
  contextUsage: $('#contextUsage'),
  contextPercent: $('#contextPercent'),
  sendBtn: $('#sendBtn'),
  imageBtn: $('#imageBtn'),
  imageInput: $('#imageInput'),
  imageTray: $('#imageTray'),
  thinkToggle: $('#thinkToggle'),
  searchToggle: $('#searchToggle'),
  settingsModal: $('#settingsModal'),
  copyModal: $('#copyModal'),
  copySubtitle: $('#copySubtitle'),
  copyRoundCount: $('#copyRoundCount'),
  copyFrom: $('#copyFrom'),
  copyTo: $('#copyTo'),
  copyAllBtn: $('#copyAllBtn'),
  copyRangeBtn: $('#copyRangeBtn'),
  copySummary: $('#copySummary'),
  copySummaryToggle: $('#copySummaryToggle'),
  copySummaryLabel: $('#copySummaryLabel'),
  copySummaryFields: $('#copySummaryFields'),
  copySummaryMin: $('#copySummaryMin'),
  copySummaryMax: $('#copySummaryMax'),
  copySummaryPrompt: $('#copySummaryPrompt'),
  copySummaryHint: $('#copySummaryHint'),
  copyProgress: $('#copyProgress'),
  copyProgressText: $('#copyProgressText'),
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
  const saved = queueConversationSave();
  saveActiveConversationId();
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
      item.innerHTML = `<span class="conv-title">${escapeHtml(conv.title)}</span><button class="conv-copy" type="button" aria-label="复制对话：${escapeHtml(
        conv.title,
      )}" title="复制对话">${icon('i-copy')}</button><button class="conv-delete" type="button" aria-label="删除对话" title="删除">${icon(
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
  const continueButton =
    isLastAssistant && message.stopped
      ? `<button class="msg-action" type="button" data-action="continue">${icon(
          'i-play',
        )}<span>继续生成</span></button>`
      : '';
  return `<button class="msg-action" type="button" data-action="copy">${icon(
    'i-copy',
  )}<span>复制</span></button>${continueButton}<button class="msg-action" type="button" data-action="regenerate">${icon(
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
  article.classList.toggle('stopped', Boolean(message.stopped));
  if (turnId) article.dataset.turnId = turnId;

  if (message.role === 'user') {
    const questionNav = turnId ? turnNavHtml(activeConversation(), turnId, 'question') : '';
    const images = Array.isArray(message.images) ? message.images : [];
    const imageHtml = images.length
      ? `<div class="user-images">${images
          .map(
            (image) =>
              `<img class="user-image" src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(
                image.name || '图片',
              )}" title="${escapeHtml(image.name || '图片')}" />`,
          )
          .join('')}</div>`
      : '';
    const bubbleHtml = String(message.content || '').trim()
      ? `<div class="user-bubble">${escapeHtml(message.content)}</div>`
      : '';
    article.innerHTML = `<div class="msg-avatar">我</div><div class="msg-body">${questionNav}${imageHtml}${bubbleHtml}<div class="msg-actions">${renderActions(
      message,
      false,
    )}</div></div>`;
    return article;
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  const answerNavHtml = turnId ? turnNavHtml(activeConversation(), turnId, 'answer', message.id) : '';

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

  const searchTrace = document.createElement('div');
  searchTrace.className = 'search-trace';
  searchTrace.hidden = true;

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

  body.append(reasoning, searchTrace, content, cursor, error, actions);

  if (answerNavHtml) {
    const answerNav = document.createElement('div');
    answerNav.innerHTML = answerNavHtml;
    if (answerNav.firstElementChild) body.appendChild(answerNav.firstElementChild);
  }

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
  const searchTrace = $('.search-trace', article);
  const content = $('.assistant-content', article);
  const cursor = $('.typing-cursor', article);
  const error = $('.error-card', article);
  const actions = $('.msg-actions', article);
  article.classList.toggle('stopped', Boolean(message.stopped));

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

  const sources = Array.isArray(message.sources) ? message.sources : [];
  const showSearch = Boolean(message.webSearch) && (Boolean(message.searching) || sources.length > 0);
  searchTrace.hidden = !showSearch;
  if (showSearch) {
    if (message.searching) {
      searchTrace.innerHTML = `<span class="search-spinner"></span><span>正在联网搜索…</span>`;
    } else {
      searchTrace.innerHTML = `<span class="search-source-label">来源</span><div class="search-source-list">${sources
        .map(
          (source) =>
            `<a class="search-source" href="${escapeHtml(safeUrl(source.url))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(
              source.title,
            )}">${escapeHtml(source.title)}</a>`,
        )
        .join('')}</div>`;
    }
  }

  if (!message.streaming && message.stopped && !String(message.content || '').trim()) {
    content.innerHTML = `<p class="stopped-placeholder">${
      message.error ? '回答中断，已保留这轮对话，可点击“继续生成”继续' : '已停止生成，可点击“继续生成”继续'
    }</p>`;
  } else {
    content.innerHTML = renderMarkdown(message.content);
  }
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
  updateContextMeter();
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
    updateContextMeter(true);
    return;
  }

  const lastAssistantId = [...conv.messages].reverse().find((m) => m.role === 'assistant')?.id;
  const fragment = document.createDocumentFragment();
  let turnId = null;
  for (const message of conv.messages) {
    if (message.role === 'user') turnId = message.id;
    fragment.appendChild(createMessageElement(message, message.id === lastAssistantId, turnId));
  }
  dom.messages.appendChild(fragment);

  document.title = `${conv.title} · DeepSeek Chatbox`;
  renderToc();
  updateContextMeter(true);
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
  if (!conv.turnBranches[turnId]) {
    conv.turnBranches[turnId] = { activeId: '', activeByQuestion: {}, branches: [] };
  }
  const group = conv.turnBranches[turnId];
  if (!Array.isArray(group.branches)) group.branches = [];
  if (!group.activeByQuestion || typeof group.activeByQuestion !== 'object') {
    group.activeByQuestion = {};
  }
  return group;
}

function activeTurnBranch(conv, turnId) {
  const group = turnId ? conv?.turnBranches?.[turnId] : null;
  if (!group || !group.branches.length) return null;
  return group.branches.find((branch) => branch.id === group.activeId) || group.branches[group.branches.length - 1];
}

function syncActiveBranchTails(conv) {
  if (!conv?.turnBranches) return;
  for (const [turnId, group] of Object.entries(conv.turnBranches)) {
    const userIndex = userIndexById(conv, turnId);
    if (userIndex < 0) continue;
    const active = group.branches?.find((branch) => branch.id === group.activeId);
    if (!active) continue;
    const activeUser = conv.messages[userIndex];
    const activeAssistant = conv.messages[userIndex + 1];
    if (activeUser?.role === 'user') active.user = cloneMessage(activeUser);
    if (activeAssistant?.role === 'assistant') active.assistant = cloneMessage(activeAssistant);
    active.tail = cloneMessages(conv.messages.slice(userIndex + 2));
  }
}

function questionGroups(conv, turnId) {
  const group = turnId ? conv?.turnBranches?.[turnId] : null;
  const output = [];
  const byId = new Map();
  for (const branch of group?.branches || []) {
    const questionId = branch.questionId || questionKey(branch.user?.content);
    let item = byId.get(questionId);
    if (!item) {
      item = { id: questionId, branches: [] };
      byId.set(questionId, item);
      output.push(item);
    }
    item.branches.push(branch);
  }
  return output;
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

function saveTurnBranch(conv, userIndex, label = '') {
  const pair = turnPairAt(conv, userIndex);
  if (!pair) return null;
  const group = ensureTurnGroup(conv, pair.user.id);
  let branch =
    group.branches.find((item) => item.assistant.id === pair.assistant.id) ||
    group.branches.find((item) => item.id === group.activeId);
  const tail = cloneMessages(conv.messages.slice(userIndex + 2));
  if (branch) {
    branch.user = cloneMessage(pair.user);
    branch.assistant = cloneMessage(pair.assistant);
    branch.tail = tail;
    if (!branch.questionId) branch.questionId = questionKey(pair.user.content);
    if (!['base', 'edit', 'regen'].includes(branch.kind)) branch.kind = 'base';
  } else {
    branch = {
      id: uid(),
      label: label || '原始回答',
      kind: 'base',
      questionId: questionKey(pair.user.content),
      createdAt: Date.now(),
      user: cloneMessage(pair.user),
      assistant: cloneMessage(pair.assistant),
      tail,
    };
    group.branches.push(branch);
  }
  group.activeId = branch.id;
  group.activeByQuestion[branch.questionId] = branch.id;
  return branch;
}

function createTurnBranch(conv, userIndex, assistant, kind, label, questionId = '') {
  const user = conv.messages[userIndex];
  if (!user || user.role !== 'user' || !assistant) return null;
  const group = ensureTurnGroup(conv, user.id);
  const branch = {
    id: uid(),
    label: label || '回答版本',
    kind,
    questionId: questionId || questionKey(user.content),
    createdAt: Date.now(),
    user: cloneMessage(user),
    assistant: cloneMessage(assistant),
    tail: [],
  };
  group.branches.push(branch);
  group.activeId = branch.id;
  group.activeByQuestion[branch.questionId] = branch.id;
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
  if (!branch.questionId) branch.questionId = questionKey(pair.user.content);
  group.activeId = branch.id;
  group.activeByQuestion[branch.questionId] = branch.id;
}

function removeTurnBranch(conv, assistantId) {
  if (!conv.turnBranches) return;
  for (const [turnId, group] of Object.entries(conv.turnBranches)) {
    group.branches = group.branches.filter((branch) => branch.assistant.id !== assistantId);
    for (const [questionId, branchId] of Object.entries(group.activeByQuestion || {})) {
      if (!group.branches.some((branch) => branch.id === branchId)) delete group.activeByQuestion[questionId];
    }
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
    if (!turnIds.has(turnId) || !conv.turnBranches[turnId].branches?.length) {
      delete conv.turnBranches[turnId];
    }
  }
}

function questionInfo(conv, turnId) {
  const groups = questionGroups(conv, turnId);
  const current = activeTurnBranch(conv, turnId);
  let index = groups.findIndex((group) => group.id === current?.questionId);
  if (index < 0) index = Math.max(0, groups.length - 1);
  return { count: Math.max(1, groups.length), index: Math.max(0, index), groups, current };
}

function answerInfo(conv, turnId, assistantId) {
  const group = turnId ? conv?.turnBranches?.[turnId] : null;
  const current = activeTurnBranch(conv, turnId);
  const questionId = current?.questionId;
  const branches = questionId
    ? (group?.branches || []).filter((branch) => branch.questionId === questionId)
    : [];
  let index = branches.findIndex((branch) => branch.assistant.id === assistantId);
  if (index < 0) index = branches.findIndex((branch) => branch.id === group?.activeId);
  return { count: Math.max(1, branches.length), index: Math.max(0, index), branches, group };
}

function applyTurnBranch(conv, userIndex, group, branch) {
  const user = cloneMessage(branch.user);
  const assistant = cloneMessage(branch.assistant);
  const currentTail = cloneMessages(conv.messages.slice(userIndex + 2));
  const currentBranch = group.branches.find((item) => item.id === group.activeId);
  if (currentBranch && currentBranch.id !== branch.id) {
    currentBranch.user = cloneMessage(conv.messages[userIndex]);
    currentBranch.assistant = cloneMessage(conv.messages[userIndex + 1]);
    currentBranch.tail = currentTail;
  }
  const nextTail = Array.isArray(branch.tail) ? cloneMessages(branch.tail) : currentTail;
  user.id = conv.messages[userIndex].id;
  group.activeId = branch.id;
  group.activeByQuestion[branch.questionId] = branch.id;
  conv.messages = conv.messages.slice(0, userIndex);
  conv.messages.push(user, assistant, ...nextTail);
  conv.updatedAt = Date.now();
  state.tocTurnId = user.id;

  persist();
  renderConversation({ keepScroll: true });
  renderSidebar();
  renderToc();
}

function switchQuestionVersion(turnId, target) {
  if (state.streaming) {
    toast('请先停止当前生成，再切换提问版本', 'error');
    return;
  }
  const conv = activeConversation();
  if (!conv || !turnId) return;
  const userIndex = userIndexById(conv, turnId);
  if (userIndex < 0) return;
  const group = ensureTurnGroup(conv, turnId);
  const groups = questionGroups(conv, turnId);
  if (groups.length < 2) return;

  const current = activeTurnBranch(conv, turnId);
  let currentIndex = groups.findIndex((item) => item.id === current?.questionId);
  if (currentIndex < 0) currentIndex = groups.length - 1;
  let nextIndex = currentIndex;
  if (typeof target === 'number') nextIndex = currentIndex + target;
  else nextIndex = groups.findIndex((item) => item.id === target);
  if (nextIndex < 0 || nextIndex >= groups.length || nextIndex === currentIndex) return;

  const nextGroup = groups[nextIndex];
  const branch =
    group.branches.find((item) => item.id === group.activeByQuestion[nextGroup.id]) ||
    nextGroup.branches[nextGroup.branches.length - 1];
  if (!branch) return;
  applyTurnBranch(conv, userIndex, group, branch);
}

function switchAnswerVersion(turnId, target) {
  if (state.streaming) {
    toast('请先停止当前生成，再切换回答版本', 'error');
    return;
  }
  const conv = activeConversation();
  if (!conv || !turnId) return;
  const userIndex = userIndexById(conv, turnId);
  if (userIndex < 0) return;
  const group = ensureTurnGroup(conv, turnId);
  const info = answerInfo(conv, turnId, null);
  if (info.branches.length < 2) return;

  let nextIndex = info.index;
  if (typeof target === 'number') nextIndex = info.index + target;
  else nextIndex = info.branches.findIndex((branch) => branch.id === target);
  if (nextIndex < 0 || nextIndex >= info.branches.length || nextIndex === info.index) return;

  applyTurnBranch(conv, userIndex, group, info.branches[nextIndex]);
}

function turnNavHtml(conv, turnId, axis, assistantId = null) {
  const info = axis === 'question' ? questionInfo(conv, turnId) : answerInfo(conv, turnId, assistantId);
  if (info.count < 2) return '';
  const prevDisabled = info.index <= 0 ? ' disabled' : '';
  const nextDisabled = info.index >= info.count - 1 ? ' disabled' : '';
  const label = axis === 'question' ? '提问' : '回答';
  return `<div class="turn-nav turn-nav-${axis}" data-turn-id="${escapeHtml(
    turnId || '',
  )}" data-turn-axis="${axis}" aria-label="${label}版本"><span class="turn-label">${label}</span><button class="turn-arrow" type="button" data-turn-dir="-1" aria-label="上一个${label}版本"${prevDisabled}>${icon(
    'i-chevron',
    'icon chev turn-chev-left',
  )}</button><span class="turn-count">${info.index + 1}/${info.count}</span><button class="turn-arrow" type="button" data-turn-dir="1" aria-label="下一个${label}版本"${nextDisabled}>${icon(
    'i-chevron',
    'icon chev turn-chev-right',
  )}</button></div>`;
}

function renderBranchList(conv, turnId) {
  const group = turnId ? conv?.turnBranches?.[turnId] : null;
  const current = activeTurnBranch(conv, turnId);
  const questionId = current?.questionId;
  const branches = questionId
    ? (group?.branches || []).filter((branch) => branch.questionId === questionId && branch.kind !== 'edit')
    : [];
  dom.tocBranches.hidden = branches.length === 0;
  if (!branches.length) {
    dom.tocBranchList.innerHTML = '';
    dom.tocBranchCount.textContent = '';
    return;
  }
  dom.tocBranchCount.textContent = `${branches.length} 条`;
  const activeId = group.activeId;
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

function branchCounts(conv) {
  const counts = { edit: 0, regen: 0, total: 0 };
  for (const group of Object.values(conv?.turnBranches || {})) {
    for (const branch of group.branches || []) {
      if (branch.kind === 'edit') counts.edit += 1;
      if (branch.kind === 'regen') counts.regen += 1;
      counts.total += 1;
    }
  }
  return counts;
}

function openBranchClearDialog() {
  if (state.streaming) {
    toast('请先停止当前生成，再清理分支', 'error');
    return;
  }
  const conv = activeConversation();
  if (!conv) return;
  const counts = branchCounts(conv);
  if (!counts.total) {
    toast('当前对话没有可清除的分支');
    return;
  }
  dom.branchClearSubtitle.textContent = `「${conv.title}」的历史版本`;
  dom.branchClearStats.textContent = `修改分支 ${counts.edit} 个 · 重新生成分支 ${counts.regen} 个`;
  const radios = [...dom.branchClearOptions.querySelectorAll('input[name="branchClearKind"]')];
  const availability = { edit: counts.edit > 0, regen: counts.regen > 0, all: counts.total > 0 };
  radios.forEach((radio) => {
    radio.disabled = !availability[radio.value];
    radio.checked = false;
  });
  const firstAvailable = radios.find((radio) => !radio.disabled);
  if (firstAvailable) firstAvailable.checked = true;
  dom.branchClearConfirm.disabled = !firstAvailable;
  dom.branchClearModal.hidden = false;
  setTimeout(() => firstAvailable?.focus(), 30);
}

function closeBranchClearDialog() {
  dom.branchClearModal.hidden = true;
  dom.clearBranchesBtn.focus();
}

function removeConversationBranches(kind) {
  const conv = activeConversation();
  if (!conv || !conv.turnBranches) return;
  const before = branchCounts(conv).total;
  if (kind === 'all') {
    conv.turnBranches = {};
  } else {
    for (const [turnId, group] of Object.entries(conv.turnBranches)) {
      const active = group.branches.find((branch) => branch.id === group.activeId);
      if (active?.kind === kind) {
        const userIndex = userIndexById(conv, turnId);
        const tail =
          Array.isArray(active.tail) && userIndex >= 0
            ? cloneMessages(active.tail)
            : userIndex >= 0
              ? cloneMessages(conv.messages.slice(userIndex + 2))
              : [];
        const preserved = {
          id: uid(),
          label: '当前回答',
          kind: 'base',
          questionId: active.questionId,
          createdAt: Date.now(),
          user: cloneMessage(active.user),
          assistant: cloneMessage(active.assistant),
          tail,
        };
        group.branches.push(preserved);
        group.activeId = preserved.id;
        group.activeByQuestion[preserved.questionId] = preserved.id;
      }
      group.branches = group.branches.filter((branch) => branch.kind !== kind);
      if (!group.branches.length) {
        delete conv.turnBranches[turnId];
        continue;
      }
      for (const [questionId, branchId] of Object.entries(group.activeByQuestion || {})) {
        if (!group.branches.some((branch) => branch.id === branchId && branch.questionId === questionId)) {
          delete group.activeByQuestion[questionId];
        }
      }
      if (!group.branches.some((branch) => branch.id === group.activeId)) {
        group.activeId = group.branches[group.branches.length - 1].id;
      }
      for (const branch of group.branches) {
        if (!group.activeByQuestion[branch.questionId]) group.activeByQuestion[branch.questionId] = branch.id;
      }
      const current = group.branches.find((branch) => branch.id === group.activeId);
      if (current) group.activeByQuestion[current.questionId] = group.activeId;
    }
  }
  const removed = before - branchCounts(conv).total;
  conv.updatedAt = Date.now();
  persist();
  renderConversation({ keepScroll: true });
  renderSidebar();
  renderToc();
  closeBranchClearDialog();
  toast(
    removed
      ? kind === 'all'
        ? `已清除 ${removed} 个历史分支`
        : `已清除 ${removed} 个${kind === 'edit' ? '修改' : '重新生成'}分支`
      : '没有可清除的分支',
  );
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
    ? `保存后会把原提问保留在提问栏（含之后 ${trailing} 条消息），并从修改后的提问重新生成。`
    : '保存后会把原提问保留在提问栏，并从修改后的提问重新生成。';

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

  const turnGroup = ensureTurnGroup(conv, messageId);
  const editCount = turnGroup.branches.filter((branch) => branch.kind === 'edit').length;
  if (editCount >= MAX_TURN_EDITS) {
    toast(`本轮提问最多修改 ${MAX_TURN_EDITS} 次`, 'error');
    return false;
  }

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
  createTurnBranch(
    conv,
    index,
    assistant,
    'edit',
    editCount ? `修改后 ${editCount + 1}` : '修改后',
  );
  state.tocTurnId = userMessage.id;
  conv.updatedAt = Date.now();
  persist();
  renderSidebar();
  renderConversation();
  toast('旧提问已保留为版本，可在提问栏切换');
  await streamAssistant(conv, assistant);
  return true;
}

function switchConversation(id) {
  if (state.streaming) stopStreaming();
  clearPendingImages();
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
  clearPendingImages();
  dom.input.value = '';
  autosizeInput();
  state.activeId = null;
  persist();
  renderSidebar();
  renderConversation();
  closeSidebar();
  dom.input.focus();
}

/* ============================================================
   Copy conversation
   ============================================================ */

let copySourceId = null;
let lastFocusedBeforeCopy = null;
let copyBusy = false;
let copyAbortController = null;
let copyAbortRequested = false;

function conversationRounds(conv) {
  const rounds = [];
  let current = null;
  for (const message of conv?.messages || []) {
    if (message.role === 'user') {
      if (current) rounds.push(current);
      current = [message];
    } else if (message.role === 'assistant' && current) {
      current.push(message);
    }
  }
  if (current) rounds.push(current);
  return rounds;
}

function summaryTranscript(rounds) {
  return rounds.map((round, index) => {
    const lines = round.map((message) => {
      const role = message.role === 'user' ? '用户' : '助手';
      return `${role}：${String(message.content || '').trim()}`;
    });
    return `【第 ${index + 1} 轮】\n${lines.join('\n')}`;
  }).join('\n\n');
}

async function collectSummaryStream(response) {
  if (!response.body) throw new Error('当前浏览器不支持流式响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let text = '';
  let done = false;

  const handle = (raw) => {
    const dataLines = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) return false;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return true;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return false;
    }
    if (payload?.error) throw new Error(payload.error.message || '摘要生成失败。');
    const choice = payload?.choices?.[0];
    if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
    else if (typeof choice?.message?.content === 'string') text += choice.message.content;
    return false;
  };

  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      done = handle(buffer.slice(0, boundary)) || done;
      buffer = buffer.slice(boundary + 2);
      if (done) break;
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (!done && buffer.trim()) handle(buffer);
  return text.trim();
}

async function requestConversationSummary(priorRounds, start, minChars, maxChars, special) {
  if (PAGES_MODE && !state.settings.apiKey.trim()) {
    throw new Error('请先在设置中填写 API Key，再生成摘要。');
  }
  const priorCount = start - 1;
  const transcript = summaryTranscript(priorRounds);
  const specialText = String(special || '').trim();
  const requirement = `生成 ${minChars}-${maxChars} 字的摘要${specialText ? `，并且${specialText}` : ''}`;
  const prompt = [
    `请将下面这段前文对话${requirement}。`,
    '要求：只输出摘要正文，不要输出标题、解释、代码块或“摘要”二字；保留关键事实、数字、结论、待办和用户偏好，便于后续对话继续。',
    '',
    `前文对话（第 1-${priorCount} 轮）：`,
    transcript,
  ].join('\n');

  const body = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: '你是一名严谨的对话摘要助手，只输出符合要求的中文摘要正文。' },
      { role: 'user', content: prompt },
    ],
    temperature: 0.3,
    reasoning_effort: 'none',
    max_tokens: Math.min(6000, Math.max(512, Math.ceil(maxChars * 2.4) + 256)),
    stream: true,
    stream_options: { include_usage: true },
  };

  const headers = { 'Content-Type': 'application/json' };
  if (state.settings.apiKey.trim()) headers.Authorization = `Bearer ${state.settings.apiKey.trim()}`;
  if (!PAGES_MODE && state.settings.baseUrl.trim()) headers['x-api-base'] = state.settings.baseUrl.trim();

  const controller = new AbortController();
  copyAbortController = controller;
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(chatEndpoint(), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      let message = `摘要生成失败（HTTP ${response.status}）`;
      try {
        const payload = await response.json();
        message = payload?.error?.message || message;
      } catch {
        /* non-JSON error */
      }
      throw new Error(message);
    }
    const summary = await collectSummaryStream(response);
    if (!summary) throw new Error('模型没有返回摘要内容，请重试。');
    return summary;
  } catch (error) {
    if (controller.signal.aborted) {
      if (!copyAbortRequested) throw new Error('摘要生成超时，请重试。');
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (copyAbortController === controller) copyAbortController = null;
  }
}

function summaryMessages(summary, start) {
  const now = Date.now();
  return [
    {
      id: uid(),
      role: 'user',
      content: `【前文摘要 · 第 1${start - 1 === 1 ? '' : `-${start - 1}`} 轮】\n${summary}`,
      ts: now,
      model: 'deepseek-flash',
    },
    {
      id: uid(),
      role: 'assistant',
      content: '已了解前文摘要，请继续。',
      ts: now + 1,
      model: 'deepseek-flash',
    },
  ];
}

function setCopyBusy(busy, label = '正在生成摘要…') {
  copyBusy = busy;
  dom.copyAllBtn.disabled = busy;
  dom.copyRangeBtn.disabled = busy;
  [dom.copyFrom, dom.copyTo, dom.copySummary, dom.copySummaryMin, dom.copySummaryMax, dom.copySummaryPrompt]
    .forEach((element) => { element.disabled = busy; });
  dom.copyProgress.hidden = !busy;
  dom.copyProgressText.textContent = label;
  dom.copyRangeBtn.textContent = busy ? label : '复制所选轮次';
  if (!busy) syncCopySummaryState();
}

function syncCopySummaryState() {
  const total = Number.parseInt(dom.copyRoundCount.textContent, 10) || 0;
  const from = Number.parseInt(dom.copyFrom.value, 10) || 1;
  const available = total > 1 && from > 1 && !copyBusy;
  dom.copySummary.disabled = !available;
  dom.copySummaryToggle.classList.toggle('disabled', !available);
  if (!available) dom.copySummary.checked = false;
  dom.copySummaryFields.hidden = !dom.copySummary.checked;
  dom.copySummaryLabel.textContent = available
    ? `将第 ${from} 轮前的对话生成摘要，作为新对话第一轮`
    : '将起始轮次前的对话生成摘要（起始轮需大于 1）';
  if (!available) {
    dom.copySummaryHint.textContent = '起始轮为第 1 轮，前面没有可摘要的对话。';
    return;
  }
  const priorLabel = from === 2 ? '第 1 轮' : `第 1 至 ${from - 1} 轮`;
  dom.copySummaryHint.textContent = `将${priorLabel}发送给模型生成摘要，摘要作为新对话第一轮，后面接第 ${from} 轮及之后的对话。`;
}

function parseSummarySettings() {
  const min = Number.parseInt(dom.copySummaryMin.value, 10);
  const max = Number.parseInt(dom.copySummaryMax.value, 10);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < 1 || min > max || max > 3000) {
    toast('请输入有效的摘要字数范围，例如 200-300（最多 3000 字）', 'error');
    return null;
  }
  return { min, max, prompt: dom.copySummaryPrompt.value.trim() };
}

async function copyConversation(sourceId, from, to, options = {}) {
  const source = state.conversations.find((conv) => conv.id === sourceId);
  if (!source) return false;
  if (copyBusy) return false;
  if (state.streaming) {
    toast('请等待当前回答完成后再复制对话');
    return false;
  }

  const rounds = conversationRounds(source);
  if (!rounds.length) {
    toast('这个对话还没有可复制的问答');
    return false;
  }

  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > rounds.length) {
    toast(`请输入第 1 到第 ${rounds.length} 轮之间的范围`);
    return false;
  }
  if (start > end) {
    toast('起始轮次不能大于结束轮次');
    return false;
  }
  if (state.conversations.length >= MAX_CONVERSATIONS) {
    toast(`最多保留 ${MAX_CONVERSATIONS} 个对话，请先删除一些旧对话`);
    return false;
  }

  const selected = rounds.slice(start - 1, end).flat();
  if (!selected.length) {
    toast('所选轮次没有可复制的内容');
    return false;
  }

  let summaryText = '';
  if (options.summary) {
    if (start <= 1) {
      toast('起始轮为第 1 轮，前面没有可摘要的对话', 'error');
      return false;
    }
    const summaryOptions = parseSummarySettings();
    if (!summaryOptions) return false;
    if (PAGES_MODE && !state.settings.apiKey.trim()) {
      toast('请先在设置中填写 API Key，再生成摘要', 'error');
      return false;
    }

    copyAbortRequested = false;
    setCopyBusy(true);
    try {
      summaryText = await requestConversationSummary(
        rounds.slice(0, start - 1),
        start,
        summaryOptions.min,
        summaryOptions.max,
        summaryOptions.prompt,
      );
    } catch (error) {
      if (!copyAbortRequested) toast(`摘要生成失败：${error.message}`, 'error');
      return false;
    } finally {
      setCopyBusy(false);
    }
    if (!summaryText || !copySourceId || dom.copyModal.hidden) return false;
  }

  const messages = selected.map((message) => {
    const cloned = normalizeMessage(JSON.parse(JSON.stringify(message)));
    cloned.id = uid();
    cloned.streaming = false;
    cloned.searching = false;
    delete cloned.startedAt;
    return cloned;
  });
  if (summaryText) messages.unshift(...summaryMessages(summaryText, start));

  const now = Date.now();
  const base = String(source.title || '对话').replace(/\s+/g, ' ').trim().slice(0, 60) || '对话';
  const title = summaryText
    ? `${base} · 摘要+第${start}${start === end ? '' : `-${end}`}轮`
    : start === 1 && end === rounds.length
      ? `${base} · 副本`
      : `${base} · 第${start}${start === end ? '' : `-${end}`}轮`;

  const copy = {
    id: uid(),
    title,
    createdAt: now,
    updatedAt: now,
    currentBranchLabel: '主分支',
    messages,
    branches: [],
    turnBranches: {},
  };

  const previousActive = state.activeId;
  state.conversations.unshift(copy);
  state.activeId = copy.id;
  if (!persist()) {
    state.conversations = state.conversations.filter((conv) => conv.id !== copy.id);
    state.activeId = previousActive;
    persist();
    toast('复制失败：浏览器本地存储空间不足，请先清理旧对话');
    return false;
  }

  state.search = '';
  dom.search.value = '';
  renderSidebar();
  renderConversation();
  closeSidebar();
  closeCopyDialog();
  toast(`已复制为「${copy.title}」`);
  return true;
}

function openCopyDialog(sourceId) {
  const source = state.conversations.find((conv) => conv.id === sourceId);
  if (!source) return;
  if (state.streaming) {
    toast('请等待当前回答完成后再复制对话');
    return;
  }

  const rounds = conversationRounds(source);
  if (!rounds.length) {
    toast('这个对话还没有可复制的问答');
    return;
  }

  copySourceId = sourceId;
  lastFocusedBeforeCopy = document.activeElement;
  dom.copySubtitle.textContent = `将「${source.title}」复制为一个新对话。`;
  dom.copyRoundCount.textContent = String(rounds.length);
  dom.copyFrom.min = '1';
  dom.copyFrom.max = String(rounds.length);
  dom.copyTo.min = '1';
  dom.copyTo.max = String(rounds.length);
  dom.copyFrom.value = '1';
  dom.copyTo.value = String(rounds.length);
  dom.copySummary.checked = false;
  dom.copySummaryMin.value = '200';
  dom.copySummaryMax.value = '300';
  dom.copySummaryPrompt.value = '';
  copyAbortRequested = false;
  setCopyBusy(false);
  dom.copyModal.hidden = false;
  setTimeout(() => dom.copyFrom.focus(), 40);
}

function closeCopyDialog() {
  if (dom.copyModal.hidden) return;
  if (copyBusy) {
    copyAbortRequested = true;
    copyAbortController?.abort();
  }
  dom.copyModal.hidden = true;
  copySourceId = null;
  setCopyBusy(false);
  lastFocusedBeforeCopy?.focus?.();
  lastFocusedBeforeCopy = null;
}

function copySelectedRange() {
  if (!copySourceId || copyBusy) return;
  const from = Number.parseInt(dom.copyFrom.value, 10);
  const to = Number.parseInt(dom.copyTo.value, 10);
  copyConversation(copySourceId, from, to, { summary: dom.copySummary.checked });
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
  const next = normalizeModel(model);
  if (next !== 'deepseek-flash' && state.settings.webSearch) {
    state.settings.webSearch = false;
    toast('DeepSeek-V4-Pro 暂不支持联网搜索，已关闭');
  }
  if (next !== 'deepseek-flash' && state.pendingImages.length) {
    clearPendingImages();
    toast('DeepSeek-V4-Pro 暂不支持图片，已移除待发送图片');
  }
  state.settings.model = next;
  saveSettings();
  updateModelUI();
  updateContextMeter(true);
}

function updateModelUI() {
  const model = normalizeModel(state.settings.model);
  dom.modelLabel.textContent = MODEL_META[model]?.label || 'DeepSeek';
  dom.thinkToggle.setAttribute('aria-pressed', String(Boolean(state.settings.deepThink)));
  dom.thinkToggle.title = state.settings.deepThink
    ? '已开启深度思考：使用更强的推理力度'
    : '开启深度思考：模型会先推理再回答';
  dom.searchToggle.setAttribute('aria-pressed', String(Boolean(state.settings.webSearch)));
  dom.searchToggle.title = state.settings.webSearch
    ? '已开启联网搜索：模型会按需搜索网页并附来源'
    : '开启联网搜索：需要 DeepSeek-V4.1-Flash';
  if (dom.imageBtn) {
    dom.imageBtn.title =
      model === 'deepseek-flash'
        ? '添加图片'
        : '添加图片（会自动切换到 DeepSeek-V4.1-Flash）';
  }
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

function toggleWebSearch() {
  if (state.streaming) {
    toast('请等待当前回答完成后再切换', 'error');
    return;
  }
  const next = !state.settings.webSearch;
  let switchedModel = false;
  if (next && normalizeModel(state.settings.model) !== 'deepseek-flash') {
    state.settings.model = 'deepseek-flash';
    switchedModel = true;
  }
  state.settings.webSearch = next;
  saveSettings();
  updateModelUI();
  if (switchedModel) {
    toast('联网搜索需要 DeepSeek-V4.1-Flash，已切换并开启');
  } else {
    toast(next ? '已开启联网搜索' : '已关闭联网搜索');
  }
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
  const hasImages = state.pendingImages.length > 0;
  dom.inputHint.textContent = hasText || hasImages ? 'Enter 发送 · Shift + Enter 换行' : '';
  dom.sendBtn.disabled = !hasText && !hasImages && !state.streaming;
}

/* ============================================================
   Context usage meter
   ============================================================ */

const CJK_TOKEN_RE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

function formatContextTokens(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function estimateTextTokens(value) {
  const text = String(value || '');
  if (!text) return 0;
  const cjk = (text.match(CJK_TOKEN_RE) || []).length;
  const other = text.length - cjk;
  // DeepSeek's tokenizer averages roughly 0.7 tokens per CJK character and
  // four characters per Latin/code token. This is still an estimate, but it
  // tracks API usage much more closely than character counts.
  return Math.ceil(cjk * 0.7 + other / 3.8);
}

function estimateConversationTokens(conv) {
  let total = 4;
  const systemPrompt = state.settings.systemPrompt.trim();
  if (systemPrompt) total += estimateTextTokens(systemPrompt) + 4;
  for (const message of conv.messages) {
    if (message.error) continue;
    const imageTokens = Array.isArray(message.images) ? message.images.length * 1024 : 0;
    if (!String(message.content || '').trim() && !imageTokens) continue;
    total += estimateTextTokens(message.content) + imageTokens + 4;
  }
  return total;
}

function contextStatsFor(conv) {
  const model = normalizeModel(state.settings.model);
  const limit = MODEL_META[model]?.contextWindow || DEFAULT_CONTEXT_WINDOW;
  if (!conv || !conv.messages.length) return { used: 0, limit, percent: 0, exact: false };

  const last = conv.messages[conv.messages.length - 1];
  if (
    last.role === 'assistant' &&
    !last.streaming &&
    !last.error &&
    Number(last.tokens?.prompt) > 0
  ) {
    const used = Number(last.tokens.prompt) + Number(last.tokens.completion || 0);
    return { used, limit, percent: (used / limit) * 100, exact: true };
  }

  // When the last message is a new user turn, reuse the API's last known
  // prompt size and estimate only the messages that came after it. This is
  // much closer to reality than re-estimating the entire conversation.
  for (let index = conv.messages.length - 1; index >= 0; index -= 1) {
    const anchor = conv.messages[index];
    if (
      anchor.role === 'assistant' &&
      !anchor.streaming &&
      !anchor.error &&
      Number(anchor.tokens?.prompt) > 0
    ) {
      let used = Number(anchor.tokens.prompt) + Number(anchor.tokens.completion || 0);
      for (let cursor = index + 1; cursor < conv.messages.length; cursor += 1) {
        const message = conv.messages[cursor];
        if (message.error) continue;
        const imageTokens = Array.isArray(message.images) ? message.images.length * 1024 : 0;
        if (!message.content && !imageTokens) continue;
        used += estimateTextTokens(message.content) + imageTokens + 4;
      }
      return {
        used,
        limit,
        percent: (used / limit) * 100,
        exact: false,
        anchored: true,
      };
    }
  }

  const used = estimateConversationTokens(conv);
  return { used, limit, percent: (used / limit) * 100, exact: false, anchored: false };
}

function updateContextMeter(force = false) {
  if (!dom.contextMeter) return;
  const conv = activeConversation();
  if (!conv || !conv.messages.length) {
    dom.contextMeter.hidden = true;
    dom.contextMeter.classList.remove('warn', 'danger');
    return;
  }

  const now = Date.now();
  if (!force && now - state.contextUpdatedAt < 280) return;
  state.contextUpdatedAt = now;

  const info = contextStatsFor(conv);
  const width = info.used > 0 ? Math.max(1.2, Math.min(100, info.percent)) : 0;
  const percentText =
    info.used > 0 && info.percent < 0.1
      ? '<0.1%'
      : `${info.percent > 100 ? '>100' : info.percent >= 10 ? Math.round(info.percent) : info.percent.toFixed(1)}%`;

  dom.contextMeter.hidden = false;
  dom.contextFill.style.width = `${width}%`;
  dom.contextUsage.textContent = `${info.exact ? '' : '≈'}${formatContextTokens(info.used)} / ${formatContextTokens(
    info.limit,
  )}`;
  dom.contextPercent.textContent = percentText;
  dom.contextTrack.setAttribute('aria-valuenow', String(Math.max(0, Math.min(100, Math.round(info.percent)))));
  dom.contextMeter.classList.toggle('warn', info.percent >= 75 && info.percent < 90);
  dom.contextMeter.classList.toggle('danger', info.percent >= 90);
  const sourceLabel = info.exact
    ? 'API 用量'
    : info.anchored
      ? '估算用量（基于上次 API 用量）'
      : '估算用量（可能偏高）';
  dom.contextMeter.title = `${sourceLabel}：${Math.round(info.used).toLocaleString(
    'en-US',
  )} / ${info.limit.toLocaleString('en-US')} tokens${
    info.exact ? '' : '；发送后按 API usage 校准'
  }`;
}

/* ============================================================
   Streaming
   ============================================================ */

function historyForApi(conv, excludeId, cutoffId = null) {
  const messages = [];
  if (state.settings.systemPrompt.trim()) {
    messages.push({ role: 'system', content: state.settings.systemPrompt.trim() });
  }
  // Keep the request body bounded when a long conversation contains many
  // images: only the newest MAX_HISTORY_IMAGES are sent as binary blocks.
  const imageMessageIds = new Set();
  let imageBudget = MAX_HISTORY_IMAGES;
  const cutoffIndex = cutoffId ? conv.messages.findIndex((m) => m.id === cutoffId) : -1;
  const budgetStart = cutoffIndex >= 0 ? cutoffIndex : conv.messages.length - 1;
  for (let i = budgetStart; i >= 0 && imageBudget > 0; i -= 1) {
    const candidate = conv.messages[i];
    if (candidate?.role !== 'user' || !Array.isArray(candidate.images) || !candidate.images.length) continue;
    imageMessageIds.add(candidate.id);
    imageBudget -= candidate.images.length;
  }
  for (const message of conv.messages) {
    if (message.id === excludeId || message.error) continue;
    const images = message.role === 'user' && Array.isArray(message.images) && imageMessageIds.has(message.id)
      ? message.images
      : [];
    const omittedImage = message.role === 'user' && Array.isArray(message.images) && message.images.length && !images.length;
    const text = String(message.content || '').trim() || (omittedImage ? '[图片已省略]' : '');
    if (!text && !images.length) continue;
    if (images.length) {
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const image of images) {
        content.push({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'auto' } });
      }
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: message.role, content: text });
    }
    if (cutoffId && message.id === cutoffId) break;
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

async function streamAssistant(conv, assistant, options = {}) {
  if (PAGES_MODE && !state.settings.apiKey.trim()) {
    toast('请先在设置中填写 API Key', 'error');
    return false;
  }
  let succeeded = false;
  const continuation = Boolean(options.continuation);

  const controller = new AbortController();
  state.streaming = { convId: conv.id, msgId: assistant.id, controller };
  assistant.streaming = true;
  assistant.stopped = false;
  assistant.error = '';
  if (!continuation) assistant.startedAt = Date.now();
  setStreamingUI(true);
  ensureAssistantElement(conv, assistant);

  const headers = { 'Content-Type': 'application/json' };
  if (state.settings.apiKey.trim()) headers.Authorization = `Bearer ${state.settings.apiKey.trim()}`;
  if (!PAGES_MODE && state.settings.baseUrl.trim()) headers['x-api-base'] = state.settings.baseUrl.trim();

  const deepThink = Boolean(assistant.deepThink);
  const webSearch = Boolean(assistant.webSearch);
  if (webSearch && !continuation) {
    assistant.searching = true;
    assistant.sources = Array.isArray(assistant.sources) ? assistant.sources : [];
  }
  const requestMessages = historyForApi(conv, assistant.id, options.historyEndId);
  if (continuation) {
    assistant.searching = false;
    requestMessages.push({ role: 'assistant', content: assistant.content, prefix: true });
  }
  const hasImageInput = requestMessages.some(
    (message) => Array.isArray(message.content) && message.content.some((block) => block?.type === 'image_url'),
  );
  const body = {
    model: webSearch || hasImageInput ? 'deepseek-flash' : assistant.model,
    messages: requestMessages,
    temperature: state.settings.temperature,
    reasoning_effort: continuation ? 'none' : deepThink ? 'high' : 'none',
  };
  if (webSearch && !continuation) body.tools = [{ type: 'deepseek_web_search' }];
  if (continuation && !PAGES_MODE) body.beta = true;
  if (PAGES_MODE) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  try {
    const response = await fetch(chatEndpoint(continuation), {
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
      const toolEvent = choice?.server_tool_event;
      if (toolEvent) {
        if (toolEvent.type === 'call_started') {
          assistant.searching = true;
        } else if (toolEvent.type === 'call_completed') {
          const call = toolEvent.call || {};
          const found = Array.isArray(call.sources) ? [...call.sources] : [];
          if (call.page) found.push(call.page);
          addAssistantSources(assistant, found);
          assistant.searching = false;
        }
        queuePaint(conv.id, assistant.id);
      }

      if (choice?.delta) {
        if (choice.delta.reasoning_content && deepThink) {
          assistant.reasoning += choice.delta.reasoning_content;
        }
        if (choice.delta.content) {
          if (!firstContentAt) firstContentAt = Date.now();
          assistant.content += choice.delta.content;
          assistant.searching = false;
        }
        const annotations = choice.delta.annotations || choice.annotations;
        if (Array.isArray(annotations)) addAssistantSources(assistant, annotations);
        if (Array.isArray(choice.delta.server_tool_calls)) {
          const found = [];
          for (const step of choice.delta.server_tool_calls) {
            for (const call of step?.calls || []) {
              if (Array.isArray(call.sources)) found.push(...call.sources);
              if (call.page) found.push(call.page);
            }
          }
          addAssistantSources(assistant, found);
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
        updateContextMeter(true);
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
    assistant.searching = false;
    assistant.stopped = false;
    if (!continuation) {
      assistant.thinkingMs = assistant.thinkingMs || (firstContentAt ? firstContentAt - assistant.startedAt : Date.now() - assistant.startedAt);
    }
    assistant.updatedAt = Date.now();
    syncTurnBranch(conv, assistant);
    conv.updatedAt = Date.now();
    persist();
    renderConversation({ keepScroll: true });
    renderSidebar();
    scrollToBottom();
    succeeded = true;
  } catch (error) {
    assistant.streaming = false;
    assistant.searching = false;
    const aborted = error?.name === 'AbortError' || controller.signal.aborted;
    if (aborted) {
      assistant.stopped = true;
      syncTurnBranch(conv, assistant);
      conv.updatedAt = Date.now();
      persist();
      renderConversation({ keepScroll: true });
      renderSidebar();
      if (!options.suppressErrorToast) toast('已停止生成，可点“继续生成”');
    } else {
      const message = error.message || '未知错误';
      const networkError =
        error instanceof TypeError ||
        !navigator.onLine ||
        /fetch|network|连接|中断|超时|failed to fetch/i.test(message);
      assistant.error = message;
      // A network interruption can happen before the first token, or between
      // chunks. Keep the partial answer (even if empty) so the user can either
      // read what arrived or press "继续生成" instead of losing the turn.
      if (networkError || assistant.content || assistant.reasoning) {
        assistant.stopped = true;
      }
      syncTurnBranch(conv, assistant);
      conv.updatedAt = Date.now();
      persist();
      renderConversation({ keepScroll: true });
      renderSidebar();
      if (!options.suppressErrorToast) {
        toast(networkError ? '网络中断，已保留当前回答；可点“继续生成”' : message, 'error');
      }
    }
  } finally {
    if (state.streaming?.msgId === assistant.id) state.streaming = null;
    setStreamingUI(false);
    updateComposerHint();
    updateContextMeter(true);
  }
  return succeeded;
}

function createAssistantMessage() {
  const webSearch = Boolean(state.settings.webSearch);
  return {
    id: uid(),
    role: 'assistant',
    content: '',
    reasoning: '',
    model: state.settings.model,
    deepThink: Boolean(state.settings.deepThink),
    webSearch,
    searching: webSearch,
    sources: [],
    ts: Date.now(),
    streaming: true,
    startedAt: Date.now(),
  };
}

function addAssistantSources(assistant, items) {
  if (!assistant || !Array.isArray(items) || !items.length) return false;
  const sources = Array.isArray(assistant.sources) ? assistant.sources : [];
  let changed = false;
  for (const item of items) {
    const source = normalizeSource(item);
    if (!source || sources.some((existing) => existing.url === source.url)) continue;
    sources.push(source);
    changed = true;
    if (sources.length >= 8) break;
  }
  assistant.sources = sources.slice(0, 8);
  return changed;
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(file) {
  if ('createImageBitmap' in window) return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('图片解码失败'));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function prepareImage(file) {
  const source = await decodeImage(file);
  const sourceWidth = source.width || source.naturalWidth || 1;
  const sourceHeight = source.height || source.naturalHeight || 1;
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  if (source.close) source.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', IMAGE_QUALITY));
  if (!blob) throw new Error('图片压缩失败');
  return {
    id: uid(),
    name: String(file.name || '图片').slice(0, 120) || '图片',
    dataUrl: await readBlobAsDataUrl(blob),
    width,
    height,
    size: blob.size,
  };
}

function renderImageTray() {
  const images = Array.isArray(state.pendingImages) ? state.pendingImages : [];
  dom.imageTray.hidden = images.length === 0;
  dom.imageTray.innerHTML = images
    .map(
      (image, index) => `<div class="image-preview-item">
        <img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}" title="${escapeHtml(image.name)}" />
        <button type="button" class="image-remove" data-remove-image="${index}" aria-label="移除图片">${icon('i-x')}</button>
      </div>`,
    )
    .join('');
  updateComposerHint();
}

async function addImageFiles(fileList) {
  if (state.streaming) {
    toast('请等待当前回答完成后再添加图片', 'error');
    return;
  }
  const files = Array.from(fileList || []);
  const remaining = MAX_IMAGES - state.pendingImages.length;
  if (remaining <= 0) {
    toast(`最多添加 ${MAX_IMAGES} 张图片`, 'error');
    return;
  }
  const picked = files.slice(0, remaining);
  if (files.length > remaining) toast(`最多添加 ${MAX_IMAGES} 张图片，已保留前 ${remaining} 张`, 'error');
  for (const file of picked) {
    if (!/^image\/(jpeg|png|gif|webp)$/i.test(file.type)) {
      toast(`不支持的图片格式：${file.name || '未知文件'}`, 'error');
      continue;
    }
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      toast(`图片过大（单张最多 ${Math.round(MAX_IMAGE_FILE_BYTES / 1024 / 1024)} MB）`, 'error');
      continue;
    }
    try {
      state.pendingImages.push(await prepareImage(file));
    } catch (error) {
      toast(`图片处理失败：${error.message || '未知错误'}`, 'error');
    }
  }
  if (state.pendingImages.length) {
    if (normalizeModel(state.settings.model) !== 'deepseek-flash') {
      state.settings.model = 'deepseek-flash';
      saveSettings();
      updateModelUI();
      toast('图片理解需要 DeepSeek-V4.1-Flash，已切换');
    }
    renderImageTray();
  }
}

function clearPendingImages() {
  state.pendingImages = [];
  renderImageTray();
}

async function sendMessage(rawText, imageList = null) {
  const text = String(rawText || '').trim();
  const images = normalizeImages(imageList || state.pendingImages);
  if ((!text && !images.length) || state.streaming) return;

  if (!hasApiKey()) {
    toast('请先配置 DeepSeek API Key', 'error');
    openSettings();
    return;
  }

  if (images.length && normalizeModel(state.settings.model) !== 'deepseek-flash') {
    state.settings.model = 'deepseek-flash';
    saveSettings();
    updateModelUI();
  }

  let conv = activeConversation();
  if (!conv) {
    conv = {
      id: uid(),
      title: titleFrom(text || images[0]?.name || '图片对话'),
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
    images: images.length ? images : undefined,
    ts: Date.now(),
    model: state.settings.model,
  };
  const assistant = createAssistantMessage();
  if (userMessage.images) assistant.model = 'deepseek-flash';

  conv.messages.push(userMessage, assistant);
  syncActiveBranchTails(conv);
  conv.updatedAt = Date.now();
  const titleSeed = text || images[0]?.name || '图片对话';
  if (conv.title === '新对话' || !conv.title) conv.title = titleFrom(titleSeed);
  if (conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = titleFrom(titleSeed);

  dom.input.value = '';
  clearPendingImages();
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

async function continueAssistant(messageId) {
  if (state.streaming) return;
  const conv = activeConversation();
  if (!conv || !conv.messages.length) return;
  const index = conv.messages.findIndex((message) => message.id === messageId);
  const assistant = conv.messages[index];
  if (!assistant || assistant.role !== 'assistant') return;
  if (index !== conv.messages.length - 1) {
    toast('只能继续最后一条回答', 'error');
    return;
  }
  if (!assistant.stopped) return;
  if (!hasApiKey()) {
    toast('请先配置 DeepSeek API Key', 'error');
    openSettings();
    return;
  }
  assistant.error = '';
  assistant.stopped = false;
  await streamAssistant(conv, assistant, { continuation: true, keepOnFailure: true });
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

  if (targetIndex < 0 || conv.messages[targetIndex]?.role !== 'assistant') return;

  let userIndex = -1;
  const start = targetIndex - 1;
  for (let i = start; i >= 0; i -= 1) {
    if (conv.messages[i].role === 'user') {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return;

  const userMessage = conv.messages[userIndex];
  const previousAssistant = conv.messages[targetIndex];
  const previousTail = cloneMessages(conv.messages.slice(targetIndex + 1));
  const hadLaterTurns = previousTail.length > 0;
  const turnGroup = ensureTurnGroup(conv, userMessage.id);
  const currentBranch = activeTurnBranch(conv, userMessage.id);
  const questionId = currentBranch?.questionId || questionKey(userMessage.content);
  const regenCount = turnGroup.branches.filter(
    (branch) => branch.questionId === questionId && branch.kind === 'regen',
  ).length;
  if (regenCount >= MAX_TURN_REGENS) {
    toast(`本轮回答最多重新生成 ${MAX_TURN_REGENS} 次`, 'error');
    return;
  }

  const previousBranch = saveTurnBranch(conv, userIndex);
  if (hadLaterTurns) conv.messages = conv.messages.slice(0, targetIndex + 1);
  const assistant = createAssistantMessage();
  conv.messages[targetIndex] = assistant;
  createTurnBranch(
    conv,
    userIndex,
    assistant,
    'regen',
    regenCount ? `重新生成 ${regenCount + 1}` : '重新生成',
    questionId,
  );
  state.tocTurnId = userMessage.id;
  conv.updatedAt = Date.now();
  persist();
  renderSidebar();
  renderConversation({ keepScroll: true });
  const succeeded = await streamAssistant(conv, assistant, {
    historyEndId: userMessage.id,
    keepOnFailure: true,
    suppressErrorToast: true,
  });
  if (succeeded) {
    toast(
      hadLaterTurns
        ? '已开始新支线，后续轮次已隐藏；可在回答栏切回旧版本'
        : '旧回答已保留为版本，之后的对话保持不变',
    );
    return;
  }

  const replacedAt = conv.messages.findIndex((message) => message.id === assistant.id);
  if (replacedAt >= 0) {
    conv.messages[replacedAt] = previousAssistant;
  } else {
    conv.messages.splice(targetIndex, 0, previousAssistant);
  }
  if (previousTail.length) conv.messages.splice(targetIndex + 1, 0, ...previousTail);
  removeTurnBranch(conv, assistant.id);
  const group = ensureTurnGroup(conv, userMessage.id);
  if (previousBranch) {
    group.activeId = previousBranch.id;
    group.activeByQuestion[previousBranch.questionId] = previousBranch.id;
  }
  conv.updatedAt = Date.now();
  persist();
  renderSidebar();
  renderConversation({ keepScroll: true });
  const reason = assistant.error || (assistant.stopped ? '生成已停止' : '生成失败');
  toast(`已恢复撤回前的回答（${reason}）`, 'error');
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

function chatEndpoint(continuation = false) {
  if (!PAGES_MODE) return '/api/chat';
  return `${apiBaseForPages()}${continuation ? '/beta/chat/completions' : '/chat/completions'}`;
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
  if (state.settings.model !== 'deepseek-flash') {
    state.settings.webSearch = false;
    if (state.pendingImages.length) clearPendingImages();
  }
  state.settings.temperature = Number(dom.tempInput.value);
  state.settings.systemPrompt = dom.systemPromptInput.value.trim();

  saveSettings();
  updateModelUI();
  updateKeyState();
  updateContextMeter(true);
  closeSettings();
  toast('设置已保存');
}

async function clearAllData() {
  if (!confirm('清除所有本地对话与设置？此操作无法撤销。')) return;
  Object.values(STORAGE).forEach((key) => localStorage.removeItem(key));
  state.conversations = [];
  state.activeId = null;
  state.settings = { ...DEFAULT_SETTINGS };
  state.pendingImages = [];
  renderImageTray();
  try {
    conversationWriteChain = conversationWriteChain.catch(() => {});
    await conversationWriteChain;
    if ('indexedDB' in window) await clearConversationDb();
    conversationRevisions.clear();
  } catch (error) {
    console.warn('clear IndexedDB failed', error);
  }
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
function externalMessageFromRaw(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fragments)) return null;
  const role = String(raw.role || '').toLowerCase();
  if (role !== 'user' && role !== 'assistant') return null;

  const content =
    role === 'user'
      ? fragmentText(raw.fragments, 'REQUEST') + fragmentFileNote(raw.fragments)
      : fragmentText(raw.fragments, 'RESPONSE');
  const reasoning = role === 'assistant' ? fragmentText(raw.fragments, 'THINK') : '';
  if (!content.trim() && !reasoning.trim()) return null;

  const think = raw.fragments.find((fragment) => fragment && fragment.type === 'THINK');
  const elapsed = Number(think?.elapsed_secs);
  const timestamp = Date.parse(raw.inserted_at) || 0;
  return {
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
  };
}

function convertExternalChatSession(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages)) return null;
  if (!value.messages.some((message) => Array.isArray(message?.fragments))) return null;

  const nodes = [];
  const byId = new Map();
  for (const raw of value.messages) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fragments)) continue;
    const id = String(raw.id ?? uid());
    if (byId.has(id)) continue;
    const node = {
      id,
      raw,
      parentId: raw.parent_id === null || raw.parent_id === undefined || raw.parent_id === ''
        ? null
        : String(raw.parent_id),
      message: externalMessageFromRaw(raw),
      ts: Date.parse(raw.inserted_at) || 0,
      children: [],
    };
    nodes.push(node);
    byId.set(id, node);
  }
  if (!nodes.length) return null;

  const roots = [];
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Chatbox stores edits/regenerations as sibling messages in a tree. The
  // export's current_message_id points at the active leaf; walking its parent
  // chain keeps only the visible conversation instead of flattening every
  // alternate branch into extra turns.
  let leaf = byId.get(String(value.current_message_id ?? '')) || null;
  if (!leaf) {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      if (nodes[i].message) {
        leaf = nodes[i];
        break;
      }
    }
  }
  let activePath = [];
  if (leaf) {
    const seen = new Set();
    for (let node = leaf; node && !seen.has(node.id); node = node.parentId ? byId.get(node.parentId) : null) {
      seen.add(node.id);
      activePath.push(node);
    }
    activePath.reverse();
  }
  const hasTree = nodes.some((node) => node.parentId && byId.has(node.parentId));
  if (!hasTree) activePath = nodes;

  let messages = activePath.map((node) => node.message).filter(Boolean);
  if (!messages.length) {
    messages = nodes.map((node) => node.message).filter(Boolean);
    activePath = nodes;
  }
  if (!messages.length) return null;

  const turnBranches = {};
  if (hasTree && activePath.length < nodes.length) {
    for (let index = 0; index < activePath.length; index += 1) {
      const node = activePath[index];
      const user = node.message;
      if (!user || user.role !== 'user') continue;

      let activeAssistantNode = null;
      for (let cursor = index + 1; cursor < activePath.length; cursor += 1) {
        if (activePath[cursor].message?.role === 'assistant') {
          activeAssistantNode = activePath[cursor];
          break;
        }
      }

      const group = { activeId: '', activeByQuestion: {}, branches: [] };
      const questionId = questionKey(user.content);

      for (const sibling of node.children) {
        if (!sibling.message || sibling.message.role !== 'assistant') continue;
        if (sibling.id === activeAssistantNode?.id) continue;
        group.branches.push({
          id: `external-answer:${sibling.id}`,
          label: `导入回答 ${group.branches.length + 2}`,
          kind: 'regen',
          questionId,
          createdAt: sibling.message.ts,
          user,
          assistant: sibling.message,
        });
      }

      const parent = node.parentId ? byId.get(node.parentId) : null;
      const questionSiblings = (parent ? parent.children : roots).filter(
        (sibling) => sibling.id !== node.id && sibling.message?.role === 'user',
      );
      for (const sibling of questionSiblings) {
        const answers = sibling.children
          .filter((child) => child.message?.role === 'assistant')
          .sort((a, b) => (b.message.ts || 0) - (a.message.ts || 0));
        if (!answers.length) continue;
        const question = sibling.message;
        group.branches.push({
          id: `external-question:${sibling.id}`,
          label: `导入提问 ${questionSiblings.indexOf(sibling) + 2}`,
          kind: 'edit',
          questionId: questionKey(question.content),
          createdAt: question.ts,
          user: question,
          assistant: answers[0].message,
        });
      }

      if (group.branches.length) turnBranches[user.id] = group;
    }
  }

  const createdAt = Date.parse(value.inserted_at) || messages[0].ts || Date.now();
  const updatedAt = Date.parse(value.updated_at) || messages[messages.length - 1].ts || createdAt;
  return {
    id: String(value.id || uid()),
    title: String(value.title || '导入的对话').slice(0, 200) || '导入的对话',
    createdAt,
    updatedAt,
    messages,
    turnBranches,
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

async function* readBackupEntries(file, onEntryError) {
  const lower = file.name.toLowerCase();

  if (lower.endsWith('.json')) {
    yield { name: file.name, text: await file.text() };
    return;
  }
  if (!lower.endsWith('.zip') && !/zip/i.test(file.type)) {
    throw new Error('请选择 .zip 或 .json 备份文件');
  }

  const decoder = new TextDecoder('utf-8');
  for await (const entry of readZipEntries(file, {
    maxEntries: MAX_IMPORT_ENTRIES,
    maxFileSize: MAX_IMPORT_FILE_SIZE,
    maxTotalSize: MAX_IMPORT_TOTAL_SIZE,
    onEntryError,
  })) {
    const name = entry.name.replace(/\\/g, '/').toLowerCase();
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('__macosx/') || name.includes('/__macosx/')) continue;
    yield { name: entry.name, text: decoder.decode(entry.data) };
  }
}

async function importChatArchive(file) {
  if (!file) return;
  if (state.streaming) {
    toast('请先停止当前生成，再导入备份', 'error');
    return;
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    toast('备份文件太大（最多 200 MB）', 'error');
    return;
  }
  if (!confirm(`导入会与现有对话合并，不会删除已有记录。\n单个文件最大 200 MB，解析后最多保留 ${MAX_CONVERSATIONS} 个对话。继续吗？`)) {
    return;
  }

  let invalidEntries = 0;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let limitSkipped = 0;
  let failed = 0;
  const byId = new Map(state.conversations.map((conv) => [conv.id, conv]));
  const canWriteDb = 'indexedDB' in window && !conversationStoreFallback;
  const beforeConversations = state.conversations.slice();
  const beforeActive = state.activeId;

  try {
    for await (const entry of readBackupEntries(file, (error, name) => {
      invalidEntries += 1;
      console.warn(`ZIP entry skipped: ${name}`, error);
    })) {
      const base = entry.name.replace(/\\/g, '/').split('/').pop().toLowerCase();
      if (base === 'manifest.json') continue;

      let found;
      try {
        const parsed = JSON.parse(entry.text);
        found = [];
        collectBackupConversations(parsed, found);
      } catch {
        invalidEntries += 1;
        continue;
      }
      if (!found.length) {
        invalidEntries += 1;
        continue;
      }

      for (const raw of found) {
        const conv = normalizeConversation(raw);
        if (!conv) {
          invalidEntries += 1;
          continue;
        }

        const existing = byId.get(conv.id);
        if (existing) {
          if (conv.updatedAt <= existing.updatedAt) {
            skipped += 1;
            continue;
          }
          if (canWriteDb) {
            try {
              await putConversationRecord(conv);
            } catch (error) {
              failed += 1;
              console.warn('导入写入失败', error);
              continue;
            }
          }
          const index = state.conversations.findIndex((item) => item.id === existing.id);
          if (index >= 0) state.conversations[index] = conv;
          byId.set(conv.id, conv);
          conversationRevisions.set(conv.id, conversationRevision(conv));
          updated += 1;
          continue;
        }

        if (state.conversations.length >= MAX_CONVERSATIONS) {
          limitSkipped += 1;
          continue;
        }
        if (canWriteDb) {
          try {
            await putConversationRecord(conv);
          } catch (error) {
            failed += 1;
            console.warn('导入写入失败', error);
            continue;
          }
        }
        state.conversations.push(conv);
        byId.set(conv.id, conv);
        conversationRevisions.set(conv.id, conversationRevision(conv));
        added += 1;
      }
    }
  } catch (error) {
    toast(`导入中断：${error.message || '不是有效的 ZIP'}`, 'error');
    renderSidebar();
    renderConversation();
    return;
  }

  if (!added && !updated) {
    if (failed) {
      toast(`导入失败：${failed} 个对话写入失败，请检查浏览器存储空间`, 'error');
      return;
    }
    const detail = skipped ? `，已跳过 ${skipped} 个重复或较旧的对话` : '';
    toast(`没有新的对话可导入${detail}`, 'error');
    return;
  }

  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  if (!state.activeId || !state.conversations.some((conv) => conv.id === state.activeId)) {
    state.activeId = state.conversations[0]?.id || null;
  }
  if (!canWriteDb && !writeStorage(STORAGE.conversations, state.conversations.slice(0, MAX_CONVERSATIONS))) {
    state.conversations = beforeConversations;
    state.activeId = beforeActive;
    toast('导入失败：浏览器本地存储空间不足，请先清理旧对话', 'error');
    return;
  }
  saveActiveConversationId();
  renderSidebar();
  renderConversation();

  const details = [
    `新增 ${added} 个`,
    updated ? `更新 ${updated} 个` : '',
    skipped ? `跳过 ${skipped} 个重复或较旧对话` : '',
    limitSkipped ? `忽略 ${limitSkipped} 个超出上限对话` : '',
    invalidEntries ? `忽略 ${invalidEntries} 个无效条目` : '',
    failed ? `写入失败 ${failed} 个` : '',
  ]
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
  dom.clearBranchesBtn.addEventListener('click', openBranchClearDialog);
  dom.tocList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-toc-id]');
    if (!item) return;
    jumpToTocMessage(item.dataset.tocId);
  });
  dom.tocBranchList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-branch-id]');
    if (!item) return;
    switchAnswerVersion(state.tocTurnId, item.dataset.branchId);
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
    if (event.target.closest('.conv-copy')) {
      event.stopPropagation();
      openCopyDialog(item.dataset.id);
      return;
    }
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
  dom.searchToggle.addEventListener('click', toggleWebSearch);
  dom.imageBtn.addEventListener('click', () => dom.imageInput.click());
  dom.imageInput.addEventListener('change', async () => {
    await addImageFiles(dom.imageInput.files);
    dom.imageInput.value = '';
  });
  dom.imageTray.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-image]');
    if (!remove) return;
    const index = Number(remove.dataset.removeImage);
    if (!Number.isInteger(index)) return;
    state.pendingImages.splice(index, 1);
    renderImageTray();
  });

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
    sendMessage(dom.input.value, state.pendingImages);
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
      if (nav) {
        const direction = Number(turnArrow.dataset.turnDir);
        if (nav.dataset.turnAxis === 'question') {
          switchQuestionVersion(nav.dataset.turnId, direction);
        } else {
          switchAnswerVersion(nav.dataset.turnId, direction);
        }
      }
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
    if (action.dataset.action === 'continue') continueAssistant(message.id);
    if (action.dataset.action === 'regenerate') regenerate(message.id);
  });

  // Branch cleanup
  $$('[data-close-branch-clear]').forEach((el) => el.addEventListener('click', closeBranchClearDialog));
  dom.branchClearConfirm.addEventListener('click', () => {
    const selected = dom.branchClearOptions.querySelector('input[name="branchClearKind"]:checked');
    if (!selected || selected.disabled) return;
    removeConversationBranches(selected.value);
  });

  // Copy conversation
  $$('[data-close-copy]').forEach((el) => el.addEventListener('click', closeCopyDialog));
  dom.copyAllBtn.addEventListener('click', () => {
    if (!copySourceId || copyBusy) return;
    const source = state.conversations.find((conv) => conv.id === copySourceId);
    if (!source) return;
    copyConversation(copySourceId, 1, conversationRounds(source).length);
  });
  dom.copyRangeBtn.addEventListener('click', copySelectedRange);
  dom.copySummary.addEventListener('change', syncCopySummaryState);
  [dom.copyFrom, dom.copyTo].forEach((input) => {
    input.addEventListener('input', syncCopySummaryState);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        copySelectedRange();
      }
    });
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
      if (!dom.branchClearModal.hidden) closeBranchClearDialog();
      if (!dom.copyModal.hidden) closeCopyDialog();
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

async function boot() {
  initTheme();
  maybeSeedDemo();
  await initConversationStore();
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
