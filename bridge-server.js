#!/usr/bin/env node
const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');

const PORT = Number(process.env.CLAWD_BRIDGE_PORT || 4317);
const DEFAULT_SESSION_KEY = process.env.CLAWD_SESSION_KEY || 'agent:main:chat-clawd';
const WORKDIR = '/Users/tricia/.openclaw/workspace';

function runOpenClaw(args) {
  return new Promise((resolve, reject) => {
    execFile('openclaw', args, {
      cwd: WORKDIR,
      maxBuffer: 1024 * 1024 * 8,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message || 'openclaw_failed'));
        return;
      }
      resolve(stdout);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFirstBalancedJson(text) {
  let start = -1;
  let open = null;
  let close = null;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (start === -1) {
      const prev = i === 0 ? '\n' : text[i - 1];
      const next = text[i + 1] || '';
      const isObjectStart = ch === '{';
      const isArrayStart = ch === '[' && prev === '\n' && !/[A-Za-z]/.test(next);
      if (isObjectStart || isArrayStart) {
        start = i;
        open = ch;
        close = ch === '{' ? '}' : ']';
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) depth++;
    if (ch === close) depth--;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return text;
}

function parseGatewayJson(stdout) {
  const text = String(stdout || '').trim();
  const jsonText = extractFirstBalancedJson(text);
  return JSON.parse(jsonText);
}

function debugLog(...args) {
  const stamp = new Date().toISOString();
  process.stdout.write(`[clawd-bridge][${stamp}] ${args.map((v) => typeof v === 'string' ? v : JSON.stringify(v)).join(' ')}\n`);
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function gatewayCall(method, params, timeout = 30000) {
  const stdout = await runOpenClaw([
    'gateway', 'call', method,
    '--json',
    '--timeout', String(timeout),
    '--params', JSON.stringify(params || {})
  ]);
  return parseGatewayJson(stdout);
}

function extractAssistantText(msg) {
  const content = Array.isArray(msg?.content) ? msg.content : [];
  return content
    .filter((item) => item && item.type === 'text' && item.text && item.text !== 'ANNOUNCE_SKIP')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function buildBridgeMessage(text) {
  const clean = String(text || '').trim();
  if (!clean) return clean;
  return [
    'Please reply in English only.',
    'Keep the tone natural, warm, concise, and human.',
    'Do not use Chinese in the spoken reply.',
    'User message:',
    clean,
  ].join('\n\n');
}

async function sendToChatSession({ sessionKey, text }) {
  const message = buildBridgeMessage(text);
  const before = await gatewayCall('chat.history', {
    sessionKey,
    limit: 6
  }, 15000);
  const beforeMessages = Array.isArray(before?.messages) ? before.messages : [];
  const beforeCount = beforeMessages.length;
  const idempotencyKey = `clawd-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  await gatewayCall('chat.send', {
    sessionKey,
    message,
    idempotencyKey,
    timeoutMs: 120000
  }, 120000);

  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(attempt === 0 ? 250 : 250);
    const history = await gatewayCall('chat.history', {
      sessionKey,
      limit: Math.max(16, beforeCount + 6)
    }, 30000);
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    const newMessages = messages.slice(beforeCount);
    for (let i = newMessages.length - 1; i >= 0; i--) {
      const msg = newMessages[i];
      if (msg.role !== 'assistant') continue;
      const reply = extractAssistantText(msg);
      if (reply) {
        return { ok: true, sessionKey, reply, history };
      }
    }
  }

  return { ok: false, sessionKey, error: 'assistant_reply_timeout' };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    try {
      const history = await gatewayCall('chat.history', { sessionKey: DEFAULT_SESSION_KEY, limit: 1 }, 10000);
      sendJson(res, 200, { ok: true, sessionKey: DEFAULT_SESSION_KEY, hasHistory: Array.isArray(history?.messages) });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || 'health_failed' });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/chat') {
    try {
      const data = await readJson(req);
      const text = String(data?.text || '').trim().slice(0, 1000);
      const sessionKey = String(data?.sessionKey || DEFAULT_SESSION_KEY);
      if (!text) {
        sendJson(res, 400, { ok: false, error: 'empty_text' });
        return;
      }

      const result = await sendToChatSession({ sessionKey, text });
      sendJson(res, result.ok ? 200 : 504, result);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || 'bridge_failed' });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`clawd bridge listening on http://127.0.0.1:${PORT}\n`);
});
