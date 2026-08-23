#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_BASE_URL = 'https://api.navy';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
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

function proxyRequest(upstream, onResponse, onError) {
  const req = upstream.mod.request(upstream.options, onResponse);
  req.on('error', onError);
  return req;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'POST' && pathname === '/api/chat') {
    const apiKey = (req.headers['x-api-key'] || '').trim();
    if (!apiKey) {
      return sendJson(res, 400, { error: { message: 'Missing API key. Add it in Settings.' } });
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) req.destroy();
    });

    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
      }

      const { model, messages, temperature } = payload;
      if (typeof model !== 'string' || !Array.isArray(messages)) {
        return sendJson(res, 400, { error: { message: 'Body must include "model" (string) and "messages" (array).' } });
      }

      const isStream = payload.stream !== false;
      const upstreamBody = JSON.stringify({
        model,
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        stream: isStream,
        ...(isStream ? { stream_options: { include_usage: true } } : {}),
      });

      const upstreamInfo = resolveUpstream(
        (req.headers['x-base-url'] || '').trim() || DEFAULT_BASE_URL,
        '/v1/chat/completions',
        'POST',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'text/event-stream',
        }
      );
      if (!upstreamInfo) {
        return sendJson(res, 400, { error: { message: 'Invalid API base URL in Settings.' } });
      }

      const upstream = proxyRequest(
        upstreamInfo,
        (upRes) => {
          if (upRes.statusCode !== 200) {
            let errBody = '';
            upRes.on('data', (c) => { errBody += c; if (errBody.length > 20000) upRes.destroy(); });
            upRes.on('end', () => {
              let message = `Navy API error (HTTP ${upRes.statusCode}).`;
              try {
                const parsed = JSON.parse(errBody);
                if (parsed.error && parsed.error.message) message = parsed.error.message;
              } catch { }
              sendJson(res, upRes.statusCode, { error: { message } });
            });
            return;
          }

          res.writeHead(200, {
            'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
          });
          upRes.pipe(res);
        },
        () => {
          if (!res.headersSent) sendJson(res, 502, { error: { message: 'Could not reach api.navy. Check your internet connection.' } });
          res.end();
        }
      );

      upstream.write(upstreamBody);
      upstream.end();

      res.on('close', () => upstream.destroy());
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/image') {
    const apiKey = (req.headers['x-api-key'] || '').trim();
    if (!apiKey) {
      return sendJson(res, 400, { error: { message: 'Missing API key. Add it in Settings.' } });
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) req.destroy();
    });

    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
      }

      const { model, prompt, n, size } = payload;
      if (typeof model !== 'string' || typeof prompt !== 'string') {
        return sendJson(res, 400, { error: { message: 'Body must include "model" (string) and "prompt" (string).' } });
      }

      const upstreamBody = JSON.stringify({
        model,
        prompt,
        n: typeof n === 'number' ? n : 1,
        size: typeof size === 'string' ? size : '1024x1024',
      });

      const upstreamInfo = resolveUpstream(
        (req.headers['x-base-url'] || '').trim() || DEFAULT_BASE_URL,
        '/v1/images/generations',
        'POST',
        {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        }
      );
      if (!upstreamInfo) {
        return sendJson(res, 400, { error: { message: 'Invalid API base URL in Settings.' } });
      }

      const upstream = proxyRequest(
        upstreamInfo,
        (upRes) => {
          let data = '';
          upRes.on('data', (c) => { data += c; if (data.length > 20 * 1024 * 1024) upRes.destroy(); });
          upRes.on('end', () => {
            if (upRes.statusCode !== 200) {
              let message = `Navy API error (HTTP ${upRes.statusCode}).`;
              try {
                const parsed = JSON.parse(data);
                if (parsed.error && parsed.error.message) message = parsed.error.message;
              } catch { }
              return sendJson(res, upRes.statusCode, { error: { message } });
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(data);
          });
        },
        () => {
          if (!res.headersSent) sendJson(res, 502, { error: { message: 'Could not reach api.navy. Check your internet connection.' } });
          res.end();
        }
      );

      upstream.write(upstreamBody);
      upstream.end();
      res.on('close', () => upstream.destroy());
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/models') {
    const apiKey = (req.headers['x-api-key'] || '').trim();
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const upstreamInfo = resolveUpstream(
      (req.headers['x-base-url'] || '').trim() || DEFAULT_BASE_URL,
      '/v1/models',
      'GET',
      headers
    );
    if (!upstreamInfo) {
      return sendJson(res, 400, { error: { message: 'Invalid API base URL in Settings.' } });
    }

    const upstream = proxyRequest(
      upstreamInfo,
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8' });
        upRes.pipe(res);
      },
      () => {
        if (!res.headersSent) sendJson(res, 502, { error: { message: 'Could not reach api.navy.' } });
        res.end();
      }
    );
    upstream.end();
    return;
  }

  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(resolved).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Maverick');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  Models by api.navy — your key stays in your browser.');
  console.log('  Press Ctrl+C to stop.');
});
