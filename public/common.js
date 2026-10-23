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
function enabledDates(ev) {
  const off = new Set(ev.disabledDates);
  return eventDates(ev).filter((d) => !off.has(d));
}

// fecha "YYYY-MM-DD" -> lista de nombres que pueden ese día
function dayIndex(responses) {
  const idx = new Map();
  for (const r of responses) {
    for (const d of r.dates) {
      if (!idx.has(d)) idx.set(d, []);
      idx.get(d).push(r.name);
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
 * opts.cell(date) -> { cls, html, title, style, clickable }
 * opts.onClick(date): al tocar un día.
 * opts.onPaint(dates, on) + opts.isOn(date): en lugar de onClick, permite arrastrar sobre los días.
 *   Se marca (o desmarca, si el primer día ya estaba marcado) el rectángulo entre el día inicial
 *   y el actual: arrastrar en horizontal toma una semana; en vertical, el mismo día de varias semanas.
 */
function renderCalendar(container, ev, opts) {
  const first = addDays(ev.startDate, -weekday(ev.startDate));
  const last = addDays(ev.startDate, ev.days - 1);
  const end = addDays(last, 6 - weekday(last));
  const inRange = new Set(eventDates(ev));

  let html = `<div class="cal${opts.onPaint ? ' paint' : ''}">`;
  html += DOW.map((d) => `<div class="cal-dow">${d}</div>`).join('');
  let i = 0;
  for (let d = first; d <= end; d = addDays(d, 1), i++) {
    const day = new Date(d + 'T00:00:00Z').getUTCDate();
    if (!inRange.has(d)) {
      html += `<div class="cal-day out"><span class="cal-num">${day}</span></div>`;
      continue;
    }
    const c = opts.cell(d) || {};
    const month = day === 1 || d === ev.startDate ? ` <span class="cal-mon">${MONTHS[new Date(d + 'T00:00:00Z').getUTCMonth()]}</span>` : '';
    html += `<button type="button" class="cal-day ${c.cls || ''}" data-date="${d}" data-r="${Math.floor(i / 7)}" data-c="${i % 7}"
      ${c.clickable === false ? 'disabled' : ''} ${c.style ? `style="${c.style}"` : ''} title="${esc(c.title || '')}">
      <span class="cal-num">${day}${month}</span>${c.html || ''}</button>`;
  }
  html += '</div>';
  container.innerHTML = html;
  container._cal = opts;
  if (!container._calBound) {
    container._calBound = true;
    bindCalendar(container);
  }
}

// Los eventos se escuchan una sola vez en el contenedor; renderCalendar sólo reemplaza el contenido.
function bindCalendar(container) {
  let drag = null; // { start, on, sel: [botones] }
  const dayAt = (x, y) => {
    const b = document.elementFromPoint(x, y)?.closest('button.cal-day:not(:disabled)');
    return b && container.contains(b) ? b : null;
  };
  const preview = (sel) => {
    container.querySelectorAll('.painting').forEach((b) => b.classList.remove('painting', 'p-on', 'p-off'));
    sel.forEach((b) => b.classList.add('painting', drag.on ? 'p-on' : 'p-off'));
  };
  const rect = (a, b) => {
    const [r1, r2] = [+a.dataset.r, +b.dataset.r].sort((x, y) => x - y);
    const [c1, c2] = [+a.dataset.c, +b.dataset.c].sort((x, y) => x - y);
    return [...container.querySelectorAll('button.cal-day:not(:disabled)')]
      .filter((x) => x.dataset.r >= r1 && x.dataset.r <= r2 && x.dataset.c >= c1 && x.dataset.c <= c2);
  };

  container.addEventListener('pointerdown', (e) => {
    const opts = container._cal;
    const b = e.target.closest('button.cal-day:not(:disabled)');
    if (!opts.onPaint || !b || e.button !== 0) return;
    e.preventDefault();
    container.setPointerCapture(e.pointerId);
    drag = { start: b, on: !opts.isOn(b.dataset.date), sel: [b] };
    preview(drag.sel);
  });
  container.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const b = dayAt(e.clientX, e.clientY);
    if (!b) return;
    drag.sel = rect(drag.start, b);
    preview(drag.sel);
  });
  container.addEventListener('pointerup', () => {
    if (!drag) return;
    const { sel, on } = drag;
    drag = null;
    container._cal.onPaint(sel.map((b) => b.dataset.date), on);
  });
  container.addEventListener('pointercancel', () => {
    if (!drag) return;
    preview([]);
    drag = null;
  });
  container.addEventListener('click', (e) => {
    const b = e.target.closest('button.cal-day:not(:disabled)');
    const opts = container._cal;
    if (!b) return;
    if (!opts.onPaint) opts.onClick?.(b.dataset.date);
    // Con el mouse o el dedo ya lo resolvió pointerup; el clic con teclado (detail 0) alterna el día.
    else if (e.detail === 0) opts.onPaint([b.dataset.date], !opts.isOn(b.dataset.date));
  });
}
