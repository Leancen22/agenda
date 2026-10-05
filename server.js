// Agenda — coordinación de fecha y hora para reuniones.
// Servidor sin dependencias: Node >= 18. Datos en $DATA_DIR/data.json (por defecto ./data).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Carga .env (si existe) sin pisar variables ya definidas en el entorno.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (ADMIN_KEY.length < 8) {
  console.error('Falta ADMIN_KEY (mínimo 8 caracteres). Definila en .env o como variable de entorno.');
  process.exit(1);
}
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');


// ---------- persistencia ----------
function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { events: {} };
  }
}

let db = load();

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- utilidades de fechas (siempre "YYYY-MM-DD" / "HH:MM", sin zona horaria) ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Los horarios elegibles son horas de inicio cada STEP minutos dentro del rango del evento.
const STEP = 60;

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function toTime(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

function eventDates(ev) {
  const out = [];
  for (let i = 0; i < ev.days; i++) out.push(addDays(ev.startDate, i));
  return out;
}

function eventTimes(ev) {
  const out = [];
  for (let m = toMin(ev.dayStart); m < toMin(ev.dayEnd); m += STEP) out.push(toTime(m));
  return out;
}

// Slots válidos = días habilitados × horarios del rango.
function validSlots(ev) {
  const disabled = new Set(ev.disabledDates);
  const times = eventTimes(ev);
  const set = new Set();
  for (const d of eventDates(ev)) {
    if (disabled.has(d)) continue;
    for (const t of times) set.add(d + 'T' + t);
  }
  return set;
}

// ---------- validación de configuración de evento ----------
function applyConfig(ev, body) {
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  if ('title' in body) ev.title = str(body.title, 120) || 'Reunión';
  if ('place' in body) ev.place = str(body.place, 200);
  if ('description' in body) ev.description = str(body.description, 1000);
  if ('startDate' in body) {
    if (!DATE_RE.test(body.startDate)) throw new Error('Fecha de inicio inválida');
    ev.startDate = body.startDate;
  }
  if ('days' in body) {
    const n = Number(body.days);
    if (!Number.isInteger(n) || n < 1 || n > 62) throw new Error('La cantidad de días debe estar entre 1 y 62');
    ev.days = n;
  }
  if ('dayStart' in body) {
    if (!TIME_RE.test(body.dayStart)) throw new Error('Hora de inicio inválida');
    ev.dayStart = body.dayStart;
  }
  if ('dayEnd' in body) {
    if (!TIME_RE.test(body.dayEnd)) throw new Error('Hora de fin inválida');
    ev.dayEnd = body.dayEnd;
  }
  if ('disabledDates' in body) {
    if (!Array.isArray(body.disabledDates)) throw new Error('disabledDates debe ser una lista');
    ev.disabledDates = body.disabledDates.filter((d) => DATE_RE.test(d));
  }
  if (toMin(ev.dayEnd) <= toMin(ev.dayStart)) {
    throw new Error('La hora de fin debe ser posterior a la de inicio');
  }
  if ('confirmed' in body) {
    const c = body.confirmed;
    if (c === null) ev.confirmed = null;
    else if (c && validSlots(ev).has(c.date + 'T' + c.time)) ev.confirmed = { date: c.date, time: c.time };
    else throw new Error('La fecha/hora confirmada no está dentro de los horarios disponibles');
  }
  // Si cambió la grilla, se descartan selecciones que quedaron fuera.
  const valid = validSlots(ev);
  for (const r of Object.values(ev.responses)) r.slots = r.slots.filter((s) => valid.has(s));
  if (ev.confirmed && !valid.has(ev.confirmed.date + 'T' + ev.confirmed.time)) ev.confirmed = null;
}

// Vista pública: oculta los tokens; marca con self:true la respuesta de quien consulta.
// Las sugerencias no se incluyen: sólo las ve el admin (adminEvent).
function publicEvent(ev, token) {
  const { responses, suggestions, ...rest } = ev;
  return {
    ...rest,
    responses: Object.entries(responses).map(([t, r]) => ({
      name: r.name,
      slots: r.slots,
      updatedAt: r.updatedAt,
      ...(token && t === token ? { self: true } : {}),
    })),
  };
}

function adminEvent(ev) {
  return { ...publicEvent(ev), suggestions: ev.suggestions || [] };
}

// ---------- http ----------
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('Cuerpo demasiado grande'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
  });
}

