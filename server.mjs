#!/usr/bin/env node
/**
 * DeepSeek Chatbox — a tiny, dependency-free local web app.
 *
 * - Serves the static UI from ./public
 * - Proxies streaming chat completions to the DeepSeek API
 * - Keeps API keys out of the page when DEEPSEEK_API_KEY is set,
 *   and accepts a per-request key from the browser otherwise.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

/** Minimal .env loader: KEY=value, optional quotes, # comments, never overrides real env. */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return;
  let text = '';
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

loadDotEnv();

const HOST = process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT || 3210);
const API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const SERVER_KEY = process.env.DEEPSEEK_API_KEY || '';
const ACCESS_USER = process.env.CHATBOX_USER || 'deepseek';
const ACCESS_PASSWORD = process.env.CHATBOX_PASSWORD || '';
const GATE_COOKIE = 'dsc_gate';
const GATE_TOKEN = ACCESS_PASSWORD
  ? crypto.createHmac('sha256', ACCESS_PASSWORD).update('dsc-gate-v1').digest('base64url')
  : '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function requestKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const value = auth.slice(7).trim();
    if (value) return value;
  }
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return SERVER_KEY;
}

function upstreamUrl(base, pathname) {
  return `${base}${pathname}`;
}

function requestBase(req) {
  const header = req.headers['x-api-base'];
  if (typeof header === 'string' && header.trim()) {
    try {
      const url = new URL(header.trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.href.replace(/\/+$/, '');
      }
    } catch {
      /* fall through to the configured base */
    }
  }
  return API_BASE;
}

function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m) => m && typeof m === 'object')
    .map((m) => {
      const role = ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user';
      const message = {
        role,
        content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
      };
      if (role === 'assistant' && m.prefix === true) message.prefix = true;
      return message;
    })
    .filter((m) => m.content.length > 0 || m.role === 'assistant')
    .slice(-80);
}

