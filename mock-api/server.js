const http = require('http');

// Mode: 'ok' | 'fail' | 'slow'
// Toggle via: POST /admin/mode  { "mode": "fail" }
let mode = 'ok';

const SLOW_DELAY_MS = 6000; // longer than the 5s timeout → triggers TimeoutError

const responses = {
  '/authorize': { success: true, message: 'authorized' },
  '/confirm':   { success: true, message: 'confirmed' },
  '/void':      { success: true, message: 'voided' },
};

function handleAdmin(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { mode: newMode } = JSON.parse(body);
      if (!['ok', 'fail', 'slow'].includes(newMode)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mode must be ok | fail | slow' }));
        return;
      }
      mode = newMode;
      console.log(`[mock-api] mode switched → ${mode}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mode }));
    } catch {
      res.writeHead(400); res.end();
    }
  });
}

function handleTransaction(req, res, handler) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    console.log(`[mock-api] POST ${req.url} mode=${mode} — ${body}`);

    if (mode === 'fail') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'simulated upstream failure' }));
      return;
    }

    const respond = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handler));
    };

    if (mode === 'slow') {
      setTimeout(respond, SLOW_DELAY_MS);
    } else {
      respond();
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/admin/mode') {
    return handleAdmin(req, res);
  }

  if (req.method === 'GET' && req.url === '/admin/mode') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mode }));
    return;
  }

  const handler = responses[req.url];
  if (req.method !== 'POST' || !handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  handleTransaction(req, res, handler);
});

server.listen(4000, () => console.log('[mock-api] listening on :4000'));