function isAdmin(req) {
  const key = String(req.headers['x-admin-key'] || '');
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Prohibido' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'No encontrado' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function api(req, res, parts) {
  // parts: ['api', ...]
  const [, scope, id, sub] = parts;

  // --- público ---
  if (scope === 'events' && id && !sub && req.method === 'GET') {
    const ev = db.events[id];
    if (!ev) return send(res, 404, { error: 'Evento no encontrado' });
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    return send(res, 200, publicEvent(ev, token));
  }

  if (scope === 'events' && id && sub === 'response' && req.method === 'PUT') {
    const ev = db.events[id];
    if (!ev) return send(res, 404, { error: 'Evento no encontrado' });
    if (ev.confirmed) return send(res, 409, { error: 'La fecha ya fue confirmada; no se aceptan cambios' });
    const body = await readBody(req);
    const token = String(body.token || '');
    const name = String(body.name || '').trim().slice(0, 60);
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(token)) return send(res, 400, { error: 'Token inválido' });
    if (!name) return send(res, 400, { error: 'Ingresá tu nombre' });
    if (!Array.isArray(body.slots)) return send(res, 400, { error: 'slots debe ser una lista' });
    const valid = validSlots(ev);
    const slots = [...new Set(body.slots)].filter((s) => valid.has(s)).sort();
    ev.responses[token] = { name, slots, updatedAt: new Date().toISOString() };
    save();
    return send(res, 200, publicEvent(ev, token));
  }

  if (scope === 'events' && id && sub === 'suggestions' && req.method === 'POST') {
    const ev = db.events[id];
    if (!ev) return send(res, 404, { error: 'Evento no encontrado' });
    const body = await readBody(req);
    const text = String(body.text || '').trim().slice(0, 1000);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!text) return send(res, 400, { error: 'Escribí tu sugerencia' });
    ev.suggestions = ev.suggestions || [];
    if (ev.suggestions.length >= 500) return send(res, 429, { error: 'El buzón está lleno' });
    ev.suggestions.push({ id: crypto.randomBytes(4).toString('hex'), name, text, createdAt: new Date().toISOString() });
    save();
    return send(res, 201, { ok: true });
  }

  // --- admin ---
  if (scope === 'admin') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Clave de administrador incorrecta' });

    if (!id && req.method === 'GET') {
      const list = Object.values(db.events)
        .map((ev) => ({ id: ev.id, title: ev.title, place: ev.place, startDate: ev.startDate, days: ev.days, confirmed: ev.confirmed, responses: Object.keys(ev.responses).length, suggestions: (ev.suggestions || []).length, createdAt: ev.createdAt }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, list);
    }

    if (!id && req.method === 'POST') {
      const body = await readBody(req);
      const ev = {
        id: crypto.randomBytes(5).toString('hex'),
        title: 'Reunión',
        place: '',
        description: '',
        startDate: new Date().toISOString().slice(0, 10),
        days: 14,
        dayStart: '09:00',
        dayEnd: '18:00',
        disabledDates: [],
        confirmed: null,
        responses: {},
        suggestions: [],
        createdAt: new Date().toISOString(),
      };
      applyConfig(ev, body);
      db.events[ev.id] = ev;
      save();
      return send(res, 201, adminEvent(ev));
    }

    const ev = db.events[id];
    if (!ev) return send(res, 404, { error: 'Evento no encontrado' });

    if (!sub && req.method === 'GET') return send(res, 200, adminEvent(ev));

    if (sub === 'suggestions' && parts[4] && req.method === 'DELETE') {
      ev.suggestions = (ev.suggestions || []).filter((s) => s.id !== parts[4]);
      save();
      return send(res, 200, adminEvent(ev));
    }

    if (!sub && req.method === 'PUT') {
      const body = await readBody(req);
      const draft = structuredClone(ev);
      applyConfig(draft, body);
      db.events[id] = draft;
      save();
      return send(res, 200, adminEvent(draft));
    }

    if (!sub && req.method === 'DELETE') {
      delete db.events[id];
      save();
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'Ruta no encontrada' });
}

http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const parts = pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'api') return await api(req, res, parts);
      if (req.method !== 'GET') return send(res, 405, { error: 'Método no permitido' });
      serveStatic(req, res, pathname);
    } catch (e) {
      send(res, 400, { error: e.message || 'Error' });
    }
  })
  .listen(PORT, () => {
    console.log(`Agenda escuchando en http://localhost:${PORT}  (admin: http://localhost:${PORT}/admin)`);
  });
