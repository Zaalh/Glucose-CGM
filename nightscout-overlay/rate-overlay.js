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
      '#cgm-rate-overlay{position:absolute;z-index:50;top:174px;left:50%;transform:translateX(-50%);display:grid;grid-template-columns:repeat(8,minmax(64px,1fr));gap:4px;width:min(98vw,1040px);font-family:Arial,Helvetica,sans-serif;pointer-events:none;align-items:end}',
      '.primary,.bgStatus.current{overflow:visible!important}',
      '#cgm-rate-overlay .rate-card{border:1px solid rgba(255,255,255,.22);border-bottom-width:2px;border-radius:6px 6px 0 0;background:rgba(9,9,9,.82);color:#ddd;padding:5px 6px 4px;text-align:left;box-shadow:0 -1px 4px rgba(0,0,0,.22);min-width:0;min-height:43px;box-sizing:border-box}',
      '#cgm-rate-overlay .rate-card.primary{border-width:1px;border-bottom-width:2px}',
      '#cgm-rate-overlay .rate-window{display:block;font-size:9px;line-height:1;text-transform:uppercase;opacity:.78;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#cgm-rate-overlay .rate-main{display:block;font-family:monospace;font-size:14px;font-weight:800;line-height:1.12;letter-spacing:0;margin-top:2px}',
      '#cgm-rate-overlay .rate-card.primary .rate-main{font-size:14px}',
      '#cgm-rate-overlay .rate-sub{display:block;font-size:8px;line-height:1.1;opacity:.86;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-rate-overlay .very-fast-down{color:#e0f2fe;border-color:#0ea5e9;background:rgba(7,89,133,.96)}',
      '#cgm-rate-overlay .fast-down{color:#7dd3fc;border-color:#38bdf8;background:rgba(8,47,73,.86)}',
      '#cgm-rate-overlay .down{color:#bae6fd;border-color:#0284c7;background:rgba(12,74,110,.68)}',
      '#cgm-rate-overlay .flat{color:#d9d9d9;border-color:rgba(255,255,255,.25)}',
      '#cgm-rate-overlay .up{color:#fed7aa;border-color:#fb923c;background:rgba(124,45,18,.66)}',
      '#cgm-rate-overlay .fast-up{color:#fdba74;border-color:#f97316;background:rgba(154,52,18,.86)}',
      '#cgm-rate-overlay .very-fast-up{color:#ffedd5;border-color:#ea580c;background:rgba(194,65,12,.96)}',
      '#cgm-rate-overlay .missing{color:#8a8a8a;border-color:rgba(255,255,255,.14);background:rgba(0,0,0,.28)}',
      '@media(max-width:700px){#cgm-rate-overlay{grid-template-columns:repeat(4,minmax(66px,1fr));gap:3px;width:98vw}#cgm-rate-overlay .rate-card{padding:4px 5px 3px;min-height:39px}#cgm-rate-overlay .rate-main,#cgm-rate-overlay .rate-card.primary .rate-main{font-size:13px}#cgm-rate-overlay .rate-sub{font-size:8px}}'
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

  function positionContainer() {
    var container = ensureContainer();
    var chart = document.querySelector('#chartContainer');
    if (!container || !chart) return;

    var chartTop = chart.getBoundingClientRect().top + window.scrollY;
    container.style.top = Math.max(0, Math.round(chartTop)) + 'px';
  }

  function render(rows) {
    ensureStyles();
    var container = ensureContainer();
    if (!container) return;
    positionContainer();

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
