(function () {
  'use strict';

  var MGDL_PER_MMOL = 18.0182;
  var WINDOWS_MINUTES = [1, 2, 3, 4, 5, 10, 15, 30];
  var MAX_BASELINE_DIFF_MS = 45000;
  var POLL_MS = 30000;
  var latestReading = null;
  var updatingCurrentGlucose = false;

  function mmol(valueMgdl) {
    return valueMgdl / MGDL_PER_MMOL;
  }

  function formatCurrentMmol(entry) {
    if (!entry || !Number.isFinite(Number(entry.sgv))) return null;
    return mmol(Number(entry.sgv)).toFixed(2);
  }

  function signed(value, digits) {
    var rounded = value.toFixed(digits);
    return value > 0 ? '+' + rounded : rounded;
  }

  function trendClass(rateMgdlPerMin) {
    if (rateMgdlPerMin <= -2) return 'fast-down';
    if (rateMgdlPerMin < -1) return 'down';
    if (rateMgdlPerMin >= 2) return 'fast-up';
    if (rateMgdlPerMin > 1) return 'up';
    return 'flat';
  }

  function trendLabel(rateMgdlPerMin) {
    if (rateMgdlPerMin <= -2) return 'daalt snel';
    if (rateMgdlPerMin < -1) return 'daalt';
    if (rateMgdlPerMin >= 2) return 'stijgt snel';
    if (rateMgdlPerMin > 1) return 'stijgt';
    return 'stabiel';
  }

  function readingTime(entry) {
    return Number(entry.date || entry.mills || Date.parse(entry.dateString));
  }

  function findBaseline(readings, latestTime, minutesBack) {
    var target = latestTime - minutesBack * 60000;
    var best = null;
    var bestDiff = Infinity;

    readings.forEach(function (entry) {
      var time = readingTime(entry);
      if (!Number.isFinite(time) || time >= latestTime) return;

      var diff = Math.abs(time - target);
      if (diff < bestDiff) {
        best = entry;
        bestDiff = diff;
      }
    });

    return bestDiff <= MAX_BASELINE_DIFF_MS ? best : null;
  }

  function sortedReadings(entries) {
    return entries
      .filter(function (entry) { return Number.isFinite(Number(entry.sgv)) && Number.isFinite(readingTime(entry)); })
      .sort(function (a, b) { return readingTime(b) - readingTime(a); });
  }

  function calculateRows(readings) {
    var latest = readings[0];
    if (!latest) return [];

    var latestTime = readingTime(latest);
    return WINDOWS_MINUTES.map(function (minutesBack) {
      var baseline = findBaseline(readings, latestTime, minutesBack);
      if (!baseline) {
        return {
          label: minutesBack + 'm',
          missing: true
        };
      }

      var minutesActual = (latestTime - readingTime(baseline)) / 60000;
      if (minutesActual <= 0) return null;

      var deltaMgdl = Number(latest.sgv) - Number(baseline.sgv);
      var rateMgdl = deltaMgdl / minutesActual;
      var rateMmol = mmol(deltaMgdl) / minutesActual;

      return {
        label: minutesBack + 'm',
        actualMinutes: minutesActual,
        rateMgdl: rateMgdl,
        rateMmol: rateMmol,
        deltaMmol: mmol(deltaMgdl),
        css: trendClass(rateMgdl),
        text: trendLabel(rateMgdl)
      };
    });
  }

  function ensureStyles() {
    if (document.getElementById('cgm-rate-overlay-style')) return;
    var style = document.createElement('style');
    style.id = 'cgm-rate-overlay-style';
    style.textContent = [
      '#cgm-rate-overlay{position:absolute;z-index:50;top:174px;left:50%;transform:translateX(-50%);display:grid;grid-template-columns:repeat(8,minmax(64px,1fr));gap:5px;width:min(98vw,1040px);font-family:Arial,Helvetica,sans-serif;pointer-events:none}',
      '.primary,.bgStatus.current{overflow:visible!important}',
      '#cgm-rate-overlay .rate-card{border:1px solid rgba(255,255,255,.22);border-radius:5px;background:rgba(0,0,0,.5);color:#ddd;padding:4px 5px;text-align:left;box-shadow:0 1px 2px rgba(0,0,0,.25);min-width:0}',
      '#cgm-rate-overlay .rate-card.primary{border-width:2px}',
      '#cgm-rate-overlay .rate-window{display:block;font-size:9px;line-height:1;text-transform:uppercase;opacity:.75;letter-spacing:0}',
      '#cgm-rate-overlay .rate-main{display:block;font-family:monospace;font-size:14px;font-weight:800;line-height:1.15;letter-spacing:0}',
      '#cgm-rate-overlay .rate-card.primary .rate-main{font-size:16px}',
      '#cgm-rate-overlay .rate-sub{display:block;font-size:9px;line-height:1.1;opacity:.86;white-space:nowrap}',
      '#cgm-rate-overlay .fast-down{color:#ff3b30;border-color:#ff3b30;background:rgba(90,0,0,.72)}',
      '#cgm-rate-overlay .down{color:#ff766f;border-color:#d9413a;background:rgba(65,0,0,.55)}',
      '#cgm-rate-overlay .flat{color:#d9d9d9;border-color:rgba(255,255,255,.25)}',
      '#cgm-rate-overlay .up{color:#67d96f;border-color:#3fb950;background:rgba(0,55,20,.45)}',
      '#cgm-rate-overlay .fast-up{color:#38ff45;border-color:#38ff45;background:rgba(0,75,25,.6)}',
      '#cgm-rate-overlay .missing{color:#8a8a8a;border-color:rgba(255,255,255,.14);background:rgba(0,0,0,.28)}',
      '@media(max-width:700px){#cgm-rate-overlay{top:158px;grid-template-columns:repeat(4,minmax(66px,1fr));gap:4px;width:98vw}#cgm-rate-overlay .rate-card{padding:4px 5px}#cgm-rate-overlay .rate-main,#cgm-rate-overlay .rate-card.primary .rate-main{font-size:13px}#cgm-rate-overlay .rate-sub{font-size:8px}}'
    ].join('');
    document.head.appendChild(style);
  }

  function ensureContainer() {
    var existing = document.getElementById('cgm-rate-overlay');
    if (existing) return existing;

    var anchor = document.querySelector('.bgStatus.current');
    if (!anchor) return null;

    var container = document.createElement('div');
    container.id = 'cgm-rate-overlay';
    container.setAttribute('aria-label', 'Glucose snelheid per minuut');
    anchor.appendChild(container);
    return container;
  }

  function render(rows) {
    ensureStyles();
    var container = ensureContainer();
    if (!container) return;

    if (!rows.length) {
      container.innerHTML = '<div class="rate-card flat primary"><span class="rate-window">snelheid</span><span class="rate-main">geen data</span><span class="rate-sub">wacht op meerdere metingen</span></div>';
      return;
    }

    container.innerHTML = rows.map(function (row, index) {
      if (row.missing) {
        return [
          '<div class="rate-card missing">',
          '<span class="rate-window">', row.label, '</span>',
          '<span class="rate-main">--</span>',
          '<span class="rate-sub">geen exact punt</span>',
          '</div>'
        ].join('');
      }

      return [
        '<div class="rate-card ', row.css, index === 0 ? ' primary' : '', '">',
        '<span class="rate-window">', row.label, ' ', row.text, '</span>',
        '<span class="rate-main">', signed(row.rateMmol, 2), '</span>',
        '<span class="rate-sub">mmol/L/min · ', row.actualMinutes.toFixed(1), 'm · Δ ', signed(row.deltaMmol, 1), '</span>',
        '</div>'
      ].join('');
    }).join('');
  }

  function renderCurrentGlucose(entry) {
    var value = formatCurrentMmol(entry);
    var currentBg = document.querySelector('.currentBG');
    if (!value || !currentBg) return;
    if (currentBg.textContent === value) return;

    updatingCurrentGlucose = true;
    currentBg.textContent = value;
    updatingCurrentGlucose = false;
  }

  function observeCurrentGlucose() {
    var observer = new MutationObserver(function () {
      if (updatingCurrentGlucose) return;
      renderCurrentGlucose(latestReading);
    });

    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function refresh() {
    fetch('/api/v1/entries/sgv.json?count=60', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (entries) {
        var readings = sortedReadings(entries);
        latestReading = readings[0] || null;
        renderCurrentGlucose(readings[0]);
        render(calculateRows(readings));
      })
      .catch(function () { render([]); });
  }

  function start() {
    observeCurrentGlucose();
    refresh();
    window.setInterval(refresh, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
