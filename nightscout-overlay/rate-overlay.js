(function () {
  'use strict';

  var MGDL_PER_MMOL = 18.0182;
  var WINDOWS_MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 20, 30, 45, 60, 90, 120];
  var MAX_BASELINE_DIFF_MS = 45000;
  var POLL_MS = 30000;
  var COMPACT_WINDOWS_MINUTES = [1, 2, 3, 4, 5, 10, 15, 30];
  var RATE_MODE_KEY = 'cgm-rate-overlay-mode';
  var SOUND_OFF_KEY = 'cgm-nightscout-sound-off';
  var latestReading = null;
  var updatingCurrentGlucose = false;
  var currentRows = [];
  var currentHypoRisk = null;
  var chartReadingsAsc = [];

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
    if (rateMgdlPerMin < -0.5) return 'slow-down';
    if (rateMgdlPerMin >= 3) return 'very-fast-up';
    if (rateMgdlPerMin >= 2) return 'fast-up';
    if (rateMgdlPerMin > 1) return 'up';
    if (rateMgdlPerMin > 0.5) return 'slow-up';
    return 'flat';
  }

  function trendLabel(rateMgdlPerMin) {
    if (rateMgdlPerMin <= -3) return 'daalt zeer snel';
    if (rateMgdlPerMin <= -2) return 'daalt snel';
    if (rateMgdlPerMin < -1) return 'daalt';
    if (rateMgdlPerMin < -0.5) return 'daalt rustig';
    if (rateMgdlPerMin >= 3) return 'stijgt zeer snel';
    if (rateMgdlPerMin >= 2) return 'stijgt snel';
    if (rateMgdlPerMin > 1) return 'stijgt';
    if (rateMgdlPerMin > 0.5) return 'stijgt rustig';
    return 'stabiel';
  }

  function trendArrow(rateMgdlPerMin) {
    if (rateMgdlPerMin <= -3) return '⇊';
    if (rateMgdlPerMin <= -1) return '↓';
    if (rateMgdlPerMin < -0.5) return '↘';
    if (rateMgdlPerMin >= 3) return '⇈';
    if (rateMgdlPerMin >= 1) return '↑';
    if (rateMgdlPerMin > 0.5) return '↗';
    return '→';
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

  function formatClock(timeMs) {
    var date = new Date(timeMs);
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  }

  function rateBetween(fromEntry, toEntry) {
    if (!fromEntry || !toEntry) return null;
    var fromTime = readingTime(fromEntry);
    var toTime = readingTime(toEntry);
    var minutes = (toTime - fromTime) / 60000;
    if (!Number.isFinite(minutes) || minutes <= 0) return null;

    var delta = mmol(Number(toEntry.sgv) - Number(fromEntry.sgv));
    return {
      minutes: minutes,
      delta: delta,
      rate: delta / minutes
    };
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
        fromMmol: mmol(Number(baseline.sgv)),
        toMmol: mmol(Number(latest.sgv)),
        arrow: trendArrow(rateMgdl),
        css: trendClass(rateMgdl),
        text: trendLabel(rateMgdl)
      };
    });
  }

  function getPrimaryRate(rows) {
    return rows.filter(function (row) {
      return row && !row.missing && Number.isFinite(row.rateMmol) && row.actualMinutes <= 5;
    }).sort(function (a, b) {
      return a.actualMinutes - b.actualMinutes;
    })[0] || null;
  }

  function calculateHypoRisk(readings, rows) {
    var latest = readings[0];
    if (!latest || !Number.isFinite(Number(latest.sgv))) return null;

    var valueMmol = mmol(Number(latest.sgv));
    var primaryRate = getPrimaryRate(rows);
    var rateMmol = primaryRate ? primaryRate.rateMmol : 0;
    var minutesToHypo = rateMmol < -0.01 ? (valueMmol - 3.9) / Math.abs(rateMmol) : null;
    var minutesToLow = rateMmol < -0.01 ? (valueMmol - 3.8) / Math.abs(rateMmol) : null;
    var minutesToUrgent = rateMmol < -0.01 ? (valueMmol - 3.0) / Math.abs(rateMmol) : null;
    var predictedHypoSoon = minutesToHypo !== null && minutesToHypo >= 0 && minutesToHypo <= 20;
    var predictedUrgentSoon = minutesToUrgent !== null && minutesToUrgent >= 0 && minutesToUrgent <= 20;

    if (valueMmol < 3.0 || predictedUrgentSoon) {
      return {
        css: 'urgent',
        title: valueMmol < 3.0 ? 'HYPO URGENT' : 'URGENT RISICO',
        detail: valueMmol < 3.0 ? valueMmol.toFixed(2) + ' mmol/L' : '3.8 ±' + Math.ceil(minutesToLow) + 'm · 3.0 ±' + Math.ceil(minutesToUrgent) + 'm',
        rate: rateMmol
      };
    }

    if (valueMmol < 3.9) {
      return {
        css: 'hypo',
        title: 'HYPO NU',
        detail: valueMmol.toFixed(2) + ' mmol/L',
        rate: rateMmol
      };
    }

    if (valueMmol < 4.5 || predictedHypoSoon) {
      var hypoDetail = 'richting 3.9 in ±' + Math.ceil(minutesToHypo) + ' min';
      if (predictedHypoSoon && minutesToUrgent !== null && minutesToUrgent >= 0) {
        hypoDetail = '3.9 ±' + Math.ceil(minutesToHypo) + 'm · 3.0 ±' + Math.ceil(minutesToUrgent) + 'm';
      }

      return {
        css: predictedHypoSoon && minutesToHypo <= 10 ? 'warning' : 'watch',
        title: predictedHypoSoon ? 'HYPO RISICO' : 'LET OP LAAG',
        detail: predictedHypoSoon ? hypoDetail : valueMmol.toFixed(2) + ' mmol/L',
        rate: rateMmol
      };
    }

    return {
      css: 'ok',
      title: 'HYPO OK',
      detail: valueMmol.toFixed(2) + ' mmol/L',
      rate: rateMmol
    };
  }

  function ensureStyles() {
    if (document.getElementById('cgm-rate-overlay-style')) return;
    var style = document.createElement('style');
    style.id = 'cgm-rate-overlay-style';
    style.textContent = [
      '#cgm-rate-overlay{position:absolute!important;z-index:9999!important;top:174px;left:50%;transform:translateX(-50%);display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:6px;width:min(98vw,860px);font-family:Arial,Helvetica,sans-serif;pointer-events:none;align-items:start}',
      '#cgm-rate-overlay.all{grid-template-columns:repeat(7,minmax(72px,1fr));width:min(98vw,1040px)}',
      '#cgm-hypo-alert{position:absolute!important;z-index:10000!important;left:50%;transform:translateX(-50%);top:174px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:max-content;max-width:min(560px,86vw);min-width:210px;border:1px solid rgba(255,255,255,.24);border-radius:5px;padding:5px 10px;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;box-shadow:0 1px 8px rgba(0,0,0,.5)}',
      '#cgm-hypo-alert .hypo-line{display:flex;align-items:center;justify-content:center;gap:8px;white-space:nowrap}',
      '#cgm-hypo-alert .hypo-title{font-size:11px;font-weight:900;line-height:1;text-transform:uppercase;white-space:nowrap}',
      '#cgm-hypo-alert .hypo-detail{font-size:11px;font-weight:700;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-hypo-alert .hypo-rate{font-family:monospace;font-size:10px;font-weight:900;line-height:1;white-space:nowrap;opacity:.9}',
      '#cgm-hypo-alert .hypo-average{font-family:monospace;font-size:10px;font-weight:900;line-height:1;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert.ok{color:#063b1d;border-color:#4ade80;background:linear-gradient(135deg,#bbf7d0 0%,#4ade80 100%)}',
      '#cgm-hypo-alert.watch{color:#2f1600;border-color:#facc15;background:linear-gradient(135deg,#fff3a3 0%,#fbbf24 100%)}',
      '#cgm-hypo-alert.warning{color:#2f1600;border-color:#f59e0b;background:linear-gradient(135deg,#ffe08a 0%,#fb923c 100%)}',
      '#cgm-hypo-alert.hypo,#cgm-hypo-alert.urgent{color:#fff7ed;border-color:#fb7185;background:linear-gradient(135deg,#f59e0b 0%,#e11d48 100%);text-shadow:0 1px 2px rgba(0,0,0,.45)}',
      '#cgm-point-rate-tooltip{position:absolute!important;z-index:10001!important;display:none;min-width:178px;border:1px solid rgba(255,255,255,.22);border-radius:5px;background:rgba(0,0,0,.86);color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;padding:7px 8px;box-shadow:0 2px 12px rgba(0,0,0,.55);pointer-events:none}',
      '#cgm-point-rate-tooltip .pt-head{display:flex;justify-content:space-between;gap:12px;font-size:12px;font-weight:900;line-height:1.15;margin-bottom:4px}',
      '#cgm-point-rate-tooltip .pt-row{display:flex;justify-content:space-between;gap:12px;font-size:11px;font-weight:700;line-height:1.25;white-space:nowrap}',
      '#cgm-point-rate-tooltip .pt-rate{font-family:monospace;font-weight:900}',
      '#cgm-current-average-rate{display:block!important;width:max-content;margin-top:4px;font-size:13px!important;line-height:1.2!important;padding:3px 7px!important;background:rgba(0,0,0,.72)!important;color:#f3f4f6!important;border:1px solid rgba(255,255,255,.2)!important;border-radius:5px!important;font-family:Arial,Helvetica,sans-serif!important;font-weight:900!important}',
      '#cgm-rate-toggle{position:absolute!important;z-index:10000!important;left:50%;transform:translateX(-50%);top:174px;border:1px solid rgba(255,255,255,.25);border-radius:5px;background:rgba(0,0,0,.72);color:#ddd;font:700 11px Arial,Helvetica,sans-serif;padding:5px 8px;cursor:pointer}',
      '#cgm-rate-toggle:hover{background:rgba(30,30,30,.9);color:#fff}',
      '.primary,.bgStatus.current{overflow:visible!important}',
      '#cgm-rate-overlay .rate-card{position:relative;border:1px solid rgba(255,255,255,.22);border-radius:5px;background:rgba(9,9,9,.82);color:#ddd;padding:5px 25px 5px 7px;text-align:left;box-shadow:0 -1px 6px rgba(0,0,0,.45);min-width:0;min-height:46px;box-sizing:border-box}',
      '#cgm-rate-overlay .rate-card.primary{border-width:1px;border-bottom-width:2px}',
      '#cgm-rate-overlay .rate-window{display:block;font-size:9px;line-height:1;text-transform:uppercase;opacity:.9;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#cgm-rate-overlay .rate-main{display:block;font-family:monospace;font-size:15px;font-weight:900;line-height:1.12;letter-spacing:0;margin-top:2px}',
      '#cgm-rate-overlay .rate-card.primary .rate-main{font-size:15px}',
      '#cgm-rate-overlay .rate-arrow{position:absolute;right:7px;top:50%;transform:translateY(-50%);font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:900;line-height:1}',
      '#cgm-rate-overlay .rate-sub{display:block;font-size:9px;line-height:1.12;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-rate-overlay .very-fast-down{color:#fff7ed;border-color:#fb7185;background:linear-gradient(135deg,#f59e0b 0%,#e11d48 100%);text-shadow:0 1px 2px rgba(0,0,0,.45)}',
      '#cgm-rate-overlay .fast-down{color:#2f1600;border-color:#f59e0b;background:linear-gradient(135deg,#ffe08a 0%,#fb923c 100%)}',
      '#cgm-rate-overlay .down{color:#2f1600;border-color:#facc15;background:linear-gradient(135deg,#fff3a3 0%,#fbbf24 100%)}',
      '#cgm-rate-overlay .slow-down{color:#063b1d;border-color:#86efac;background:linear-gradient(135deg,#c7f9d4 0%,#fef08a 100%)}',
      '#cgm-rate-overlay .flat{color:#063b1d;border-color:#4ade80;background:linear-gradient(135deg,#bbf7d0 0%,#4ade80 100%)}',
      '#cgm-rate-overlay .slow-up{color:#064e3b;border-color:#86efac;background:linear-gradient(135deg,#bbf7d0 0%,#ddd6fe 100%)}',
      '#cgm-rate-overlay .up{color:#3b0764;border-color:#c084fc;background:linear-gradient(135deg,#ead6ff 0%,#c084fc 100%)}',
      '#cgm-rate-overlay .fast-up{color:#faf5ff;border-color:#a855f7;background:linear-gradient(135deg,#c084fc 0%,#9333ea 100%);text-shadow:0 1px 2px rgba(0,0,0,.42)}',
      '#cgm-rate-overlay .very-fast-up{color:#faf5ff;border-color:#7e22ce;background:linear-gradient(135deg,#9333ea 0%,#581c87 100%);text-shadow:0 1px 2px rgba(0,0,0,.52)}',
      '#cgm-rate-overlay .missing{color:#8a8a8a;border-color:rgba(255,255,255,.14);background:rgba(0,0,0,.28)}',
      '@media(max-width:700px){#cgm-rate-overlay,#cgm-rate-overlay.all{grid-template-columns:repeat(4,minmax(72px,1fr));gap:3px;width:98vw}#cgm-hypo-alert{left:50%;right:auto;transform:translateX(-50%);max-width:94vw;min-width:0;gap:3px;padding:5px 7px}#cgm-hypo-alert .hypo-line{gap:5px}#cgm-hypo-alert .hypo-title,#cgm-hypo-alert .hypo-detail{font-size:10px}#cgm-hypo-alert .hypo-rate,#cgm-hypo-alert .hypo-average{font-size:9px}#cgm-rate-overlay .rate-card{padding:4px 19px 3px 5px;min-height:42px}#cgm-rate-overlay .rate-window{font-size:8px}#cgm-rate-overlay .rate-main,#cgm-rate-overlay .rate-card.primary .rate-main{font-size:13px}#cgm-rate-overlay .rate-arrow{right:5px;font-size:15px}#cgm-rate-overlay .rate-sub{font-size:7px}}'
    ].join('');
    document.head.appendChild(style);
  }

  function soundIsOff() {
    if (localStorage.getItem(SOUND_OFF_KEY) === null) {
      localStorage.setItem(SOUND_OFF_KEY, '1');
    }
    return localStorage.getItem(SOUND_OFF_KEY) !== '0';
  }

  function setAlarmAudioMuted(muted) {
    Array.prototype.forEach.call(document.querySelectorAll('audio.alarm, .audio.alarms audio'), function (audio) {
      audio.muted = muted;
      audio.volume = muted ? 0 : 1;
      if (muted) {
        try { audio.pause(); } catch (error) {}
      }
    });
  }

  function setBrowserAlarmCheckboxes(enabled) {
    [
      'alarm-urgenthigh-browser',
      'alarm-high-browser',
      'alarm-low-browser',
      'alarm-urgentlow-browser',
      'alarm-timeagowarn-browser',
      'alarm-timeagourgent-browser',
      'alarm-pumpbatterylow-browser'
    ].forEach(function (id) {
      var checkbox = document.getElementById(id);
      if (checkbox && checkbox.checked !== enabled) {
        checkbox.checked = enabled;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  function applySoundDefault() {
    if (!soundIsOff()) {
      setAlarmAudioMuted(false);
      return;
    }

    setBrowserAlarmCheckboxes(false);
    setAlarmAudioMuted(true);
  }

  function installSoundDefaultOff() {
    if (document.body.dataset.cgmSoundDefaultOff === '1') return;
    document.body.dataset.cgmSoundDefaultOff = '1';

    var originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (soundIsOff() && (this.matches('audio.alarm') || this.closest('.audio.alarms'))) {
        try { this.pause(); } catch (error) {}
        return Promise.resolve();
      }
      return originalPlay.apply(this, arguments);
    };

    document.addEventListener('click', function (event) {
      if (event.target && event.target.closest && event.target.closest('#testAlarms')) {
        localStorage.setItem(SOUND_OFF_KEY, '0');
        setAlarmAudioMuted(false);
      }
    }, true);

    document.addEventListener('change', function (event) {
      var target = event.target;
      if (target && target.id && /^alarm-.*-browser$/.test(target.id) && target.checked) {
        localStorage.setItem(SOUND_OFF_KEY, '0');
        setAlarmAudioMuted(false);
      }
    }, true);

    applySoundDefault();
    window.setTimeout(applySoundDefault, 1000);
    window.setTimeout(applySoundDefault, 3000);
    window.setInterval(applySoundDefault, 5000);
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

  function ensureHypoAlert() {
    var existing = document.getElementById('cgm-hypo-alert');
    if (existing) return existing;

    var alert = document.createElement('div');
    alert.id = 'cgm-hypo-alert';
    alert.setAttribute('aria-label', 'Hypoglykemie waarschuwing');
    document.body.appendChild(alert);
    return alert;
  }

  function ensurePointTooltip() {
    var existing = document.getElementById('cgm-point-rate-tooltip');
    if (existing) return existing;

    var tooltip = document.createElement('div');
    tooltip.id = 'cgm-point-rate-tooltip';
    tooltip.setAttribute('aria-label', 'Glucose verandering rond meetpunt');
    document.body.appendChild(tooltip);
    return tooltip;
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

  function renderHypoAlert(risk) {
    var alert = ensureHypoAlert();
    currentHypoRisk = risk;
    if (!risk) {
      alert.style.display = 'none';
      return;
    }

    alert.style.display = 'flex';
    alert.className = risk.css;
    alert.innerHTML = [
      '<div class="hypo-line">',
      '<span class="hypo-title">', risk.title, '</span>',
      '<span class="hypo-detail">', risk.detail, '</span>',
      '<span class="hypo-rate">', signed(risk.rate, 3), '/min</span>',
      '</div>',
      '<div class="hypo-line"><span class="hypo-average">', averageRateText(true), '</span></div>'
    ].join('');
  }

  function positionContainer() {
    var container = ensureContainer();
    var button = ensureToggle();
    var alert = ensureHypoAlert();
    var chart = document.querySelector('#chartContainer');
    if (!container || !chart) return;

    var chartTop = chart.getBoundingClientRect().top + window.scrollY;
    var buttonHeight = button.getBoundingClientRect().height || 24;
    var buttonTop = chartTop - buttonHeight - 6;
    var containerTop = chartTop + 4;
    button.style.top = Math.max(0, Math.round(buttonTop)) + 'px';
    alert.style.top = '8px';
    container.style.top = Math.max(0, Math.round(containerTop)) + 'px';
  }

  function render(rows) {
    ensureStyles();
    var container = ensureContainer();
    if (!container) return;
    currentRows = rows;
    updateToggleLabel();
    renderHypoAlert(currentHypoRisk);
    removeCurrentAverageRate();
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
        '<span class="rate-arrow">', row.arrow, '</span>',
        '<span class="rate-main">', signed(row.rateMmol, 3), '</span>',
        '<span class="rate-sub">', row.fromMmol.toFixed(2), '→', row.toMmol.toFixed(2), ' · Δ ', signed(row.deltaMmol, 2), '</span>',
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

  function removeCurrentAverageRate() {
    var existing = document.getElementById('cgm-current-average-rate');
    if (existing) existing.remove();
  }

  function averageRateText(withSpeedWord) {
    var usableRows = currentRows.filter(function (row) {
      return row && !row.missing && Number.isFinite(row.rateMmol) && row.actualMinutes <= 15;
    });
    if (!usableRows.length) return '';

    var avgRate = usableRows.reduce(function (sum, row) { return sum + row.rateMmol; }, 0) / usableRows.length;
    var label = avgRate < -0.01 ? 'gem. daling' : avgRate > 0.01 ? 'gem. stijging' : 'gem. stabiel';
    if (withSpeedWord) label += ' snelheid';
    return label + ' ' + signed(avgRate, 3) + '/min';
  }

  function pointIndexFromDot(dot) {
    var dots = Array.prototype.slice.call(document.querySelectorAll('circle.entry-dot')).filter(function (el) {
      return Number.isFinite(Number(el.getAttribute('cx')));
    }).sort(function (a, b) {
      return Number(a.getAttribute('cx')) - Number(b.getAttribute('cx'));
    });
    var dotIndex = dots.indexOf(dot);
    if (dotIndex < 0 || !chartReadingsAsc.length) return -1;

    var offset = Math.max(0, chartReadingsAsc.length - dots.length);
    return offset + dotIndex;
  }

  function showPointTooltip(dot, event) {
    var index = pointIndexFromDot(dot);
    var entry = chartReadingsAsc[index];
    if (!entry) return;

    var prev = chartReadingsAsc[index - 1] || null;
    var next = chartReadingsAsc[index + 1] || null;
    var prevRate = rateBetween(prev, entry);
    var nextRate = rateBetween(entry, next);
    var tooltip = ensurePointTooltip();
    var currentValue = mmol(Number(entry.sgv)).toFixed(2);

    function rateText(rate) {
      if (!rate) return '--';
      return signed(rate.delta, 2) + ' / ' + signed(rate.rate, 3) + '/min';
    }

    tooltip.innerHTML = [
      '<div class="pt-head"><span>BG ', currentValue, '</span><span>', formatClock(readingTime(entry)), '</span></div>',
      '<div class="pt-row"><span>vorige</span><span class="pt-rate">', rateText(prevRate), '</span></div>',
      '<div class="pt-row"><span>volgende</span><span class="pt-rate">', rateText(nextRate), '</span></div>'
    ].join('');

    var x = event.pageX || (dot.getBoundingClientRect().left + window.scrollX);
    var y = event.pageY || (dot.getBoundingClientRect().top + window.scrollY);
    tooltip.style.display = 'block';
    tooltip.style.left = Math.min(window.scrollX + window.innerWidth - 205, Math.max(window.scrollX + 6, x + 12)) + 'px';
    tooltip.style.top = Math.max(window.scrollY + 6, y - 54) + 'px';
  }

  function installPointTooltip() {
    if (document.body.dataset.cgmPointTooltip === '1') return;
    document.body.dataset.cgmPointTooltip = '1';

    document.addEventListener('click', function (event) {
      var dot = event.target && event.target.closest ? event.target.closest('circle.entry-dot') : null;
      var tooltip = ensurePointTooltip();
      if (!dot) {
        tooltip.style.display = 'none';
        return;
      }
      showPointTooltip(dot, event);
    }, true);
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
    fetch('/api/v1/entries/sgv.json?count=2000', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (entries) {
        var readings = sortedReadings(entries);
        chartReadingsAsc = readings.slice().reverse();
        var rows = calculateRows(readings);
        latestReading = readings[0] || null;
        renderCurrentGlucose(readings[0]);
        currentHypoRisk = calculateHypoRisk(readings, rows);
        render(rows);
      })
      .catch(function () { render([]); });
  }

  function start() {
    installSoundDefaultOff();
    installPointTooltip();
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
