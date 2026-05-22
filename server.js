#!/usr/bin/env node

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT       = process.env.PORT || 3000;
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, 'config');

function readConfig(filename) {
  try { return fs.readFileSync(path.join(CONFIG_DIR, filename), 'utf8'); } catch (_) { return null; }
}

function escape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function configSection() {
  const files = [
    { name: 'config.json', content: readConfig('config.json') },
    { name: 'config.yaml', content: readConfig('config.yaml') },
    { name: 'config.js',   content: readConfig('config.js')   },
  ].filter(f => f.content !== null);

  if (files.length === 0) return '';

  return `
    <h2>App config</h2>
    ${files.map(f => `
      <h3>${f.name}</h3>
      <pre style="background:#f4f4f4;padding:12px;border-radius:4px;overflow:auto;font-size:0.85em">${escape(f.content)}</pre>
    `).join('')}`;
}

http.createServer((req, res) => {
  const verify = req.headers['x-ssl-client-verify'];
  const dn     = req.headers['x-ssl-client-dn'];
  const cert   = req.headers['x-ssl-client-cert'];

  let certSection = '';
  if (verify) {
    const rows = [
      ['Verify', verify],
      ['DN',     dn || ''],
    ];
    if (cert) {
      const decoded = decodeURIComponent(cert);
      rows.push(['Cert', `<pre style="font-size:0.75em;overflow:auto">${decoded}</pre>`]);
    }
    certSection = `
      <h2>Client certificate</h2>
      <table border="1" cellpadding="6" style="border-collapse:collapse">
        ${rows.map(([k, v]) => `<tr><th align="left">${k}</th><td>${v}</td></tr>`).join('')}
      </table>`;
  }

  const authUser   = req.headers['x-auth-request-user']   || req.headers['x-forwarded-user']   || '';
  const authEmail  = req.headers['x-auth-request-email']  || req.headers['x-forwarded-email']  || '';
  const authGroups = req.headers['x-auth-request-groups'] || req.headers['x-forwarded-groups'] || '';
  let authSection = '';
  if (authUser || authEmail || authGroups) {
    const rows = [
      ['User',   authUser],
      ['Email',  authEmail],
      ['Groups', authGroups],
    ].filter(([, v]) => v);
    authSection = `
      <h2>Authenticated user</h2>
      <table border="1" cellpadding="6" style="border-collapse:collapse">
        ${rows.map(([k, v]) => `<tr><th align="left">${k}</th><td>${v}</td></tr>`).join('')}
      </table>`;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<html><body><h1>hello from basic-app</h1>${authSection}${certSection}${configSection()}</body></html>\n`);
}).listen(PORT, () => {
  console.log(`app on http://localhost:${PORT}`);
});
