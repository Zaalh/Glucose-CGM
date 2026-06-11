(function () {
  'use strict';

  var MGDL_PER_MMOL = 18.0182;
  var WINDOWS_MINUTES = Array.from({ length: 60 }, function (_, index) { return index + 1; }).concat([65, 70, 75, 80, 85, 90, 120]);
  var MAX_BASELINE_DIFF_MS = 75000;
  var POLL_MS = 30000;
  var OVERLAY_ENTRY_COUNT = 1600;
  var COMPACT_WINDOWS_MINUTES = [1, 2, 3, 4, 5, 10, 15, 30];
  var CLASSIC_WINDOWS_MINUTES = [1, 2, 3, 4, 5, 10, 15, 20, 30, 45, 60, 90, 120];
  var RATE_MODE_KEY = 'cgm-rate-overlay-mode';
  var RATE_VIEW_KEY = 'cgm-rate-overlay-view';
  var RATE_CALC_KEY = 'cgm-rate-overlay-calc';
  var SOUND_OFF_KEY = 'cgm-nightscout-sound-off';
  var ESTIMATE_LINE_CLASS = 'cgm-estimated-glucose-line';
  var ESTIMATE_GAP_MIN_MS = 150000;
  var ESTIMATE_OPEN_MAX_MS = 1200000;
  var ESTIMATE_PIXEL_GAP_MIN = 3;
  var MIN_REFRESH_MS = 5000;
  var latestReading = null;
  var updatingCurrentGlucose = false;
  var currentRows = [];
  var currentReadings = [];
  var selectedReadingTime = null;
  var currentHypoRisk = null;
  var currentPatternCorrection = null;
  var FORECAST_CALIBRATION_KEY = 'cgm-forecast-calibration-v1';
  var refreshTimer = null;
  var PEAK_DROP_THRESHOLDS = {
    watch: { minDrop: 1.4, minRate: 0.05, maxMinutes: 75 },
    high: { minDrop: 1.9, minRate: 0.07, maxMinutes: 60 },
    urgent: { minDrop: 2.6, minRate: 0.09, maxMinutes: 45 }
  };
  var chartReadingsAsc = [];
  var estimateRenderTimer = null;
  var chartObserver = null;
  var observedChart = null;
  var latestDbPrediction = null;
  var refreshInFlight = false;
  var pendingRefresh = false;
  var lastRefreshStartedAt = 0;
  var lastObservedCurrentText = null;

  function mmol(valueMgdl) {
    return valueMgdl / MGDL_PER_MMOL;
  }

  function formatCurrentMmol(entry) {
    if (!entry || !Number.isFinite(Number(entry.sgv))) return null;
    return mmol(Number(entry.sgv)).toFixed(2);
  }

  // Reformat whatever number Nightscout already rendered to 2 decimals.
  // Used as a fallback when we don't yet have a fresh reading, so the
  // displayed value never falls back to Nightscout's 1-decimal format.
  function formatDisplayedMmol(text) {
    var num = parseFloat(text);
    if (!Number.isFinite(num)) return null;
    // Skip mg/dL values (whole numbers >= 36); mmol stays well below that.
    if (text.indexOf('.') === -1 && num >= 36) return null;
    return num.toFixed(2);
  }

  // Our own precise delta, computed from raw sgv values over a ~5-minute
  // window (the reading closest to 5 min before the latest). Returns mmol
  // as a number, or null when no matching baseline exists. This is the
  // exact change from raw data — not a re-padding of Nightscout's rounded
  // header delta.
  function computePreciseDelta() {
    var readings = currentReadings;
    if (!readings || readings.length < 2) return null;
    var latest = readings[0];
    if (!latest || !Number.isFinite(Number(latest.sgv))) return null;
    var baseline = findBaseline(readings, readingTime(latest), 5);
    if (!baseline) return null;
    return mmol(Number(latest.sgv) - Number(baseline.sgv));
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
    if (rateMgdlPerMin <= -3) return 'zeer snel';
    if (rateMgdlPerMin <= -2) return 'daalt snel';
    if (rateMgdlPerMin < -1) return 'daalt';
    if (rateMgdlPerMin < -0.5) return 'daalt rustig';
    if (rateMgdlPerMin >= 3) return 'zeer snel';
    if (rateMgdlPerMin >= 2) return 'stijgt snel';
    if (rateMgdlPerMin > 1) return 'stijgt';
    if (rateMgdlPerMin > 0.5) return 'stijgt rustig';
    return 'stabiel';
  }

  function trendArrow(rateMgdlPerMin) {
    if (rateMgdlPerMin <= -3) return '↓↓';
    if (rateMgdlPerMin <= -1) return '↓';
    if (rateMgdlPerMin < -0.5) return '↘';
    if (rateMgdlPerMin >= 3) return '↑↑';
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

  function calculateRows(readings, anchorEntry) {
    var latest = anchorEntry || readings[0];
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

  // Momentaan: elk vakje = de instantane snelheid op dat moment in het verleden
  // (de helling van díe ene minuut), als tijdlijn terug. 1M = nu, 2M = 1 min geleden, enz.
  function calculateMomentRows(readings, anchorEntry) {
    var latest = anchorEntry || readings[0];
    if (!latest) return [];
    var latestTime = readingTime(latest);
    return WINDOWS_MINUTES.map(function (minutesBack) {
      var target = latestTime - (minutesBack - 1) * 60000;
      var bestIdx = -1;
      var bestDiff = Infinity;
      for (var i = 0; i < readings.length; i++) {
        var time = readingTime(readings[i]);
        if (!Number.isFinite(time) || time > latestTime) continue;
        var diff = Math.abs(time - target);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      }
      if (bestIdx < 0 || bestDiff > MAX_BASELINE_DIFF_MS) {
        return { label: minutesBack + 'm', missing: true };
      }
      var pointEntry = readings[bestIdx];
      var prevEntry = readings[bestIdx + 1]; // één meting ouder
      var r = rateBetween(prevEntry, pointEntry);
      if (!r) return { label: minutesBack + 'm', missing: true };
      var rateMgdl = r.rate * MGDL_PER_MMOL;
      return {
        label: minutesBack + 'm',
        actualMinutes: r.minutes,
        rateMgdl: rateMgdl,
        rateMmol: r.rate,
        deltaMmol: r.delta,
        fromMmol: mmol(Number(prevEntry.sgv)),
        toMmol: mmol(Number(pointEntry.sgv)),
        arrow: trendArrow(rateMgdl),
        css: trendClass(rateMgdl),
        text: trendLabel(rateMgdl)
      };
    });
  }

  function computeRows(readings, anchorEntry) {
    return getCalcMode() === 'momentaan'
      ? calculateMomentRows(readings, anchorEntry)
      : calculateRows(readings, anchorEntry);
  }

  function getPrimaryRate(rows) {
    return rows.filter(function (row) {
      return row && !row.missing && Number.isFinite(row.rateMmol) && row.actualMinutes <= 5;
    }).sort(function (a, b) {
      return a.actualMinutes - b.actualMinutes;
    })[0] || null;
  }

  function getForecastRateMmol(rows) {
    var candidates = rows.filter(function (row) {
      return row && !row.missing && Number.isFinite(row.rateMmol) && row.actualMinutes <= 20;
    });
    if (!candidates.length) return null;

    // Groepeer per tijdband en middel bínnen elke band, daarna weeg de banden.
    // Anders tellen de ~5 korte vensters (1-5m) elk apart mee (5x 0.45) en domineert
    // 1-minuut-ruis de blend: een mini-opwaartse wiebel kan "stijgend" tonen terwijl
    // de trend duidelijk daalt.
    var bands = [
      { max: 5, w: 0.35, sum: 0, n: 0 },
      { max: 10, w: 0.30, sum: 0, n: 0 },
      { max: 15, w: 0.20, sum: 0, n: 0 },
      { max: 20, w: 0.15, sum: 0, n: 0 }
    ];
    candidates.forEach(function (row) {
      for (var bi = 0; bi < bands.length; bi++) {
        if (row.actualMinutes <= bands[bi].max) { bands[bi].sum += row.rateMmol; bands[bi].n += 1; break; }
      }
    });
    var totalW = 0;
    var rate = 0;
    bands.forEach(function (b) {
      if (b.n > 0) { rate += (b.sum / b.n) * b.w; totalW += b.w; }
    });
    if (totalW <= 0) return null;
    rate = rate / totalW;

    // Guardrail against single-window spikes.
    var sorted = candidates.map(function (r) { return r.rateMmol; }).sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    if (Math.abs(rate - median) > 0.06) {
      rate = median + (rate > median ? 0.06 : -0.06);
    }
    return rate;
  }

  function loadForecastCalibration() {
    try {
      var raw = localStorage.getItem(FORECAST_CALIBRATION_KEY);
      if (!raw) return { biasPerMin: 0, corrScale: 1, samples: 0 };
      var parsed = JSON.parse(raw);
      return {
        biasPerMin: Number.isFinite(parsed.biasPerMin) ? parsed.biasPerMin : 0,
        corrScale: Number.isFinite(parsed.corrScale) ? parsed.corrScale : 1,
        samples: Number.isFinite(parsed.samples) ? parsed.samples : 0
      };
    } catch (_err) {
      return { biasPerMin: 0, corrScale: 1, samples: 0 };
    }
  }

  function saveForecastCalibration(data) {
    try { localStorage.setItem(FORECAST_CALIBRATION_KEY, JSON.stringify(data)); } catch (_err) {}
  }

  function calibrateFromHistory(readings) {
    if (!readings || readings.length < 200) return;
    var points = readings.slice().sort(function (a, b) { return readingTime(a) - readingTime(b); });
    var start = Math.max(0, points.length - 1200);
    var horizons = [10, 15, 20, 30];
    var biasErrSum = 0;
    var biasWeight = 0;
    var corrScaleEstimates = [];

    for (var i = start; i < points.length; i++) {
      var anchor = points[i];
      var anchorTime = readingTime(anchor);
      if (!Number.isFinite(anchorTime)) continue;
      var contextDesc = points.slice(0, i + 1).reverse();
      var rows = calculateRows(contextDesc, anchor);
      var rate = getForecastRateMmol(rows);
      if (!Number.isFinite(rate)) continue;
      var signal = detectPeakDropSignal(contextDesc);
      var corrObj = computePatternCorrection(contextDesc, signal);
      var corr = corrObj ? corrObj.correction : 0;
      var base = mmol(Number(anchor.sgv));
      if (!Number.isFinite(base)) continue;

      horizons.forEach(function (h) {
        var target = points.find(function (p) {
          var t = readingTime(p);
          return Number.isFinite(t) && t >= anchorTime + h * 60000 - 45000 && t <= anchorTime + h * 60000 + 45000;
        });
        if (!target) return;
        var actual = mmol(Number(target.sgv));
        if (!Number.isFinite(actual)) return;
        var w = Math.min(1, h / 20);
        var trendOnly = base + rate * h;
        var predicted = Math.max(1.5, Math.min(33, trendOnly - corr * w));
        var err = actual - predicted;
        biasErrSum += err;
        biasWeight += h;

        if (corr > 0.05) {
          var implied = (trendOnly - actual) / (corr * w);
          if (Number.isFinite(implied) && implied >= 0 && implied <= 2.5) corrScaleEstimates.push(implied);
        }
      });
    }

    if (biasWeight <= 0) return;
    var biasPerMin = (biasErrSum / biasWeight);
    var corrScale = 1;
    if (corrScaleEstimates.length >= 20) {
      corrScaleEstimates.sort(function (a, b) { return a - b; });
      corrScale = corrScaleEstimates[Math.floor(corrScaleEstimates.length / 2)];
    }
    saveForecastCalibration({
      biasPerMin: Math.max(-0.03, Math.min(0.03, biasPerMin)),
      corrScale: Math.max(0.6, Math.min(1.6, corrScale)),
      samples: biasWeight
    });
  }

  function calculateHypoRisk(readings, rows) {
    var latest = readings[0];
    if (!latest || !Number.isFinite(Number(latest.sgv))) return null;

    var valueMmol = mmol(Number(latest.sgv));
    var blendedRate = getForecastRateMmol(rows);
    var primaryRate = getPrimaryRate(rows);
    var rateMmol = Number.isFinite(blendedRate) ? blendedRate : (primaryRate ? primaryRate.rateMmol : 0);
    var minutesToHypo = rateMmol < -0.01 ? (valueMmol - 3.9) / Math.abs(rateMmol) : null;
    var minutesToLow = rateMmol < -0.01 ? (valueMmol - 3.8) / Math.abs(rateMmol) : null;
    var minutesToUrgent = rateMmol < -0.01 ? (valueMmol - 3.0) / Math.abs(rateMmol) : null;
    var predictedHypoSoon = minutesToHypo !== null && minutesToHypo >= 0 && minutesToHypo <= 20;
    var predictedUrgentSoon = minutesToUrgent !== null && minutesToUrgent >= 0 && minutesToUrgent <= 20;
    var lowEta = minutesToLow !== null && minutesToLow <= 0 ? 'nu' : '±' + Math.ceil(minutesToLow) + 'm';
    var urgentEta = minutesToUrgent !== null && minutesToUrgent <= 0 ? 'nu' : '±' + Math.ceil(minutesToUrgent) + 'm';

    if (valueMmol < 3.0) {
      return {
        css: 'urgent',
        title: 'HYPO URGENT',
        detail: valueMmol.toFixed(2) + ' mmol/L',
        rate: rateMmol
      };
    }

    if (valueMmol < 3.9) {
      return {
        css: 'hypo',
        title: 'HYPO',
        detail: predictedUrgentSoon ? valueMmol.toFixed(2) + ' mmol/L · 3.8 ' + lowEta + ' · 3.0 ' + urgentEta : valueMmol.toFixed(2) + ' mmol/L',
        rate: rateMmol
      };
    }

    if (predictedUrgentSoon) {
      return {
        css: 'urgent',
        title: 'URGENT RISICO',
        detail: valueMmol.toFixed(2) + ' mmol/L · 3.8 ' + lowEta + ' · 3.0 ' + urgentEta,
        rate: rateMmol
      };
    }

    if (valueMmol < 4.5 || predictedHypoSoon) {
      var hypoDetail = valueMmol.toFixed(2) + ' mmol/L · richting 3.9 in ±' + Math.ceil(minutesToHypo) + ' min';
      if (predictedHypoSoon && minutesToUrgent !== null && minutesToUrgent >= 0) {
        hypoDetail = valueMmol.toFixed(2) + ' mmol/L · 3.9 ±' + Math.ceil(minutesToHypo) + 'm · 3.0 ±' + Math.ceil(minutesToUrgent) + 'm';
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

  function normalizeHypoRisk(risk, valueMmol, rateMmol) {
    if (!risk || !Number.isFinite(valueMmol) || !Number.isFinite(rateMmol)) return risk;
    if (risk.css !== 'urgent') return risk;
    if (valueMmol < 3.0) return risk;
    if (rateMmol < -0.01) return risk;

    return {
      css: valueMmol < 4.5 ? 'watch' : 'ok',
      title: valueMmol < 4.5 ? 'LET OP LAAG' : 'HYPO OK',
      detail: valueMmol.toFixed(2) + ' mmol/L',
      rate: rateMmol
    };
  }

  function detectPeakDropSignal(readings) {
    if (!readings || readings.length < 2) return null;
    var latest = readings[0];
    var latestTime = readingTime(latest);
    var latestMmol = mmol(Number(latest.sgv));
    if (!Number.isFinite(latestTime) || !Number.isFinite(latestMmol)) return null;

    var recent = readings.filter(function (entry) {
      var time = readingTime(entry);
      var value = mmol(Number(entry.sgv));
      return Number.isFinite(time) && Number.isFinite(value) && time <= latestTime && time >= latestTime - 120 * 60000;
    });
    if (!recent.length) return null;

    var peak = recent.reduce(function (best, entry) {
      return Number(entry.sgv) > Number(best.sgv) ? entry : best;
    }, recent[0]);
    var peakMmol = mmol(Number(peak.sgv));
    var peakTime = readingTime(peak);
    if (!Number.isFinite(peakMmol) || !Number.isFinite(peakTime) || peakTime >= latestTime) return null;

    var afterPeak = recent.filter(function (entry) {
      var time = readingTime(entry);
      return Number.isFinite(time) && time >= peakTime && time <= latestTime;
    });
    var trough = afterPeak.reduce(function (lowest, entry) {
      return Number(entry.sgv) < Number(lowest.sgv) ? entry : lowest;
    }, latest);
    var troughMmol = mmol(Number(trough.sgv));
    var recoveredFromTrough = Number.isFinite(troughMmol) ? latestMmol - troughMmol : 0;
    if (latestMmol >= 5.3 && recoveredFromTrough >= 0.6) return null;

    var drop = peakMmol - latestMmol;
    var minutes = (latestTime - peakTime) / 60000;
    if (!Number.isFinite(drop) || !Number.isFinite(minutes) || minutes <= 0) return null;
    var dropRate = drop / minutes;

    var tier = peakMmol >= 10 ? '10+' : peakMmol >= 9 ? '9+' : peakMmol >= 8.5 ? '8.5+' : null;
    if (!tier) return null;

    var severity = null;
    if ((tier === '10+' && drop >= PEAK_DROP_THRESHOLDS.urgent.minDrop && minutes <= PEAK_DROP_THRESHOLDS.urgent.maxMinutes) || dropRate >= PEAK_DROP_THRESHOLDS.urgent.minRate || (latestMmol <= 5.0 && drop >= 2.4)) {
      severity = 'urgent';
    } else if ((tier === '10+' && drop >= PEAK_DROP_THRESHOLDS.high.minDrop && minutes <= PEAK_DROP_THRESHOLDS.high.maxMinutes) || (tier === '9+' && drop >= 1.8 && minutes <= PEAK_DROP_THRESHOLDS.high.maxMinutes) || dropRate >= PEAK_DROP_THRESHOLDS.high.minRate) {
      severity = 'high';
    } else if ((tier === '8.5+' && drop >= PEAK_DROP_THRESHOLDS.watch.minDrop && minutes <= PEAK_DROP_THRESHOLDS.watch.maxMinutes) || dropRate >= PEAK_DROP_THRESHOLDS.watch.minRate) {
      severity = 'watch';
    }
    if (!severity) return null;

    return {
      tier: tier,
      peak: peakMmol,
      current: latestMmol,
      drop: drop,
      minutes: minutes,
      dropRate: dropRate,
      severity: severity
    };
  }

  function computePatternCorrection(readings, signal) {
    if (!readings || !signal) return null;
    var latestTime = readingTime(readings[0]);
    var episodes = [];

    readings.forEach(function (entry, index) {
      var peakValue = mmol(Number(entry.sgv));
      var peakTime = readingTime(entry);
      if (!Number.isFinite(peakValue) || !Number.isFinite(peakTime)) return;
      if (peakTime >= latestTime - 30 * 60000) return;
      if (peakValue < 8.5) return;

      var ageMin = (latestTime - peakTime) / 60000;
      if (ageMin > 12 * 60) return;
      var tier = peakValue >= 10 ? '10+' : peakValue >= 9 ? '9+' : '8.5+';
      if (tier !== signal.tier) return;

      var lookAhead = readings.slice(0, index).filter(function (candidate) {
        var t = readingTime(candidate);
        return Number.isFinite(t) && t > peakTime && t <= peakTime + 30 * 60000;
      });
      if (!lookAhead.length) return;

      var trough = lookAhead.reduce(function (minEntry, candidate) {
        return Number(candidate.sgv) < Number(minEntry.sgv) ? candidate : minEntry;
      }, lookAhead[0]);
      var troughMmol = mmol(Number(trough.sgv));
      if (!Number.isFinite(troughMmol)) return;
      episodes.push(peakValue - troughMmol);
    });

    if (episodes.length < 2) return null;
    episodes.sort(function (a, b) { return a - b; });
    var medianDrop = episodes[Math.floor(episodes.length / 2)];
    var correction = Math.max(0, medianDrop * 0.18);
    return {
      episodes: episodes.length,
      medianDrop: medianDrop,
      correction: correction
    };
  }

  function formatEtaValue(baseMmol, rateMmol, minutes) {
    if (!Number.isFinite(baseMmol) || !Number.isFinite(rateMmol)) return '--';
    var projected = Math.max(1.5, Math.min(33, baseMmol + rateMmol * minutes));
    return projected.toFixed(1);
  }

  function etaArrow(baseMmol, rateMmol, minutes) {
    if (!Number.isFinite(baseMmol) || !Number.isFinite(rateMmol)) return '→';
    var projected = baseMmol + rateMmol * minutes;
    var delta = projected - baseMmol;
    if (delta >= 0.35) return '↑';
    if (delta <= -0.35) return '↓';
    return '→';
  }

  function horizonPredictionText() {
    if (!latestReading || !currentRows || !currentRows.length) return '';
    var baseMmol = mmol(Number(latestReading.sgv));
    if (!Number.isFinite(baseMmol)) return '';
    var blendedRate = getForecastRateMmol(currentRows);
    var primaryRate = getPrimaryRate(currentRows);
    var rate = Number.isFinite(blendedRate) ? blendedRate : (primaryRate ? primaryRate.rateMmol : NaN);
    if (!Number.isFinite(rate)) return '';
    if (latestDbPrediction && latestDbPrediction.predictedMmol && latestDbPrediction.entryIdentifier === latestReading.identifier) {
      var db = latestDbPrediction.predictedMmol;
      var v10 = Number(db['10']);
      var v15 = Number(db['15']);
      var v20 = Number(db['20']);
      var v30 = Number(db['30']);
      if ([v10, v15, v20, v30].every(function (v) { return Number.isFinite(v); })) {
        return '10m ' + etaArrow(baseMmol, rate, 10) + v10.toFixed(1) +
          ' · 15m ' + etaArrow(baseMmol, rate, 15) + v15.toFixed(1) +
          ' · 20m ' + etaArrow(baseMmol, rate, 20) + v20.toFixed(1) +
          ' · 30m ' + etaArrow(baseMmol, rate, 30) + v30.toFixed(1);
      }
    }
    var corr = currentPatternCorrection && rate < -0.005 ? currentPatternCorrection.correction : 0;
    var calib = loadForecastCalibration();
    var horizons = [10, 15, 20, 30];
    var prev = null;
    var parts = horizons.map(function (minutes) {
      // Apply pattern correction progressively by horizon smoothly up to 30m
      var corrWeight = minutes / 30;
      var effectiveCorr = corr * calib.corrScale;
      var raw = baseMmol + rate * minutes;
      var adjusted = raw - (effectiveCorr * corrWeight) + calib.biasPerMin * minutes;
      adjusted = Math.max(1.5, Math.min(33, adjusted));

      // Keep projections monotonic in trend direction to avoid impossible ordering.
      if (prev !== null) {
        if (rate < 0 && adjusted > prev) adjusted = prev;
        if (rate > 0 && adjusted < prev) adjusted = prev;
      }
      prev = adjusted;

      return minutes + 'm ' + etaArrow(baseMmol, rate, minutes) + adjusted.toFixed(1);
    });
    return parts.join(' · ');
  }

  function dropFromPeakText(readings) {
    if (!readings || readings.length < 2) return '';
    var latest = readings[0];
    var latestTime = readingTime(latest);
    var latestMmol = mmol(Number(latest.sgv));
    if (!Number.isFinite(latestTime) || !Number.isFinite(latestMmol)) return '';

    var windowMs = 120 * 60000;
    var candidates = readings.filter(function (entry) {
      var time = readingTime(entry);
      var value = mmol(Number(entry.sgv));
      return Number.isFinite(time) && Number.isFinite(value) && time <= latestTime && time >= latestTime - windowMs;
    });
    if (!candidates.length) return '';

    var peak = candidates.reduce(function (best, entry) {
      return Number(entry.sgv) > Number(best.sgv) ? entry : best;
    }, candidates[0]);
    var peakMmol = mmol(Number(peak.sgv));
    var peakTime = readingTime(peak);
    if (!Number.isFinite(peakMmol) || !Number.isFinite(peakTime) || peakTime >= latestTime) return '';

    var drop = peakMmol - latestMmol;
    var minutes = (latestTime - peakTime) / 60000;
    if (!Number.isFinite(drop) || !Number.isFinite(minutes) || minutes <= 0) return '';

    var dropRate = drop / minutes;
    var meaningfulPeak = peakMmol >= 8.5;
    var meaningfulDrop = drop >= 1.5 || dropRate >= 0.06;
    if (!meaningfulPeak || !meaningfulDrop) return '';

    return 'HYPO patroon: piek ' + peakMmol.toFixed(1) + ' → nu ' + latestMmol.toFixed(1) +
      ' (Δ-' + drop.toFixed(1) + ' in ' + Math.round(minutes) + 'm, ' + dropRate.toFixed(3) + '/min)';
  }

  function calculateStats(readings) {
    if (!readings.length) return null;

    var latestTime = readingTime(readings[0]);
    var since = latestTime - 24 * 60 * 60000;
    var values = readings.filter(function (entry) {
      var time = readingTime(entry);
      return Number.isFinite(time) && time >= since && Number.isFinite(Number(entry.sgv));
    }).map(function (entry) {
      return mmol(Number(entry.sgv));
    });

    if (!values.length) return null;

    var count = values.length;
    var entries = readings.filter(function (entry) {
      var time = readingTime(entry);
      return Number.isFinite(time) && time >= since && Number.isFinite(Number(entry.sgv));
    }).sort(function (a, b) {
      return readingTime(a) - readingTime(b);
    });
    var lowCount = values.filter(function (value) { return value < 3.9; }).length;
    var urgentLowCount = values.filter(function (value) { return value < 3.0; }).length;
    var highCount = values.filter(function (value) { return value > 10.0; }).length;
    var inRangeCount = count - lowCount - highCount;
    var sum = values.reduce(function (total, value) { return total + value; }, 0);
    var average = sum / count;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var variance = values.reduce(function (total, value) {
      var diff = value - average;
      return total + diff * diff;
    }, 0) / count;
    var stdDev = Math.sqrt(variance);
    var cv = average > 0 ? stdDev / average * 100 : 0;
    var estimatedA1c = (average * MGDL_PER_MMOL + 46.7) / 28.7;
    var hypoEvents = 0;
    var inHypo = false;
    var lastHypoTime = null;
    var missingIntervals = 0;
    var fastestRise = null;
    var fastestDrop = null;
    var nightValues = [];

    entries.forEach(function (entry, index) {
      var value = mmol(Number(entry.sgv));
      var time = readingTime(entry);
      var hour = new Date(time).getHours();
      if (hour < 6) nightValues.push(value);

      if (value < 3.9) {
        lastHypoTime = time;
        if (!inHypo) {
          hypoEvents += 1;
          inHypo = true;
        }
      } else {
        inHypo = false;
      }

      if (index === 0) return;
      var previous = entries[index - 1];
      var previousTime = readingTime(previous);
      var minutes = (time - previousTime) / 60000;
      if (minutes > 7) missingIntervals += 1;
      if (minutes <= 0 || minutes > 20) return;

      var rate = (value - mmol(Number(previous.sgv))) / minutes;
      if (fastestRise === null || rate > fastestRise) fastestRise = rate;
      if (fastestDrop === null || rate < fastestDrop) fastestDrop = rate;
    });

    var lastHypoMinutes = lastHypoTime ? Math.round((latestTime - lastHypoTime) / 60000) : null;

    return {
      lowPct: Math.round(lowCount / count * 100),
      urgentLowPct: Math.round(urgentLowCount / count * 100),
      inRangePct: Math.round(inRangeCount / count * 100),
      highPct: Math.round(highCount / count * 100),
      average: average,
      min: min,
      max: max,
      stdDev: stdDev,
      cv: cv,
      stability: cv <= 36 ? 'stabiel' : 'wisselend',
      estimatedA1c: estimatedA1c,
      count: count,
      hypoEvents: hypoEvents,
      fastestRise: fastestRise,
      fastestDrop: fastestDrop,
      lastHypoMinutes: lastHypoMinutes,
      missingIntervals: missingIntervals,
      nightMin: nightValues.length ? Math.min.apply(null, nightValues) : null
    };
  }

  function ensureStyles() {
    if (document.getElementById('cgm-rate-overlay-style')) return;
    var style = document.createElement('style');
    style.id = 'cgm-rate-overlay-style';
    style.textContent = [
      '#cgm-rate-overlay{position:absolute!important;z-index:9999!important;top:174px;left:50%;transform:translateX(-50%);display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:6px;width:min(98vw,860px);font-family:Arial,Helvetica,sans-serif;pointer-events:none;align-items:start}',
      '#cgm-rate-overlay.classic{grid-template-columns:repeat(5,minmax(110px,1fr));width:min(98vw,900px)}',
      '#cgm-rate-overlay.all{left:6px;transform:none;grid-template-columns:repeat(21,minmax(0,1fr));width:calc(100vw - 12px)}',
      '#cgm-rate-overlay.all .rate-card{padding:3px 11px 3px 4px}',
      '#cgm-rate-overlay.all .rate-window{font-size:7px}',
      '#cgm-rate-overlay.all .rate-main{font-size:11px;line-height:1.03}',
      '#cgm-rate-overlay.all .rate-card.primary .rate-main{font-size:11px;line-height:1.03}',
      '#cgm-rate-overlay.all .rate-sub{font-size:6px}',
      '#cgm-rate-overlay.all .rate-arrow{right:2px;font-size:12px}',
      '#cgm-hypo-alert{position:absolute!important;z-index:10000!important;left:50%;transform:translateX(-50%);top:174px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:max-content;max-width:min(700px,90vw);min-width:320px;border:1px solid rgba(255,255,255,.24);border-radius:7px;padding:8px 14px;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;box-shadow:0 1px 8px rgba(0,0,0,.5)}',
      '#cgm-hypo-alert.has-carb{display:grid;grid-template-columns:minmax(0,1fr) 168px;column-gap:10px;align-items:center;max-width:min(700px,90vw)}',
      '#cgm-hypo-alert .hypo-main{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-width:0}',
      '#cgm-carb-advice{display:none;min-width:0;border-left:1px solid rgba(0,0,0,.22);padding-left:10px;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;color:inherit}',
      '#cgm-carb-advice .carb-title{display:inline;font-size:13px;font-weight:900;line-height:1.15;text-transform:uppercase;white-space:normal}',
      '#cgm-carb-advice .carb-message{display:inline;font-size:10px;font-weight:800;line-height:1.15;margin-left:6px;white-space:normal}',
      '#cgm-hypo-alert .hypo-line{display:flex;align-items:center;justify-content:center;gap:10px;white-space:nowrap}',
      '#cgm-hypo-alert .hypo-line.primary{display:flex;flex-direction:column;gap:2px;align-items:center;justify-content:center}',
      '#cgm-hypo-alert .hypo-title{font-size:15px;font-weight:900;line-height:1;text-transform:uppercase;white-space:nowrap}',
      '#cgm-hypo-alert .hypo-detail{font-size:24px;font-weight:900;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-hypo-alert .hypo-valrate{display:flex;align-items:baseline;justify-content:center;gap:10px;flex-wrap:wrap}',
      '#cgm-hypo-alert .hypo-rate{font-family:monospace;font-size:19px;font-weight:900;line-height:1;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-models{justify-content:space-between;gap:16px;width:100%}',
      '#cgm-hypo-alert .hypo-v1{font-family:monospace;font-size:12px;font-weight:800;line-height:1.15;white-space:nowrap;opacity:.85}',
      '#cgm-hypo-alert .hypo-v2{font-family:monospace;font-size:12px;font-weight:800;line-height:1.15;white-space:nowrap;opacity:.8}',
      '#cgm-hypo-alert .hypo-average{font-family:monospace;font-size:14px;font-weight:900;line-height:1.1;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-predict{font-family:monospace;font-size:13px;font-weight:800;line-height:1.15;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-drop{font-family:monospace;font-size:12px;font-weight:800;line-height:1.15;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-carb-inline{font-family:monospace;font-size:12px;font-weight:900;line-height:1.15;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-model{font-family:Arial,Helvetica,sans-serif;font-size:9px;font-weight:700;opacity:.6;margin-left:6px;padding:1px 4px;border:1px solid rgba(0,0,0,.25);border-radius:4px;vertical-align:middle}',
      '#cgm-hypo-alert .hypo-feedback{display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-top:4px}',
      '#cgm-hypo-alert .hypo-feedback button{font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;line-height:1;padding:4px 7px;border:1px solid rgba(0,0,0,.28);border-radius:5px;background:rgba(255,255,255,.55);color:inherit;cursor:pointer}',
      '#cgm-hypo-alert .hypo-feedback button:disabled{opacity:.55;cursor:default}',
      '@media(max-width:700px){#cgm-hypo-alert .hypo-feedback button{font-size:10px;padding:3px 5px}}',
      '#cgm-hypo-alert.ok{color:#063b1d;border-color:#4ade80;background:linear-gradient(135deg,#bbf7d0 0%,#4ade80 100%)}',
      '#cgm-hypo-alert.watch{color:#2f1600;border-color:#facc15;background:linear-gradient(135deg,#fff3a3 0%,#fbbf24 100%)}',
      '#cgm-hypo-alert.warning{color:#2f1600;border-color:#f59e0b;background:linear-gradient(135deg,#ffe08a 0%,#fb923c 100%)}',
      '#cgm-hypo-alert.hypo,#cgm-hypo-alert.urgent{color:#fff7ed;border-color:#fb7185;background:linear-gradient(135deg,#f59e0b 0%,#e11d48 100%);text-shadow:0 1px 2px rgba(0,0,0,.45)}',
      '#cgm-hypo-alert,#cgm-hypo-alert.ok,#cgm-hypo-alert.watch,#cgm-hypo-alert.warning,#cgm-hypo-alert.hypo,#cgm-hypo-alert.urgent{color:#111!important;text-shadow:none!important}',
      '#cgm-point-rate-tooltip{position:absolute!important;z-index:10001!important;display:none;min-width:178px;border:1px solid rgba(255,255,255,.22);border-radius:5px;background:rgba(0,0,0,.86);color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;padding:7px 8px;box-shadow:0 2px 12px rgba(0,0,0,.55);pointer-events:none}',
      '#cgm-point-rate-tooltip .pt-head{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px;font-size:12px;font-weight:900;line-height:1.15;margin-bottom:4px}',
      '#cgm-point-rate-tooltip .pt-head .pt-bg{text-align:left}',
      '#cgm-point-rate-tooltip .pt-head .pt-mid{font-size:13px;text-align:center;white-space:nowrap}',
      '#cgm-point-rate-tooltip .pt-head .pt-time{text-align:right}',
      '#cgm-point-rate-tooltip .pt-delta{justify-content:center;font-size:12px;font-weight:900}',
      '#cgm-point-rate-tooltip .pt-row{display:flex;justify-content:space-between;gap:12px;font-size:11px;font-weight:700;line-height:1.25;white-space:nowrap}',
      '#cgm-point-rate-tooltip .pt-rate{font-family:monospace;font-weight:900}',
      '.cgm-estimated-glucose-line{pointer-events:none}',
      '.cgm-estimated-glucose-line path{fill:none;stroke:#58a6ff;stroke-width:2.5;stroke-dasharray:5 5;stroke-linecap:round;stroke-linejoin:round;opacity:.9;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))}',
      '#cgm-current-average-rate{display:block!important;width:max-content;margin-top:4px;font-size:13px!important;line-height:1.2!important;padding:3px 7px!important;background:rgba(0,0,0,.72)!important;color:#f3f4f6!important;border:1px solid rgba(255,255,255,.2)!important;border-radius:5px!important;font-family:Arial,Helvetica,sans-serif!important;font-weight:900!important}',
      '#cgm-stats-panel{position:absolute!important;z-index:9998!important;left:50%;transform:translateX(-50%);width:min(98vw,980px);display:grid;grid-template-columns:repeat(6,minmax(92px,1fr));gap:4px;padding:5px;border:1px solid rgba(255,255,255,.14);border-radius:5px;background:rgba(0,0,0,.76);color:#e5e7eb;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;box-shadow:0 1px 10px rgba(0,0,0,.45)}',
      '#cgm-stats-panel .stats-title{grid-column:1/-1;font-size:10px;font-weight:900;text-transform:uppercase;color:#9ca3af;line-height:1}',
      '#cgm-stats-panel .stat{min-width:0;border:1px solid rgba(255,255,255,.12);border-radius:4px;background:rgba(255,255,255,.06);padding:4px 5px;box-sizing:border-box}',
      '#cgm-stats-panel .stat-label{display:block;font-size:9px;line-height:1;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-stats-panel .stat-value{display:block;font-family:monospace;font-size:13px;font-weight:900;line-height:1.15;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-stats-panel .low .stat-value{color:#fb7185}#cgm-stats-panel .range .stat-value{color:#4ade80}#cgm-stats-panel .high .stat-value{color:#c084fc}',
      '#cgm-rate-toggle,#cgm-rate-view-toggle,#cgm-rate-calc-toggle{position:absolute!important;z-index:10003!important;border:1px solid rgba(255,255,255,.25);border-radius:5px;background:rgba(0,0,0,.72);color:#ddd;font:700 11px Arial,Helvetica,sans-serif;padding:5px 8px;cursor:pointer;min-width:64px;text-align:center}',
      '#cgm-rate-toggle{left:50%;transform:translateX(-50%);top:174px}',
      '#cgm-rate-view-toggle{top:174px}',
      '#cgm-rate-toggle:hover,#cgm-rate-view-toggle:hover,#cgm-rate-calc-toggle:hover{background:rgba(30,30,30,.9);color:#fff}',
      '#cgm-rate-history-nav{position:absolute!important;z-index:10003!important;display:none;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.25);border-radius:5px;background:rgba(0,0,0,.72);padding:3px 6px;color:#ddd;font:700 11px Arial,Helvetica,sans-serif;white-space:nowrap}',
      '#cgm-rate-history-nav button{border:1px solid rgba(255,255,255,.25);background:rgba(30,30,30,.6);color:#ddd;border-radius:4px;padding:2px 6px;font:700 11px Arial,Helvetica,sans-serif;cursor:pointer}',
      '#cgm-rate-history-nav button:hover:not(:disabled){background:rgba(60,60,60,.9);color:#fff}',
      '#cgm-rate-history-nav button:disabled{opacity:.45;cursor:not-allowed}',
      '#cgm-rate-history-nav .hist-time{min-width:40px;text-align:center}',
      '#cgm-mobile-dock{display:none}',
      '.primary,.bgStatus.current{overflow:visible!important}',
      '#cgm-rate-overlay .rate-card{position:relative;border:1px solid rgba(255,255,255,.22);border-radius:5px;background:rgba(9,9,9,.82);color:#ddd;padding:4px 25px 4px 7px;text-align:left;box-shadow:0 -1px 6px rgba(0,0,0,.45);min-width:0;box-sizing:border-box}',
      '#cgm-rate-overlay .rate-card.primary{border-width:1px;border-bottom-width:2px}',
      '#cgm-rate-overlay .rate-window{display:block;font-size:9px;line-height:1;text-transform:uppercase;opacity:.9;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#cgm-rate-overlay .rate-main{display:block;font-family:monospace;font-size:15px;font-weight:900;line-height:1.05;letter-spacing:0;margin-top:1px}',
      '#cgm-rate-overlay .rate-card.primary .rate-main{font-size:15px}',
      '#cgm-rate-overlay .rate-arrow{position:absolute;right:7px;top:50%;transform:translateY(-50%);font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:900;line-height:1}',
      '#cgm-rate-overlay .rate-sub{display:block;font-size:9px;line-height:1.05;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}',
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
      '#cgm-ai-toggle{position:fixed;z-index:10002;right:10px;bottom:10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:800;line-height:1;padding:7px 11px;border:1px solid rgba(0,0,0,.3);border-radius:6px;background:linear-gradient(135deg,#a5b4fc 0%,#6366f1 100%);color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)}',
      '#cgm-ai-panel{position:fixed;z-index:10002;right:10px;bottom:48px;display:none;width:340px;max-width:92vw;max-height:70vh;overflow:auto;border:1px solid rgba(0,0,0,.28);border-radius:8px;background:#0f172a;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:12px;padding:10px;box-shadow:0 6px 24px rgba(0,0,0,.5)}',
      '#cgm-ai-panel.open{display:block}',
      '#cgm-ai-panel .ai-row{display:flex;gap:6px;align-items:center;margin-bottom:8px}',
      '#cgm-ai-panel select{flex:1;min-width:0;font-size:12px;padding:4px;border-radius:5px;border:1px solid rgba(255,255,255,.2);background:#1e293b;color:#e2e8f0}',
      '#cgm-ai-panel .ai-run{font-size:12px;font-weight:800;padding:5px 10px;border-radius:5px;border:1px solid rgba(255,255,255,.25);background:#6366f1;color:#fff;cursor:pointer}',
      '#cgm-ai-panel .ai-run[disabled]{opacity:.5;cursor:default}',
      '#cgm-ai-panel .ai-status{font-size:11px;opacity:.85;margin-bottom:8px;min-height:14px}',
      '#cgm-ai-panel .ai-sec{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;opacity:.7;margin:8px 0 4px}',
      '#cgm-ai-panel .ai-item{border-top:1px solid rgba(255,255,255,.1);padding:6px 0;cursor:pointer}',
      '#cgm-ai-panel .ai-item:hover{background:rgba(255,255,255,.04)}',
      '#cgm-ai-panel .ai-item-head{display:flex;gap:6px;align-items:flex-start}',
      '#cgm-ai-panel .ai-chev{flex:0 0 auto;opacity:.7;transition:transform .12s}',
      '#cgm-ai-panel .ai-item.open .ai-chev{transform:rotate(90deg)}',
      '#cgm-ai-panel .ai-item-title{flex:1;min-width:0}',
      '#cgm-ai-panel .ai-item .ai-meta{font-size:10px;opacity:.6;margin-top:2px}',
      '#cgm-ai-panel .ai-detail{display:none;margin-top:6px;padding:6px 8px;border-left:2px solid rgba(129,140,248,.6);background:rgba(255,255,255,.03);border-radius:0 4px 4px 0}',
      '#cgm-ai-panel .ai-item.open .ai-detail{display:block}',
      '#cgm-ai-panel .ai-d-row{margin-bottom:4px;line-height:1.35}',
      '#cgm-ai-panel .ai-d-row b{opacity:.8}',
      '#cgm-ai-panel .ai-d-meta{font-size:10px;opacity:.65;margin-top:4px}',
      '#cgm-ai-panel .ai-d-id{font-size:9px;opacity:.4;margin-top:3px;font-family:monospace}',
      '#cgm-ai-panel .ai-empty{opacity:.6;font-style:italic}',
      '@media(min-width:701px) and (max-width:1180px){#cgm-hypo-alert.has-carb{grid-template-columns:minmax(0,1fr) 138px;column-gap:8px}#cgm-carb-advice{padding-left:8px}#cgm-carb-advice .carb-title{font-size:11px}#cgm-carb-advice .carb-message{font-size:9px}}',
      '@media(max-width:700px){#cgm-mobile-dock{display:flex!important;flex-direction:column!important;width:100%!important;padding:8px 8px 0!important;box-sizing:border-box!important;gap:6px!important;clear:both!important}#cgm-mobile-dock #cgm-hypo-alert,#cgm-mobile-dock #cgm-carb-advice,#cgm-mobile-dock #cgm-rate-overlay,#cgm-mobile-dock #cgm-rate-toggle,#cgm-mobile-dock #cgm-rate-view-toggle,#cgm-mobile-dock #cgm-rate-history-nav{position:static!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;transform:none!important;box-sizing:border-box!important}#cgm-mobile-dock #cgm-hypo-alert,#cgm-mobile-dock #cgm-carb-advice{width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;gap:2px;padding:5px 7px}#cgm-mobile-dock #cgm-carb-advice .carb-title{font-size:12px}#cgm-mobile-dock #cgm-carb-advice .carb-message{font-size:10px;margin-left:6px}#cgm-mobile-dock #cgm-rate-overlay,#cgm-mobile-dock #cgm-rate-overlay.classic,#cgm-mobile-dock #cgm-rate-overlay.all{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:3px!important;width:100%!important;align-items:start!important;margin:0!important}#cgm-mobile-dock #cgm-rate-toggle,#cgm-mobile-dock #cgm-rate-view-toggle{display:inline-block!important;width:max-content!important;min-width:58px!important;margin:0 6px 0 0!important;padding:4px 7px!important;font-size:10px!important}#cgm-mobile-dock #cgm-rate-history-nav{width:max-content!important;max-width:100%!important;margin:0!important;font-size:10px!important;padding:2px 5px!important}#cgm-mobile-dock #cgm-hypo-alert .hypo-line{gap:4px;white-space:normal!important;text-align:center}#cgm-mobile-dock #cgm-hypo-alert .hypo-title{font-size:11px}#cgm-mobile-dock #cgm-hypo-alert .hypo-detail{font-size:16px}#cgm-mobile-dock #cgm-hypo-alert .hypo-rate{font-size:12px}#cgm-mobile-dock #cgm-hypo-alert .hypo-average{font-size:10px}#cgm-mobile-dock #cgm-hypo-alert .hypo-predict{font-size:9px;white-space:normal!important}#cgm-mobile-dock #cgm-hypo-alert .hypo-drop{font-size:9px;white-space:normal!important}#cgm-mobile-dock #cgm-rate-overlay .rate-card{padding:3px 16px 3px 5px;min-height:0}#cgm-mobile-dock #cgm-rate-overlay .rate-window{font-size:8px;line-height:1}#cgm-mobile-dock #cgm-rate-overlay .rate-main,#cgm-mobile-dock #cgm-rate-overlay .rate-card.primary .rate-main{font-size:12px;line-height:1.02;margin-top:1px}#cgm-mobile-dock #cgm-rate-overlay .rate-arrow{right:4px;font-size:14px}#cgm-mobile-dock #cgm-rate-overlay .rate-sub{font-size:7px;line-height:1.02;margin-top:1px}#cgm-stats-panel{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:3px!important;width:98vw!important;padding:4px!important}#cgm-stats-panel .stat{padding:3px 4px}#cgm-stats-panel .stat-label{font-size:8px}#cgm-stats-panel .stat-value{font-size:11px}}'
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
      var mode = getMode();
      var nextMode = mode === 'compact' ? 'classic' : mode === 'classic' ? 'all' : mode === 'all' ? 'off' : 'compact';
      localStorage.setItem(RATE_MODE_KEY, nextMode);
      render(currentRows);
    });
    document.body.appendChild(button);
    return button;
  }

  function ensureViewToggle() {
    var existing = document.getElementById('cgm-rate-view-toggle');
    if (existing) return existing;

    var button = document.createElement('button');
    button.id = 'cgm-rate-view-toggle';
    button.type = 'button';
    button.addEventListener('click', function () {
      var next = getViewMode() === 'live' ? 'history' : 'live';
      localStorage.setItem(RATE_VIEW_KEY, next);
      if (next === 'live') selectedReadingTime = null;
      refresh();
    });
    document.body.appendChild(button);
    return button;
  }

  function ensureCalcToggle() {
    var existing = document.getElementById('cgm-rate-calc-toggle');
    if (existing) return existing;

    var button = document.createElement('button');
    button.id = 'cgm-rate-calc-toggle';
    button.type = 'button';
    button.addEventListener('click', function () {
      var next = getCalcMode() === 'momentaan' ? 'verhouding' : 'momentaan';
      localStorage.setItem(RATE_CALC_KEY, next);
      // A calc-mode tap is meant to compare the current live rate cards.
      // If history had an old chart point selected, the hypo block kept
      // updating live while the cards appeared frozen on that old point.
      localStorage.setItem(RATE_VIEW_KEY, 'live');
      selectedReadingTime = null;
      scheduleRefresh(0, true);
    });
    document.body.appendChild(button);
    return button;
  }

  function getCalcMode() {
    return localStorage.getItem(RATE_CALC_KEY) === 'momentaan' ? 'momentaan' : 'verhouding';
  }

  function ensureHistoryNav() {
    var existing = document.getElementById('cgm-rate-history-nav');
    if (existing) return existing;

    var nav = document.createElement('div');
    nav.id = 'cgm-rate-history-nav';
    nav.innerHTML = [
      '<button type="button" data-dir="1">← ouder</button>',
      '<span class="hist-time">--:--</span>',
      '<button type="button" data-dir="-1">nieuwer →</button>'
    ].join('');

    nav.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('button[data-dir]') : null;
      if (!btn) return;
      var dir = Number(btn.getAttribute('data-dir'));
      stepHistory(dir);
    });

    document.body.appendChild(nav);
    return nav;
  }

  function stepHistory(direction) {
    if (!currentReadings.length) return;
    var idx = currentReadings.findIndex(function (entry) { return readingTime(entry) === selectedReadingTime; });
    if (idx < 0) idx = 0;
    var nextIdx = Math.max(0, Math.min(currentReadings.length - 1, idx + direction));
    selectedReadingTime = readingTime(currentReadings[nextIdx]);
    refresh();
  }

  // Lichte re-anchor zonder data opnieuw te laden: zet de vakjes op een historisch punt.
  // Gebruikt voor scrubben (muis over de grafiek) in history-modus.
  function applyHistoryAnchor(anchorTime) {
    if (!currentReadings.length) return;
    selectedReadingTime = anchorTime;
    var anchorEntry = currentReadings.find(function (entry) { return readingTime(entry) === anchorTime; }) || null;
    render(computeRows(currentReadings, anchorEntry));
  }

  function ensureHypoAlert() {
    var existing = document.getElementById('cgm-hypo-alert');
    if (existing) return existing;

    var alert = document.createElement('div');
    alert.id = 'cgm-hypo-alert';
    alert.setAttribute('aria-label', 'Hypoglykemie waarschuwing');
    alert.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('button[data-feedback]') : null;
      if (!btn) return;
      event.stopPropagation();
      sendFeedback(btn.getAttribute('data-feedback'), btn);
    });
    document.body.appendChild(alert);
    return alert;
  }

  function ensureCarbAdvice(parent) {
    var existing = document.getElementById('cgm-carb-advice');
    if (existing) {
      if (parent && existing.parentElement !== parent) parent.appendChild(existing);
      return existing;
    }

    var panel = document.createElement('div');
    panel.id = 'cgm-carb-advice';
    panel.setAttribute('aria-label', 'Suikeradvies');
    (parent || document.body).appendChild(panel);
    return panel;
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

  function ensureStatsPanel() {
    var existing = document.getElementById('cgm-stats-panel');
    if (existing) return existing;

    var panel = document.createElement('div');
    panel.id = 'cgm-stats-panel';
    panel.setAttribute('aria-label', 'Glucose statistieken laatste 24 uur');
    document.body.appendChild(panel);
    return panel;
  }

  function ensureMobileDock(chart) {
    var existing = document.getElementById('cgm-mobile-dock');
    var parent = chart && chart.parentElement ? chart.parentElement : document.body;
    
    if (existing) {
        if (!document.body.contains(existing)) {
            parent.insertBefore(existing, chart || parent.firstChild);
        }
        return existing;
    }
    
    var dock = document.createElement('div');
    dock.id = 'cgm-mobile-dock';
    dock.setAttribute('aria-label', 'Mobiele glucose overlay');
    parent.insertBefore(dock, chart || parent.firstChild);
    return dock;
  }

  function getMode() {
    var mode = localStorage.getItem(RATE_MODE_KEY);
    if (mode === 'off') {
      localStorage.setItem(RATE_MODE_KEY, 'compact');
      return 'compact';
    }
    return mode === 'classic' || mode === 'all' ? mode : 'compact';
  }

  function getViewMode() {
    var mode = localStorage.getItem(RATE_VIEW_KEY);
    return mode === 'history' ? 'history' : 'live';
  }

  function visibleRows(rows) {
    if (getMode() === 'all') return rows;
    if (getMode() === 'classic') {
      return rows.filter(function (row) {
        var minutes = Number.parseInt(row.label, 10);
        return CLASSIC_WINDOWS_MINUTES.indexOf(minutes) !== -1;
      });
    }

    return rows.filter(function (row) {
      var minutes = Number.parseInt(row.label, 10);
      return COMPACT_WINDOWS_MINUTES.indexOf(minutes) !== -1;
    });
  }

  function updateToggleLabel() {
    var button = ensureToggle();
    var viewButton = ensureViewToggle();
    var mode = getMode();
    button.textContent = mode === 'compact' ? 'compact' : mode === 'classic' ? 'klassiek' : mode === 'all' ? 'alles' : 'uit';
    var view = getViewMode();
    viewButton.textContent = view === 'history' ? 'history' : 'live';
    var calcButton = ensureCalcToggle();
    calcButton.textContent = getCalcMode() === 'momentaan' ? 'momentaan' : 'verhouding';
  }

  function updateHistoryNav() {
    var nav = ensureHistoryNav();
    var view = getViewMode();
    if (view !== 'history') {
      nav.style.display = 'none';
      return;
    }

    nav.style.display = 'flex';
    var current = currentReadings.find(function (entry) {
      return readingTime(entry) === selectedReadingTime;
    }) || null;
    if (!current && currentReadings.length) {
      current = currentReadings[0];
      selectedReadingTime = readingTime(current);
    }

    var idx = current ? currentReadings.findIndex(function (entry) { return readingTime(entry) === readingTime(current); }) : -1;
    var prevBtn = nav.querySelector('button[data-dir="1"]');
    var nextBtn = nav.querySelector('button[data-dir="-1"]');
    var timeLabel = nav.querySelector('.hist-time');
    if (timeLabel) timeLabel.textContent = current ? formatClock(readingTime(current)) : '--:--';
    if (prevBtn) prevBtn.disabled = idx < 0 || idx >= currentReadings.length - 1;
    if (nextBtn) nextBtn.disabled = idx <= 0;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  // --- AI-review paneel ------------------------------------------------------
  var AI_MODEL_KEY = 'cgmAiModel';
  // Getest werkend op de Ollama free-tier (snel + betrouwbare JSON). Andere
  // modellen kunnen 403 (abonnement), leeg of traag zijn; de lijst zelf komt
  // live uit /api/tags, dus geretireerde modellen verdwijnen vanzelf.
  var AI_RECOMMENDED = ['nemotron-3-nano:30b', 'gemma4:31b', 'gpt-oss:120b'];
  var AI_DEFAULT_MODEL = 'gpt-oss:120b';
  var aiModelsLoaded = false;
  var aiLatestTimer = null;
  // Laatst opgehaalde observaties/vragen in geheugen, zodat de detail-uitklap uit
  // reeds-opgehaalde data komt: geen extra LLM-call / Ollama-quota.
  var aiLatestObs = [];
  var aiLatestQ = [];

  function ensureAiToggle() {
    var existing = document.getElementById('cgm-ai-toggle');
    if (existing) return existing;
    var btn = document.createElement('button');
    btn.id = 'cgm-ai-toggle';
    btn.type = 'button';
    btn.textContent = 'AI';
    btn.addEventListener('click', toggleAiPanel);
    document.body.appendChild(btn);
    return btn;
  }

  function ensureAiPanel() {
    var existing = document.getElementById('cgm-ai-panel');
    if (existing) return existing;
    var panel = document.createElement('div');
    panel.id = 'cgm-ai-panel';
    panel.innerHTML = [
      '<div class="ai-row">',
      '  <select id="cgm-ai-model" aria-label="AI model"></select>',
      '  <button type="button" class="ai-run" id="cgm-ai-run">Review draaien</button>',
      '</div>',
      '<div class="ai-status" id="cgm-ai-status"></div>',
      '<div id="cgm-ai-body"></div>'
    ].join('');
    document.body.appendChild(panel);
    panel.querySelector('#cgm-ai-run').addEventListener('click', runAiReviewFromUi);
    panel.querySelector('#cgm-ai-model').addEventListener('change', function (e) {
      try { localStorage.setItem(AI_MODEL_KEY, e.target.value); } catch (err) {}
    });
    panel.querySelector('#cgm-ai-body').addEventListener('click', onAiItemClick);
    return panel;
  }

  function toggleAiPanel() {
    var panel = ensureAiPanel();
    var open = panel.classList.toggle('open');
    if (open) {
      loadAiModels();
      loadAiLatest();
      if (!aiLatestTimer) aiLatestTimer = window.setInterval(loadAiLatest, 60000);
    } else if (aiLatestTimer) {
      window.clearInterval(aiLatestTimer);
      aiLatestTimer = null;
    }
  }

  function setAiStatus(text) {
    var el = document.getElementById('cgm-ai-status');
    if (el) el.textContent = text || '';
  }

  function loadAiModels() {
    if (aiModelsLoaded) return;
    aiModelsLoaded = true;
    fetchWithTimeout('/_ai-review/models', { cache: 'no-store' }, 12000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        var sel = document.getElementById('cgm-ai-model');
        if (!sel || !json || !Array.isArray(json.models)) return;
        var saved = '';
        try { saved = localStorage.getItem(AI_MODEL_KEY) || ''; } catch (e) {}
        function opt(m) { return '<option value="' + escapeHtml(m) + '">' + escapeHtml(m) + '</option>'; }
        var recs = AI_RECOMMENDED.filter(function (m) { return json.models.indexOf(m) >= 0; });
        var rest = json.models.filter(function (m) { return recs.indexOf(m) < 0; });
        var html = '';
        if (recs.length) html += '<optgroup label="⭐ Aanbevolen">' + recs.map(opt).join('') + '</optgroup>';
        html += '<optgroup label="Alle modellen">' + rest.map(opt).join('') + '</optgroup>';
        sel.innerHTML = html;
        if (saved && json.models.indexOf(saved) >= 0) sel.value = saved;
        else if (json.models.indexOf(AI_DEFAULT_MODEL) >= 0) sel.value = AI_DEFAULT_MODEL;
      })
      .catch(function () { aiModelsLoaded = false; });
  }

  function runAiReviewFromUi() {
    var runBtn = document.getElementById('cgm-ai-run');
    var sel = document.getElementById('cgm-ai-model');
    var model = sel ? sel.value : '';
    if (runBtn) runBtn.disabled = true;
    setAiStatus('Bezig met review' + (model ? ' (' + model + ')' : '') + '…');
    fetchWithTimeout('/_ai-review/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model })
    }, 120000)
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.json || res.json.ok === false) {
          setAiStatus('Fout: ' + ((res.json && res.json.message) || 'onbekend'));
          return;
        }
        if (res.json.skipped) setAiStatus('Overgeslagen: ' + res.json.reason);
        else setAiStatus('Klaar — model ' + (res.json.model || '?') + ', ' +
          (res.json.observations ? res.json.observations.length : 0) + ' observaties, ' +
          (res.json.questions ? res.json.questions.length : 0) + ' vragen.');
        loadAiLatest();
      })
      .catch(function (err) { setAiStatus('Fout: ' + (err && err.message ? err.message : err)); })
      .then(function () { if (runBtn) runBtn.disabled = false; });
  }

  function loadAiLatest() {
    fetchWithTimeout('/_ai-review/latest?limit=10', { cache: 'no-store' }, 12000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (json && json.ok) renderAiLatest(json.observations || [], json.questions || []);
      })
      .catch(function () {});
  }

  function aiTime(s) { return s ? new Date(s).toLocaleString() : ''; }
  function aiClip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  // Detail-HTML uit reeds-opgehaalde data (geen extra netwerk/LLM-call).
  function aiObsDetailHtml(o) {
    var rows = [];
    if (o.summary) rows.push('<div class="ai-d-row"><b>Samenvatting:</b> ' + escapeHtml(o.summary) + '</div>');
    if (o.hypothesis) rows.push('<div class="ai-d-row"><b>Hypothese:</b> ' + escapeHtml(o.hypothesis) + '</div>');
    var meta = [];
    if (o.confidence) meta.push('zekerheid: ' + o.confidence);
    if (o.scope) meta.push('scope: ' + o.scope);
    if (o.model) meta.push('model: ' + o.model);
    if (o.createdAt) meta.push(aiTime(o.createdAt));
    if (o.needsUserConfirmation) meta.push('bevestiging gevraagd');
    rows.push('<div class="ai-d-meta">' + escapeHtml(meta.join(' · ')) + '</div>');
    if (o.runId) rows.push('<div class="ai-d-id">run ' + escapeHtml(o.runId) + '</div>');
    return '<div class="ai-detail">' + rows.join('') + '</div>';
  }

  function aiQDetailHtml(q) {
    var rows = [];
    if (q.question) rows.push('<div class="ai-d-row"><b>Vraag:</b> ' + escapeHtml(q.question) + '</div>');
    if (q.reason) rows.push('<div class="ai-d-row"><b>Reden:</b> ' + escapeHtml(q.reason) + '</div>');
    var meta = [];
    if (q.relatedEntryIdentifier) meta.push('entry: ' + q.relatedEntryIdentifier);
    if (q.model) meta.push('model: ' + q.model);
    if (q.createdAt) meta.push(aiTime(q.createdAt));
    if (meta.length) rows.push('<div class="ai-d-meta">' + escapeHtml(meta.join(' · ')) + '</div>');
    if (q.runId) rows.push('<div class="ai-d-id">run ' + escapeHtml(q.runId) + '</div>');
    return '<div class="ai-detail">' + rows.join('') + '</div>';
  }

  function renderAiLatest(observations, questions) {
    var body = document.getElementById('cgm-ai-body');
    if (!body) return;
    aiLatestObs = observations || [];
    aiLatestQ = questions || [];
    var html = ['<div class="ai-sec">Observaties</div>'];
    if (!aiLatestObs.length) html.push('<div class="ai-empty">Nog geen observaties.</div>');
    aiLatestObs.forEach(function (o, i) {
      var title = o.summary || o.hypothesis || '(leeg)';
      html.push(
        '<div class="ai-item" data-ai-type="obs" data-ai-idx="' + i + '">' +
        '<div class="ai-item-head"><span class="ai-chev">▸</span><span class="ai-item-title">' + escapeHtml(aiClip(title, 90)) + '</span></div>' +
        '<div class="ai-meta">' + escapeHtml((o.confidence || '') + ' · ' + (o.scope || '') + ' · ' + aiTime(o.createdAt)) + '</div>' +
        aiObsDetailHtml(o) +
        '</div>');
    });
    html.push('<div class="ai-sec">Vragen</div>');
    if (!aiLatestQ.length) html.push('<div class="ai-empty">Nog geen vragen.</div>');
    aiLatestQ.forEach(function (q, i) {
      html.push(
        '<div class="ai-item" data-ai-type="q" data-ai-idx="' + i + '">' +
        '<div class="ai-item-head"><span class="ai-chev">▸</span><span class="ai-item-title">' + escapeHtml(aiClip(q.question || '(leeg)', 90)) + '</span></div>' +
        aiQDetailHtml(q) +
        '</div>');
    });
    body.innerHTML = html.join('');
  }

  // Klik op een item: detail in-/uitklappen (puur UI, geen netwerk-call).
  function onAiItemClick(event) {
    var item = event.target && event.target.closest ? event.target.closest('.ai-item') : null;
    if (!item) return;
    item.classList.toggle('open');
  }

  function installAiReview() {
    ensureAiToggle();
  }

  var MODEL_RISK_LABELS = {
    ok: 'ok', low: 'laag', watch: 'let op', warning: 'risico', high: 'risico',
    likely: 'likely', urgent: 'urgent'
  };

  // Eén compacte model-badge (V1 of V2). Score-uitleg + redenen in de hover-tooltip.
  function modelSpanHtml(cls, label, risk, score, reasons, suffix, scaleNote) {
    if (!risk) return '';
    var lbl = MODEL_RISK_LABELS[risk] || risk;
    var s = Number.isFinite(score) ? ' · ' + score : '';
    var parts = [];
    if (scaleNote) parts.push(scaleNote);
    if (Array.isArray(reasons)) parts = parts.concat(reasons.filter(Boolean));
    var titleAttr = parts.length ? ' title="' + escapeHtml(parts.join(' · ')) + '"' : '';
    return '<span class="' + cls + '"' + titleAttr + '>' +
      label + ': ' + lbl + s + (suffix || '') + '</span>';
  }

  // V1 (regelmodel) en V2 (reactieve-hypo shadow) naast elkaar op één regel.
  // Alleen tonen als de snapshot bij de actuele meting hoort. V1 = primair
  // tenzij V2 geactiveerd is, dan staat V1 in legacyRisk/legacyScore.
  function modelLinesHtml() {
    var p = latestDbPrediction;
    if (!p) return '';
    if (latestReading && p.entryIdentifier && p.entryIdentifier !== latestReading.identifier) return '';
    var v2Active = p.legacyRisk != null;
    var v1Risk = v2Active ? p.legacyRisk : p.risk;
    var v1Score = v2Active ? p.legacyScore : p.riskScore;
    var v1Reasons = v2Active ? null : p.reasons;
    // Score-schaal in de tooltip zodat het getal betekenis heeft.
    var v1Scale = 'score-schaal: <3 laag · 3-4 let op · 5-6 risico · ≥7 urgent';
    var v2Scale = p.shadowTuned
      ? 'score-schaal: hoger = risicovoller (drempels getuned)'
      : 'score-schaal: <3 laag · 3-4 let op · 5-7 likely · ≥8 urgent';
    var v1 = modelSpanHtml('hypo-v1', 'V1', v1Risk, v1Score, v1Reasons, '', v1Scale);
    var conf = Number.isFinite(p.shadowConfidence) ? ' · ' + Math.round(p.shadowConfidence * 100) + '%' : '';
    var v2 = p.shadowRisk
      ? modelSpanHtml('hypo-v2', 'V2', p.shadowRisk, p.shadowScore, p.shadowReasons, conf + (p.shadowTuned ? ' ✓' : ''), v2Scale)
      : '';
    if (!v1 && !v2) return '';
    return '<div class="hypo-line hypo-models">' + v1 + v2 + '</div>';
  }

  function dbPatternLineText() {
    var p = latestDbPrediction;
    if (!p || !p.pattern) return '';
    if (latestReading && p.entryIdentifier && p.entryIdentifier !== latestReading.identifier) return '';
    var pattern = p.pattern;
    var count = Number(pattern.similarEpisodeCount);
    var hypoCount = Number(pattern.similarHypoCount);
    if (!Number.isFinite(count) || count < 3) return '';
    var ratio = Number(pattern.similarHypoRatio);
    var ratioText = Number.isFinite(ratio) ? ' · ' + Math.round(ratio * 100) + '%' : '';
    var hypoText = Number.isFinite(hypoCount) ? hypoCount : '?';
    var line = 'vergelijkbaar: ' + count + ' episodes · ' + hypoText + ' onder 4.5' + ratioText;
    var curveCount = Number(pattern.curveMatchCount);
    if (Number.isFinite(curveCount) && curveCount >= 3) {
      var curveHypo = Number(pattern.curveHypoCount);
      var curveRatio = Number(pattern.curveHypoRatio);
      line += ' · curve: ' + curveCount + '/' + (Number.isFinite(curveHypo) ? curveHypo : '?');
      if (Number.isFinite(curveRatio)) line += ' (' + Math.round(curveRatio * 100) + '%)';
    }
    if (pattern.weekdayRiskHigh && pattern.weekday) {
      line += ' · ' + pattern.weekday + ' riskanter';
    }
    return line;
  }

  function renderCarbAdvice(alert) {
    var panel = ensureCarbAdvice(alert);
    var p = latestDbPrediction;
    if (!p || !p.carbAdvice) {
      panel.style.display = 'none';
      if (alert) alert.classList.remove('has-carb');
      return;
    }
    if (latestReading && p.entryIdentifier && p.entryIdentifier !== latestReading.identifier) {
      panel.style.display = 'none';
      if (alert) alert.classList.remove('has-carb');
      return;
    }
    var advice = p.carbAdvice;
    if (!advice.action || advice.action === 'none') {
      panel.style.display = 'none';
      if (alert) alert.classList.remove('has-carb');
      return;
    }
    panel.style.display = 'block';
    panel.className = advice.action === 'eat_now' ? 'urgent' : 'prepare';
    if (alert) alert.classList.add('has-carb');
    var title = advice.title || (advice.action === 'eat_now' ? 'Neem nu suiker' : 'Houd suiker klaar');
    var message = advice.message || '';
    var titleParts = Array.isArray(advice.reasons) ? advice.reasons.filter(Boolean) : [];
    if (Number.isFinite(advice.minutesTo40)) titleParts.push('tijd tot 4.0: ' + advice.minutesTo40 + ' min');
    if (Number.isFinite(advice.minutesTo45)) titleParts.push('tijd tot 4.5: ' + advice.minutesTo45 + ' min');
    if (titleParts.length) panel.setAttribute('title', titleParts.join(' · '));
    else panel.removeAttribute('title');
    panel.innerHTML = [
      '<span class="carb-title">', escapeHtml(title), '</span>',
      message ? '<span class="carb-message">' + escapeHtml(message) + '</span>' : ''
    ].join('');
  }

  function carbAdviceInlineHtml() {
    var p = latestDbPrediction;
    if (!p || !p.carbAdvice) return '';
    if (latestReading && p.entryIdentifier && p.entryIdentifier !== latestReading.identifier) return '';
    var advice = p.carbAdvice;
    if (!advice.action || advice.action === 'none' || advice.action === 'eat_now') return '';
    var title = advice.title || 'Houd suiker klaar';
    var message = advice.message || '';
    var detail = message ? ' · ' + message : '';
    var titleParts = Array.isArray(advice.reasons) ? advice.reasons.filter(Boolean) : [];
    if (Number.isFinite(advice.minutesTo40)) titleParts.push('tijd tot 4.0: ' + advice.minutesTo40 + ' min');
    if (Number.isFinite(advice.minutesTo45)) titleParts.push('tijd tot 4.5: ' + advice.minutesTo45 + ' min');
    var titleAttr = titleParts.length ? ' title="' + escapeHtml(titleParts.join(' · ')) + '"' : '';
    return '<div class="hypo-line"><span class="hypo-carb-inline"' + titleAttr + '>advies: ' +
      escapeHtml(title + detail) + '</span></div>';
  }

  function carbAdviceInlineText() {
    var p = latestDbPrediction;
    if (!p || !p.carbAdvice) return '';
    if (latestReading && p.entryIdentifier && p.entryIdentifier !== latestReading.identifier) return '';
    var advice = p.carbAdvice;
    if (!advice.action || advice.action === 'none' || advice.action === 'eat_now') return '';
    var title = advice.title || 'Houd suiker klaar';
    var message = advice.message || '';
    return 'advies: ' + title + (message ? ' · ' + message : '');
  }

  function renderHypoAlert(risk) {
    var alert = ensureHypoAlert();
    currentHypoRisk = risk;
    var patternLine = currentPatternCorrection
      ? 'patrooncorr: -' + currentPatternCorrection.correction.toFixed(1) + ' (n=' + currentPatternCorrection.episodes + ')'
      : '';
    var dbPatternLine = dbPatternLineText();
    var carbInlineText = carbAdviceInlineText();
      
    if (!risk && !patternLine && !dbPatternLine) {
      alert.style.display = 'none';
      return;
    }

    alert.style.display = 'flex';
    var safeRisk = risk || { css: 'ok', title: 'HYPO OK', detail: 'Patroon actief', rate: (currentRows && currentRows.length ? getPrimaryRate(currentRows).rateMmol : 0) };
    var hadCarb = alert.classList.contains('has-carb');
    alert.className = safeRisk.css + (hadCarb ? ' has-carb' : '');
    var dropLine = dropFromPeakText(currentReadings);

    // Bij lows leest de armsensor te hoog/te traag (interstitieel loopt achter en
    // onderschat ernstige lows — bloed kan onder 2.0 zitten terwijl de sensor 2.4 toont).
    // Een precies voorspeld getal is daar misleidend; toon risico + onzekerheid i.p.v. een cijfer.
    var nowMmol = latestReading ? mmol(Number(latestReading.sgv)) : NaN;
    var blendedRateNow = getForecastRateMmol(currentRows);
    var primaryNow = getPrimaryRate(currentRows);
    var rateNow = Number.isFinite(blendedRateNow) ? blendedRateNow : (primaryNow ? primaryNow.rateMmol : 0);
    var proj20 = Number.isFinite(nowMmol) ? nowMmol + rateNow * 20 : NaN;
    var lowUnreliable = (Number.isFinite(nowMmol) && nowMmol <= 3.9) ||
                        (Number.isFinite(proj20) && proj20 <= 3.9 && rateNow < -0.04);
    var predictHtml = lowUnreliable
      ? '<div class="hypo-line"><span class="hypo-predict">verwacht: laag — kan lager zijn dan gemeten</span></div>'
      : '<div class="hypo-line"><span class="hypo-predict">verwacht: ' + horizonPredictionText() + ' mmol/L</span></div>';

    alert.innerHTML = [
      '<div class="hypo-main">',
      '<div class="hypo-line primary">',
      '<span class="hypo-title">', safeRisk.title, '</span>',
      '<span class="hypo-valrate">',
      '<span class="hypo-detail">', safeRisk.detail || '', '</span>',
      '<span class="hypo-rate">', signed(safeRisk.rate, 3), '/min</span>',
      '</span>',
      '</div>',
      modelLinesHtml(),
      '<div class="hypo-line"><span class="hypo-average">', averageRateText(true), '</span></div>',
      predictHtml,
      dropLine ? '<div class="hypo-line"><span class="hypo-drop">' + dropLine + '</span></div>' : '',
      dbPatternLine ? '<div class="hypo-line"><span class="hypo-drop" style="font-weight: bold;">' + escapeHtml(dbPatternLine) + '</span></div>' : '',
      patternLine || carbInlineText ? '<div class="hypo-line"><span class="hypo-drop" style="font-weight: bold;">' + escapeHtml([patternLine, carbInlineText].filter(Boolean).join(' · ')) + '</span></div>' : '',
      (!patternLine && !carbInlineText) ? carbAdviceInlineHtml() : '',
      '</div>'
    ].join('');
    var p = latestDbPrediction;
    var advice = p && p.carbAdvice ? p.carbAdvice : null;
    if (advice && advice.action === 'eat_now') renderCarbAdvice(alert);
    else {
      var panel = ensureCarbAdvice(alert);
      panel.style.display = 'none';
      alert.classList.remove('has-carb');
    }
  }

  function sendFeedback(type, btn) {
    if (!type) return;
    var payload = { type: type };
    if (latestReading && latestReading.identifier) payload.entryIdentifier = latestReading.identifier;
    if (btn) btn.disabled = true;
    fetch('/_feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    }).then(function (res) { return res.json(); })
      .then(function () { if (btn) btn.textContent = '✓'; })
      .catch(function () { if (btn) btn.disabled = false; });
  }

  function positionContainer() {
    var container = ensureContainer();
    var button = ensureToggle();
    var viewButton = ensureViewToggle();
    var calcButton = ensureCalcToggle();
    var alert = ensureHypoAlert();
    var statsPanel = ensureStatsPanel();
    var chart = document.querySelector('#chartContainer');
    if (!container || !chart) return;

    var chartTop = chart.getBoundingClientRect().top + window.scrollY;
    var chartBottom = chart.getBoundingClientRect().bottom + window.scrollY;
    var bgValue = document.querySelector('.currentBG, #currentBG, [data-current-bg]');
    var clock = document.querySelector('.currentTime, #currentTime, [data-current-time]');
    var statusLine = document.querySelector('.currentDetails, .currentStatus, #currentDetails');
    var buttonHeight = button.getBoundingClientRect().height || 24;
    var buttonTop = chartTop - buttonHeight - 6;
    var containerTop = chartTop + 4;
    var alertTop = chartTop + 4;
    var nav = ensureHistoryNav();
    if (bgValue && clock) {
      var bgRect = bgValue.getBoundingClientRect();
      var clockRect = clock.getBoundingClientRect();
      var midY = ((bgRect.bottom + clockRect.top) / 2) + window.scrollY;
      alertTop = midY - 70;
    } else if (bgValue && statusLine) {
      var bgOnlyRect = bgValue.getBoundingClientRect();
      var statusRect = statusLine.getBoundingClientRect();
      alertTop = ((bgOnlyRect.bottom + statusRect.top) / 2 + window.scrollY) - 70;
    }
    var alertRect = alert.getBoundingClientRect();
    var alertBottom = window.scrollY + alertRect.bottom;
    buttonTop = alertBottom + 4;

    if (window.innerWidth <= 700) {
      var dock = ensureMobileDock(chart);
      var mobileWidth = Math.max(260, window.innerWidth - 16);
      dock.appendChild(alert);
      dock.appendChild(button);
      dock.appendChild(viewButton);
      dock.appendChild(calcButton);
      dock.appendChild(container);
      if (nav.parentElement !== dock) dock.appendChild(nav);

      [alert, button, viewButton, calcButton, nav, container].forEach(function (el) {
        el.style.setProperty('position', 'static', 'important');
        el.style.setProperty('left', 'auto', 'important');
        el.style.setProperty('top', 'auto', 'important');
        el.style.setProperty('transform', 'none', 'important');
        el.style.setProperty('box-sizing', 'border-box', 'important');
      });
      alert.style.setProperty('width', '100%', 'important');
      alert.style.setProperty('max-width', Math.round(mobileWidth) + 'px', 'important');
      alert.style.setProperty('min-width', '0', 'important');
      alert.style.setProperty('margin', '0', 'important');
      container.style.setProperty('width', '100%', 'important');
      container.style.setProperty('margin', '0', 'important');
      button.style.setProperty('margin', '0 6px 0 0', 'important');
      viewButton.style.setProperty('margin', '0', 'important');
      calcButton.style.setProperty('margin', '0 6px 0 0', 'important');
      nav.style.setProperty('margin', '0', 'important');
      statsPanel.style.removeProperty('display');
      var topElements = [
        document.querySelector('.currentBG, #currentBG, [data-current-bg]'),
        document.querySelector('.currentTime, #currentTime, [data-current-time]'),
        document.querySelector('.currentDetails, .currentStatus, #currentDetails')
      ].filter(Boolean);
      var topBottom = topElements.reduce(function (bottom, el) {
        return Math.max(bottom, el.getBoundingClientRect().bottom + window.scrollY);
      }, window.scrollY + 72);
      var dockTop = dock.getBoundingClientRect().top + window.scrollY;
      dock.style.setProperty('margin-top', Math.max(8, topBottom - dockTop + 10) + 'px', 'important');
      // Direct apply without RAF for mobile
      chart.style.setProperty('margin-top', Math.max(12, dock.getBoundingClientRect().height + 14) + 'px', 'important');
      statsPanel.style.setProperty('position', 'absolute', 'important');
      statsPanel.style.setProperty('display', 'grid', 'important');
      statsPanel.style.setProperty('top', Math.round(chart.getBoundingClientRect().bottom + window.scrollY + 16) + 'px', 'important');
      statsPanel.style.setProperty('left', '50%', 'important');
      statsPanel.style.setProperty('transform', 'translateX(-50%)', 'important');
      return;
    } else {
      if (alert.parentElement !== document.body) document.body.appendChild(alert);
      if (button.parentElement !== document.body) document.body.appendChild(button);
      if (viewButton.parentElement !== document.body) document.body.appendChild(viewButton);
      if (calcButton.parentElement !== document.body) document.body.appendChild(calcButton);
      if (container.parentElement !== document.body) document.body.appendChild(container);
      if (nav.parentElement !== document.body) document.body.appendChild(nav);
      [alert, button, viewButton, calcButton, nav, container].forEach(function (el) {
        el.style.removeProperty('position');
        el.style.removeProperty('box-sizing');
      });
      chart.style.removeProperty('margin-top');
      statsPanel.style.removeProperty('display');
      alert.style.width = '';
      alert.style.maxWidth = '';
      alert.style.left = '50%';
      alert.style.transform = 'translateX(-50%)';
      container.style.left = '50%';
      container.style.transform = 'translateX(-50%)';
      container.style.width = '';
      statsPanel.style.top = Math.max(0, Math.round(chartBottom + 8)) + 'px';
      var stackButtons = [calcButton, viewButton, button];
      var stackGap = 5;
      var maxButtonWidth = Math.max.apply(null, stackButtons.map(function (el) {
        return el.getBoundingClientRect().width || 64;
      }));
      var stackHeight = stackButtons.reduce(function (sum, el) {
        return sum + (el.getBoundingClientRect().height || 24);
      }, 0) + stackGap * (stackButtons.length - 1);
      var stackLeft = window.scrollX + alertRect.right + 10;
      var stackTop = window.scrollY + alertRect.top + Math.max(0, (alertRect.height - stackHeight) / 2);
      if (stackLeft + maxButtonWidth > window.scrollX + window.innerWidth - 8) {
        stackLeft = window.scrollX + alertRect.left - maxButtonWidth - 10;
      }
      stackLeft = Math.max(window.scrollX + 6, stackLeft);
      stackButtons.forEach(function (el) {
        var h = el.getBoundingClientRect().height || 24;
        el.style.top = Math.max(0, Math.round(stackTop)) + 'px';
        el.style.left = Math.round(stackLeft) + 'px';
        el.style.transform = 'none';
        el.style.minWidth = Math.round(maxButtonWidth) + 'px';
        stackTop += h + stackGap;
      });
    }
    var buttonRect = button.getBoundingClientRect();
    nav.style.top = Math.max(0, Math.round(buttonRect.bottom + window.scrollY + 6)) + 'px';
    nav.style.left = Math.round(window.scrollX + buttonRect.left) + 'px';
    alert.style.top = Math.max(0, Math.round(alertTop)) + 'px';
    container.style.top = Math.max(0, Math.round(containerTop)) + 'px';
    if (window.innerWidth > 700) {
      statsPanel.style.top = Math.max(0, Math.round(chartBottom + 8)) + 'px';
    }
  }

  function renderStatsPanel(stats) {
    var panel = ensureStatsPanel();
    if (!stats) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'grid';
    panel.innerHTML = [
      '<div class="stats-title">Laatste 24 uur (update: ' + new Date().toLocaleTimeString() + ')</div>',
      '<div class="stat low"><span class="stat-label">Laag</span><span class="stat-value">', stats.lowPct, '%</span></div>',
      '<div class="stat range"><span class="stat-label">In bereik</span><span class="stat-value">', stats.inRangePct, '%</span></div>',
      '<div class="stat high"><span class="stat-label">Hoog</span><span class="stat-value">', stats.highPct, '%</span></div>',
      '<div class="stat"><span class="stat-label">Gemiddelde</span><span class="stat-value">', stats.average.toFixed(1), ' mmol/L</span></div>',
      '<div class="stat"><span class="stat-label">Min</span><span class="stat-value">', stats.min.toFixed(1), ' mmol/L</span></div>',
      '<div class="stat"><span class="stat-label">Max</span><span class="stat-value">', stats.max.toFixed(1), ' mmol/L</span></div>',
      '<div class="stat"><span class="stat-label">Std. afwijking</span><span class="stat-value">', stats.stdDev.toFixed(1), ' mmol/L</span></div>',
      '<div class="stat"><span class="stat-label">CV</span><span class="stat-value">', Math.round(stats.cv), '% ', stats.stability, '</span></div>',
      '<div class="stat"><span class="stat-label">Gesch. HbA1c</span><span class="stat-value">', stats.estimatedA1c.toFixed(1), '%</span></div>',
      '<div class="stat range"><span class="stat-label">In bereik</span><span class="stat-value">', stats.inRangePct, '%</span></div>',
      '<div class="stat"><span class="stat-label">Metingen</span><span class="stat-value">', stats.count, '</span></div>',
      '<div class="stat low"><span class="stat-label">Onder 3.0</span><span class="stat-value">', stats.urgentLowPct, '%</span></div>',
      '<div class="stat low"><span class="stat-label">Hypo events</span><span class="stat-value">', stats.hypoEvents, '</span></div>',
      '<div class="stat"><span class="stat-label">Laatste hypo</span><span class="stat-value">', stats.lastHypoMinutes === null ? 'geen' : stats.lastHypoMinutes + 'm', '</span></div>',
      '<div class="stat high"><span class="stat-label">Snelste stijging</span><span class="stat-value">', stats.fastestRise === null ? '--' : signed(stats.fastestRise, 3) + '/min', '</span></div>',
      '<div class="stat low"><span class="stat-label">Snelste daling</span><span class="stat-value">', stats.fastestDrop === null ? '--' : signed(stats.fastestDrop, 3) + '/min', '</span></div>',
      '<div class="stat"><span class="stat-label">Gemiste gaten</span><span class="stat-value">', stats.missingIntervals, '</span></div>',
      '<div class="stat"><span class="stat-label">Nacht min</span><span class="stat-value">', stats.nightMin === null ? '--' : stats.nightMin.toFixed(1) + ' mmol/L', '</span></div>'
    ].join('');
    positionContainer();
  }

  function render(rows) {
    if (window.console) console.log('[CGM Overlay] Render called, rows=', rows.length);
    ensureStyles();
    var container = ensureContainer();
    if (!container) return;
    currentRows = rows;
    updateHistoryNav();
    updateToggleLabel();
    renderHypoAlert(currentHypoRisk);
    removeCurrentAverageRate();
    positionContainer();

    if (getMode() === 'off') {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'grid';
    container.classList.toggle('classic', getMode() === 'classic');
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
    positionContainer();
    // Force a CSS repaint specifically for mobile browsers
    var dock = document.getElementById('cgm-mobile-dock');
    if (dock) { dock.style.display = 'none'; dock.offsetHeight; dock.style.display = ''; }
  }

  function renderCurrentGlucose(entry) {
    var currentBg = document.querySelector('.currentBG');
    if (!currentBg) return;
    var value = formatCurrentMmol(entry) || formatDisplayedMmol(currentBg.textContent);
    if (!value) return;
    if (currentBg.textContent === value) return;

    updatingCurrentGlucose = true;
    currentBg.textContent = value;
    updatingCurrentGlucose = false;
  }

  // Leave Nightscout's own header delta untouched and show our precise
  // 2-decimal 5-min delta alongside it, so both are visible for comparison.
  function renderCurrentDelta() {
    var deltaEl = document.querySelector('.bgdelta, #bgdelta, .currentDelta, [data-delta]');
    if (!deltaEl) return;
    var delta = computePreciseDelta();
    var ours = document.getElementById('cgm-precise-delta');

    if (delta === null) {
      if (ours) { updatingCurrentGlucose = true; ours.remove(); updatingCurrentGlucose = false; }
      return;
    }

    updatingCurrentGlucose = true;
    if (!ours) {
      ours = document.createElement('span');
      ours.id = 'cgm-precise-delta';
      ours.style.cssText = 'margin-left:6px;opacity:0.7;font-size:0.62em;font-weight:600;vertical-align:middle;';
    }
    if (ours.previousElementSibling !== deltaEl) {
      deltaEl.insertAdjacentElement('afterend', ours);
    }
    var text = signed(delta, 2) + ' (5m)';
    if (ours.textContent !== text) ours.textContent = text;
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

  function estimateExpectedIntervalMs(points) {
    var intervals = points.map(function (point, index) {
      if (index === 0) return null;
      if (!point.entry || !points[index - 1].entry) return null;
      return readingTime(point.entry) - readingTime(points[index - 1].entry);
    }).filter(function (interval) {
      return Number.isFinite(interval) && interval > 0;
    }).sort(function (a, b) {
      return a - b;
    });

    if (!intervals.length) return 60000;
    return intervals[Math.floor(intervals.length / 2)];
  }

  function estimateExpectedPixelGap(points) {
    var gaps = points.map(function (point, index) {
      if (index === 0) return null;
      return point.x - points[index - 1].x;
    }).filter(function (gap) {
      return Number.isFinite(gap) && gap > 0;
    }).sort(function (a, b) {
      return a - b;
    });

    if (!gaps.length) return 0;
    return gaps[Math.floor(gaps.length / 2)];
  }

  function chartDotPoints() {
    var dots = Array.prototype.slice.call(document.querySelectorAll('#chartContainer svg circle.entry-dot')).filter(function (el) {
      return Number.isFinite(Number(el.getAttribute('cx'))) && Number.isFinite(Number(el.getAttribute('cy')));
    }).sort(function (a, b) {
      return Number(a.getAttribute('cx')) - Number(b.getAttribute('cx'));
    });
    if (!dots.length) return [];

    var offset = Math.max(0, chartReadingsAsc.length - dots.length);
    return dots.map(function (dot, index) {
      return {
        dot: dot,
        entry: chartReadingsAsc[offset + index] || null,
        x: Number(dot.getAttribute('cx')),
        y: Number(dot.getAttribute('cy'))
      };
    }).filter(function (point) {
      return Number.isFinite(point.x) && Number.isFinite(point.y);
    });
  }

  function ensureEstimateLayer() {
    var svg = document.querySelector('#chartContainer svg');
    var focus = document.querySelector('#chartContainer svg .chart-focus');
    if (!svg || !focus) return null;

    var layer = svg.querySelector('.' + ESTIMATE_LINE_CLASS);
    if (!layer) {
      layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      layer.setAttribute('class', ESTIMATE_LINE_CLASS);
      focus.insertBefore(layer, focus.firstChild);
    }
    return layer;
  }

  function pathBetween(a, b) {
    return 'M' + a.x.toFixed(1) + ',' + a.y.toFixed(1) + 'L' + b.x.toFixed(1) + ',' + b.y.toFixed(1);
  }

  function recentPixelSlope(points, latest) {
    if (!latest.entry) return null;
    var latestTime = readingTime(latest.entry);
    for (var i = points.length - 2; i >= 0; i -= 1) {
      var point = points[i];
      if (!point.entry) continue;
      var dt = latestTime - readingTime(point.entry);
      if (dt >= 240000 && latest.x !== point.x) {
        return {
          yPerMs: (latest.y - point.y) / dt,
          xPerMs: (latest.x - point.x) / dt
        };
      }
    }
    return null;
  }

  function renderEstimatedGlucoseLine() {
    var layer = ensureEstimateLayer();
    if (!layer) return;

    var points = chartDotPoints();
    if (points.length < 2) {
      layer.innerHTML = '';
      return;
    }

    var expectedInterval = estimateExpectedIntervalMs(points);
    var gapThreshold = Math.max(ESTIMATE_GAP_MIN_MS, expectedInterval * 2.5);
    var expectedPixelGap = estimateExpectedPixelGap(points);
    var pixelGapThreshold = Math.max(ESTIMATE_PIXEL_GAP_MIN, expectedPixelGap * 2.5);
    var chart = document.querySelector('#chartContainer');
    var chartWidth = chart ? chart.getBoundingClientRect().width : window.innerWidth;
    var paths = [];

    for (var i = 1; i < points.length; i += 1) {
      var previous = points[i - 1];
      var current = points[i];
      var gapPx = current.x - previous.x;
      var inView = current.x >= -20 && previous.x <= chartWidth + 20;
      if (inView && gapPx > pixelGapThreshold) {
        paths.push(pathBetween(previous, current));
      }
    }

    var latest = points[points.length - 1];
    var staleMs = latest.entry ? Date.now() - readingTime(latest.entry) : 0;
    if (latest.entry && staleMs > gapThreshold && staleMs <= ESTIMATE_OPEN_MAX_MS) {
      var slope = recentPixelSlope(points, latest);
      if (slope && slope.xPerMs > 0) {
        paths.push(pathBetween(latest, {
          x: Math.min(chartWidth + 20, latest.x + slope.xPerMs * staleMs),
          y: latest.y + slope.yPerMs * staleMs
        }));
      }
    }

    layer.innerHTML = paths.map(function (d) {
      return '<path d="' + d + '"></path>';
    }).join('');
  }

  function scheduleEstimatedGlucoseLine(delay) {
    if (estimateRenderTimer) window.clearTimeout(estimateRenderTimer);
    estimateRenderTimer = window.setTimeout(function () {
      estimateRenderTimer = null;
      window.requestAnimationFrame(renderEstimatedGlucoseLine);
    }, delay || 80);
  }

  function isOnlyEstimateLayerMutation(mutations) {
    return mutations.every(function (mutation) {
      var target = mutation.target;
      if (target && target.closest && target.closest('.' + ESTIMATE_LINE_CLASS)) return true;

      var added = Array.prototype.slice.call(mutation.addedNodes || []);
      var removed = Array.prototype.slice.call(mutation.removedNodes || []);
      return added.concat(removed).every(function (node) {
        return node.nodeType === 1 && node.closest && node.closest('.' + ESTIMATE_LINE_CLASS);
      });
    });
  }

  function observeChartChanges() {
    var chart = document.querySelector('#chartContainer');
    if (!chart) {
      window.setTimeout(observeChartChanges, 1000);
      return;
    }
    if (chart === observedChart && chartObserver) return;

    if (chartObserver) chartObserver.disconnect();
    observedChart = chart;
    chartObserver = new MutationObserver(function (mutations) {
      if (isOnlyEstimateLayerMutation(mutations)) return;
      scheduleEstimatedGlucoseLine();
    });
    chartObserver.observe(chart, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['cx', 'cy', 'r', 'transform', 'width', 'height']
    });
  }

  function installChartRangeListeners() {
    document.addEventListener('change', function (event) {
      var target = event.target;
      if (target && target.id && /^(12|24)-browser$/.test(target.id)) {
        scheduleEstimatedGlucoseLine(300);
        window.setTimeout(scheduleEstimatedGlucoseLine, 1200);
        window.setTimeout(scheduleEstimatedGlucoseLine, 2500);
      }
    }, true);

    document.addEventListener('click', function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('#chartContainer, #settings, #drawer')) {
        scheduleEstimatedGlucoseLine(300);
        window.setTimeout(scheduleEstimatedGlucoseLine, 1200);
      }
    }, true);
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

    var trendRateMmol = prevRate ? prevRate.rate : (nextRate ? nextRate.rate : 0);
    var trendArrowText = trendArrow(trendRateMmol * MGDL_PER_MMOL);
    var deltaFromPrev = prevRate ? signed(prevRate.delta, 1) + 'mmol/L' : '--';

    tooltip.innerHTML = [
      '<div class="pt-head"><span class="pt-bg">BG ', currentValue, '</span><span class="pt-mid">', currentValue, ' ', trendArrowText, '</span><span class="pt-time">', formatClock(readingTime(entry)), '</span></div>',
      '<div class="pt-row pt-delta"><span>Δ ', deltaFromPrev, '</span></div>',
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
      var protectedUi = event.target && event.target.closest
        ? event.target.closest('#cgm-rate-history-nav, #cgm-rate-toggle, #cgm-rate-view-toggle, #cgm-rate-calc-toggle')
        : null;
      if (protectedUi) return;

      var dot = event.target && event.target.closest ? event.target.closest('circle.entry-dot') : null;
      var tooltip = ensurePointTooltip();
      if (!dot) {
        tooltip.style.display = 'none';
        if (getViewMode() === 'history') selectedReadingTime = null;
        refresh();
        return;
      }
      var index = pointIndexFromDot(dot);
      var entry = chartReadingsAsc[index];
      if (getViewMode() === 'history') {
        selectedReadingTime = entry ? readingTime(entry) : null;
      }
      refresh();
      showPointTooltip(dot, event);
    }, true);

    // History-scrub: in history-modus volgen de vakjes het meetpunt onder de muis.
    // Vegen over de grafiek i.p.v. stap-voor-stap bladeren. rAF-throttle tegen jank.
    var scrubRaf = null;
    var pendingScrubTime = null;
    document.addEventListener('mousemove', function (event) {
      if (getViewMode() !== 'history') return;
      var dot = event.target && event.target.closest ? event.target.closest('circle.entry-dot') : null;
      if (!dot) return;
      var entry = chartReadingsAsc[pointIndexFromDot(dot)];
      if (!entry) return;
      var t = readingTime(entry);
      if (t === selectedReadingTime) return;
      pendingScrubTime = t;
      if (scrubRaf) return;
      scrubRaf = window.requestAnimationFrame(function () {
        scrubRaf = null;
        if (pendingScrubTime !== null) applyHistoryAnchor(pendingScrubTime);
      });
    }, true);
  }

  function isOverlayMutation(mutation) {
    var target = mutation.target;
    if (!target || !target.closest) return false;
    return Boolean(target.closest(
      '#cgm-rate-overlay, #cgm-hypo-alert, #cgm-carb-advice, #cgm-rate-toggle, #cgm-rate-view-toggle, #cgm-rate-history-nav, #cgm-stats-panel, #cgm-point-rate-tooltip'
    ));
  }

  function isNightscoutLiveMutation(mutation) {
    var target = mutation.target;
    if (!target || !target.closest) return false;
    return Boolean(target.closest(
      '.currentBG, #currentBG, [data-current-bg], .currentTime, #currentTime, [data-current-time], #chartContainer'
    ));
  }

  function observeCurrentGlucose() {
    // Disabled MutationObserver. We will rely purely on aggressive polling.
  }

  function scheduleRefresh(delay, force) {
    if (refreshTimer) {
      if (force) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      } else {
        return;
      }
    }
    var elapsed = Date.now() - lastRefreshStartedAt;
    var wait = force ? (delay || 0) : Math.max(delay || 1000, Math.max(0, MIN_REFRESH_MS - elapsed));
    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      refresh(force);
    }, wait);
  }

  // Fetch met harde timeout. Zonder dit blijft een hangende request (bijv. tijdens een
  // backend-herstart) eeuwig openstaan, waardoor refreshInFlight nooit reset en de
  // auto-refresh bevriest tot een handmatige herlaad.
  function fetchWithTimeout(url, options, ms) {
    var opts = options || {};
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    var ctrl = new AbortController();
    var merged = Object.assign({}, opts, { signal: ctrl.signal });
    var timer = window.setTimeout(function () { ctrl.abort(); }, ms || 12000);
    return fetch(url, merged).then(
      function (r) { window.clearTimeout(timer); return r; },
      function (e) { window.clearTimeout(timer); throw e; }
    );
  }

  function fetchOverlayEntries() {
    var ts = Date.now();
    if (window.console) console.log('[CGM Overlay] Fetching data... ts=' + ts);
    return fetchWithTimeout('/_overlay/entries?count=' + OVERLAY_ENTRY_COUNT + '&ts=' + ts, { cache: 'no-store' }, 12000)
      .then(function (response) {
        if (!response.ok) throw new Error('Overlay entries gaf HTTP ' + response.status);
        return response.json();
      })
      .then(function (json) {
        if (Array.isArray(json)) return json;
        if (json && Array.isArray(json.entries)) return json.entries;
        throw new Error('Overlay entries gaf geen entries terug');
      })
      .catch(function (error) {
        if (window.console && window.console.warn) {
          window.console.warn('[CGM Overlay] Lichte endpoint faalde, val terug op Nightscout:', error);
        }
        return fetchWithTimeout('/api/v1/entries/sgv.json?count=' + OVERLAY_ENTRY_COUNT + '&ts=' + ts, { cache: 'no-store' }, 12000)
          .then(function (response) {
            if (!response.ok) throw new Error('Nightscout entries gaf HTTP ' + response.status);
            return response.json();
          });
      });
  }

  function refresh(force) {
    if (refreshInFlight) {
      // Watchdog: laat een vastgelopen/hangende refresh de auto-update niet permanent
      // blokkeren. Na 45s als vastgelopen beschouwen en alsnog doorgaan.
      if (Date.now() - lastRefreshStartedAt < 45000) {
        pendingRefresh = true;
        return;
      }
    }
    refreshInFlight = true;
    lastRefreshStartedAt = Date.now();
    fetchOverlayEntries()
      .then(function (entries) {
        var readings = sortedReadings(entries);
        if (!readings.length) throw new Error('Geen bruikbare SGV entries ontvangen');
        var previousLatestTime = currentReadings.length ? readingTime(currentReadings[0]) : null;
        currentReadings = readings;
        chartReadingsAsc = readings.slice().reverse();
        calibrateFromHistory(readings);
        var anchorEntry = null;
        if (getViewMode() === 'history' && selectedReadingTime !== null) {
          // If history mode was still following the previously-latest point,
          // keep it live instead of freezing the rate cards on an old minute.
          if (previousLatestTime !== null && selectedReadingTime === previousLatestTime) {
            selectedReadingTime = readingTime(readings[0]);
          }
          anchorEntry = readings.find(function (entry) {
            return readingTime(entry) === selectedReadingTime;
          }) || null;
          if (!anchorEntry) selectedReadingTime = null;
        }
        if (getViewMode() === 'history' && selectedReadingTime === null && readings.length) {
          selectedReadingTime = readingTime(readings[0]);
          anchorEntry = readings[0];
        }
        var rows = computeRows(readings, anchorEntry);
        latestReading = readings[0] || null;
        renderCurrentGlucose(anchorEntry || readings[0]);
        renderCurrentDelta();
        currentHypoRisk = calculateHypoRisk(readings, rows);
        var peakSignal = detectPeakDropSignal(readings);
        currentPatternCorrection = computePatternCorrection(readings, peakSignal);
        if (peakSignal && currentHypoRisk) {
          var trendRate = getForecastRateMmol(rows);
          if (!Number.isFinite(trendRate)) {
            var fallbackPrimary = getPrimaryRate(rows);
            trendRate = fallbackPrimary ? fallbackPrimary.rateMmol : 0;
          }
          var nowMmol = mmol(Number((anchorEntry || readings[0]).sgv));
          // Never escalate to URGENT from peak pattern when trend is rising/flat.
          var canEscalateUrgent = Number.isFinite(trendRate) && trendRate < -0.01 && Number.isFinite(nowMmol) && nowMmol <= 5.2;
          if (peakSignal.severity === 'urgent' && canEscalateUrgent) {
            currentHypoRisk.css = 'urgent';
            currentHypoRisk.title = 'HYPO URGENT';
          } else if (peakSignal.severity === 'high' && currentHypoRisk.css !== 'urgent') {
            currentHypoRisk.css = 'warning';
            currentHypoRisk.title = currentHypoRisk.title === 'HYPO OK' ? 'HYPO RISICO' : currentHypoRisk.title;
          } else if (peakSignal.severity === 'watch' && currentHypoRisk.css === 'ok') {
            currentHypoRisk.css = 'watch';
            currentHypoRisk.title = 'HYPO LET OP';
          }
        }
        // --- Alarm uit de sync (V1 of de geactiveerde V2) mag het kaart-alarm alleen
        // ESCALEREN, nooit verlagen: zo neemt V2 het alarm over zodra het strenger is,
        // terwijl de huidige-waarde-veiligheid (client-side) altijd blijft staan. ---
        if (latestDbPrediction && currentHypoRisk && readings[0] &&
            latestDbPrediction.entryIdentifier === readings[0].identifier) {
          var sevOrder = { ok: 0, watch: 1, warning: 2, hypo: 3, urgent: 4 };
          var syncCss = latestDbPrediction.risk === 'urgent' ? 'urgent'
            : latestDbPrediction.risk === 'high' ? 'warning'
            : latestDbPrediction.risk === 'watch' ? 'watch' : null;
          var curCss = currentHypoRisk.css || 'ok';
          if (syncCss && sevOrder[syncCss] > sevOrder[curCss]) {
            currentHypoRisk.css = syncCss;
            if (syncCss === 'urgent') currentHypoRisk.title = 'HYPO URGENT';
            else if (syncCss === 'warning' && currentHypoRisk.title === 'HYPO OK') currentHypoRisk.title = 'HYPO RISICO';
            else if (syncCss === 'watch' && currentHypoRisk.title === 'HYPO OK') currentHypoRisk.title = 'HYPO LET OP';
          }
          // Badge: welk model is de backend-alarmbron (V1 of geactiveerde V2)?
          currentHypoRisk.model = latestDbPrediction.modelVersion === 'reactive-hypo-v2' ? 'V2' : 'V1';
        }
        var finalRate = currentHypoRisk ? currentHypoRisk.rate : 0;
        var finalMmol = mmol(Number((anchorEntry || readings[0]).sgv));
        currentHypoRisk = normalizeHypoRisk(currentHypoRisk, finalMmol, finalRate);
        renderStatsPanel(calculateStats(readings));
        render(rows);
        observeChartChanges();
        scheduleEstimatedGlucoseLine(0);
        window.setTimeout(scheduleEstimatedGlucoseLine, 500);
        window.setTimeout(scheduleEstimatedGlucoseLine, 1500);
        if (window.console && window.console.log) {
          window.console.log('[CGM Overlay] Refreshed ' + readings.length + ' entries at ' + new Date().toLocaleTimeString());
        }
      })
      .catch(function (err) {
        if (!currentReadings.length) {
          renderStatsPanel(null);
          render([]);
          renderEstimatedGlucoseLine();
        }
        if (window.console && window.console.error) window.console.error('[CGM Overlay] Refresh error:', err);
      })
      .then(function () {
        refreshInFlight = false;
        if (pendingRefresh) {
          pendingRefresh = false;
          scheduleRefresh(250, true);
        }
      });
  }

  function fetchLatestDbPrediction() {
    fetchWithTimeout('/_prediction/latest', { cache: 'no-store' }, 12000)
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (json) {
        latestDbPrediction = json && json.snapshot ? json.snapshot : null;
      })
      .catch(function () {
        latestDbPrediction = null;
      });
  }

    function start() {
    console.log('--- NIEUWE SCRIPT VERSIE GELADEN ---');
    installSoundDefaultOff();
    installPointTooltip();
    installChartRangeListeners();
    installAiReview();
    observeCurrentGlucose();
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      if (window.console) console.log('[CGM Overlay] Woke up on mobile, forcing refresh');
      scheduleRefresh(10, true);
    }
  });

    observeChartChanges();
    fetchLatestDbPrediction();
    refresh(true);
    window.setInterval(fetchLatestDbPrediction, Math.max(POLL_MS, 60000));
    window.setInterval(function () { scheduleRefresh(0, false); }, POLL_MS);
    window.addEventListener('resize', positionContainer);
    window.addEventListener('resize', scheduleEstimatedGlucoseLine);
    window.setTimeout(positionContainer, 1000);
    window.setTimeout(positionContainer, 3000);
    window.setTimeout(scheduleEstimatedGlucoseLine, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}());
