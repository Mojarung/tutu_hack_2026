/**
 * RU: Все настройки задаются на стартовом экране. На карте остаются только чат и карточки
 *     маршрутов, а весь пересчёт идёт по расписаниям, полученным один раз.
 * EN: Every setting lives on the start screen. The map keeps only the chat and the route
 *     cards, and all recomputation runs on timetables fetched once.
 */

import * as maplibregl from './vendor/maplibre-gl.mjs';

const RAMP = [
  [0, [232, 115, 74]],
  [90, [232, 169, 60]],
  [180, [232, 169, 60]],
  [300, [111, 163, 63]],
  [420, [31, 138, 91]],
];
const DEAD = [195, 198, 210];
const GROUND_MAX = 2880;
const PRICE_MAX = 50000;

const state = {
  home: 'Москва',
  today: null,
  date: null,
  notBefore: 8 * 60,
  deadline: 22 * 60,
  groundMin: 0,
  groundMax: GROUND_MAX,
  budgetMin: 0,
  budgetMax: PRICE_MAX,
  nights: 0,
  stations: new Map(),
  markers: new Map(),
  selected: null,
};

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const fmt = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const fmtDur = (m) => {
  const h = Math.floor(Math.max(m, 0) / 60);
  const r = Math.max(m, 0) % 60;
  if (h && r) return `${h} ч ${r} м`;
  return h ? `${h} ч` : `${r} м`;
};
const dayMonth = (iso) => `${iso.slice(8)}.${iso.slice(5, 7)}`;

/* ---------- домен / domain ---------- */

/** RU: Та же математика, что в backend/src/obratno/ground.py. / EN: mirrors ground.py. */
function solve(out, back, deadline, limits) {
  const { groundMin = 0, groundMax = Infinity, notBefore = 0, priceMin = 0, priceMax = Infinity } =
    limits || {};
  const candidates = back.filter((r) => r[1] <= deadline).sort((a, b) => b[1] - a[1]);
  for (const [backDep, backArr, backPrice = 0] of candidates) {
    let best = null;
    for (const [outDep, outArr, outPrice = 0] of out) {
      if (outDep < notBefore || outArr > backDep) continue;
      const total = outPrice + backPrice;
      if (total > priceMax || total < priceMin) continue;
      if (best === null || outArr < best.arr) best = { dep: outDep, arr: outArr, price: outPrice };
    }
    if (best === null) continue;
    const ground = backDep - best.arr;
    if (ground >= groundMin && ground <= groundMax) {
      return {
        outDep: best.dep,
        outArr: best.arr,
        backDep,
        backArr,
        ground,
        price: best.price + backPrice,
      };
    }
  }
  return null;
}

