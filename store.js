// Almacenamiento de eventos con dos backends intercambiables:
//  - Redis vía API REST de Upstash (Vercel y otros entornos sin disco persistente),
//    si están definidas KV_REST_API_URL/KV_REST_API_TOKEN o UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN.
//  - Archivo JSON en $DATA_DIR/data.json en cualquier otro caso.
//
// Un evento se maneja como { ...config, responses: { token: resp }, suggestions: [ ... ] }.
// Respuestas y sugerencias se guardan por separado de la configuración para que dos personas
// que responden a la vez no se pisen.
const fs = require('fs');
const path = require('path');

function fileStore(dataDir) {
  const file = path.join(dataDir, 'data.json');
  let db;
  try {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    db = { events: {} };
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(db, null, 2));
    fs.renameSync(file + '.tmp', file);
  }
  const split = ({ responses, suggestions, ...config }) => config;

  return {
    kind: 'archivo ' + file,
    async list() {
      return Object.values(db.events).map((ev) => ({
        config: split(ev),
        responses: Object.keys(ev.responses || {}).length,
        suggestions: (ev.suggestions || []).length,
      }));
    },
    async get(id) {
      const ev = db.events[id];
      return ev ? structuredClone({ responses: {}, suggestions: [], ...ev }) : null;
    },
    async saveConfig(config) {
      const prev = db.events[config.id] || { responses: {}, suggestions: [] };
      db.events[config.id] = { ...config, responses: prev.responses || {}, suggestions: prev.suggestions || [] };
      save();
    },
    async remove(id) {
      delete db.events[id];
      save();
    },
    async setResponse(id, token, resp) {
      db.events[id].responses[token] = resp;
      save();
    },
    async addSuggestion(id, s) {
      (db.events[id].suggestions = db.events[id].suggestions || []).push(s);
      save();
    },
    async removeSuggestion(id, sid) {
      db.events[id].suggestions = (db.events[id].suggestions || []).filter((s) => s.id !== sid);
      save();
    },
  };
}

function redisStore(url, token) {
  const P = 'agenda:';
  const k = {
    ids: P + 'events',
    config: (id) => P + 'ev:' + id,
    resp: (id) => P + 'resp:' + id,
    sug: (id) => P + 'sug:' + id,
  };

  async function pipeline(cmds) {
    const res = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    if (!res.ok) throw new Error('Error de base de datos (' + res.status + ')');
    const out = await res.json();
    const err = out.find((r) => r.error);
    if (err) throw new Error('Error de base de datos: ' + err.error);
    return out.map((r) => r.result);
  }
  // HGETALL devuelve [campo, valor, campo, valor, ...]
  function hashValues(flat) {
    const out = {};
    for (let i = 0; i < (flat || []).length; i += 2) out[flat[i]] = JSON.parse(flat[i + 1]);
    return out;
  }

  return {
    kind: 'Redis ' + new URL(url).host,
    async list() {
      const [ids] = await pipeline([['SMEMBERS', k.ids]]);
      if (!ids.length) return [];
      const res = await pipeline(ids.flatMap((id) => [['GET', k.config(id)], ['HLEN', k.resp(id)], ['HLEN', k.sug(id)]]));
      const out = [];
      for (let i = 0; i < ids.length; i++) {
        const raw = res[i * 3];
        if (raw) out.push({ config: JSON.parse(raw), responses: res[i * 3 + 1], suggestions: res[i * 3 + 2] });
      }
      return out;
    },
    async get(id) {
      const [raw, resp, sug] = await pipeline([['GET', k.config(id)], ['HGETALL', k.resp(id)], ['HGETALL', k.sug(id)]]);
      if (!raw) return null;
      const suggestions = Object.values(hashValues(sug)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { ...JSON.parse(raw), responses: hashValues(resp), suggestions };
    },
    async saveConfig(config) {
      await pipeline([['SET', k.config(config.id), JSON.stringify(config)], ['SADD', k.ids, config.id]]);
    },
    async remove(id) {
      await pipeline([['DEL', k.config(id), k.resp(id), k.sug(id)], ['SREM', k.ids, id]]);
    },
    async setResponse(id, tok, resp) {
      await pipeline([['HSET', k.resp(id), tok, JSON.stringify(resp)]]);
    },
    async addSuggestion(id, s) {
      await pipeline([['HSET', k.sug(id), s.id, JSON.stringify(s)]]);
    },
    async removeSuggestion(id, sid) {
      await pipeline([['HDEL', k.sug(id), sid]]);
    },
  };
}

function createStore({ dataDir }) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStore(url, token);
  if (process.env.VERCEL) {
    throw new Error('En Vercel hace falta una base Redis (Upstash): agregala desde Storage en el proyecto de Vercel.');
  }
  return fileStore(dataDir);
}

module.exports = { createStore };
