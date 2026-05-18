const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ═══════════════════════════════════════════════════════════════
//  PERSISTENCIA (fichero JSON — suficiente para uso de equipo)
// ═══════════════════════════════════════════════════════════════
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { operations: {} };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let DB = loadData();

// ═══════════════════════════════════════════════════════════════
//  TIEMPO REAL — SSE por sala
// ═══════════════════════════════════════════════════════════════
// clients: { opId: [ {res, role, missionId} ] }
const clients = {};

function broadcast(opId, missionId, event, data, excludeRes = null) {
  const room = clients[opId] || [];
  const msg = `data: ${JSON.stringify({ event, data })}\n\n`;
  room.forEach(c => {
    if (c.res !== excludeRes) {
      try { c.res.write(msg); } catch(e) {}
    }
  });
}

function addClient(opId, res, role) {
  if (!clients[opId]) clients[opId] = [];
  clients[opId].push({ res, role });
}

function removeClient(opId, res) {
  if (clients[opId]) clients[opId] = clients[opId].filter(c => c.res !== res);
}

// ═══════════════════════════════════════════════════════════════
//  CÓDIGOS Y HELPERS
// ═══════════════════════════════════════════════════════════════
function genCode(len = 6) {
  return crypto.randomBytes(len).toString('hex').toUpperCase().slice(0, len);
}

function getRoleByCode(op, code) {
  if (op.codes.editor  === code) return 'editor';
  if (op.codes.mando   === code) return 'mando';
  if (op.codes.soldado === code) return 'soldado';
  return null;
}

function canEdit(role, layer) {
  if (role === 'editor')  return true;               // editor edita todo
  if (role === 'mando'  && layer === 'mando')   return true;
  if (role === 'soldado' && layer === 'soldado') return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════
//  TILE CACHE
// ═══════════════════════════════════════════════════════════════
const tileCache = new Map();
const CACHE_MAX = 3000;

function fetchTile(z, y, x, cb) {
  const key = `${z}/${y}/${x}`;
  if (tileCache.has(key)) return cb(null, tileCache.get(key));
  const cdn = (parseInt(x) + parseInt(y)) % 9 + 1;
  const tileUrl = `https://cdn${cdn}.gamermaps.net/maps/arma-reforger/terrain/everon/0505/${z}/${y}/t_${x}.jpg`;
  const req = https.get(tileUrl, {
    headers: {
      'Referer': 'https://gamermaps.net/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
    }
  }, (res) => {
    if (res.statusCode !== 200) return cb(new Error('Status ' + res.statusCode));
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (tileCache.size >= CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
      tileCache.set(key, buf);
      cb(null, buf);
    });
  });
  req.on('error', cb);
  req.setTimeout(8000, () => { req.destroy(); cb(new Error('timeout')); });
}

// ═══════════════════════════════════════════════════════════════
//  MIME
// ═══════════════════════════════════════════════════════════════
const MIME = { '.html':'text/html', '.js':'application/javascript',
               '.css':'text/css', '.jpg':'image/jpeg', '.png':'image/png' };

