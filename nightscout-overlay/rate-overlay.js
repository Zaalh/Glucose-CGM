(function () {
  'use strict';

  var MGDL_PER_MMOL = 18.0182;
  var WINDOWS_MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 30, 45, 60, 90, 120];
  var MAX_BASELINE_DIFF_MS = 45000;
  var POLL_MS = 30000;
  var COMPACT_WINDOWS_MINUTES = [1, 2, 3, 4, 5, 10, 15, 30];
  var RATE_MODE_KEY = 'cgm-rate-overlay-mode';
  var latestReading = null;
  var updatingCurrentGlucose = false;
  var currentRows = [];

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
    if (rateMgdlPerMin <= -3) return 'very-fast-down';
    if (rateMgdlPerMin <= -2) return 'fast-down';
    if (rateMgdlPerMin < -1) return 'down';
    if (rateMgdlPerMin >= 3) return 'very-fast-up';
    if (rateMgdlPerMin >= 2) return 'fast-up';
    if (rateMgdlPerMin > 1) return 'up';
    return 'flat';
  }

  function trendLabel(rateMgdlPerMin) {
    if (rateMgdlPerMin <= -3) return 'daalt zeer snel';
    if (rateMgdlPerMin <= -2) return 'daalt snel';
    if (rateMgdlPerMin < -1) return 'daalt';
    if (rateMgdlPerMin >= 3) return 'stijgt zeer snel';
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
      '#cgm-rate-overlay{position:absolute!important;z-index:9999!important;top:174px;left:50%;transform:translateX(-50%);display:grid;grid-template-columns:repeat(4,minmax(96px,1fr));gap:4px;width:min(98vw,620px);font-family:Arial,Helvetica,sans-serif;pointer-events:none;align-items:start}',
      '#cgm-rate-overlay.all{grid-template-columns:repeat(7,minmax(72px,1fr));width:min(98vw,1040px)}',
      '#cgm-rate-toggle{position:absolute!important;z-index:10000!important;left:50%;transform:translateX(-50%);top:174px;border:1px solid rgba(255,255,255,.25);border-radius:5px;background:rgba(0,0,0,.72);color:#ddd;font:700 11px Arial,Helvetica,sans-serif;padding:5px 8px;cursor:pointer}',
      '#cgm-rate-toggle:hover{background:rgba(30,30,30,.9);color:#fff}',
      '.primary,.bgStatus.current{overflow:visible!important}',
      '#cgm-rate-overlay .rate-card{border:1px solid rgba(255,255,255,.22);border-radius:5px;background:rgba(9,9,9,.82);color:#ddd;padding:4px 5px;text-align:left;box-shadow:0 -1px 6px rgba(0,0,0,.45);min-width:0;min-height:38px;box-sizing:border-box}',
      '#cgm-rate-overlay .rate-card.primary{border-width:1px;border-bottom-width:2px}',
      '#cgm-rate-overlay .rate-window{display:block;font-size:8px;line-height:1;text-transform:uppercase;opacity:.9;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#cgm-rate-overlay .rate-main{display:block;font-family:monospace;font-size:12px;font-weight:900;line-height:1.12;letter-spacing:0;margin-top:2px}',
      '#cgm-rate-overlay .rate-card.primary .rate-main{font-size:12px}',
      '#cgm-rate-overlay .rate-sub{display:block;font-size:7px;line-height:1.1;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-rate-overlay .very-fast-down{color:#fff7ed;border-color:#fb7185;background:linear-gradient(135deg,#f59e0b 0%,#e11d48 100%);text-shadow:0 1px 2px rgba(0,0,0,.45)}',
      '#cgm-rate-overlay .fast-down{color:#2f1600;border-color:#f59e0b;background:linear-gradient(135deg,#ffe08a 0%,#fb923c 100%)}',
      '#cgm-rate-overlay .down{color:#2f1600;border-color:#facc15;background:linear-gradient(135deg,#fff3a3 0%,#fbbf24 100%)}',
      '#cgm-rate-overlay .flat{color:#063b1d;border-color:#4ade80;background:linear-gradient(135deg,#bbf7d0 0%,#4ade80 100%)}',
      '#cgm-rate-overlay .up{color:#3b0764;border-color:#c084fc;background:linear-gradient(135deg,#ead6ff 0%,#c084fc 100%)}',
      '#cgm-rate-overlay .fast-up{color:#faf5ff;border-color:#a855f7;background:linear-gradient(135deg,#c084fc 0%,#9333ea 100%);text-shadow:0 1px 2px rgba(0,0,0,.42)}',
      '#cgm-rate-overlay .very-fast-up{color:#faf5ff;border-color:#7e22ce;background:linear-gradient(135deg,#9333ea 0%,#581c87 100%);text-shadow:0 1px 2px rgba(0,0,0,.52)}',
      '#cgm-rate-overlay .missing{color:#8a8a8a;border-color:rgba(255,255,255,.14);background:rgba(0,0,0,.28)}',
      '@media(max-width:700px){#cgm-rate-overlay,#cgm-rate-overlay.all{grid-template-columns:repeat(4,minmax(72px,1fr));gap:3px;width:98vw}#cgm-rate-overlay .rate-card{padding:4px 5px 3px;min-height:38px}#cgm-rate-overlay .rate-main,#cgm-rate-overlay .rate-card.primary .rate-main{font-size:12px}#cgm-rate-overlay .rate-sub{font-size:7px}}'
    ].join('');
    document.head.appendChild(style);
  }

  function ensureContainer() {
    var existing = document.getElementById('cgm-rate-overlay');
    if (existing) return existing;

    var container = document.createElement('div');
    container.id = 'cgm-rate-overlay';
    container.setAttribute('aria-label', 'Glucose snelheid per minuut');
    document.body.appendChild(container);
    return container;
  }

  function ensureToggle() {
    var existing = document.getElementById('cgm-rate-toggle');
    if (existing) return existing;

    var button = document.createElement('button');
    button.id = 'cgm-rate-toggle';
    button.type = 'button';
    button.addEventListener('click', function () {
      var nextMode = getMode() === 'compact' ? 'all' : getMode() === 'all' ? 'off' : 'compact';
      localStorage.setItem(RATE_MODE_KEY, nextMode);
      render(currentRows);
    });
    document.body.appendChild(button);
    return button;
  }

  function getMode() {
    var mode = localStorage.getItem(RATE_MODE_KEY);
    return mode === 'all' || mode === 'off' ? mode : 'compact';
  }

  function visibleRows(rows) {
    if (getMode() === 'all') return rows;
    return rows.filter(function (row) {
      var minutes = Number.parseInt(row.label, 10);
      return COMPACT_WINDOWS_MINUTES.indexOf(minutes) !== -1;
    });
  }

  function updateToggleLabel() {
    var button = ensureToggle();
    var mode = getMode();
    button.textContent = mode === 'compact' ? 'compact' : mode === 'all' ? 'alles' : 'uit';
  }

  function positionContainer() {
    var container = ensureContainer();
    var button = ensureToggle();
    var chart = document.querySelector('#chartContainer');
    if (!container || !chart) return;

    var chartTop = chart.getBoundingClientRect().top + window.scrollY;
    var buttonHeight = button.getBoundingClientRect().height || 24;
    var buttonTop = chartTop - buttonHeight - 6;
    var containerTop = chartTop + 4;
    button.style.top = Math.max(0, Math.round(buttonTop)) + 'px';
    container.style.top = Math.max(0, Math.round(containerTop)) + 'px';
  }

  function render(rows) {
    ensureStyles();
    var container = ensureContainer();
    if (!container) return;
    currentRows = rows;
    updateToggleLabel();
    positionContainer();

    if (getMode() === 'off') {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'grid';
    container.classList.toggle('all', getMode() === 'all');
    rows = visibleRows(rows);

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
    window.requestAnimationFrame(positionContainer);
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
    fetch('/api/v1/entries/sgv.json?count=240', { cache: 'no-store' })
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
    window.addEventListener('resize', positionContainer);
    window.setTimeout(positionContainer, 1000);
    window.setTimeout(positionContainer, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