async function handleModels(req, res) {
  const key = requestKey(req);
  if (!key) return json(res, 401, { error: { message: '缺少 API Key，请先在设置中填写。' } });
  const base = requestBase(req);
  try {
    const response = await fetch(upstreamUrl(base, '/models'), {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (error) {
    json(res, 502, { error: { message: `无法连接 DeepSeek API：${error.message}` } });
  }
}

async function handleChat(req, res) {
  const key = requestKey(req);
  if (!key) {
    return json(res, 401, {
      error: { message: '缺少 API Key。请点击左下角「设置」填写，或为服务设置 DEEPSEEK_API_KEY 环境变量。' },
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return json(res, error.status || 400, { error: { message: error.message } });
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages.length) {
    return json(res, 400, { error: { message: '消息不能为空。' } });
  }

  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'deepseek-flash';
  const payload = { model, messages, stream: true, stream_options: { include_usage: true } };

  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.trim() : '';
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'].includes(effort)) {
    payload.reasoning_effort = effort;
  }

  if (Array.isArray(body.tools)) {
    const tools = body.tools
      .filter((tool) => tool && tool.type === 'deepseek_web_search')
      .slice(0, 1)
      .map(() => ({ type: 'deepseek_web_search' }));
    if (tools.length) payload.tools = tools;
  }

  if (!['high', 'xhigh', 'ultra', 'max'].includes(effort)) {
    const temperature = Number(body.temperature);
    if (Number.isFinite(temperature)) {
      payload.temperature = Math.min(2, Math.max(0, temperature));
    }
  }
  const maxTokens = Number(body.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = Math.min(8192, Math.floor(maxTokens));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('上游响应超时')), 180000);
  const base = requestBase(req);
  const beta = body.beta === true;
  let closed = false;
  res.on('close', () => {
    closed = true;
    clearTimeout(timeout);
    controller.abort(new Error('客户端已断开'));
  });

  let upstream;
  try {
    upstream = await fetch(upstreamUrl(base, beta ? '/beta/chat/completions' : '/chat/completions'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (!closed) {
      json(res, 502, {
        error: {
          message: controller.signal.aborted
            ? '请求已取消或超时。'
            : `无法连接 DeepSeek API：${error.message}`,
        },
      });
    }
    return;
  }

  if (!upstream.ok) {
    clearTimeout(timeout);
    const text = await upstream.text().catch(() => '');
    let message = `DeepSeek API 返回 ${upstream.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message || message;
    } catch {
      if (text.trim()) message = text.trim().slice(0, 600);
    }
    if (!closed) {
      json(res, upstream.status, { error: { message, status: upstream.status } });
    }
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  try {
    for await (const chunk of upstream.body) {
      if (closed) break;
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    if (!closed && !controller.signal.aborted) {
      try {
        res.write(
          `data: ${JSON.stringify({ error: { message: `流式传输中断：${error.message}` } })}\n\n`,
        );
      } catch {
        /* socket already gone */
      }
    }
    res.end();
  } finally {
    clearTimeout(timeout);
  }
}

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return json(res, 400, { error: { message: 'Bad URL' } });
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return json(res, 403, { error: { message: 'Forbidden' } });
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return json(res, 404, { error: { message: 'Not found' } });
  }
  if (!info.isFile()) return json(res, 404, { error: { message: 'Not found' } });

  const ext = path.extname(filePath).toLowerCase();
  const noCache = ext === '.html' || ext === '.js' || ext === '.css';
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=300',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

function basicCredentials(req) {
  const header = req.headers.authorization || '';
  if (!/^Basic\s+/i.test(header)) return null;
  try {
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index === -1) return null;
    return { user: decoded.slice(0, index), pass: decoded.slice(index + 1) };
  } catch {
    return null;
  }
}

function checkAccess(req) {
  if (!ACCESS_PASSWORD) return { ok: true, fresh: false };

  const cookie = readCookie(req, GATE_COOKIE);
  if (cookie && safeEqual(cookie, GATE_TOKEN)) return { ok: true, fresh: false };

  const credentials = basicCredentials(req);
  if (credentials && credentials.user === ACCESS_USER && safeEqual(credentials.pass, ACCESS_PASSWORD)) {
    return { ok: true, fresh: true };
  }
  return { ok: false, fresh: false };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const access = checkAccess(req);
  if (!access.ok) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="DeepSeek Chatbox", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end('Authentication required');
  }
  if (access.fresh) {
    res.setHeader(
      'Set-Cookie',
      `${GATE_COOKIE}=${GATE_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
    );
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        hasServerKey: Boolean(SERVER_KEY),
        model: 'deepseek-flash',
        baseUrl: API_BASE,
      });
    }
    if (pathname === '/api/models' && req.method === 'GET') {
      return await handleModels(req, res);
    }
    if (pathname === '/api/chat' && req.method === 'POST') {
      return await handleChat(req, res);
    }
    if (pathname.startsWith('/api/')) {
      return json(res, 404, { error: { message: 'Not found' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: { message: 'Method not allowed' } });
    }
    return await serveStatic(req, res);
  } catch (error) {
    console.error('[server]', error);
    if (!res.headersSent) {
      json(res, error.status || 500, { error: { message: error.message || 'Internal error' } });
    } else {
      res.end();
    }
  }
});

async function listen(port, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = port + i;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, HOST);
      });
      return candidate;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`端口 ${port}–${port + attempts - 1} 均被占用`);
}

const port = await listen(BASE_PORT);
console.log('');
console.log('  DeepSeek Chatbox 已启动');
console.log(`  → http://${HOST}:${port}`);
console.log(
  SERVER_KEY
    ? '  API Key：使用服务端 DEEPSEEK_API_KEY'
    : '  API Key：未配置，请在页面「设置」中填写',
);
if (ACCESS_PASSWORD) console.log('  访问保护：已开启（HTTP Basic）');
console.log('');