// ═══════════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════════
function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch(e) { resolve({}); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  const q = parsed.query;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── TILE PROXY ──────────────────────────────────────────────
  const tileMatch = p.match(/^\/tile\/(\d+)\/(\d+)\/(\d+)$/);
  if (tileMatch) {
    const [, z, y, x] = tileMatch;
    fetchTile(z, y, x, (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400', 'Content-Length': buf.length });
      res.end(buf);
    });
    return;
  }

  // ── SSE — SUSCRIPCIÓN TIEMPO REAL ───────────────────────────
  // GET /api/subscribe?opId=XXX&code=YYY
  if (p === '/api/subscribe') {
    const { opId, code } = q;
    const op = DB.operations[opId];
    if (!op) { json(res, { error: 'Operación no encontrada' }, 404); return; }
    const role = getRoleByCode(op, code);
    if (!role) { json(res, { error: 'Código inválido' }, 403); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Enviar estado inicial
    res.write(`data: ${JSON.stringify({ event: 'init', data: { op, role } })}\n\n`);

    addClient(opId, res, role);
    req.on('close', () => removeClient(opId, res));
    return;
  }

  // ── API REST ─────────────────────────────────────────────────

  // POST /api/operations — crear operación
  if (p === '/api/operations' && method === 'POST') {
    const body = await parseBody(req);
    const opId = genCode(8);
    const op = {
      id: opId,
      name: body.name || 'Nueva Operación',
      mapId: body.mapId || 0,
      createdAt: Date.now(),
      codes: {
        editor:  genCode(6),
        mando:   genCode(6),
        soldado: genCode(6),
      },
      // Capa base del editor (permanente)
      baseMarkers: [],
      baseStrokes: [],
      // Misiones
      missions: {}
    };
    DB.operations[opId] = op;
    saveData(DB);
    json(res, { op });
    return;
  }

  // GET /api/operations?code=XXX — obtener operación por código
  if (p === '/api/operations' && method === 'GET') {
    const { code } = q;
    if (!code) { json(res, { error: 'Falta código' }, 400); return; }
    // Buscar en todas las ops
    let found = null, foundRole = null;
    for (const op of Object.values(DB.operations)) {
      const role = getRoleByCode(op, code);
      if (role) { found = op; foundRole = role; break; }
    }
    if (!found) { json(res, { error: 'Código no válido' }, 404); return; }
    json(res, { op: found, role: foundRole });
    return;
  }

  // POST /api/operations/:opId/missions — crear misión
  if (p.match(/^\/api\/operations\/\w+\/missions$/) && method === 'POST') {
    const opId = p.split('/')[3];
    const body = await parseBody(req);
    const { code } = body;
    const op = DB.operations[opId];
    if (!op) { json(res, { error: 'No encontrado' }, 404); return; }
    const role = getRoleByCode(op, code);
    if (role !== 'editor') { json(res, { error: 'Solo el editor puede crear misiones' }, 403); return; }

    const mId = genCode(6);
    op.missions[mId] = {
      id: mId,
      name: body.name || 'Misión ' + (Object.keys(op.missions).length + 1),
      createdAt: Date.now(),
      mandoMarkers: [], mandoStrokes: [],
      soldadoMarkers: [], soldadoStrokes: [],
    };
    saveData(DB);
    broadcast(opId, null, 'mission_created', { mission: op.missions[mId] });
    json(res, { mission: op.missions[mId] });
    return;
  }

  // PUT /api/operations/:opId/layers — actualizar una capa
  // body: { code, layer, markers, strokes, missionId? }
  if (p.match(/^\/api\/operations\/\w+\/layers$/) && method === 'PUT') {
    const opId = p.split('/')[3];
    const body = await parseBody(req);
    const { code, layer, markers, strokes, missionId } = body;
    const op = DB.operations[opId];
    if (!op) { json(res, { error: 'No encontrado' }, 404); return; }
    const role = getRoleByCode(op, code);
    if (!role) { json(res, { error: 'Código inválido' }, 403); return; }
    if (!canEdit(role, layer)) { json(res, { error: 'Sin permisos para esta capa' }, 403); return; }

    if (layer === 'base') {
      // Solo editor
      op.baseMarkers = markers || op.baseMarkers;
      op.baseStrokes = strokes || op.baseStrokes;
    } else if (missionId && op.missions[missionId]) {
      const m = op.missions[missionId];
      if (layer === 'mando') {
        m.mandoMarkers = markers || m.mandoMarkers;
        m.mandoStrokes = strokes || m.mandoStrokes;
      } else if (layer === 'soldado') {
        m.soldadoMarkers = markers || m.soldadoMarkers;
        m.soldadoStrokes = strokes || m.soldadoStrokes;
      }
    }

    saveData(DB);

    // Broadcast a todos en la sala
    broadcast(opId, missionId, 'layer_update', {
      layer, markers, strokes, missionId
    }, res);

    json(res, { ok: true });
    return;
  }

  // ── ARCHIVOS ESTÁTICOS ───────────────────────────────────────
  let filePath = p === '/' ? '/index.html' : p;
  filePath = path.join(__dirname, 'Public', filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`EVERON OPS v2 running on port ${PORT}`));
