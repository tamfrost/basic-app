#!/usr/bin/env node

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT       = process.env.PORT || 3000;
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, 'config');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function readConfig(filename) {
  try { return fs.readFileSync(path.join(CONFIG_DIR, filename), 'utf8'); } catch (_) { return null; }
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, urlPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end(); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function apiInfo(req, res) {
  const config = [
    { name: 'config.json', content: readConfig('config.json') },
    { name: 'config.yaml', content: readConfig('config.yaml') },
    { name: 'config.js',   content: readConfig('config.js')   },
  ].filter(f => f.content !== null);

  const payload = {
    gitCommit: process.env.GIT_COMMIT || 'unknown',
    buildTime: process.env.BUILD_TIME || 'unknown',
    auth: {
      user:   req.headers['x-auth-request-user']   || req.headers['x-forwarded-user']   || '',
      email:  req.headers['x-auth-request-email']  || req.headers['x-forwarded-email']  || '',
      groups: req.headers['x-auth-request-groups'] || req.headers['x-forwarded-groups'] || '',
    },
    cert: {
      verify: req.headers['x-ssl-client-verify'] || '',
      dn:     req.headers['x-ssl-client-dn']     || '',
      pem:    req.headers['x-ssl-client-cert'] ? decodeURIComponent(req.headers['x-ssl-client-cert']) : '',
    },
    config,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

http.createServer((req, res) => {
  if (req.url === '/api/info' || req.url.startsWith('/api/info?')) {
    apiInfo(req, res);
  } else {
    serveStatic(req, res);
  }
}).listen(PORT, () => {
  console.log(`app on http://localhost:${PORT}`);
});
