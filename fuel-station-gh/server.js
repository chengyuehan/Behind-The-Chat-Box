#!/usr/bin/env node
// Optional LOCAL dev server. GitHub Pages does NOT use this — there the page reads
// the committed fuel-data.json directly. Locally this serves the files and also
// exposes a live /api/fuel-data (rebuilt on demand) for testing.
//
//   node server.js     # http://localhost:8753
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildData } = require('./build-data.js');

const PORT = process.env.PORT || 8753;
const STATIC = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
let cache = null;

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/fuel-data') {
    if (!cache) { try { cache = await buildData(); } catch (e) { console.error(e.message); } }
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(cache || { live: false, stations: [] }));
  }
  const file = url === '/' ? '/index.html' : url;
  const fp = path.join(__dirname, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': STATIC[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`AI Fuel Station → http://localhost:${PORT}`));
