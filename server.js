// Agenda — coordinación de fecha para reuniones.
// Servidor sin dependencias: Node >= 18. Datos en Redis (Upstash) o en $DATA_DIR/data.json; ver store.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store');

// Carga .env (si existe) sin pisar variables ya definidas en el entorno.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Errores de configuración: localmente cortan el arranque; en Vercel se informan en cada pedido a la API,
// porque un proceso que termina sólo deja un 500 genérico.
const configErrors = [];
if (ADMIN_KEY.length < 8) configErrors.push('Falta ADMIN_KEY (mínimo 8 caracteres). Definila en .env o como variable de entorno.');
let store = null;
try {
  store = createStore({ dataDir: DATA_DIR });
} catch (e) {
  configErrors.push(e.message);
}
if (configErrors.length) {
  configErrors.forEach((m) => console.error(m));
  if (!process.env.VERCEL) process.exit(1);
}

// ---------- utilidades de fechas (siempre "YYYY-MM-DD" / "HH:MM", sin zona horaria) ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function eventDates(ev) {
  const out = [];
  for (let i = 0; i < ev.days; i++) out.push(addDays(ev.startDate, i));
  return out;
}

// Días que los participantes pueden marcar: los del rango menos los deshabilitados.
function validDates(ev) {
  const disabled = new Set(ev.disabledDates);
  return new Set(eventDates(ev).filter((d) => !disabled.has(d)));
}

// Datos de versiones anteriores, que se elegían por día y hora: la hora confirmada pasa a ser
// la hora del evento y los horarios marcados ("YYYY-MM-DDTHH:MM") se reducen a sus días.
function migrate(ev) {
  if (ev.time === undefined) ev.time = ev.confirmed?.time || '';
  delete ev.dayStart;
  delete ev.dayEnd;
  if (ev.confirmed) ev.confirmed = { date: ev.confirmed.date };
  return ev;
}
function responseDates(r) {
  return r.dates || [...new Set((r.slots || []).map((s) => s.slice(0, 10)))];
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
  if ('time' in body) {
    const t = str(body.time, 5);
    if (t && !TIME_RE.test(t)) throw new Error('Hora inválida');
    ev.time = t;
  }
  if ('disabledDates' in body) {
    if (!Array.isArray(body.disabledDates)) throw new Error('disabledDates debe ser una lista');
    ev.disabledDates = body.disabledDates.filter((d) => DATE_RE.test(d));
  }
  if ('confirmed' in body) {
    const c = body.confirmed;
    if (c === null) ev.confirmed = null;
    else if (c && validDates(ev).has(c.date)) ev.confirmed = { date: c.date };
    else throw new Error('La fecha confirmada no está entre los días disponibles');
  }
  // Si cambió el rango y la fecha confirmada quedó fuera, se anula.
  if (ev.confirmed && !validDates(ev).has(ev.confirmed.date)) ev.confirmed = null;
}

// Vista pública: oculta los tokens; marca con self:true la respuesta de quien consulta.
// Los días marcados que quedaron fuera del rango actual (o deshabilitados) no se muestran.
// Las sugerencias no se incluyen: sólo las ve el admin (adminEvent).
function publicEvent(ev, token) {
  const { responses, suggestions, ...rest } = migrate(ev);
  const valid = validDates(ev);
  return {
    ...rest,
    responses: Object.entries(responses).map(([t, r]) => ({
      name: r.name,
      dates: responseDates(r).filter((d) => valid.has(d)),
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
  if (!ADMIN_KEY) return false;
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
  const [, scope, id, sub, subId] = parts;
  if (configErrors.length) return send(res, 503, { error: configErrors.join(' ') });

  // --- público ---
  if (scope === 'events' && id && !sub && req.method === 'GET') {
    const ev = await store.get(id);
    if (!ev) return send(res, 404, { error: 'Evento no encontrado' });
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    return send(res, 200, publicEvent(ev, token));
  }

  if (scope === 'events' && id && sub === 'response' && req.method === 'PUT') {
    const ev = await store.get(id);
    if (!ev) return send(res, 404, { error: 'Evento no encontrado' });
    if (ev.confirmed) return send(res, 409, { error: 'La fecha ya fue confirmada; no se aceptan cambios' });
    const body = await readBody(req);
    const token = String(body.token || '');
    const name = String(body.name || '').trim().slice(0, 60);
    if (!/^[a-zA-Z0-9-]{16,64}$/.test(token)) return send(res, 400, { error: 'Token inválido' });
    if (!name) return send(res, 400, { error: 'Ingresá tu nombre' });
    if (!Array.isArray(body.dates)) return send(res, 400, { error: 'dates debe ser una lista' });
    const valid = validDates(ev);
    const dates = [...new Set(body.dates)].filter((d) => valid.has(d)).sort();
    const resp = { name, dates, updatedAt: new Date().toISOString() };
    await store.setResponse(id, token, resp);
    ev.responses[token] = resp;
    return send(res, 200, publicEvent(ev, token));
  }

  if (scope === 'events' && id && sub === 'suggestions' && req.method === 'POST') {
    const ev = await store.get(id);
    if (!ev) return send(res, 404, { error: 'Evento no encontrado' });
    const body = await readBody(req);
    const text = String(body.text || '').trim().slice(0, 1000);
    const name = String(body.name || '').trim().slice(0, 60);
    if (!text) return send(res, 400, { error: 'Escribí tu sugerencia' });
    if (ev.suggestions.length >= 500) return send(res, 429, { error: 'El buzón está lleno' });
    await store.addSuggestion(id, { id: crypto.randomBytes(4).toString('hex'), name, text, createdAt: new Date().toISOString() });
    return send(res, 201, { ok: true });
  }

  // --- admin ---
  if (scope === 'admin') {
    if (!isAdmin(req)) return send(res, 401, { error: 'Clave de administrador incorrecta' });

    if (!id && req.method === 'GET') {
      const list = (await store.list())
        .map(({ config, responses, suggestions }) => {
          const c = migrate(config);
          return { id: c.id, title: c.title, place: c.place, startDate: c.startDate, days: c.days, time: c.time, confirmed: c.confirmed, responses, suggestions, createdAt: c.createdAt };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, list);
    }

    if (!id && req.method === 'POST') {
      const body = await readBody(req);
      const config = {
        id: crypto.randomBytes(5).toString('hex'),
        title: 'Reunión',
        place: '',
        description: '',
        startDate: new Date().toISOString().slice(0, 10),
        days: 14,
        time: '',
        disabledDates: [],
        confirmed: null,
        createdAt: new Date().toISOString(),
      };
      applyConfig(config, body);
      await store.saveConfig(config);
      return send(res, 201, adminEvent({ ...config, responses: {}, suggestions: [] }));
    }

    const ev = await store.get(id);
    if (!ev) return send(res, 404, { error: 'Evento no encontrado' });

    if (!sub && req.method === 'GET') return send(res, 200, adminEvent(ev));

    if (sub === 'suggestions' && subId && req.method === 'DELETE') {
      await store.removeSuggestion(id, subId);
      ev.suggestions = ev.suggestions.filter((s) => s.id !== subId);
      return send(res, 200, adminEvent(ev));
    }

    if (!sub && req.method === 'PUT') {
      const body = await readBody(req);
      const { responses, suggestions, ...config } = migrate(ev);
      applyConfig(config, body);
      await store.saveConfig(config);
      return send(res, 200, adminEvent({ ...config, responses, suggestions }));
    }

    if (!sub && req.method === 'DELETE') {
      await store.remove(id);
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
    if (store) console.log('Datos en: ' + store.kind);
  });
