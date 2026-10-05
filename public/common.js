// Utilidades compartidas entre la vista de participantes y la de administración.
const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DOW_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// 0 = lunes … 6 = domingo
function weekday(date) {
  return (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
}
function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function toTime(min) {
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
function fmtDay(date) {
  const d = new Date(date + 'T00:00:00Z');
  return `${DOW[weekday(date)]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function fmtLong(date) {
  const d = new Date(date + 'T00:00:00Z');
  return `${DOW_LONG[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS_LONG[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

function eventDates(ev) {
  const out = [];
  for (let i = 0; i < ev.days; i++) out.push(addDays(ev.startDate, i));
  return out;
}
// Horas de inicio elegibles: cada STEP minutos dentro del rango (igual que en el servidor).
const STEP = 60;
function eventTimes(ev) {
  const out = [];
  for (let m = toMin(ev.dayStart); m < toMin(ev.dayEnd); m += STEP) out.push(toTime(m));
  return out;
}
function enabledDates(ev) {
  const off = new Set(ev.disabledDates);
  return eventDates(ev).filter((d) => !off.has(d));
}

// slot "YYYY-MM-DDTHH:MM" -> lista de nombres disponibles
function slotIndex(ev) {
  const idx = new Map();
  for (const r of ev.responses) {
    for (const s of r.slots) {
      if (!idx.has(s)) idx.set(s, []);
      idx.get(s).push(r.name);
    }
  }
  return idx;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

/**
 * Dibuja un calendario semanal (lunes a domingo) que cubre el rango del evento.
 * opts.cell(date) -> { cls, html, title, clickable }
 */
function renderCalendar(container, ev, opts) {
  const first = addDays(ev.startDate, -weekday(ev.startDate));
  const last = addDays(ev.startDate, ev.days - 1);
  const end = addDays(last, 6 - weekday(last));
  const inRange = new Set(eventDates(ev));

  let html = '<div class="cal">';
  html += DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('');
  for (let d = first; d <= end; d = addDays(d, 1)) {
    const day = new Date(d + 'T00:00:00Z').getUTCDate();
    if (!inRange.has(d)) {
      html += `<div class="cal-day out"><span class="cal-num">${day}</span></div>`;
      continue;
    }
    const c = opts.cell(d) || {};
    const month = day === 1 || d === ev.startDate ? ` <span class="cal-mon">${MONTHS[new Date(d + 'T00:00:00Z').getUTCMonth()]}</span>` : '';
    html += `<button type="button" class="cal-day ${c.cls || ''}" data-date="${d}" ${c.clickable === false ? 'disabled' : ''} title="${esc(c.title || '')}">
      <span class="cal-num">${day}${month}</span>${c.html || ''}</button>`;
  }
  html += '</div>';
  container.innerHTML = html;
  container.querySelectorAll('button.cal-day').forEach((b) => b.addEventListener('click', () => opts.onClick(b.dataset.date)));
}
