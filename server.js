#!/usr/bin/env node

const http = require('http');

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body><h1>hello from basic-app</h1></body></html>\n');
}).listen(PORT, () => {
  console.log(`app on http://localhost:${PORT}`);
});