/** RU: Пределы поиска одним объектом, обе границы. / EN: search limits, both bounds. */
function limits() {
  return {
    groundMin: state.groundMin,
    groundMax: state.groundMax >= GROUND_MAX ? Infinity : state.groundMax,
    notBefore: state.notBefore,
    priceMin: state.budgetMin,
    priceMax: state.budgetMax >= PRICE_MAX ? Infinity : state.budgetMax,
  };
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
map.on('error', () => {
  if (!map.__fellBack) {
    map.__fellBack = true;
    map.setStyle(FALLBACK_STYLE);
  }
});

/** RU: MapLibre владеет transform корня маркера, GSAP анимирует только вложенный узел.
 *  EN: MapLibre owns the marker root transform, GSAP animates the inner node only. */
function buildPuck(station) {
  const root = document.createElement('div');
  const el = document.createElement('div');
  el.className = 'puck';
  el.innerHTML =
    '<div class="puck-halo"></div><div class="puck-dot"></div>' +
    `<div class="puck-ring" hidden></div><span class="puck-name">${station.name}</span>`;
  root.appendChild(el);
  root.addEventListener('click', () => openCard(station.code));
  const marker = new maplibregl.Marker({ element: root })
    .setLngLat([station.lon, station.lat])
    .addTo(map);
  const dot = el.querySelector('.puck-dot');
  gsap.set(el, { scale: 0, opacity: 0 });
  return {
    el,
    marker,
    dot,
    halo: el.querySelector('.puck-halo'),
    ring: el.querySelector('.puck-ring'),
    setW: gsap.quickTo(dot, 'width', { duration: 0.25, ease: 'power2.out' }),
    setH: gsap.quickTo(dot, 'height', { duration: 0.25, ease: 'power2.out' }),
  };
}

function paint(code) {
  const data = state.stations.get(code);
  const puck = state.markers.get(code);
  if (!data || !puck) return null;
  const answer =
    data.out && data.back
      ? solve(data.out, data.back, state.deadline, limits())
      : null;
  const size = answer ? 16 + Math.min(answer.ground, 480) * (46 / 480) : 12;
  const color = answer ? rampColor(answer.ground) : DEAD;
  puck.setW(size);
  puck.setH(size);
  puck.dot.style.background = rgb(color);
  puck.halo.style.background = rgb(color);
  gsap.to(puck.halo, {
    width: answer ? size * 2.1 : 0,
    height: answer ? size * 2.1 : 0,
    opacity: answer ? 0.2 : 0,
    duration: 0.35,
    ease: 'power2.out',
  });
  gsap.to(puck.el, { opacity: answer ? 1 : 0.5, duration: 0.3 });
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
  $('reachable').textContent = String(reachable);
  $('deadline-label').textContent = fmt(state.deadline);
  if (state.selected) openCard(state.selected, true);
}

/* ---------- кнопки / buttons ---------- */
function groupButtons(host, items, isOn, onPick) {
  host.innerHTML = '';
  items.forEach((item) => {
    const button = document.createElement('button');
    button.className = 'pill';
    button.type = 'button';
    button.textContent = item.label;
    button.setAttribute('aria-pressed', String(isOn(item)));
    button.addEventListener('click', () => onPick(item));
    host.appendChild(button);
  });
}

/** RU: Двусторонний ползунок: две ручки на одной дорожке.
 *  EN: Dual range control: two thumbs on one track. */
function dualRange(hostId, labelId, format, onChange) {
  const host = document.getElementById(hostId);
  const a = host.querySelector('.range-a');
  const b = host.querySelector('.range-b');
  const fill = host.querySelector('.range-fill');
  const max = Number(a.max);

  const sync = () => {
    let low = Number(a.value);
    let high = Number(b.value);
    if (low > high) [low, high] = [high, low];
    fill.style.left = (low / max) * 100 + '%';
    fill.style.right = 100 - (high / max) * 100 + '%';
    document.getElementById(labelId).textContent = format(low, high);
    onChange(low, high);
  };

  a.addEventListener('input', sync);
  b.addEventListener('input', sync);
  sync();
}

const rub = (value) => value.toLocaleString('ru-RU') + ' ₽';

function groundLabel(low, high) {
  if (low === 0 && high >= GROUND_MAX) return 'любое время';
  if (high >= GROUND_MAX) return 'от ' + fmtDur(low);
  if (low === 0) return 'до ' + fmtDur(high);
  return fmtDur(low) + ' — ' + fmtDur(high);
}

function budgetLabel(low, high) {
  if (low === 0 && high >= PRICE_MAX) return 'любые';
  if (high >= PRICE_MAX) return 'от ' + rub(low);
  if (low === 0) return 'до ' + rub(high);
  return rub(low) + ' — ' + rub(high);
}

/* ---------- выбор города / city picker ---------- */
let pickTarget = null;
let pickTimer = null;

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

/* ---------- карточка маршрута / route card ---------- */
function legRow(title, ride, from, to) {
  if (!ride) return '';
  const [dep, arr, price = 0, voyage = '', vehicle = 'Электричка'] = ride;
  return `
    <div class="leg">
      <div class="leg-top"><span class="k">${title}</span><span class="v">${fmt(dep)} → ${fmt(arr)}</span></div>
      <div class="leg-mid">${vehicle}${voyage ? ` ${voyage}` : ''}${price ? ` · ${price} ₽` : ''} · ${fmtDur(arr - dep)}</div>
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

const NIGHTS_ITEMS = [
  { v: 0, label: 'без ночёвки' },
  { v: 1, label: '1 ночь' },
  { v: 2, label: '2 ночи' },
];

function nightsBlock() {
  return `
    <div class="row"><span class="k">остаться на</span><span class="pill-group" id="nights"></span></div>
    <div id="stay"></div>`;
}

function wireNights(code) {
  groupButtons($('nights'), NIGHTS_ITEMS, (i) => i.v === state.nights, (i) => {
    state.nights = i.v;
    if (i.v > 0) loadStay(code);
    else if ($('stay')) $('stay').innerHTML = '';
    wireNights(code);
  });
  if (state.nights > 0) loadStay(code);
}

function openCard(code, silent = false) {
  const data = state.stations.get(code);
  if (!data) return;
  state.selected = code;
  const answer =
    data.out && data.back
      ? solve(data.out, data.back, state.deadline, limits())
      : null;
  const body = $('card-body');
  const truncated = data.window === 'truncated';
  const lastBack = data.back && data.back.length ? Math.max(...data.back.map((r) => r[0])) : null;

  if (answer) {
    const buffer = data.back
      .filter((r) => r[0] < answer.backDep)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 2);
    body.innerHTML = `
      <h2>${data.name}</h2>
      <p class="sub">${data.line || ''}</p>
      <div class="hero"><span class="k">часов на земле</span><div class="big">${fmtDur(answer.ground)}</div></div>
      ${legRow('туда', data.out.find((r) => r[0] === answer.outDep && r[1] === answer.outArr), data.from_name, data.to_name)}
      ${legRow('обратно, последняя', data.back.find((r) => r[0] === answer.backDep && r[1] === answer.backArr), data.back_from_name, data.back_to_name)}
      ${buffer.map((r) => legRow('запас', r, data.back_from_name, data.back_to_name)).join('')}
      <div class="row"><span class="k">билеты туда-обратно</span><span class="v">${answer.price || 0} ₽</span></div>
      ${truncated ? `<div class="warn">Tutu отдаёт первые 300 рейсов, дальше ${fmt(lastBack)} расписания нет</div>` : ''}
      ${data.checkout_url ? `<a class="pill buy" href="${data.checkout_url}" target="_blank" rel="noopener">расписание на Tutu</a>` : ''}
      ${nightsBlock()}`;
  } else {
    body.innerHTML = `
      <h2>${data.name}</h2>
      <div class="warn">Обратно к ${fmt(state.deadline)} никак</div>
      <p class="muted" style="margin:10px 0 0">Последняя обратно ${lastBack !== null ? fmt(lastBack) : 'не найдена'}.</p>
      <div id="escape" class="muted" style="margin-top:12px">ищем, где переночевать…</div>
      ${nightsBlock()}`;
    if (!silent) loadEscape(code);
  }
  wireNights(code);
  $('card').hidden = false;
  if (!silent) {
    gsap.fromTo($('card'), { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'expo.out' });
  }
}

async function loadStay(code) {
  const host = $('stay');
  if (!host) return;
  host.innerHTML = '<div class="muted">считаем проживание и обратный рейс…</div>';
  const url =
    `/api/plan?code=${code}&date=${state.date}&deadline=${state.deadline}` +
    `&not_before=${state.notBefore}&nights=${state.nights}&min_ground=${state.groundMin}` +
    `&max_ground=${state.groundMax >= GROUND_MAX ? 0 : state.groundMax}` +
    `&budget=${state.budgetMax >= PRICE_MAX ? 0 : state.budgetMax}&budget_min=${state.budgetMin}` +
    `&home=${encodeURIComponent(state.home)}`;
  const res = await fetch(url).then((r) => r.json());
  const stay = res.stay;
  if (!stay || !$('stay')) return;
  const hotel = stay.hotels[0];
  $('stay').innerHTML = `
    ${stay.out ? `<div class="row"><span class="k">туда ${dayMonth(state.date)}</span><span class="v">${stay.out.dep} → ${stay.out.arr}</span></div>` : ''}
    ${
      hotel
        ? `<div class="hotel"><div style="flex:1">
             <a href="${hotel.checkout_url}" target="_blank" rel="noopener">${hotel.name}</a>
             <div class="muted">${hotel.room || ''}${hotel.walk_min ? ` · ${hotel.walk_min} мин пешком (оценка по координатам)` : ''}</div>
           </div><div class="v">${hotel.price ? `${Math.round(hotel.price)} ₽` : 'Tutu не вернул цену'}</div></div>
           <div class="muted">${stay.price_note}</div>`
        : '<div class="muted">Tutu не вернул отели в этом городе</div>'
    }
    ${
      stay.back
        ? `<div class="row"><span class="k">обратно ${dayMonth(stay.back_date)}</span><span class="v">${stay.back.dep} → ${stay.back.arr}</span></div>
           <div class="row"><span class="k">всего на земле</span><span class="v">${stay.ground_label || ''}</span></div>`
        : `<div class="warn">В этот день обратно до ${fmt(state.deadline)} ничего нет</div>`
    }`;
}

async function loadEscape(code) {
  const url = `/api/plan?code=${code}&date=${state.date}&deadline=${state.deadline}&home=${encodeURIComponent(state.home)}`;
  const res = await fetch(url).then((r) => r.json());
  const host = $('escape');
  if (!host || !res.escape) return;
  const { hotels, taxi, buses } = res.escape;
  host.innerHTML = `
    ${
      hotels
        .map(
          (h) => `<div class="hotel"><div style="flex:1">
            <a href="${h.checkout_url}" target="_blank" rel="noopener">${h.name}</a>
            <div class="muted">${h.room || ''}${h.walk_min ? ` · ${h.walk_min} мин пешком (оценка по координатам)` : ''}</div>
          </div><div class="v">${h.price ? `${Math.round(h.price)} ₽` : 'Tutu не вернул цену'}</div></div>`,
        )
        .join('') || '<div class="muted">Tutu не вернул отели в этом городе</div>'
    }
    <div class="row"><span class="k">такси домой</span><span class="v">~${taxi.rub} ₽ <span class="muted">(${taxi.note})</span></span></div>
    <div class="row"><span class="k">автобусы обратно</span><span class="v">${buses || 'нет'}</span></div>`;
}

$('card-close').addEventListener('click', () => {
  $('card').hidden = true;
  state.selected = null;
});

/* ---------- чат / chat ---------- */
let chatContext = {};
let lastQuestion = '';

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
  host.hidden = !chips.length;
  if (!chips.length) return;
  host.innerHTML = '';
  chips.forEach((chip) => {
    const el = document.createElement('span');
    el.className = 'chip';
    el.textContent = chipLabel(chip);
    host.appendChild(el);
  });
  const note = document.createElement('span');
  note.className = 'chip-source';
  note.textContent = source === 'agent' ? 'агент' : 'разобрано локально';
  host.appendChild(note);
}

const TOOL_LABELS = {
  set_params: 'уточнил условия',
  list_options: 'сравнил города',
  plan_station: 'собрал маршрут',
  stay_plan: 'посчитал ночёвку',
  escape: 'искал ночлег',
};

/** RU: Видно, что именно делал агент: инструменты, а не пересказ. / EN: the agent's real steps. */
function traceRow(res) {
  const trace = res.trace || [];
  if (!trace.length) return '';
  const steps = trace.map((s) => `<span>${TOOL_LABELS[s.tool] || s.tool}</span>`).join('');
  return `<div class="trace">${steps}</div>`;
}

function showChatPlan(res) {
  const body = $('card-body');
  if (!res.plan) {
    body.innerHTML =
      `<h2>Не складывается</h2><p class="asked">«${lastQuestion}»</p>` +
      `<div class="warn">${res.reply}</div>${traceRow(res)}`;
    $('card').hidden = false;
    return;
  }
  const plan = res.plan;
  state.selected = plan.code;
  body.innerHTML = `
    <h2>${plan.name}</h2>
    <p class="asked">«${lastQuestion}»</p>
    <p class="sub">${res.reply}</p>
    ${traceRow(res)}
    <div class="hero"><span class="k">часов на земле</span><div class="big">${plan.ground_label}</div></div>
    ${planLegRow('туда', plan.out)}
    ${planLegRow('обратно, последняя', plan.back)}
    ${plan.buffer.map((r) => planLegRow('запас', r)).join('')}
    <div class="row"><span class="k">билеты туда-обратно</span><span class="v">${plan.price_total || 0} ₽</span></div>
    ${plan.checkout_url ? `<a class="pill buy" href="${plan.checkout_url}" target="_blank" rel="noopener">расписание на Tutu</a>` : ''}
    ${res.options.length ? `<p class="sub" style="margin:16px 0 6px">ещё варианты</p><div class="pill-group" id="opts"></div>` : ''}
    ${nightsBlock()}`;
  if (res.options.length) {
    groupButtons(
      $('opts'),
      res.options.map((o) => ({ ...o, label: `${o.name} · ${o.ground}` })),
      () => false,
      (o) => openCard(o.code),
    );
  }
  wireNights(plan.code);
  $('card').hidden = false;
  gsap.fromTo($('card'), { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: 'expo.out' });
}

$('ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('ask-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  lastQuestion = text;
  boot('считаем план');
  chatContext = {
    ...chatContext,
    home: state.home,
    date: state.date,
    deadline: state.deadline,
    min_ground: state.groundMin,
    max_ground: state.groundMax >= GROUND_MAX ? 0 : state.groundMax,
    not_before: state.notBefore,
    budget: state.budgetMax >= PRICE_MAX ? 0 : state.budgetMax,
    budget_min: state.budgetMin,
  };
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, context: chatContext }),
  }).then((r) => r.json());
  boot(null);
  chatContext = res.context || chatContext;
  if (chatContext.deadline) state.deadline = chatContext.deadline;
  if (typeof chatContext.min_ground === 'number') state.groundMin = chatContext.min_ground;
  repaintAll();
  renderChips(res.chips || [], res.source);
  showChatPlan(res);
});

/* ---------- загрузка поля / field loading ---------- */
function boot(text) {
  const el = $('boot');
  el.hidden = !text;
  if (text) $('boot-text').textContent = text;
}

let fieldStream = null;

/** RU: Один веер за раз: прошлый поток закрывается, иначе ответы перезаписывают друг друга.
 *  EN: One fan at a time, otherwise two answers overwrite each other. */
function loadField() {
  if (fieldStream) fieldStream.close();
  state.stations.forEach((value, code) => {
    state.stations.set(code, { ...value, out: null, back: null, window: null });
  });
  $('card').hidden = true;
  state.selected = null;
  repaintAll();
  boot('веер расписаний');

  let done = 0;
  const total = state.stations.size;
  const source = new EventSource(
    `/api/field/stream?home=${encodeURIComponent(state.home)}&date=${state.date}`,
  );
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
 *  EN: Candidates depend on the origin, so pucks are rebuilt. */
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
  map.easeTo({ center: [meta.home.lon, meta.home.lat + 0.25], zoom: 7.1, duration: 700 });
  $('edit-label').textContent = home;
  return meta;
}

/* ---------- стартовый экран / start screen ---------- */
function openGate() {
  $('gate').hidden = false;
  gsap.fromTo($('gate'), { opacity: 0 }, { opacity: 1, duration: 0.3 });
}

async function startSearch() {
  state.date = $('gate-date').value || state.today;
  const [dh, dm] = ($('gate-dtime').value || '08:00').split(':').map(Number);
  const [ah, am] = ($('gate-time').value || '22:00').split(':').map(Number);
  const days = Math.max(
    0,
    Math.round(
      (new Date(`${$('gate-rdate').value || state.date}T00:00:00`) -
        new Date(`${state.date}T00:00:00`)) /
        86400000,
    ),
  );
  state.notBefore = dh * 60 + dm;
  state.deadline = days * 24 * 60 + ah * 60 + am;
  if (state.deadline <= state.notBefore) state.deadline += 24 * 60;

  $('gate').hidden = true;
  await loadStations(state.home);
  loadField();
}

async function start() {
  const saved = localStorage.getItem('obratno.home') || 'Москва';
  state.home = saved;
  const meta = await loadStations(saved);
  state.today = meta.today;
  state.date = meta.today;

  const now = new Date();
  const departure = Math.min(
    20 * 60,
    Math.round((now.getHours() * 60 + now.getMinutes() + 45) / 15) * 15,
  );
  const homeBy = departure + 6 * 60;
  $('gate-date').value = state.date;
  $('gate-date').min = state.today;
  $('gate-rdate').min = state.today;
  $('gate-dtime').value = `${pad(Math.floor(departure / 60))}:${pad(departure % 60)}`;
  $('gate-time').value = `${pad(Math.floor(homeBy / 60) % 24)}:${pad(homeBy % 60)}`;
  const returnDate = new Date(`${state.date}T00:00:00`);
  if (homeBy >= 24 * 60) returnDate.setDate(returnDate.getDate() + 1);
  $('gate-rdate').value = returnDate.toISOString().slice(0, 10);
  $('gate-city-name').textContent = state.home;

  /* RU: Одно нажатие открывает и дату, и время: сначала календарь, следом часы.
     EN: One tap opens both the date and the time pickers in sequence. */
  const chainPickers = (dateId, timeId) => {
    const dateInput = $(dateId);
    const timeInput = $(timeId);
    const show = (node) => {
      node.focus();
      if (typeof node.showPicker === 'function') {
        try {
          node.showPicker();
        } catch {
          /* браузер откроет по фокусу / the browser opens it on focus */
        }
      }
    };
    dateInput.closest('.pill').addEventListener('click', (event) => {
      if (event.target === timeInput) return;
      show(dateInput);
    });
    dateInput.addEventListener('change', () => show(timeInput));
    timeInput.addEventListener('click', (event) => {
      event.stopPropagation();
      show(timeInput);
    });
  };
  chainPickers('gate-date', 'gate-dtime');
  chainPickers('gate-rdate', 'gate-time');

  const pickCity = (city) => {
    state.home = city.name;
    localStorage.setItem('obratno.home', city.name);
    $('gate-city-name').textContent = city.name;
    $('edit-label').textContent = city.name;
  };
  $('gate-city').addEventListener('click', () => openPicker(pickCity));
  $('edit-btn').addEventListener('click', openGate);
  $('gate-go').addEventListener('click', startSearch);
  $('picker-close').addEventListener('click', closePicker);
  $('picker').addEventListener('click', (e) => {
    if (e.target === $('picker')) closePicker();
  });
  $('picker-input').addEventListener('input', (e) => {
    clearTimeout(pickTimer);
    pickTimer = setTimeout(() => renderPicker(e.target.value), 140);
  });

  dualRange('ground-range', 'ground-label', groundLabel, (low, high) => {
    state.groundMin = low;
    state.groundMax = high;
  });
  dualRange('budget-range', 'budget-label', budgetLabel, (low, high) => {
    state.budgetMin = low;
    state.budgetMax = high;
  });
  if (new URLSearchParams(location.search).has('go')) startSearch();
}

start();
