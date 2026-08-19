/**
 * RU: Клиент считает ответ из расписаний, полученных один раз. Перетаскивание циферблата
 *     не делает ни одного сетевого вызова — этого требует ТЗ.
 * EN: The client computes answers from timetables fetched once. Dragging the dial makes
 *     no network call at all, exactly as the spec demands.
 */

import * as maplibregl from './vendor/maplibre-gl.mjs';

let MIN_DEADLINE = 12 * 60;
let MAX_DEADLINE = 27 * 60;

/** RU: Циферблат живёт между «через час после отъезда» и «сутки спустя».
 *  EN: The dial spans from an hour after departure to a full day later. */
function setDialRange(departureMinutes) {
  MIN_DEADLINE = departureMinutes + 60;
  MAX_DEADLINE = departureMinutes + 24 * 60;
}
const RAMP = [
  [0, [232, 115, 74]],
  [90, [232, 169, 60]],
  [180, [232, 169, 60]],
  [300, [111, 163, 63]],
  [420, [31, 138, 91]],
];
const DEAD = [195, 198, 210];

const state = {
  home: 'Москва',
  date: null,
  today: null,
  deadline: 22 * 60,
  minGround: 0,
  notBefore: 0,
  budget: 0,
  nights: 0,
  stations: new Map(),
  markers: new Map(),
  selected: null,
};

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const fmtDur = (m) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h} ч ${r} м`;
  return h ? `${h} ч` : `${r} м`;
};

/** RU: Та же математика, что в backend/src/obratno/ground.py. / EN: mirrors ground.py. */
function solve(out, back, deadline, minGround, notBefore = 0, budget = 0) {
  const candidates = back.filter((r) => r[1] <= deadline).sort((a, b) => b[1] - a[1]);
  for (const [backDep, backArr, backPrice = 0] of candidates) {
    let bestArr = null;
    let bestDep = 0;
    let bestPrice = 0;
    for (const [outDep, outArr, outPrice = 0] of out) {
      if (outDep < notBefore || outArr > backDep) continue;
      if (budget && outPrice + backPrice > budget) continue;
      if (bestArr === null || outArr < bestArr) {
        bestArr = outArr;
        bestDep = outDep;
        bestPrice = outPrice;
      }
    }
    if (bestArr === null) continue;
    const ground = backDep - bestArr;
    if (ground >= minGround) {
      return {
        outDep: bestDep, outArr: bestArr, backDep, backArr, ground,
        price: bestPrice + backPrice,
      };
    }
  }
  return null;
}

function rampColor(minutes) {
  if (minutes <= RAMP[0][0]) return RAMP[0][1];
  for (let i = 1; i < RAMP.length; i += 1) {
    if (minutes <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1];
      const [b, cb] = RAMP[i];
      const t = (minutes - a) / (b - a);
      return ca.map((v, k) => Math.round(v + (cb[k] - v) * t));
    }
  }
  return RAMP[RAMP.length - 1][1];
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/* ---------- карта / map ---------- */
const FALLBACK_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9eaf0' } }],
};

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [37.6173, 55.9],
  zoom: 7.1,
  attributionControl: { compact: true },
});
map.on('error', (e) => {
  if (String(e?.error?.message || '').includes('style') && !map.__fellBack) {
    map.__fellBack = true;
    map.setStyle(FALLBACK_STYLE);
  }
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

/* ---------- шайбы / pucks ---------- */
function buildPuck(station) {
  /* RU: MapLibre владеет transform внешнего элемента, GSAP — только внутренним.
     EN: MapLibre owns the root transform, GSAP animates the inner node only. */
  const root = document.createElement('div');
  const el = document.createElement('div');
  el.className = 'puck';
  el.innerHTML =
    '<div class="puck-halo"></div><div class="puck-dot"></div>' +
    `<div class="puck-ring" hidden></div><span class="puck-name">${station.name}</span>`;
  root.appendChild(el);
  root.addEventListener('click', () => openCard(station.code));
  const marker = new maplibregl.Marker({ element: root }).setLngLat([station.lon, station.lat]).addTo(map);
  const dot = el.querySelector('.puck-dot');
  const halo = el.querySelector('.puck-halo');
  const ring = el.querySelector('.puck-ring');
  gsap.set(el, { scale: 0, opacity: 0 });
  return {
    el,
    marker,
    setSize: gsap.quickTo(dot, 'width', { duration: 0.25, ease: 'power2.out' }),
    setSizeY: gsap.quickTo(dot, 'height', { duration: 0.25, ease: 'power2.out' }),
    dot,
    halo,
    ring,
  };
}

function paint(code) {
  const data = state.stations.get(code);
  const puck = state.markers.get(code);
  if (!data || !puck || data.isHome) return null;
  const answer =
    data.out && data.back
      ? solve(data.out, data.back, state.deadline, state.minGround, state.notBefore, state.budget)
      : null;
  const size = answer ? 16 + Math.min(answer.ground, 480) * (46 / 480) : 12;
  const color = answer ? rampColor(answer.ground) : DEAD;
  puck.setSize(size);
  puck.setSizeY(size);
  puck.dot.style.background = rgb(color);
  puck.halo.style.background = rgb(color);
  const haloSize = answer ? size * 2.1 : 0;
  gsap.to(puck.halo, {
    width: haloSize,
    height: haloSize,
    duration: 0.35,
    ease: 'power2.out',
    opacity: answer ? 0.2 : 0,
  });
  gsap.to(puck.el, { opacity: answer ? 1 : 0.55, duration: 0.3 });
  const truncated = data.window === 'truncated';
  puck.ring.hidden = !truncated;
  if (truncated) {
    puck.ring.style.width = `${size + 12}px`;
    puck.ring.style.height = `${size + 12}px`;
  }
  return answer;
}

function repaintAll() {
  let reachable = 0;
  for (const code of state.stations.keys()) if (paint(code)) reachable += 1;
  const node = $('reachable');
  if (node) node.textContent = String(reachable);
  if (state.selected) openCard(state.selected, true);
}

/* ---------- циферблат / dial ---------- */
const dial = $('dial');
const R = 104;
const CIRC = 2 * Math.PI * R;
const fillEl = $('dial-fill');
fillEl.style.strokeDasharray = String(CIRC);

(function ticks() {
  const g = $('dial-ticks');
  for (let i = 0; i < 30; i += 1) {
    const a = (i / 30) * Math.PI * 2 - Math.PI / 2;
    const r1 = 86;
    const r2 = i % 5 === 0 ? 76 : 81;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 120 + Math.cos(a) * r1);
    line.setAttribute('y1', 120 + Math.sin(a) * r1);
    line.setAttribute('x2', 120 + Math.cos(a) * r2);
    line.setAttribute('y2', 120 + Math.sin(a) * r2);
    line.setAttribute('class', 'dial-tick');
    g.appendChild(line);
  }
})();

function renderDial() {
  const t = (state.deadline - MIN_DEADLINE) / (MAX_DEADLINE - MIN_DEADLINE);
  gsap.to('#dial-handle', { rotation: t * 360, duration: 0.25, ease: 'power3.out', svgOrigin: '120 120' });
  gsap.to(fillEl, { strokeDashoffset: CIRC * (1 - t), duration: 0.25, ease: 'power3.out' });
  $('dial-time').textContent = fmt(state.deadline);
  dial.setAttribute('aria-valuenow', String(state.deadline));
}

function setDeadline(value, repaint = true) {
  state.deadline = Math.max(MIN_DEADLINE, Math.min(MAX_DEADLINE, Math.round(value / 5) * 5));
  renderDial();
  if (repaint) repaintAll();
}

let dragging = false;
function angleToValue(event) {
  const box = dial.getBoundingClientRect();
  const x = event.clientX - (box.left + box.width / 2);
  const y = event.clientY - (box.top + box.height / 2);
  let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
  if (deg < 0) deg += 360;
  const value = MIN_DEADLINE + (deg / 360) * (MAX_DEADLINE - MIN_DEADLINE);
  if (Math.abs(value - state.deadline) > 450) {
    return value > state.deadline ? MIN_DEADLINE : MAX_DEADLINE;
  }
  return value;
}
dial.addEventListener('pointerdown', (e) => {
  dragging = true;
  dial.setPointerCapture(e.pointerId);
  setDeadline(angleToValue(e));
});
dial.addEventListener('pointermove', (e) => dragging && setDeadline(angleToValue(e)));
dial.addEventListener('pointerup', () => (dragging = false));
dial.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setDeadline(state.deadline - 15);
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setDeadline(state.deadline + 15);
});

/* ---------- кнопки / buttons ---------- */
function groupButtons(host, items, isOn, onPick) {
  host.innerHTML = '';
  items.forEach((item) => {
    const b = document.createElement('button');
    b.className = 'pill';
    b.type = 'button';
    b.textContent = item.label;
    b.setAttribute('aria-pressed', String(isOn(item)));
    b.addEventListener('click', () => onPick(item));
    host.appendChild(b);
  });
}

function dateItems() {
  const base = new Date(`${state.today}T00:00:00`);
  const names = ['сегодня', 'завтра'];
  return [0, 1, 2, 3].map((offset) => {
    const d = new Date(base.getTime() + offset * 86400000);
    const iso = d.toISOString().slice(0, 10);
    return { iso, label: names[offset] || `${d.getDate()}.${pad(d.getMonth() + 1)}` };
  });
}

function renderDates() {
  groupButtons(
    $('dates'),
    dateItems(),
    (i) => i.iso === state.date,
    (i) => {
      state.date = i.iso;
      $('date-input').value = i.iso;
      renderDates();
      loadField();
    },
  );
}

const GROUND_ITEMS = [
  { v: 0, label: 'любое' },
  { v: 60, label: '1 ч' },
  { v: 120, label: '2 ч' },
  { v: 240, label: '4 ч' },
  { v: 360, label: '6 ч' },
];
function renderGround() {
  groupButtons(
    $('ground'),
    GROUND_ITEMS,
    (i) => i.v === state.minGround,
    (i) => {
      state.minGround = i.v;
      renderGround();
      repaintAll();
    },
  );
}

const BUDGET_ITEMS = [
  { v: 0, label: 'любой' },
  { v: 400, label: 'до 400 ₽' },
  { v: 800, label: 'до 800 ₽' },
  { v: 1500, label: 'до 1500 ₽' },
];
function renderBudget() {
  groupButtons($('budget'), BUDGET_ITEMS, (i) => i.v === state.budget, (i) => {
    state.budget = i.v;
    renderBudget();
    repaintAll();
  });
}

/* ---------- карточка обрыва / cliff card ---------- */
/** RU: Строка рейса: транспорт, номер, станции, цена — всё из ответа Tutu.
 *  EN: One leg line: vehicle, number, stations, price, all from the Tutu response. */
function legRow(title, ride, from, to) {
  if (!ride) return '';
  const [dep, arr, price = 0, voyage = '', vehicle = 'Электричка'] = ride;
  return `
    <div class="leg">
      <div class="leg-top"><span class="k">${title}</span><span class="v">${fmt(dep)} → ${fmt(arr)}</span></div>
      <div class="leg-mid">${vehicle}${voyage ? ` ${voyage}` : ''}${price ? ` · ${price} ₽` : ''}</div>
      <div class="leg-route">${from || 'Tutu не вернул станцию'} → ${to || ''}</div>
    </div>`;
}

function planLegRow(title, leg) {
  if (!leg) return '';
  return `
    <div class="leg">
      <div class="leg-top"><span class="k">${title}</span><span class="v">${leg.dep} → ${leg.arr}</span></div>
      <div class="leg-mid">${leg.vehicle}${leg.voyage ? ` ${leg.voyage}` : ''}${leg.price ? ` · ${leg.price} ₽` : ''} · ${leg.duration}</div>
      <div class="leg-route">${leg.from || 'Tutu не вернул станцию'} → ${leg.to || ''}</div>
    </div>`;
}

async function openCard(code, silent = false) {
  state.selected = code;
  const data = state.stations.get(code);
  const answer = data.out
    ? solve(data.out, data.back, state.deadline, state.minGround, state.notBefore, state.budget)
    : null;
  const card = $('card');
  const body = $('card-body');
  const truncated = data.window === 'truncated';
  const lastBack = data.back?.length ? Math.max(...data.back.map((r) => r[0])) : null;

  if (answer) {
    const buffer = data.back
      .filter((r) => r[0] < answer.backDep)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 2);
    body.innerHTML = `
      <h2>${data.name}</h2>
      <p class="sub">${data.line} · ${data.from_name || 'Tutu не вернул вокзал'}</p>
      <div class="hero">
        <span class="k">часов на земле</span>
        <div class="big">${fmtDur(answer.ground)}</div>
      </div>
      ${legRow('туда', data.out.find((r) => r[0] === answer.outDep && r[1] === answer.outArr), data.from_name, data.to_name)}
      ${legRow('обратно, последняя', data.back.find((r) => r[0] === answer.backDep && r[1] === answer.backArr), data.back_from_name, data.back_to_name)}
      ${buffer.map((r) => legRow('запас', r, data.back_from_name, data.back_to_name)).join('')}
      <div class="row"><span class="k">билеты туда-обратно</span><span class="v">${answer.price || 0} ₽</span></div>
      ${data.checkout_url ? `<a class="pill buy" href="${data.checkout_url}" target="_blank" rel="noopener">расписание и покупка на Tutu</a>` : ''}
      ${truncated ? `<div class="warn">Tutu отдаёт первые 300 рейсов, дальше ${fmt(lastBack)} расписания нет</div>` : ''}
      <p class="muted" style="margin-top:14px">Обратных рейсов в ответе: ${data.back.length} из ${data.back_total ?? data.back.length}</p>`;
  } else {
    body.innerHTML = `
      <h2>${data.name}</h2>
      <p class="sub">${data.line}</p>
      <div class="warn">Сегодня обратно никак</div>
      <p class="muted" style="margin:10px 0 0">Последняя обратно ${lastBack !== null ? fmt(lastBack) : 'не найдена'}, это позже, чем «дома к ${fmt(state.deadline)}».</p>
      <div id="escape" class="muted" style="margin-top:12px">ищем, где переночевать…</div>`;
    if (!silent) loadEscape(code);
  }
  body.insertAdjacentHTML(
    'beforeend',
    `<div class="row"><span class="k">остаться на</span><span class="pill-group" id="nights"></span></div><div id="stay"></div>`,
  );
  groupButtons(
    $('nights'),
    [{ v: 0, label: 'без ночёвки' }, { v: 1, label: '1 ночь' }, { v: 2, label: '2 ночи' }],
    (i) => i.v === state.nights,
    (i) => {
      state.nights = i.v;
      openCard(code, true);
      if (i.v > 0) loadStay(code);
    },
  );
  if (state.nights > 0) loadStay(code);
  card.hidden = false;
  if (!silent) gsap.fromTo(card, { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'expo.out' });
}

async function loadStay(code) {
  const host = $('stay');
  if (!host) return;
  host.innerHTML = '<div class="muted">считаем проживание и обратный рейс…</div>';
  const url =
    `/api/plan?code=${code}&date=${state.date}&deadline=${state.deadline}` +
    `&not_before=${state.notBefore}&nights=${state.nights}&home=${encodeURIComponent(state.home)}`;
  const res = await fetch(url).then((r) => r.json());
  const stay = res.stay;
  if (!stay || !$('stay')) return;
  const hotel = stay.hotels[0];
  const dm = (iso) => `${iso.slice(8)}.${iso.slice(5, 7)}`;
  $('stay').innerHTML = `
    ${stay.out ? `<div class="row"><span class="k">туда ${dm(state.date)}</span><span class="v">${stay.out.dep} → ${stay.out.arr}</span></div>` : ''}
    ${hotel
      ? `<div class="hotel"><div style="flex:1">
           <a href="${hotel.checkout_url}" target="_blank" rel="noopener">${hotel.name}</a>
           <div class="muted">${hotel.room || ''}${hotel.walk_min ? ` · ${hotel.walk_min} мин пешком (оценка по координатам)` : ''}</div>
         </div><div class="v">${hotel.price ? `${Math.round(hotel.price)} ₽` : 'Tutu не вернул цену'}</div></div>
         <div class="muted">${stay.price_note}</div>`
      : '<div class="muted">Tutu не вернул отели в этом городе</div>'}
    ${stay.back
      ? `<div class="row"><span class="k">обратно ${dm(stay.back_date)}</span><span class="v">${stay.back.dep} → ${stay.back.arr}</span></div>
         <div class="row"><span class="k">всего на земле</span><span class="v">${stay.ground_label || ''}</span></div>`
      : `<div class="warn">В этот день обратно до ${fmt(state.deadline)} ничего нет</div>`}`;
}

async function loadEscape(code) {
  const url =
    `/api/plan?code=${code}&date=${state.date}&deadline=${state.deadline}` +
    `&not_before=${state.notBefore}&budget=${state.budget}&home=${encodeURIComponent(state.home)}`;
  const res = await fetch(url).then((r) => r.json());
  const host = $('escape');
  if (!host || !res.escape) return;
  const { hotels, taxi, buses } = res.escape;
  host.innerHTML = `
    ${hotels
      .map(
        (h) => `<div class="hotel">
          <div style="flex:1">
            <a href="${h.checkout_url}" target="_blank" rel="noopener">${h.name}</a>
            <div class="muted">${h.room || ''}${h.walk_min ? ` · ${h.walk_min} мин пешком (оценка по координатам)` : ''}</div>
          </div>
          <div class="v" style="font:600 16px Onest">${h.price ? `${Math.round(h.price)} ₽` : 'Tutu не вернул цену'}</div>
        </div>`,
      )
      .join('') || '<div class="muted">Tutu не вернул отели в этом городе</div>'}
    <div class="row"><span class="k">такси домой</span><span class="v">~${taxi.rub} ₽ <span class="muted">(${taxi.note})</span></span></div>
    <div class="row"><span class="k">автобусы обратно</span><span class="v">${buses || 'нет'}</span></div>`;
}

$('card-close').addEventListener('click', () => {
  $('card').hidden = true;
  state.selected = null;
});

/* ---------- чипы / chips ---------- */
/** RU: Диалог правит параметры, план считает домен. / EN: chat edits params, domain computes. */
let chatContext = {};

$('ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('ask-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  boot('считаем план');
  chatContext = {
    ...chatContext,
    home: state.home,
    date: state.date,
    deadline: state.deadline,
    min_ground: state.minGround,
    not_before: state.notBefore,
    budget: state.budget,
  };
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, context: chatContext }),
  }).then((r) => r.json());
  boot(null);
  chatContext = res.context || chatContext;
  if (chatContext.deadline) setDeadline(chatContext.deadline, false);
  if (typeof chatContext.min_ground === 'number') state.minGround = chatContext.min_ground;
  renderGround();
  repaintAll();
  renderChips(res.chips || [], res.source);
  showChatPlan(res);
});

function showChatPlan(res) {
  const card = $('card');
  const body = $('card-body');
  if (!res.plan) {
    body.innerHTML = `<h2>Не складывается</h2><div class="warn">${res.reply}</div>`;
    card.hidden = false;
    return;
  }
  const plan = res.plan;
  state.selected = plan.code;
  body.innerHTML = `
    <h2>${plan.name}</h2>
    <p class="sub">${res.reply}</p>
    <div class="hero"><span class="k">часов на земле</span><div class="big">${plan.ground_label}</div></div>
    ${planLegRow('туда', plan.out)}
    ${planLegRow('обратно, последняя', plan.back)}
    ${plan.buffer.map((r) => planLegRow('запас', r)).join('')}
    <div class="row"><span class="k">билеты туда-обратно</span><span class="v">${plan.price_total || 0} ₽</span></div>
    ${plan.checkout_url ? `<a class="pill buy" href="${plan.checkout_url}" target="_blank" rel="noopener">расписание и покупка на Tutu</a>` : ''}
    ${res.options.length ? `<p class="sub" style="margin:16px 0 6px">ещё варианты</p><div class="pill-group" id="opts"></div>` : ''}
    <p class="muted" style="margin-top:14px">Напишите правку в строке снизу: «хочу подольше», «дома к 23:00», «во Владимир».</p>`;
  if (res.options.length) {
    groupButtons(
      $('opts'),
      res.options.map((o) => ({ ...o, label: `${o.name} · ${o.ground}` })),
      () => false,
      (o) => {
        chatContext.code = o.code;
        openCard(o.code);
      },
    );
  }
  card.hidden = false;
  gsap.fromTo(card, { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'expo.out' });
}

function chipLabel(chip) {
  if (chip.type === 'deadline') return `дома к ${fmt(chip.value)}`;
  if (chip.type === 'min_ground') return `хотя бы ${fmtDur(chip.value)} там`;
  if (chip.type === 'date') return chip.value === 'tomorrow' ? 'завтра' : 'сегодня';
  if (chip.type === 'direct') return 'только прямые';
  if (chip.type === 'station') return chip.label || chip.value;
  return chip.type;
}

function renderChips(chips, source) {
  const host = $('chips');
  host.hidden = chips.length === 0;
  if (!chips.length) return;
  host.innerHTML = '';
  chips.forEach((chip, index) => {
    const el = document.createElement('span');
    el.className = 'chip';
    el.innerHTML = `${chipLabel(chip)}<button type="button" aria-label="Убрать">×</button>`;
    el.querySelector('button').addEventListener('click', () => {
      chips.splice(index, 1);
      renderChips(chips, source);
    });
    host.appendChild(el);
  });
  const apply = document.createElement('button');
  apply.className = 'pill chip-apply is-on';
  apply.type = 'button';
  apply.textContent = 'применить';
  apply.addEventListener('click', () => applyChips(chips));
  host.appendChild(apply);
  const note = document.createElement('span');
  note.className = 'chip-source';
  note.textContent = source === 'llm' ? 'разобрано моделью' : 'разобрано локально';
  host.appendChild(note);
  gsap.from(host.children, { y: 8, opacity: 0, duration: 0.35, stagger: 0.04, ease: 'power2.out' });
}

function applyChips(chips) {
  let reload = false;
  chips.forEach((chip) => {
    if (chip.type === 'deadline') setDeadline(chip.value, false);
    if (chip.type === 'min_ground') state.minGround = chip.value;
    if (chip.type === 'date' && chip.value === 'tomorrow') {
      state.date = dateItems()[1].iso;
      reload = true;
    }
    if (chip.type === 'station') state.selected = chip.value;
  });
  renderGround();
  renderDates();
  $('chips').hidden = true;
  if (reload) loadField();
  else repaintAll();
}

/* ---------- выбор города / city picker ---------- */
let pickTarget = null;

async function renderPicker(query) {
  const res = await fetch(`/api/cities?q=${encodeURIComponent(query)}&limit=80`).then((r) => r.json());
  const list = $('picker-list');
  list.innerHTML = '';
  let letter = '';
  res.cities.forEach((city) => {
    const first = city.name[0].toUpperCase();
    if (first !== letter) {
      letter = first;
      const head = document.createElement('div');
      head.className = 'picker-letter';
      head.textContent = letter;
      list.appendChild(head);
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'picker-row';
    row.innerHTML = `${city.name}<span>${city.region}</span>`;
    row.addEventListener('click', () => {
      if (pickTarget) pickTarget(city);
      closePicker();
    });
    list.appendChild(row);
  });
}

function openPicker(onPick) {
  pickTarget = onPick;
  $('picker').hidden = false;
  $('picker-input').value = '';
  renderPicker('');
  $('picker-input').focus();
}

function closePicker() {
  $('picker').hidden = true;
  pickTarget = null;
}

$('picker-close').addEventListener('click', closePicker);
$('picker').addEventListener('click', (e) => {
  if (e.target === $('picker')) closePicker();
});
let pickTimer = null;
$('picker-input').addEventListener('input', (e) => {
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => renderPicker(e.target.value), 140);
});

/* ---------- загрузка / loading ---------- */
function boot(text) {
  const el = $('boot');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  $('boot-text').textContent = text;
}

/** RU: Для сегодняшней даты прошедшие отправления не считаются. / EN: past departures ignored. */
/** RU: Один веер за раз: прошлый поток закрывается, иначе два ответа перезаписывают друг друга.
 *  EN: One fan at a time: the previous stream is closed, else two answers overwrite each other. */
let fieldStream = null;

function resetField() {
  state.stations.forEach((value, code) => {
    const puck = state.markers.get(code);
    const isHome = value.name === state.home;
    if (puck) {
      if (isHome) puck.marker.remove();
      else puck.marker.addTo(map);
    }
    state.stations.set(code, { ...value, out: null, back: null, window: null, isHome });
  });
  $('card').hidden = true;
  state.selected = null;
}

function loadField() {
  if (fieldStream) fieldStream.close();
  resetField();
  boot('веер расписаний');
  let done = 0;
  const total = [...state.stations.values()].filter((item) => !item.isHome).length;
  const source = new EventSource(`/api/field/stream?home=${encodeURIComponent(state.home)}&date=${state.date}`);
  fieldStream = source;
  source.addEventListener('station', (event) => {
    const data = JSON.parse(event.data);
    const previous = state.stations.get(data.code) || {};
    state.stations.set(data.code, { ...previous, ...data });
    const puck = state.markers.get(data.code);
    if (puck) {
      paint(data.code);
      gsap.to(puck.el, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(1.6)' });
    }
    done += 1;
    boot(`веер расписаний · ${done} из ${total}`);
    repaintAll();
  });
  source.addEventListener('done', () => {
    source.close();
    boot(null);
    repaintAll();
  });
  source.onerror = () => {
    source.close();
    boot(null);
  };
}

let homeMarker = null;

/** RU: Кандидаты зависят от точки отправления, поэтому шайбы пересобираются.
 *  EN: Candidates depend on the origin, so the pucks are rebuilt. */
async function loadStations(home) {
  const meta = await fetch(`/api/stations?home=${encodeURIComponent(home)}`).then((r) => r.json());
  state.markers.forEach((puck) => puck.marker.remove());
  state.markers.clear();
  state.stations.clear();
  meta.stations.forEach((station) => {
    state.stations.set(station.code, station);
    state.markers.set(station.code, buildPuck(station));
  });
  if (homeMarker) homeMarker.remove();
  homeMarker = new maplibregl.Marker({ color: '#16143c' })
    .setLngLat([meta.home.lon, meta.home.lat])
    .addTo(map);
  map.easeTo({ center: [meta.home.lon, meta.home.lat + 0.2], zoom: 7.1, duration: 600 });
  $('home-name').textContent = home;
  return meta;
}

async function start() {
  const saved = localStorage.getItem('obratno.home') || 'Москва';
  const meta = await loadStations(saved);
  state.today = meta.today;
  state.date = meta.today;
  state.home = saved;
  const now = new Date();
  const departure = Math.min(20 * 60, Math.round((now.getHours() * 60 + now.getMinutes() + 45) / 15) * 15);
  $('gate-date').value = state.date;
  $('gate-date').min = state.today;
  $('gate-rdate').value = state.date;
  $('gate-rdate').min = state.today;
  $('gate-dtime').value = `${pad(Math.floor(departure / 60))}:${pad(departure % 60)}`;
  $('gate-city-name').textContent = state.home;

  const pickCity = (city) => {
    state.home = city.name;
    localStorage.setItem('obratno.home', city.name);
    $('gate-city-name').textContent = city.name;
    $('home-name').textContent = city.name;
  };
  $('gate-city').addEventListener('click', () => openPicker(pickCity));
  $('home-btn').addEventListener('click', () => {
    openPicker(async (city) => {
      pickCity(city);
      await loadStations(city.name);
      loadField();
    });
  });

  const dateInput = $('date-input');
  dateInput.value = state.date;
  dateInput.min = state.today;
  dateInput.closest('.pill').addEventListener('click', () => {
    if (typeof dateInput.showPicker === 'function') dateInput.showPicker();
  });
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    state.date = dateInput.value;
    renderDates();
    loadField();
  });

  renderDates();
  renderGround();
  renderBudget();

  const startSearch = async () => {
    state.date = $('gate-date').value || state.today;
    dateInput.value = state.date;
    const [dh, dm] = ($('gate-dtime').value || '08:00').split(':').map(Number);
    const [ah, am] = ($('gate-time').value || '22:00').split(':').map(Number);
    const days = Math.max(
      0,
      Math.round(
        (new Date(`${$('gate-rdate').value || state.date}T00:00:00`) -
          new Date(`${state.date}T00:00:00`)) / 86400000,
      ),
    );
    state.notBefore = dh * 60 + dm;
    setDialRange(state.notBefore);
    let deadline = days * 24 * 60 + ah * 60 + am;
    if (deadline <= state.notBefore) deadline += 24 * 60;
    setDeadline(deadline, false);
    renderDates();
    await loadStations(state.home);
    loadField();
    gsap.to($('gate'), { opacity: 0, duration: 0.4, ease: 'power2.out' });
    setTimeout(() => {
      $('gate').hidden = true;
    }, 420);
  };
  $('gate-go').addEventListener('click', startSearch);
  if (new URLSearchParams(location.search).has('go')) startSearch();
}

start();
