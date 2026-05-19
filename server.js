const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'Public');

// ═══════════════════════════════════════════════
//  GITHUB PERSISTENCE
//  Variables de entorno en Render:
//    GITHUB_TOKEN  — Personal Access Token
//    GITHUB_OWNER  — tu usuario GitHub (ej: Bhelma)
//    GITHUB_REPO   — nombre del repo (ej: Dibujo_Map)
//    GITHUB_FILE   — ruta del archivo (por defecto: data.json)
// ═══════════════════════════════════════════════
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_OWNER = process.env.GITHUB_OWNER;
const GH_REPO  = process.env.GITHUB_REPO;
const GH_FILE  = process.env.GITHUB_FILE || 'data.json';

let DB = { operations: {} };
let ghFileSha = null;

function ghRequest(method, apiPath, body, cb) {
  const data = body ? JSON.stringify(body) : null;
  const opts = {
    hostname: 'api.github.com',
    path: apiPath,
    method,
    headers: {
      'Authorization': 'token ' + GH_TOKEN,
      'User-Agent': 'everon-ops',
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    }
  };
  if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
  const req = https.request(opts, res => {
    let raw = '';
    res.on('data', c => raw += c);
    res.on('end', () => {
      try { cb(null, JSON.parse(raw), res.statusCode); }
      catch(e) { cb(null, raw, res.statusCode); }
    });
  });
  req.on('error', cb);
  if (data) req.write(data);
  req.end();
}

function loadFromGitHub(cb) {
  if (!GH_TOKEN) { console.log('Sin GITHUB_TOKEN — datos en memoria'); cb(); return; }
  ghRequest('GET', `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`, null, (err, data, status) => {
    if (err || status === 404) { console.log('data.json no existe en GitHub, empezando vacío'); cb(); return; }
    try {
      ghFileSha = data.sha;
      DB = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
      console.log('DB cargada:', Object.keys(DB.operations).length, 'operaciones');
    } catch(e) { console.error('Error parseando DB:', e.message); }
    cb();
  });
}

function saveToGitHub() {
  if (!GH_TOKEN) return;
  const body = {
    message: 'auto: update data',
    content: Buffer.from(JSON.stringify(DB, null, 2)).toString('base64'),
    ...(ghFileSha ? { sha: ghFileSha } : {})
  };
  ghRequest('PUT', `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`, body, (err, data, status) => {
    if (err) { console.error('Error GitHub save:', err.message); return; }
    if (status === 200 || status === 201) {
      ghFileSha = data.content && data.content.sha;
    } else {
      console.error('GitHub save error:', status);
    }
  });
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToGitHub, 2000);
}

// ═══════════════════════════════════════════════
//  SSE — TIEMPO REAL
// ═══════════════════════════════════════════════
const clients = {};

function broadcast(opId, event, data, excludeRes) {
  const msg = `data: ${JSON.stringify({ event, data })}\n\n`;
  (clients[opId] || []).forEach(c => {
    if (c.res !== excludeRes) try { c.res.write(msg); } catch(e) {}
  });
}

function addClient(opId, res, role) {
  if (!clients[opId]) clients[opId] = [];
  clients[opId].push({ res, role });
}

function removeClient(opId, res) {
  if (clients[opId]) clients[opId] = clients[opId].filter(c => c.res !== res);
}

// ═══════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════
function genCode(len) {
  return crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, len || 6);
}

function getRole(op, code) {
  if (!code || !op) return null;
  code = code.toUpperCase();
  if (op.codes.editor === code) return 'editor';
  if (op.codes.player === code) return 'player';
  return null;
}

function makeOp(name, mapId) {
  const id = genCode(8);
  return {
    id, name, mapId: mapId || 0, createdAt: Date.now(),
    codes: { editor: genCode(6), player: genCode(6) },
    editorMarkers: [], editorStrokes: [], missions: {}
  };
}

function makeMission(name) {
  return { id: genCode(6), name, createdAt: Date.now(), playerMarkers: [], playerStrokes: [] };
}

// ═══════════════════════════════════════════════
//  TILE PROXY
// ═══════════════════════════════════════════════
const tileCache = new Map();

function fetchTile(z, y, x, cb) {
  const key = `${z}/${y}/${x}`;
  if (tileCache.has(key)) return cb(null, tileCache.get(key));
  const cdn = (parseInt(x) + parseInt(y)) % 9 + 1;
  const req = https.get(
    `https://cdn${cdn}.gamermaps.net/maps/arma-reforger/terrain/everon/0505/${z}/${y}/t_${x}.jpg`,
    { headers: { 'Referer': 'https://gamermaps.net/', 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' } },
    res => {
      if (res.statusCode !== 200) return cb(new Error('Status ' + res.statusCode));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (tileCache.size >= 3000) tileCache.delete(tileCache.keys().next().value);
        tileCache.set(key, buf);
        cb(null, buf);
      });
    }
  );
  req.on('error', cb);
  req.setTimeout(8000, () => { req.destroy(); cb(new Error('timeout')); });
}

// ═══════════════════════════════════════════════
//  HTTP
// ═══════════════════════════════════════════════
const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript',
               '.css':'text/css', '.jpg':'image/jpeg', '.png':'image/png' };

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}

