/**
 * Mini server locale per il player demo.
 * - Serve index.html su http://localhost:8080
 * - Proxy /api/relinker → mediapolis.rai.it (risolve il CORS)
 * 
 * Avvio: node server.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;

const RELINKERS = {
  rai1: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=2606803&output=62',
  rai2: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=308718&output=62'
};

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Route: /api/relinker?ch=rai1|rai2 ──
  if (parsedUrl.pathname === '/api/relinker') {
    const ch = parsedUrl.query.ch || 'rai1';
    const relinkerUrl = RELINKERS[ch] || RELINKERS.rai1;
    console.log(`[proxy] Relinker ${ch.toUpperCase()}...`);

    https.get(relinkerUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.raiplay.it/'
      }
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const hlsUrl = json?.video?.[0]
            || json?.playlist?.find(p => p.type === 'main')?.url;
          if (!hlsUrl) throw new Error('URL non trovata');
          console.log(`[proxy] ${ch.toUpperCase()} OK:`, hlsUrl.substring(0, 70) + '...');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: hlsUrl, channel: ch }));
        } catch(e) {
          console.error('[proxy] Errore:', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    }).on('error', (e) => {
      console.error('[proxy] Fetch error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── Route: / o /index.html → serve la pagina ──
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        res.end('Errore lettura index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  // 404 per tutto il resto
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   RAI 1 Analytics Player — Server OK  ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║   Apri: http://localhost:${PORT}           ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  console.log('Premi Ctrl+C per fermare il server.');
});
