/* Trip Weather: day-by-day forecasts for every stop on a trip.
   Plain JS, no build step. Data from Open-Meteo (no API key). */
(function () {
  'use strict';

  /** A day (or hour) counts as rainy at or above this precipitation probability, in percent. */
  const RAIN_THRESHOLD = 30;

  /** Rain severity bands for the trip report, highest first. Anything below RAIN_THRESHOLD counts as dry. */
  const RAIN_SEVERITY = [
    { key: 'high', min: 70, label: 'Very likely' },
    { key: 'mid', min: 50, label: 'Likely' },
    { key: 'low', min: RAIN_THRESHOLD, label: 'Possible' },
  ];

  /** Open-Meteo forecasts reach this many days ahead, counting today. */
  const FORECAST_DAYS = 16;
  const MAX_TRIP_DAYS = 60;
  const FETCH_TIMEOUT_MS = 15000;

  const STORAGE_KEY = 'tripWeather.state.v1';
  const CACHE_PREFIX = 'tripWeather.cache.v1.';
  const SHARE_KEY = 'trip';

  const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

  const SAMPLE_STOPS = [
    { name: 'Lisbon', admin1: 'Lisbon', country: 'Portugal', lat: 38.71667, lon: -9.13333, timezone: 'Europe/Lisbon' },
    { name: 'Tokyo', admin1: 'Tokyo', country: 'Japan', lat: 35.6895, lon: 139.69171, timezone: 'Asia/Tokyo' },
  ];

  // WMO weather interpretation codes -> label + emoji.
  const WMO = {
    0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
    45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
    51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌦️'],
    56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
    61: ['Light rain', '🌧️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
    71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
    80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'], 82: ['Violent showers', '🌧️'],
    85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'],
    95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
  };

  // ---------- small utilities ----------

  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function cleanStr(v, max) {
    return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
  }

  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }
  function storageRemove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  // ---------- dates (all trip dates are YYYY-MM-DD in the city's own timezone) ----------

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const toUTC = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const addDays = (s, n) => new Date(toUTC(s) + n * 864e5).toISOString().slice(0, 10);
  const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 864e5);

  function validTz(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  function todayIn(tz) {
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
    if (tz && validTz(tz)) opts.timeZone = tz;
    const p = {};
    for (const part of new Intl.DateTimeFormat('en-US', opts).formatToParts(new Date())) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day}`;
  }

  const fmtDow = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
  const fmtMonthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const fmtFull = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const dateObj = (s) => new Date(toUTC(s) + 12 * 36e5);

  function fmtRange(start, end) {
    const n = diffDays(start, end) + 1;
    const span = start === end ? fmtFull.format(dateObj(start)) : `${fmtFull.format(dateObj(start))} – ${fmtFull.format(dateObj(end))}`;
    return `${span} · ${n} day${n === 1 ? '' : 's'}`;
  }

  function fmtUpdated(ts) {
    const d = new Date(ts);
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? `today ${time}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
  }

  function localTime(tz) {
    if (!tz || !validTz(tz)) return '';
    return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  }

  // "2–5 PM", "11 AM–2 PM"; endExclusive is the hour after the last rainy hour.
  function fmtHourWindow(start, endExclusive) {
    if (start === 0 && endExclusive === 24) return 'All day';
    const part = (h) => { const hh = h % 24; return { n: hh % 12 === 0 ? 12 : hh % 12, ap: hh < 12 ? 'AM' : 'PM' }; };
    const a = part(start);
    const b = part(endExclusive);
    return a.ap === b.ap && endExclusive < 24 ? `${a.n}–${b.n} ${b.ap}` : `${a.n} ${a.ap}–${b.n} ${b.ap}`;
  }

  // ---------- temperature + colour scales ----------

  function convertTemp(v, fromUnit) {
    if (v == null) return null;
    if (fromUnit === state.unit) return v;
    return state.unit === 'C' ? (v - 32) * 5 / 9 : v * 9 / 5 + 32;
  }

  const fmtTemp = (v) => (v == null ? '–' : `${Math.round(v)}°`);

  // Rain likelihood: light blue (0%) to deep blue (100%), used for every rain mark.
  const RAIN_LOW = [207, 232, 255];
  const RAIN_HIGH = [9, 60, 160];
  function rainColor(p) {
    const t = clamp((p || 0) / 100, 0, 1);
    const c = RAIN_LOW.map((lo, i) => Math.round(lo + (RAIN_HIGH[i] - lo) * t));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }
  const rainTextColor = (p) => (p >= 50 ? '#ffffff' : '#0a2a5c');

  // ---------- state ----------

  function sanitizeStop(o) {
    if (!o || typeof o !== 'object') return null;
    const lat = Number(o.lat);
    const lon = Number(o.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    if (!DATE_RE.test(o.start) || !DATE_RE.test(o.end)) return null;
    const name = cleanStr(o.name, 100);
    if (!name) return null;
    let start = o.start;
    let end = o.end;
    if (end < start) [start, end] = [end, start];
    if (diffDays(start, end) + 1 > MAX_TRIP_DAYS) end = addDays(start, MAX_TRIP_DAYS - 1);
    return {
      id: typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id) ? o.id : newId(),
      name,
      admin1: cleanStr(o.admin1, 100),
      country: cleanStr(o.country, 100),
      lat: Math.round(lat * 1e4) / 1e4,
      lon: Math.round(lon * 1e4) / 1e4,
      timezone: typeof o.timezone === 'string' && validTz(o.timezone) ? o.timezone : '',
      start,
      end,
    };
  }

  function loadState() {
    const defaults = { stops: [], unit: 'F', seeded: false, view: 'stops' };
    try {
      const saved = JSON.parse(storageGet(STORAGE_KEY));
      if (saved && Array.isArray(saved.stops)) {
        return {
          stops: saved.stops.map(sanitizeStop).filter(Boolean),
          unit: saved.unit === 'C' ? 'C' : 'F',
          seeded: !!saved.seeded,
          view: saved.view === 'report' ? 'report' : 'stops',
        };
      }
    } catch (e) { /* fall through to defaults */ }
    return defaults;
  }

  const state = loadState();
  const saveState = () => storageSet(STORAGE_KEY, JSON.stringify(state));

  // Per-stop runtime info: { status: 'loading'|'ok'|'stale'|'error'|'idle', entry, error, offline, req }
  const runtime = new Map();

  const sortedStops = () => state.stops.slice().sort((a, b) => (
    a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.name.localeCompare(b.name)
  ));

  function readCache(id) {
    try {
      const e = JSON.parse(storageGet(CACHE_PREFIX + id));
      return e && e.data && e.data.daily && Array.isArray(e.data.daily.time) ? e : null;
    } catch (err) { return null; }
  }
  const writeCache = (id, entry) => storageSet(CACHE_PREFIX + id, JSON.stringify(entry));
  const dropCache = (id) => storageRemove(CACHE_PREFIX + id);

  // ---------- networking ----------

  async function fetchJSON(url, outerSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const onOuterAbort = () => ctrl.abort();
    if (outerSignal) outerSignal.addEventListener('abort', onOuterAbort);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        let reason = '';
        try { reason = (await res.json()).reason || ''; } catch (e) { /* ignore */ }
        const err = new Error(reason || `The weather service returned an error (${res.status}).`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError' && !(outerSignal && outerSignal.aborted)) {
        throw new Error('The weather service took too long to respond.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  // The slice of a stop's dates that has a forecast today, or null if none does.
  function forecastWindow(stop) {
    const today = todayIn(stop.timezone);
    const last = addDays(today, FORECAST_DAYS - 1);
    const start = stop.start > today ? stop.start : today;
    const end = stop.end < last ? stop.end : last;
    return start <= end ? { start, end } : null;
  }

  function slimForecast(json) {
    const d = json && json.daily;
    const h = (json && json.hourly) || {};
    if (!d || !Array.isArray(d.time)) throw new Error('The weather service sent an unexpected response.');
    return {
      timezone: typeof json.timezone === 'string' ? json.timezone : '',
      daily: {
        time: d.time,
        hi: d.temperature_2m_max || [],
        lo: d.temperature_2m_min || [],
        rain: d.precipitation_probability_max || [],
        code: d.weather_code || [],
      },
      hourly: {
        time: h.time || [],
        rain: h.precipitation_probability || [],
      },
    };
  }

  async function fetchForecast(stop) {
    const win = forecastWindow(stop);
    if (!win) return null;
    const base = {
      latitude: String(stop.lat),
      longitude: String(stop.lon),
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
      hourly: 'precipitation_probability,temperature_2m',
      timezone: 'auto',
      temperature_unit: state.unit === 'C' ? 'celsius' : 'fahrenheit',
    };
    let json;
    try {
      json = await fetchJSON(`${FORECAST_URL}?${new URLSearchParams({ ...base, start_date: win.start, end_date: win.end })}`);
    } catch (err) {
      // Near midnight the service's "today" can differ from ours; fall back to the full 16-day window.
      if (err.status !== 400) throw err;
      json = await fetchJSON(`${FORECAST_URL}?${new URLSearchParams({ ...base, forecast_days: String(FORECAST_DAYS) })}`);
    }
    return slimForecast(json);
  }

  const isNetworkError = (err) => !navigator.onLine || err instanceof TypeError;

  async function refreshStop(stop) {
    const prev = runtime.get(stop.id) || {};
    const req = (prev.req || 0) + 1;
    const cached = prev.entry || readCache(stop.id);
    runtime.set(stop.id, { status: 'loading', entry: cached, req });
    renderBody(stop.id);

    let next;
    try {
      const data = await fetchForecast(stop);
      if (data === null) {
        next = { status: 'idle', entry: cached };
      } else {
        const entry = { unit: state.unit, fetchedAt: Date.now(), data };
        writeCache(stop.id, entry);
        next = { status: 'ok', entry };
        if (data.timezone && validTz(data.timezone) && data.timezone !== stop.timezone) {
          stop.timezone = data.timezone;
          saveState();
        }
      }
    } catch (err) {
      const offline = isNetworkError(err);
      const message = offline ? "Couldn't reach the weather service." : err.message;
      next = cached ? { status: 'stale', entry: cached, offline, error: message } : { status: 'error', entry: null, offline, error: message };
    }
    const current = runtime.get(stop.id);
    if (!current || current.req !== req) return; // a newer refresh (or removal) superseded this one
    runtime.set(stop.id, { ...next, req });
    renderBody(stop.id);
  }

  let refreshing = null;
  function refreshAll() {
    const btn = $('#refresh-btn');
    btn.classList.add('is-busy');
    btn.disabled = true;
    const run = Promise.allSettled(state.stops.map(refreshStop)).finally(() => {
      if (refreshing === run) {
        btn.classList.remove('is-busy');
        btn.disabled = false;
        refreshing = null;
      }
    });
    refreshing = run;
    return run;
  }

  // ---------- forecast shaping ----------

  function indexForecast(entry) {
    const days = new Map();
    if (!entry) return days;
    const { data, unit } = entry;
    const d = data.daily;
    d.time.forEach((date, i) => {
      days.set(date, {
        hi: convertTemp(num(d.hi[i]), unit),
        lo: convertTemp(num(d.lo[i]), unit),
        rain: num(d.rain[i]),
        code: num(d.code[i]),
        hours: new Array(24).fill(null),
      });
    });
    const h = data.hourly;
    h.time.forEach((t, i) => {
      const day = days.get(String(t).slice(0, 10));
      const hour = parseInt(String(t).slice(11, 13), 10);
      const p = num(h.rain[i]);
      if (!day || !(hour >= 0 && hour < 24) || p == null) return;
      day.hours[hour] = Math.max(day.hours[hour] == null ? 0 : day.hours[hour], p);
    });
    return days;
  }

  function rainWindows(hours) {
    const windows = [];
    let cur = null;
    hours.forEach((p, h) => {
      if (p != null && p >= RAIN_THRESHOLD) {
        if (!cur) cur = { start: h, end: h + 1, peak: p };
        else { cur.end = h + 1; cur.peak = Math.max(cur.peak, p); }
      } else if (cur) {
        windows.push(cur);
        cur = null;
      }
    });
    if (cur) windows.push(cur);
    return windows;
  }

  // ---------- rendering ----------

  const stopsEl = $('#stops');

  function placeLine(stop) {
    return [stop.admin1 && stop.admin1 !== stop.name ? stop.admin1 : '', stop.country].filter(Boolean).join(', ');
  }

  function renderAll() {
    scheduleReport();
    if (!state.stops.length) {
      stopsEl.innerHTML = `
        <div class="empty">
          <div class="empty-icon" aria-hidden="true">🧳</div>
          <h2>No stops yet</h2>
          <p>Search for a city above, pick your dates, and tap <strong>Add</strong> to see its forecast.</p>
        </div>`;
      return;
    }
    stopsEl.innerHTML = sortedStops().map((s) => (
      `<section class="stop" data-id="${esc(s.id)}" aria-label="${esc(s.name)}">
        <div class="stop-header"></div>
        <div class="stop-body"></div>
      </section>`
    )).join('');
    for (const s of state.stops) {
      renderHeader(s.id);
      renderBody(s.id);
    }
  }

  const sectionFor = (id) => stopsEl.querySelector(`section[data-id="${CSS.escape(id)}"]`);
  const stopById = (id) => state.stops.find((s) => s.id === id);

  let editingId = null;

  function renderHeader(id) {
    const stop = stopById(id);
    const section = sectionFor(id);
    if (!stop || !section) return;
    const editing = editingId === id;
    section.querySelector('.stop-header').innerHTML = `
      <div class="stop-head">
        <div class="stop-title">
          <h2>${esc(stop.name)}</h2>
          <p class="stop-place">${esc(placeLine(stop))}</p>
          <p class="stop-dates">${esc(fmtRange(stop.start, stop.end))}</p>
        </div>
        <div class="stop-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-action="edit" aria-expanded="${editing}">
            <span aria-hidden="true">✎</span> Edit dates</button>
          <button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-action="remove" aria-label="Remove ${esc(stop.name)}">
            <span aria-hidden="true">🗑</span> Remove</button>
        </div>
      </div>
      ${editing ? `
      <form class="edit-form" data-id="${esc(id)}" novalidate>
        <div class="field"><label for="edit-start-${esc(id)}">Start</label>
          <input id="edit-start-${esc(id)}" name="start" type="date" value="${esc(stop.start)}" required></div>
        <div class="field"><label for="edit-end-${esc(id)}">End</label>
          <input id="edit-end-${esc(id)}" name="end" type="date" value="${esc(stop.end)}" min="${esc(stop.start)}" required></div>
        <div class="edit-buttons">
          <button type="button" class="btn btn-ghost" data-action="cancel-edit">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
        <p class="form-msg" role="alert"></p>
      </form>` : ''}`;
  }

  function renderBody(id) {
    const stop = stopById(id);
    const section = sectionFor(id);
    if (!stop || !section) return;
    const body = section.querySelector('.stop-body');
    const scrollers = [...body.querySelectorAll('.days, .chart-scroll')].map((el) => el.scrollLeft);
    // The chart card sits inside the body's side margins and has a 1px border.
    const inset = window.innerWidth >= 900 ? 46 : 34;
    const width = Math.max(260, (body.clientWidth || section.clientWidth || 320) - inset);
    body.innerHTML = bodyHTML(stop, runtime.get(id) || { status: 'loading', entry: readCache(id) }, width);
    body.querySelectorAll('.days, .chart-scroll').forEach((el, i) => { el.scrollLeft = scrollers[i] || 0; });
    scheduleReport();
  }

  function bodyHTML(stop, rt, width) {
    const today = todayIn(stop.timezone);
    const last = addDays(today, FORECAST_DAYS - 1);
    const days = indexForecast(rt.entry);
    const dates = [];
    for (let d = stop.start; d <= stop.end; d = addDays(d, 1)) dates.push(d);

    const withData = dates.filter((d) => d >= today && d <= last && days.has(d) && days.get(d).hi != null && days.get(d).lo != null);
    let min = Infinity;
    let max = -Infinity;
    for (const d of withData) { min = Math.min(min, days.get(d).lo); max = Math.max(max, days.get(d).hi); }

    const cards = dates.map((date) => {
      if (date < today) return pastCard(date);
      if (date > last) return placeholderCard(date);
      const day = days.get(date);
      if (day && day.hi != null && day.lo != null) return dayCard(date, day, min, max, date === today);
      if (rt.status === 'loading') return skeletonCard(date);
      return missingCard(date);
    }).join('');

    return `
      ${metaHTML(stop, rt, today, last)}
      ${withData.length ? chartHTML(withData.map((d) => ({ date: d, ...days.get(d) })), width, stop.id) : ''}
      <div class="days" role="list">${cards}</div>`;
  }

  function metaHTML(stop, rt, today, last) {
    const tzTime = localTime(stop.timezone);
    const local = tzTime ? `<span class="meta-item">Local time ${esc(tzTime)}</span>` : '';
    const updated = rt.entry ? `Last updated ${esc(fmtUpdated(rt.entry.fetchedAt))}` : '';
    const allFuture = stop.start > last;
    const allPast = stop.end < today;

    if (allPast) return `<div class="stop-meta"><span class="meta-item">This trip has ended.</span>${local}</div>`;
    if (allFuture) {
      return `<div class="stop-meta"><span class="meta-item">Forecast opens around ${esc(fmtFull.format(dateObj(addDays(stop.start, -(FORECAST_DAYS - 1)))))}.</span>${local}</div>`;
    }
    switch (rt.status) {
      case 'loading':
        return `<div class="stop-meta"><span class="meta-item loading"><span class="spinner" aria-hidden="true"></span>${rt.entry ? 'Updating…' : 'Loading forecast…'}</span>${rt.entry ? `<span class="meta-item">${updated}</span>` : ''}${local}</div>`;
      case 'ok':
        return `<div class="stop-meta"><span class="meta-item">Updated ${esc(fmtUpdated(rt.entry.fetchedAt))}</span>${local}</div>`;
      case 'stale':
        return `<div class="notice notice-offline" role="status">
            <span aria-hidden="true">${rt.offline ? '📡' : '⚠️'}</span>
            <div><strong>${rt.offline ? 'Offline' : 'Couldn’t refresh'}.</strong> Showing the saved forecast. ${updated}.
            ${rt.offline ? '' : `<span class="notice-detail">${esc(rt.error)}</span>`}</div>
            <button type="button" class="btn btn-ghost btn-sm" data-action="retry">Retry</button>
          </div>`;
      case 'error':
        return `<div class="notice notice-error" role="alert">
            <span aria-hidden="true">${rt.offline ? '📡' : '⚠️'}</span>
            <div><strong>Couldn’t load the forecast for ${esc(stop.name)}.</strong>
            <span class="notice-detail">${esc(rt.offline ? 'Check your connection and try again.' : rt.error)}</span></div>
            <button type="button" class="btn btn-ghost btn-sm" data-action="retry">Retry</button>
          </div>`;
      default:
        return `<div class="stop-meta">${local}</div>`;
    }
  }

  function dayHead(date, isToday) {
    const d = dateObj(date);
    return `<div class="day-head">
        <span class="dow">${esc(fmtDow.format(d))}</span>
        <span class="date">${esc(fmtMonthDay.format(d))}</span>
        ${isToday ? '<span class="today-pill">Today</span>' : ''}
      </div>`;
  }

  function dayCard(date, day, min, max, isToday) {
    const [label, emoji] = WMO[day.code] || ['Unknown', '🌡️'];
    const span = max - min || 1;
    const top = ((max - day.hi) / span) * 100;
    const bottom = ((day.lo - min) / span) * 100;
    const fullLabel = `${fmtFull.format(dateObj(date))}: ${label}, high ${Math.round(day.hi)}, low ${Math.round(day.lo)}`;
    return `
      <article class="day${isToday ? ' is-today' : ''}" role="listitem" aria-label="${esc(fullLabel)}">
        ${dayHead(date, isToday)}
        <div class="wx">
          <span class="wx-icon" role="img" aria-label="${esc(label)}">${emoji}</span>
          <span class="wx-label">${esc(label)}</span>
        </div>
        <div class="temps">
          <div class="temp-vals">
            <div class="temp hi"><span class="temp-lbl"><span aria-hidden="true">▲</span> High</span><span class="temp-val">${fmtTemp(day.hi)}</span></div>
            <div class="temp lo"><span class="temp-lbl"><span aria-hidden="true">▼</span> Low</span><span class="temp-val">${fmtTemp(day.lo)}</span></div>
          </div>
          <div class="range" title="Range compared with the rest of this trip" aria-hidden="true">
            <div class="range-fill" style="top:${top.toFixed(1)}%;bottom:${bottom.toFixed(1)}%"></div>
          </div>
        </div>
        ${rainHTML(day)}
      </article>`;
  }

  function rainHTML(day) {
    const peak = day.rain != null ? day.rain : Math.max(-1, ...day.hours.filter((p) => p != null));
    if (peak < 0) return '<div class="rain rain-none"><span class="dry">Rain chance unavailable</span></div>';
    if (peak < RAIN_THRESHOLD) {
      return `<div class="rain rain-dry"><span class="dry"><span aria-hidden="true">☀</span> Dry <span class="dry-pct">${Math.round(peak)}% chance</span></span></div>`;
    }
    const windows = rainWindows(day.hours);
    const hasHours = day.hours.some((p) => p != null);
    const bars = day.hours.map((p, h) => {
      const v = p == null ? 0 : p;
      return `<span class="hb${v >= RAIN_THRESHOLD ? ' hb-on' : ''}" style="height:${Math.max(6, v)}%;background:${rainColor(v)}" title="${esc(fmtHourWindow(h, h + 1))}: ${p == null ? 'n/a' : Math.round(p) + '%'}"></span>`;
    }).join('');
    return `
      <div class="rain rain-yes">
        <span class="rain-badge" style="background:${rainColor(peak)};color:${rainTextColor(peak)}">
          <span aria-hidden="true">☔</span> Rain ${Math.round(peak)}%</span>
        ${windows.length ? `<ul class="rain-windows">${windows.map((w) => (
          `<li><span class="rw-dot" style="background:${rainColor(w.peak)}"></span>${esc(fmtHourWindow(w.start, w.end))} · peak ${Math.round(w.peak)}%</li>`
        )).join('')}</ul>` : `<p class="rain-note">No single hour reaches ${RAIN_THRESHOLD}%.</p>`}
        ${hasHours ? `
        <div class="hourbars" role="img" aria-label="Hourly rain chance from midnight to midnight">
          <span class="hb-threshold" style="bottom:${RAIN_THRESHOLD}%"></span>${bars}
        </div>
        <div class="hb-axis" aria-hidden="true"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span></span></div>` : ''}
      </div>`;
  }

  function placeholderCard(date) {
    const opens = addDays(date, -(FORECAST_DAYS - 1));
    return `
      <article class="day day-muted day-placeholder" role="listitem">
        ${dayHead(date, false)}
        <div class="muted-body">
          <span class="muted-icon" aria-hidden="true">🗓️</span>
          <p>Forecast not available yet. Check back within 16 days</p>
          <p class="muted-sub">Available around ${esc(fmtMonthDay.format(dateObj(opens)))}</p>
        </div>
      </article>`;
  }

  function pastCard(date) {
    return `
      <article class="day day-muted" role="listitem">
        ${dayHead(date, false)}
        <div class="muted-body"><span class="muted-icon" aria-hidden="true">⏮</span><p>This day has passed.</p></div>
      </article>`;
  }

  function missingCard(date) {
    return `
      <article class="day day-muted" role="listitem">
        ${dayHead(date, false)}
        <div class="muted-body"><span class="muted-icon" aria-hidden="true">☁️</span><p>No forecast for this day yet.</p></div>
      </article>`;
  }

  function skeletonCard(date) {
    return `
      <article class="day day-skeleton" role="listitem" aria-busy="true">
        ${dayHead(date, false)}
        <div class="sk sk-icon"></div><div class="sk sk-line"></div>
        <div class="sk sk-temp"></div><div class="sk sk-temp"></div><div class="sk sk-line"></div>
      </article>`;
  }

  // Combined high/low chart for a stop, drawn as inline SVG at the container's pixel width.
  function chartHTML(points, containerWidth, id) {
    const step = 64;
    const padX = 30;
    const W = Math.max(containerWidth, points.length * step + padX * 2);
    const H = 190;
    const top = 30;
    const bottom = 150;
    let min = Math.min(...points.map((p) => p.lo));
    let max = Math.max(...points.map((p) => p.hi));
    if (max - min < 4) { min -= 2; max += 2; }
    const x = (i) => (points.length === 1 ? W / 2 : padX + (i * (W - padX * 2)) / (points.length - 1));
    const y = (v) => top + ((max - v) / (max - min)) * (bottom - top);

    const hiPts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.hi).toFixed(1)}`);
    const loPts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.lo).toFixed(1)}`);
    const band = `M${hiPts.join('L')}L${loPts.slice().reverse().join('L')}Z`;
    const gridVals = [min, (min + max) / 2, max];
    const gradId = `band-${String(id).replace(/[^\w-]/g, '')}`;

    const svg = `
      <svg class="chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily high and low temperatures">
        <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="band-top"/><stop offset="1" class="band-bottom"/></linearGradient></defs>
        ${gridVals.map((v) => `<line class="grid" x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('')}
        <path class="band" d="${band}" fill="url(#${gradId})"/>
        <polyline class="line-hi" points="${hiPts.join(' ')}"/>
        <polyline class="line-lo" points="${loPts.join(' ')}"/>
        ${points.map((p, i) => `
          <circle class="dot-hi" cx="${x(i).toFixed(1)}" cy="${y(p.hi).toFixed(1)}" r="4"/>
          <circle class="dot-lo" cx="${x(i).toFixed(1)}" cy="${y(p.lo).toFixed(1)}" r="4"/>
          <text class="lbl-hi" x="${x(i).toFixed(1)}" y="${(y(p.hi) - 10).toFixed(1)}">${fmtTemp(p.hi)}</text>
          <text class="lbl-lo" x="${x(i).toFixed(1)}" y="${(y(p.lo) + 19).toFixed(1)}">${fmtTemp(p.lo)}</text>
          <text class="lbl-x" x="${x(i).toFixed(1)}" y="${H - 8}">${esc(fmtDow.format(dateObj(p.date)))} ${esc(String(+p.date.slice(8)))}</text>`).join('')}
      </svg>`;
    return `
      <figure class="chart-card">
        <figcaption class="chart-legend">
          <span class="lg lg-hi"><span class="lg-swatch"></span>High</span>
          <span class="lg lg-lo"><span class="lg-swatch"></span>Low</span>
          <span class="lg-unit">°${state.unit}</span>
        </figcaption>
        <div class="chart-scroll">${svg}</div>
      </figure>`;
  }

  // ---------- trip report: every day of every stop, in date order ----------

  const reportEl = $('#report');
  let reportQueued = false;

  function scheduleReport() {
    if (reportQueued) return;
    reportQueued = true;
    requestAnimationFrame(() => { reportQueued = false; renderReport(); });
  }

  const severityOf = (p) => (p == null ? null : RAIN_SEVERITY.find((b) => p >= b.min) || null);

  function reportRows() {
    const rows = [];
    for (const stop of sortedStops()) {
      const rt = runtime.get(stop.id) || { status: 'loading', entry: readCache(stop.id) };
      const days = indexForecast(rt.entry);
      const today = todayIn(stop.timezone);
      const last = addDays(today, FORECAST_DAYS - 1);
      for (let date = stop.start; date <= stop.end; date = addDays(date, 1)) {
        const day = days.get(date);
        let kind = 'ok';
        if (date < today) kind = 'past';
        else if (date > last) kind = 'later';
        else if (!day || day.hi == null) kind = rt.status === 'loading' ? 'loading' : 'missing';
        let peak = null;
        if (kind === 'ok') {
          const hourly = day.hours.filter((p) => p != null);
          peak = day.rain != null ? day.rain : hourly.length ? Math.max(...hourly) : null;
        }
        rows.push({ stop, date, day, kind, peak, sev: kind === 'ok' ? severityOf(peak) : null });
      }
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.stop.start.localeCompare(b.stop.start));
  }

  function rainPill(peak, sev) {
    if (peak == null) return '<span class="rp rp-none">No data</span>';
    if (!sev) return `<span class="rp rp-dry">Dry · ${Math.round(peak)}%</span>`;
    return `<span class="rp rp-${sev.key}" style="background:${rainColor(peak)};color:${rainTextColor(peak)}"><span aria-hidden="true">☔</span> ${esc(sev.label)} · ${Math.round(peak)}%</span>`;
  }

  function renderReport() {
    if (!reportEl) return;
    if (!state.stops.length) {
      reportEl.innerHTML = `<div class="empty"><div class="empty-icon" aria-hidden="true">🗒️</div><h2>Nothing to report yet</h2><p>Add your stops and the trip report will gather every day here.</p></div>`;
      return;
    }
    const rows = reportRows();
    const forecastRows = rows.filter((r) => r.kind === 'ok');
    const counts = RAIN_SEVERITY.map((b) => ({ ...b, n: forecastRows.filter((r) => r.sev && r.sev.key === b.key).length }));
    const rainy = forecastRows.filter((r) => r.sev).sort((a, b) => b.peak - a.peak);
    const dry = forecastRows.filter((r) => !r.sev && r.peak != null).length;
    const later = rows.filter((r) => r.kind === 'later').length;
    const first = rows[0].date;
    const lastDate = rows.reduce((m, r) => (r.date > m ? r.date : m), first);
    const cities = new Set(state.stops.map((s) => s.name)).size;
    let hottest = null;
    let coldest = null;
    for (const r of forecastRows) {
      if (!hottest || r.day.hi > hottest.day.hi) hottest = r;
      if (!coldest || r.day.lo < coldest.day.lo) coldest = r;
    }
    const where = (r) => `${esc(fmtFull.format(dateObj(r.date)))} in ${esc(r.stop.name)}`;
    const loading = rows.some((r) => r.kind === 'loading');

    const highlights = [];
    if (rainy.length) highlights.push(`<li><strong>Wettest day:</strong> ${where(rainy[0])}, ${Math.round(rainy[0].peak)}% chance of rain${rainWindows(rainy[0].day.hours).length ? ` (${esc(rainWindows(rainy[0].day.hours).map((w) => fmtHourWindow(w.start, w.end)).join(', '))})` : ''}.</li>`);
    else if (forecastRows.length) highlights.push('<li><strong>No rain expected</strong> on any forecast day.</li>');
    if (hottest) highlights.push(`<li><strong>Warmest:</strong> high of ${fmtTemp(hottest.day.hi)}${state.unit} on ${where(hottest)}.</li>`);
    if (coldest) highlights.push(`<li><strong>Coolest:</strong> low of ${fmtTemp(coldest.day.lo)}${state.unit} on ${where(coldest)}.</li>`);
    if (later) highlights.push(`<li>${later} day${later === 1 ? ' is' : 's are'} more than 16 days out, so ${later === 1 ? 'it has' : 'they have'} no forecast yet.</li>`);

    const tally = [
      ...counts.map((c) => `<div class="tally tally-${c.key}"><span class="tally-n">${c.n}</span><span class="tally-l"><span class="sev-dot" style="background:${rainColor(c.key === 'high' ? 85 : c.key === 'mid' ? 60 : 40)}"></span>${esc(c.label)}</span></div>`),
      `<div class="tally tally-dry"><span class="tally-n">${dry}</span><span class="tally-l"><span class="sev-dot sev-dot-dry"></span>Dry</span></div>`,
    ].join('');

    let prevDate = '';
    const list = rows.map((r) => {
      const d = dateObj(r.date);
      const newDate = r.date !== prevDate;
      prevDate = r.date;
      const dateCell = `<div class="rr-date${newDate ? '' : ' rr-date-repeat'}"><span class="rr-dow">${esc(fmtDow.format(d))}</span><span class="rr-md">${esc(fmtMonthDay.format(d))}</span></div>`;
      const city = `<div class="rr-city"><span class="rr-name">${esc(r.stop.name)}</span><span class="rr-country">${esc(r.stop.country)}</span></div>`;
      if (r.kind !== 'ok') {
        const msg = { past: 'Day has passed', later: 'Forecast not available yet', loading: 'Loading…', missing: 'No forecast' }[r.kind];
        return `<li class="rr rr-muted">${dateCell}${city}<div class="rr-wx"></div><div class="rr-temp"></div><div class="rr-rain"><span class="rp rp-none">${esc(msg)}</span></div></li>`;
      }
      const [label, emoji] = WMO[r.day.code] || ['Unknown', '🌡️'];
      const windows = r.sev ? rainWindows(r.day.hours) : [];
      const tint = r.sev ? ` style="--sev:${rainColor(r.peak)}"` : '';
      return `<li class="rr${r.sev ? ` rr-rain-${r.sev.key}` : ''}"${tint}>
          ${dateCell}${city}
          <div class="rr-wx"><span class="rr-emoji" role="img" aria-label="${esc(label)}">${emoji}</span><span class="rr-label">${esc(label)}</span></div>
          <div class="rr-temp"><span class="rr-hi">▲ ${fmtTemp(r.day.hi)}</span><span class="rr-lo">▼ ${fmtTemp(r.day.lo)}</span></div>
          <div class="rr-rain">${rainPill(r.peak, r.sev)}${windows.length ? `<span class="rr-windows">${esc(windows.map((w) => fmtHourWindow(w.start, w.end)).join(', '))}</span>` : ''}</div>
        </li>`;
    }).join('');

    reportEl.innerHTML = `
      <section class="report-card" aria-labelledby="report-title">
        <div class="report-head">
          <h2 id="report-title">Trip report</h2>
          <p class="report-sub">${esc(fmtFull.format(dateObj(first)))} – ${esc(fmtFull.format(dateObj(lastDate)))} · ${state.stops.length} stop${state.stops.length === 1 ? '' : 's'}, ${cities} cit${cities === 1 ? 'y' : 'ies'}${loading ? ' · <span class="meta-item loading"><span class="spinner" aria-hidden="true"></span>Loading…</span>' : ''}</p>
        </div>
        <div class="tallies" aria-label="Days by rain chance">${tally}</div>
        <ul class="highlights">${highlights.join('')}</ul>
        <p class="sev-key">Rain chance: <strong>Possible</strong> ${RAIN_THRESHOLD}–49% · <strong>Likely</strong> 50–69% · <strong>Very likely</strong> 70%+. Times are local to each city.</p>
      </section>
      <ol class="report-list" aria-label="Every day of the trip">${list}</ol>`;
  }

  function syncView() {
    const report = state.view === 'report';
    stopsEl.hidden = report;
    reportEl.hidden = !report;
    document.querySelectorAll('.view-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === state.view)));
    if (report) renderReport();
  }

  document.querySelectorAll('.view-tab').forEach((t) => t.addEventListener('click', () => {
    state.view = t.dataset.view;
    saveState();
    syncView();
    if (state.view === 'stops') state.stops.forEach((s) => renderBody(s.id)); // charts need the visible width
  }));

  // ---------- toasts + dialogs ----------

  let toastTimer = null;
  function toast(message, action) {
    const el = $('#toast');
    clearTimeout(toastTimer);
    el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : ''}`;
    el.hidden = false;
    if (action) {
      el.querySelector('.toast-action').addEventListener('click', () => { el.hidden = true; action.onClick(); }, { once: true });
    }
    toastTimer = setTimeout(() => { el.hidden = true; if (action && action.onExpire) action.onExpire(); }, action ? 6000 : 3500);
  }

  function openDialog(dialog) {
    return new Promise((resolve) => {
      dialog.returnValue = '';
      dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true });
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else resolve(window.confirm($('h2', dialog).textContent) ? (dialog.dataset.ok || 'ok') : 'cancel');
    });
  }

  // ---------- add form + city autocomplete ----------

  const form = $('#add-form');
  const cityInput = $('#city');
  const cityList = $('#city-list');
  const startInput = $('#start');
  const endInput = $('#end');
  const formMsg = $('#form-msg');

  let geoCtrl = null;
  let geoTimer = null;
  let geoResults = [];
  let activeIdx = -1;
  let selectedPlace = null;

  function setFormMsg(text) { formMsg.textContent = text; }

  function openList() { cityList.hidden = false; cityInput.setAttribute('aria-expanded', 'true'); }
  function closeList() {
    cityList.hidden = true;
    cityInput.setAttribute('aria-expanded', 'false');
    cityInput.removeAttribute('aria-activedescendant');
    activeIdx = -1;
  }

  function listMessage(text) {
    geoResults = [];
    cityList.innerHTML = `<li class="combo-msg" role="option" aria-disabled="true">${esc(text)}</li>`;
    openList();
  }

  function placeLabel(p) { return [p.name, p.admin1, p.country].filter(Boolean).join(', '); }

  function renderList() {
    if (!geoResults.length) { listMessage('No matching cities. Try another spelling.'); return; }
    const counts = {};
    geoResults.forEach((p) => { counts[placeLabel(p)] = (counts[placeLabel(p)] || 0) + 1; });
    cityList.innerHTML = geoResults.map((p, i) => {
      const detail = [p.admin1, counts[placeLabel(p)] > 1 ? p.admin2 : '', p.country].filter(Boolean).join(', ');
      return `<li id="city-opt-${i}" class="combo-opt" role="option" aria-selected="${i === activeIdx}" data-index="${i}">
          <span class="opt-name">${esc(p.name)}</span><span class="opt-detail">${esc(detail)}</span></li>`;
    }).join('');
    openList();
  }

  function setActive(i) {
    activeIdx = i;
    cityList.querySelectorAll('.combo-opt').forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) {
      cityInput.setAttribute('aria-activedescendant', `city-opt-${i}`);
      const li = $(`#city-opt-${i}`);
      if (li) li.scrollIntoView({ block: 'nearest' });
    }
  }

  function selectPlace(i) {
    const p = geoResults[i];
    if (!p) return;
    selectedPlace = p;
    cityInput.value = placeLabel(p);
    closeList();
    setFormMsg('');
  }

  async function searchCities(query) {
    if (geoCtrl) geoCtrl.abort();
    const ctrl = new AbortController();
    geoCtrl = ctrl;
    if (cityList.hidden || !geoResults.length) listMessage('Searching…');
    try {
      const json = await fetchJSON(`${GEO_URL}?${new URLSearchParams({ name: query, count: '5', language: 'en', format: 'json' })}`, ctrl.signal);
      if (ctrl !== geoCtrl) return;
      geoResults = (json.results || []).map((r) => ({
        name: cleanStr(r.name, 100),
        admin1: cleanStr(r.admin1, 100),
        admin2: cleanStr(r.admin2, 100),
        country: cleanStr(r.country, 100),
        lat: r.latitude,
        lon: r.longitude,
        timezone: r.timezone,
      })).filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon));
      activeIdx = -1;
      if (document.activeElement === cityInput) renderList();
    } catch (err) {
      if (ctrl !== geoCtrl || (err.name === 'AbortError' && ctrl.signal.aborted)) return;
      listMessage(isNetworkError(err) ? 'City search needs a connection. Try again when you’re online.' : 'City search failed. Please try again.');
    }
  }

  cityInput.addEventListener('input', () => {
    selectedPlace = null;
    clearTimeout(geoTimer);
    const q = cityInput.value.trim();
    if (q.length < 2) { if (geoCtrl) geoCtrl.abort(); closeList(); return; }
    geoTimer = setTimeout(() => searchCities(q), 250);
  });

  cityInput.addEventListener('keydown', (e) => {
    const open = !cityList.hidden && geoResults.length;
    if (e.key === 'ArrowDown' && open) { e.preventDefault(); setActive((activeIdx + 1) % geoResults.length); }
    else if (e.key === 'ArrowUp' && open) { e.preventDefault(); setActive((activeIdx - 1 + geoResults.length) % geoResults.length); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); selectPlace(activeIdx >= 0 ? activeIdx : 0); }
    else if (e.key === 'Escape') { closeList(); }
  });

  cityInput.addEventListener('focus', () => { if (!selectedPlace && geoResults.length) renderList(); });
  cityInput.addEventListener('blur', () => setTimeout(closeList, 150));
  cityList.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus so blur doesn't close first
  cityList.addEventListener('click', (e) => {
    const li = e.target.closest('.combo-opt');
    if (li) selectPlace(Number(li.dataset.index));
  });

  startInput.addEventListener('change', () => {
    endInput.min = startInput.value;
    if (endInput.value && startInput.value && endInput.value < startInput.value) endInput.value = startInput.value;
  });

  function validateDates(start, end) {
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) return 'Choose a start and end date.';
    if (end < start) return 'The end date must be on or after the start date.';
    if (diffDays(start, end) + 1 > MAX_TRIP_DAYS) return `Stops can be up to ${MAX_TRIP_DAYS} days long.`;
    return '';
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!selectedPlace) {
      setFormMsg(cityInput.value.trim() ? 'Pick a city from the suggestions so we know which one you mean.' : 'Enter a city name.');
      const q = cityInput.value.trim();
      if (q.length >= 2) { cityInput.focus(); searchCities(q); } else cityInput.focus();
      return;
    }
    const problem = validateDates(startInput.value, endInput.value);
    if (problem) { setFormMsg(problem); return; }
    const stop = sanitizeStop({ ...selectedPlace, start: startInput.value, end: endInput.value });
    if (!stop) { setFormMsg('Something about that city looks off. Try another match.'); return; }
    state.stops.push(stop);
    saveState();
    renderAll();
    refreshStop(stop);
    cityInput.value = '';
    selectedPlace = null;
    geoResults = [];
    setFormMsg('');
    toast(`Added ${stop.name}`);
    const section = sectionFor(stop.id);
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------- stop actions (edit / remove / retry) ----------

  stopsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const section = btn.closest('section.stop');
    const id = section && section.dataset.id;
    const stop = id && stopById(id);
    if (!stop) return;
    switch (btn.dataset.action) {
      case 'edit':
        editingId = editingId === id ? null : id;
        renderHeader(id);
        if (editingId) { const input = section.querySelector('.edit-form input'); if (input) input.focus(); }
        break;
      case 'cancel-edit':
        editingId = null;
        renderHeader(id);
        break;
      case 'retry':
        refreshStop(stop);
        break;
      case 'remove':
        removeStop(stop);
        break;
      default:
        break;
    }
  });

  stopsEl.addEventListener('change', (e) => {
    const f = e.target.closest('.edit-form');
    if (f && e.target.name === 'start') {
      f.elements.end.min = e.target.value;
      if (f.elements.end.value < e.target.value) f.elements.end.value = e.target.value;
    }
  });

  stopsEl.addEventListener('submit', (e) => {
    const f = e.target.closest('.edit-form');
    if (!f) return;
    e.preventDefault();
    const stop = stopById(f.dataset.id);
    if (!stop) return;
    const start = f.elements.start.value;
    const end = f.elements.end.value;
    const problem = validateDates(start, end);
    if (problem) { f.querySelector('.form-msg').textContent = problem; return; }
    stop.start = start;
    stop.end = end;
    editingId = null;
    saveState();
    renderAll();
    refreshStop(stop);
    toast(`Updated dates for ${stop.name}`);
  });

  function removeStop(stop) {
    const index = state.stops.indexOf(stop);
    const saved = runtime.get(stop.id);
    state.stops.splice(index, 1);
    runtime.delete(stop.id);
    if (editingId === stop.id) editingId = null;
    saveState();
    renderAll();
    toast(`Removed ${stop.name}`, {
      label: 'Undo',
      onClick: () => {
        state.stops.push(stop);
        if (saved) runtime.set(stop.id, { ...saved, req: (saved.req || 0) + 1, status: saved.entry ? 'ok' : saved.status });
        saveState();
        renderAll();
        if (!saved || !saved.entry) refreshStop(stop);
      },
      onExpire: () => { if (!stopById(stop.id)) dropCache(stop.id); },
    });
  }

  // ---------- toolbar ----------

  function syncUnitButtons() {
    document.querySelectorAll('.unit-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));
  }

  document.querySelectorAll('.unit-btn').forEach((b) => b.addEventListener('click', () => {
    if (state.unit === b.dataset.unit) return;
    state.unit = b.dataset.unit;
    saveState();
    syncUnitButtons();
    renderAll(); // cached values convert instantly; fresh numbers follow
    refreshAll();
  }));

  $('#refresh-btn').addEventListener('click', () => refreshAll());

  $('#clear-btn').addEventListener('click', async () => {
    if (!state.stops.length) { toast('There are no stops to clear.'); return; }
    $('#confirm-text').textContent = `This removes all ${state.stops.length} stop${state.stops.length === 1 ? '' : 's'} and their saved forecasts from this device.`;
    if (await openDialog($('#confirm-dialog')) !== 'ok') return;
    state.stops.forEach((s) => dropCache(s.id));
    state.stops = [];
    runtime.clear();
    editingId = null;
    saveState();
    renderAll();
    toast('All stops cleared');
  });

  // ---------- share links ----------

  function b64urlEncode(str) {
    let bin = '';
    new TextEncoder().encode(str).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(s) {
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  function shareUrl() {
    const payload = [1, sortedStops().map((s) => [s.name, s.admin1, s.country, s.lat, s.lon, s.timezone, s.start, s.end])];
    return `${location.href.split('#')[0]}#${SHARE_KEY}=${b64urlEncode(JSON.stringify(payload))}`;
  }

  // null when the hash has no share payload; [] when it has one we couldn't read.
  function parseShareHash(hash) {
    const m = new RegExp(`[#&]${SHARE_KEY}=([A-Za-z0-9_-]+)`).exec(hash || '');
    if (!m) return null;
    try {
      const [version, list] = JSON.parse(b64urlDecode(m[1]));
      if (version !== 1 || !Array.isArray(list)) return [];
      return list.slice(0, 100).map((a) => Array.isArray(a) && sanitizeStop({
        name: a[0], admin1: a[1], country: a[2], lat: a[3], lon: a[4], timezone: a[5], start: a[6], end: a[7],
      })).filter(Boolean).map((s) => ({ ...s, id: newId() }));
    } catch (e) {
      return [];
    }
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall back below */ }
    return false;
  }

  $('#share-btn').addEventListener('click', async () => {
    if (!state.stops.length) { toast('Add a stop first, then share your trip.'); return; }
    const url = shareUrl();
    if (await copyText(url)) { toast('Share link copied. Open it on your phone to import your stops.'); return; }
    const input = $('#share-input');
    input.value = url;
    openDialog($('#share-dialog'));
    input.focus();
    input.select();
  });

  $('#share-copy').addEventListener('click', async () => {
    const input = $('#share-input');
    input.select();
    let ok = await copyText(input.value);
    if (!ok) { try { ok = document.execCommand('copy'); } catch (e) { ok = false; } }
    $('#share-copy').textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(() => { $('#share-copy').textContent = 'Copy'; }, 2000);
  });

  const stopKey = (s) => `${s.name.toLowerCase()}|${s.lat.toFixed(2)}|${s.lon.toFixed(2)}|${s.start}|${s.end}`;

  function applyImport(incoming, mode) {
    if (mode === 'replace') {
      state.stops.forEach((s) => dropCache(s.id));
      runtime.clear();
      state.stops = incoming;
    } else {
      const have = new Set(state.stops.map(stopKey));
      incoming.forEach((s) => { if (!have.has(stopKey(s))) { state.stops.push(s); have.add(stopKey(s)); } });
    }
    editingId = null;
    saveState();
    renderAll();
    refreshAll();
  }

  function clearHash() {
    try { history.replaceState(null, '', location.href.split('#')[0]); } catch (e) { location.hash = ''; }
  }

  let importing = false;
  async function handleShareLink() {
    const incoming = parseShareHash(location.hash);
    if (incoming === null || importing) return;
    importing = true;
    clearHash();
    try {
      if (!incoming.length) { toast('That share link couldn’t be read.'); return; }
      const count = `${incoming.length} stop${incoming.length === 1 ? '' : 's'}`;
      if (!state.stops.length) {
        applyImport(incoming, 'replace');
        toast(`Imported ${count}`);
        return;
      }
      $('#import-text').textContent = `This link has ${count}. You already have ${state.stops.length} on this device. Replace them, or merge the two lists?`;
      $('#import-list').innerHTML = incoming.map((s) => `<li><strong>${esc(s.name)}</strong> <span>${esc(fmtRange(s.start, s.end))}</span></li>`).join('');
      const choice = await openDialog($('#import-dialog'));
      if (choice === 'replace' || choice === 'merge') {
        applyImport(incoming, choice);
        toast(choice === 'replace' ? `Replaced with ${count}` : `Merged ${count}`);
      }
    } finally {
      importing = false;
    }
  }

  // ---------- connectivity + resize ----------

  function syncNetBanner() { $('#net-banner').hidden = navigator.onLine; }
  window.addEventListener('offline', syncNetBanner);
  window.addEventListener('online', () => { syncNetBanner(); refreshAll(); });

  let lastWidth = window.innerWidth;
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(window.innerWidth - lastWidth) < 30) return;
      lastWidth = window.innerWidth;
      state.stops.forEach((s) => renderBody(s.id));
    }, 200);
  });

  // Day changes (and local clocks) move on while the app sits open: re-render every few minutes.
  setInterval(() => state.stops.forEach((s) => renderBody(s.id)), 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const stale = state.stops.some((s) => { const r = runtime.get(s.id); return !r || !r.entry || Date.now() - r.entry.fetchedAt > 30 * 60 * 1000; });
    if (stale && !refreshing) refreshAll();
  });

  // ---------- start up ----------

  function init() {
    $('#threshold-label').textContent = String(RAIN_THRESHOLD);
    const today = todayIn();
    startInput.value = today;
    endInput.value = addDays(today, 3);
    endInput.min = today;
    syncUnitButtons();
    syncNetBanner();

    const hasShare = parseShareHash(location.hash) !== null;
    if (!state.seeded && !hasShare && !state.stops.length) {
      state.stops = SAMPLE_STOPS.map((s) => sanitizeStop({ ...s, start: todayIn(s.timezone), end: addDays(todayIn(s.timezone), 6) }));
    }
    state.seeded = true;
    saveState();

    renderAll();
    syncView();
    if (state.stops.length) refreshAll();
    if (hasShare) handleShareLink();
    window.addEventListener('hashchange', handleShareLink);

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* app still works without it */ });
    }
  }

  init();
})();