function send(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const q = parsed.query;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // TILE PROXY
  const tm = p.match(/^\/tile\/(\d+)\/(\d+)\/(\d+)$/);
  if (tm) {
    fetchTile(tm[1], tm[2], tm[3], (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type':'image/jpeg', 'Cache-Control':'public,max-age=86400', 'Content-Length':buf.length });
      res.end(buf);
    });
    return;
  }

  // SSE
  if (p === '/api/events' && method === 'GET') {
    const op = DB.operations[q.opId];
    if (!op) { send(res, { error: 'No encontrado' }, 404); return; }
    const role = getRole(op, q.code);
    if (!role) { send(res, { error: 'Código inválido' }, 403); return; }
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
    res.write(`data: ${JSON.stringify({ event:'init', data:{ op, role } })}\n\n`);
    addClient(q.opId, res, role);
    broadcast(q.opId, 'online', { count: (clients[q.opId]||[]).length });
    req.on('close', () => { removeClient(q.opId, res); broadcast(q.opId, 'online', { count: (clients[q.opId]||[]).length }); });
    return;
  }

  // GET /api/ops — listar
  if (p === '/api/ops' && method === 'GET') {
    const list = Object.values(DB.operations)
      .map(op => ({ id:op.id, name:op.name, mapId:op.mapId, createdAt:op.createdAt, missionCount:Object.keys(op.missions||{}).length }))
      .sort((a,b) => b.createdAt - a.createdAt);
    send(res, { ops: list }); return;
  }

  // POST /api/ops — crear
  if (p === '/api/ops' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) { send(res, { error: 'Falta nombre' }, 400); return; }
    const op = makeOp(body.name.trim(), body.mapId || 0);
    DB.operations[op.id] = op;
    scheduleSave();
    send(res, { op }); return;
  }

  // GET /api/ops/join?code=X
  if (p === '/api/ops/join' && method === 'GET') {
    for (const op of Object.values(DB.operations)) {
      const role = getRole(op, q.code);
      if (role) { send(res, { op, role }); return; }
    }
    send(res, { error: 'Código no válido' }, 404); return;
  }

  // DELETE /api/ops/:id
  const opDel = p.match(/^\/api\/ops\/(\w+)$/);
  if (opDel && method === 'DELETE') {
    const op = DB.operations[opDel[1]];
    if (!op) { send(res, { error: 'No encontrado' }, 404); return; }
    const body = await readBody(req);
    if (getRole(op, body.code) !== 'editor') { send(res, { error: 'Sin permiso' }, 403); return; }
    delete DB.operations[opDel[1]];
    scheduleSave();
    send(res, { ok: true }); return;
  }

  // POST /api/ops/:id/missions
  const mPost = p.match(/^\/api\/ops\/(\w+)\/missions$/);
  if (mPost && method === 'POST') {
    const op = DB.operations[mPost[1]];
    if (!op) { send(res, { error: 'No encontrado' }, 404); return; }
    const body = await readBody(req);
    if (getRole(op, body.code) !== 'editor') { send(res, { error: 'Sin permiso' }, 403); return; }
    const m = makeMission(body.name || 'Misión');
    op.missions[m.id] = m;
    scheduleSave();
    broadcast(op.id, 'mission_added', { mission: m });
    send(res, { mission: m }); return;
  }

  // PUT /api/ops/:id/editor
  const edPut = p.match(/^\/api\/ops\/(\w+)\/editor$/);
  if (edPut && method === 'PUT') {
    const op = DB.operations[edPut[1]];
    if (!op) { send(res, { error: 'No encontrado' }, 404); return; }
    const body = await readBody(req);
    if (getRole(op, body.code) !== 'editor') { send(res, { error: 'Sin permiso' }, 403); return; }
    op.editorMarkers = body.markers || [];
    op.editorStrokes = body.strokes || [];
    scheduleSave();
    broadcast(op.id, 'editor_update', { markers: op.editorMarkers, strokes: op.editorStrokes }, res);
    send(res, { ok: true }); return;
  }

  // PUT /api/ops/:id/missions/:mId/players
  const plPut = p.match(/^\/api\/ops\/(\w+)\/missions\/(\w+)\/players$/);
  if (plPut && method === 'PUT') {
    const op = DB.operations[plPut[1]];
    if (!op) { send(res, { error: 'No encontrado' }, 404); return; }
    const body = await readBody(req);
    if (!getRole(op, body.code)) { send(res, { error: 'Sin permiso' }, 403); return; }
    const m = op.missions[plPut[2]];
    if (!m) { send(res, { error: 'Misión no encontrada' }, 404); return; }
    m.playerMarkers = body.markers || [];
    m.playerStrokes = body.strokes || [];
    scheduleSave();
    broadcast(op.id, 'player_update', { missionId: m.id, markers: m.playerMarkers, strokes: m.playerStrokes }, res);
    send(res, { ok: true }); return;
  }

  // ARCHIVOS ESTÁTICOS
  let file = p === '/' ? '/index.html' : p;
  file = path.join(PUBLIC_DIR, file);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

// ARRANQUE
loadFromGitHub(() => {
  server.listen(PORT, () => {
    console.log(`EVERON OPS v4 — puerto ${PORT}`);
    if (!GH_TOKEN) console.warn('⚠ Sin GITHUB_TOKEN — datos no persisten');
    else console.log(`GitHub: ${GH_OWNER}/${GH_REPO}/${GH_FILE}`);
  });
});
