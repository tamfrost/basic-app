#!/usr/bin/env node

const http = require('http');

const PORT = process.env.PORT || 3000;

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

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<html><body><h1>hello from basic-app</h1>${certSection}</body></html>\n`);
}).listen(PORT, () => {
  console.log(`app on http://localhost:${PORT}`);
});
