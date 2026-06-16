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
  // Forecast/risk-basis: altijd verhouding-stijl (trailing average), los van de
  // momentaan/verhouding-weergave-toggle. Zo verandert een wéérgave-voorkeur nooit
  // de hypo-risk-rate of de forecast-lijn. Het grid (currentRows) volgt wél de toggle.
  var currentForecastRows = [];
  var currentReadings = [];
  var selectedReadingTime = null;
  var currentHypoRisk = null;
  var currentPatternCorrection = null;
  var FORECAST_CALIBRATION_KEY = 'cgm-forecast-calibration-v1';
  var MEAL_CALIBRATION_KEY = 'cgm-meal-calibration-v1';
  var MEAL_EPISODE_KEY = 'cgm-meal-episode-v1';
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

  function calculateHypoRisk(readings, forecastRows) {
    var latest = readings[0];
    if (!latest || !Number.isFinite(Number(latest.sgv))) return null;

    var valueMmol = mmol(Number(latest.sgv));
    var blendedRate = getForecastRateMmol(forecastRows);
    var primaryRate = getPrimaryRate(forecastRows);
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
    if (!latestReading || !currentForecastRows || !currentForecastRows.length) return '';
    var baseMmol = mmol(Number(latestReading.sgv));
    if (!Number.isFinite(baseMmol)) return '';
    var blendedRate = getForecastRateMmol(currentForecastRows);
    var primaryRate = getPrimaryRate(currentForecastRows);
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
    var impactEvents = [];
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
      var absRate = Math.abs(rate);
      var absDelta = Math.abs(value - mmol(Number(previous.sgv)));
      if (absRate >= 0.12 || absDelta >= 1.2) {
        impactEvents.push({ at: time, from: mmol(Number(previous.sgv)), to: value, delta: value - mmol(Number(previous.sgv)), minutes: minutes, rate: rate });
      }
    });

    var lastHypoMinutes = lastHypoTime ? Math.round((latestTime - lastHypoTime) / 60000) : null;
    var fastestAbs = Math.max(Math.abs(fastestRise || 0), Math.abs(fastestDrop || 0));
    var impactScore = Math.max(0, Math.min(100, Math.round(fastestAbs / 0.35 * 100)));
    var impactLevel = impactScore >= 80 ? 'urgent' : (impactScore >= 55 ? 'high' : (impactScore >= 30 ? 'watch' : 'low'));
    impactEvents = impactEvents.slice().sort(function (a, b) { return Math.abs(b.rate) - Math.abs(a.rate); }).slice(0, 5);

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
      impactScore: impactScore,
      impactLevel: impactLevel,
      impactEvents: impactEvents,
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
      '#cgm-hypo-alert{position:absolute!important;z-index:10000!important;left:50%;transform:translateX(-50%);top:174px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;width:max-content;max-width:min(740px,90vw);min-width:360px;border:1px solid rgba(255,255,255,.24);border-radius:7px;padding:10px 16px;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;box-shadow:0 1px 8px rgba(0,0,0,.5)}',
      '#cgm-hypo-alert.has-carb{display:grid;grid-template-columns:minmax(0,1fr) 176px;column-gap:12px;align-items:center;max-width:min(760px,90vw)}',
      '#cgm-hypo-alert .hypo-main{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-width:0}',
      '#cgm-carb-advice{display:none;min-width:0;border-left:1px solid rgba(0,0,0,.22);padding-left:10px;font-family:Arial,Helvetica,sans-serif;box-sizing:border-box;color:inherit}',
      '#cgm-carb-advice .carb-title{display:inline;font-size:13px;font-weight:900;line-height:1.15;text-transform:uppercase;white-space:normal}',
      '#cgm-carb-advice .carb-message{display:inline;font-size:10px;font-weight:800;line-height:1.15;margin-left:6px;white-space:normal}',
      '#cgm-hypo-alert .hypo-line{display:flex;align-items:center;justify-content:center;gap:10px;max-width:100%;white-space:normal;text-align:center}',
      '#cgm-hypo-alert .hypo-line.primary{display:flex;flex-direction:column;gap:2px;align-items:center;justify-content:center}',
      '#cgm-hypo-alert .hypo-title{font-size:15px;font-weight:900;line-height:1;text-transform:uppercase;white-space:nowrap}',
      '#cgm-hypo-alert .hypo-detail{font-size:24px;font-weight:900;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-hypo-alert .hypo-valrate{display:flex;align-items:baseline;justify-content:center;gap:10px;flex-wrap:wrap}',
      '#cgm-hypo-alert .hypo-rate{font-family:monospace;font-size:19px;font-weight:900;line-height:1;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-models{justify-content:space-between;gap:16px;width:100%}',
      '#cgm-hypo-alert .hypo-v1{font-family:monospace;font-size:12px;font-weight:800;line-height:1.15;white-space:nowrap;opacity:.85}',
      '#cgm-hypo-alert .hypo-v2{font-family:monospace;font-size:12px;font-weight:800;line-height:1.15;white-space:nowrap;opacity:.8}',
      '#cgm-hypo-alert .hypo-average{font-family:monospace;font-size:14px;font-weight:900;line-height:1.1;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-predict{font-family:monospace;font-size:13px;font-weight:800;line-height:1.2;white-space:normal;opacity:.95}',
      '#cgm-hypo-alert .hypo-drop{font-family:monospace;font-size:12px;font-weight:800;line-height:1.2;white-space:normal;opacity:.95}',
      '#cgm-hypo-alert .hypo-carb-inline{font-family:monospace;font-size:12px;font-weight:900;line-height:1.2;white-space:normal;opacity:.95}',
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
      '#cgm-meal-badge{position:absolute!important;z-index:10001!important;display:none;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center;width:154px;min-height:132px;box-sizing:border-box;border:1px solid #f59e0b;border-radius:9px;padding:10px 8px;font-family:Arial,Helvetica,sans-serif;font-weight:900;font-size:11px;line-height:1.2;color:#2f1600;background:linear-gradient(135deg,#fde68a 0%,#fbbf24 100%);box-shadow:0 1px 8px rgba(0,0,0,.5);white-space:normal;pointer-events:none}',
      '#cgm-meal-badge .meal-ic{font-size:22px;line-height:1}',
      '#cgm-meal-badge .meal-time{font-family:monospace;font-weight:900;opacity:.9}',
      '#cgm-meal-badge.meal-snel{border-color:#fb7185;background:linear-gradient(135deg,#fecaca 0%,#fb7185 100%)}',
      '#cgm-meal-badge.meal-langzaam{border-color:#fcd34d;background:linear-gradient(135deg,#fef9c3 0%,#fde047 100%)}',
      '#cgm-meal-badge.meal-dip{border-color:#93c5fd;background:linear-gradient(135deg,#e0f2fe 0%,#bae6fd 100%);color:#0c3a5b;font-weight:800;opacity:.92}',
      '#cgm-meal-badge.meal-reactive-drop{border-color:#ef4444;background:linear-gradient(135deg,#fee2e2 0%,#ef4444 100%);color:#fff}',
      // Reactieve daling waarvan de verwachte bodem veilig is: rustige kleur i.p.v. rood.
      '#cgm-meal-badge.meal-reactive-drop-low{border-color:#cbd5e1;background:linear-gradient(135deg,#f1f5f9 0%,#e2e8f0 100%);color:#1f2937;opacity:.95}',
      '#cgm-meal-badge.meal-reactive-drop-watch{border-color:#fcd34d;background:linear-gradient(135deg,#fef9c3 0%,#fde047 100%);color:#3a2e00}',
      '#cgm-meal-badge.meal-risk-watch{box-shadow:0 0 0 2px rgba(251,191,36,.38),0 1px 6px rgba(0,0,0,.35)}',
      '#cgm-meal-badge.meal-risk-high{box-shadow:0 0 0 2px rgba(249,115,22,.48),0 1px 8px rgba(0,0,0,.45)}',
      '#cgm-meal-badge.meal-risk-urgent{box-shadow:0 0 0 2px rgba(220,38,38,.58),0 1px 10px rgba(0,0,0,.55)}',
      '@media(max-width:700px){#cgm-meal-badge{width:128px;min-height:64px;font-size:10px;padding:6px 5px}#cgm-meal-badge .meal-ic{font-size:18px}}',
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
      '#cgm-ai-toggle{position:fixed;z-index:10002;left:10px;bottom:10px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:800;line-height:1;padding:7px 11px;border:1px solid rgba(0,0,0,.3);border-radius:6px;background:linear-gradient(135deg,#a5b4fc 0%,#6366f1 100%);color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)}',
      '#cgm-ai-panel{position:fixed;z-index:10002;left:10px;bottom:48px;display:none;width:520px;max-width:94vw;max-height:50vh;overflow:auto;border:1px solid rgba(0,0,0,.28);border-radius:8px;background:#0f172a;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif;font-size:12px;padding:10px;box-shadow:0 6px 24px rgba(0,0,0,.5)}',
      '#cgm-ai-panel.open{display:block}',
      '#cgm-ai-panel .ai-row{display:flex;gap:6px;align-items:center;margin-bottom:8px}',
      '#cgm-ai-panel select{flex:1;min-width:0;font-size:12px;padding:4px;border-radius:5px;border:1px solid rgba(255,255,255,.2);background:#1e293b;color:#e2e8f0}',
      '#cgm-ai-panel .ai-run{font-size:12px;font-weight:800;padding:5px 10px;border-radius:5px;border:1px solid rgba(255,255,255,.25);background:#6366f1;color:#fff;cursor:pointer}',
      '#cgm-ai-panel .ai-run[disabled]{opacity:.5;cursor:default}',
      '#cgm-ai-panel .ai-status{font-size:11px;opacity:.85;margin-bottom:8px;min-height:14px}',
      '#cgm-ai-panel .ai-runrow{margin-bottom:8px}',
      '#cgm-ai-panel .ai-runlabel{font-size:11px;opacity:.7;margin-right:6px;white-space:nowrap}',
      '#cgm-ai-panel .ai-sec{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;opacity:.7;margin:8px 0 4px}',
      '#cgm-ai-panel button.ai-sec{display:flex;width:100%;align-items:center;gap:5px;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;padding:0}',
      '#cgm-ai-panel .ai-section-body{display:none}',
      '#cgm-ai-panel .ai-episode-section.open>.ai-section-body{display:block}',
      '#cgm-ai-panel .ai-episode-section.open>button.ai-sec .ai-chev{transform:rotate(90deg)}',
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
      '#cgm-ai-panel .ai-curve{margin-top:6px}',
      '#cgm-ai-panel .ai-svg{width:100%;height:auto;display:block;background:rgba(0,0,0,.25);border-radius:4px}',
      '#cgm-ai-panel .ai-rev-head{font-size:12px;font-weight:700;margin-bottom:4px;color:#e2e8f0}',
      '#cgm-ai-panel .ai-mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:4px 0 6px}',
      '#cgm-ai-panel .ai-mcell{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:5px;padding:5px 4px;text-align:center}',
      '#cgm-ai-panel .ai-mcell.low{border-color:rgba(96,165,250,.45)}',
      '#cgm-ai-panel .ai-mcell.high{border-color:rgba(251,113,133,.45)}',
      '#cgm-ai-panel .ai-mcell-v{font-size:12px;font-weight:900;line-height:1.15}',
      '#cgm-ai-panel .ai-mcell-l{font-size:8px;opacity:.6;margin-top:2px}',
      '#cgm-ai-panel .ai-ex-badge{font-size:9px;font-weight:800;padding:1px 5px;border-radius:6px}',
      '#cgm-ai-panel .ai-ex-badge.high{color:#fb7185;background:rgba(251,113,133,.16)}',
      '#cgm-ai-panel .ai-ex-badge.low{color:#60a5fa;background:rgba(96,165,250,.16)}',
      '#cgm-ai-panel .ai-dots{display:flex;gap:6px;margin:4px 0}',
      '#cgm-ai-panel .ai-dot-col{display:flex;flex-direction:column;align-items:center;gap:2px}',
      '#cgm-ai-panel .ai-dot{width:11px;height:11px;border-radius:50%;background:rgba(255,255,255,.12)}',
      '#cgm-ai-panel .ai-dot.on.high{background:#fb7185}',
      '#cgm-ai-panel .ai-dot.on.low{background:#60a5fa}',
      '#cgm-ai-panel .ai-dot-col label{font-size:7px;opacity:.5}',
      '#cgm-ai-panel .ai-rev-ctx{margin-top:6px;padding:5px 7px;border-radius:5px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08)}',
      '#cgm-ai-panel .ai-rev-ctx-t{font-size:10px;font-weight:700;opacity:.7;text-transform:uppercase;letter-spacing:.03em;margin-bottom:3px}',
      '#cgm-ai-panel .ai-ev-chip{display:inline-block;font-size:10px;padding:1px 6px;margin:2px 3px 0 0;border-radius:10px;background:rgba(99,102,241,.16);border:1px solid rgba(129,140,248,.3)}',
      '#cgm-ai-panel .ai-sevband{font-size:11px;padding:3px 7px;margin:3px 0;border-left:3px solid rgba(148,163,184,.4);border-radius:0 4px 4px 0}',
      '#cgm-ai-panel .ai-sevband.on{background:rgba(248,113,133,.12);border-left-color:#f43f5e}',
      '#cgm-ai-panel .ai-sev-tag{font-size:9px;font-weight:700;color:#fbbf24;border:1px solid #fbbf24;border-radius:5px;padding:0 5px}',
      '#cgm-ai-panel .ai-sim{display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:4px 6px;margin:3px 0;border-radius:5px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);cursor:pointer}',
      '#cgm-ai-panel .ai-sim:hover{background:rgba(255,255,255,.07)}',
      '#cgm-ai-panel .ai-rev-actions{display:flex;gap:5px;margin-top:8px}',
      '#cgm-ai-panel .ai-rev-btn{flex:1;font-size:10px;padding:4px 6px;border:1px solid rgba(255,255,255,.2);border-radius:5px;background:#1e293b;color:#cbd5e1;cursor:pointer}',
      '#cgm-ai-panel .ai-rev-btn:hover{background:#334155}',
      '#cgm-ai-panel .ai-reasons{margin-top:5px}',
      '#cgm-ai-panel .ai-reasons ul{margin:3px 0 0;padding-left:16px}',
      '#cgm-ai-panel .ai-reasons li{margin-bottom:2px;line-height:1.3}',
      '#cgm-ai-panel .ai-empty{opacity:.6;font-style:italic}',
      '#cgm-ai-panel .ai-banner{margin-bottom:6px}',
      '#cgm-ai-panel .ai-srchealth{font-size:10px;padding:4px 7px;border-radius:5px;margin-bottom:4px;border:1px solid rgba(255,255,255,.12)}',
      '#cgm-ai-panel .ai-srchealth.ok{background:rgba(52,211,153,.12)}',
      '#cgm-ai-panel .ai-srchealth.watch{background:rgba(251,191,36,.14)}',
      '#cgm-ai-panel .ai-srchealth.bad{background:rgba(248,113,113,.16)}',
      '#cgm-ai-panel .ai-reminder{display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:10px;padding:4px 7px;border-radius:5px;margin-bottom:4px;background:rgba(99,102,241,.14);border:1px solid rgba(129,140,248,.4)}',
      '#cgm-ai-panel .ai-reminder.watch{background:rgba(251,191,36,.16)}',
      '#cgm-ai-panel .ai-rem-act{display:flex;gap:3px;flex-shrink:0}',
      '#cgm-ai-panel .ai-rem-act button{font-size:9px;padding:2px 5px;border:1px solid rgba(255,255,255,.25);border-radius:4px;background:rgba(30,30,30,.6);color:#ddd;cursor:pointer}',
      '#cgm-ai-panel .ai-quicklog{margin-bottom:7px;padding:5px 7px;border:1px solid rgba(255,255,255,.12);border-radius:5px;background:rgba(255,255,255,.03)}',
      '#cgm-ai-panel .ai-ql-title{font-size:10px;opacity:.7;margin-bottom:4px}',
      '#cgm-ai-panel .ai-ql-btns{display:flex;flex-wrap:wrap;gap:4px}',
      '#cgm-ai-panel .ai-ql-btn{font-size:10px;padding:3px 7px;border:1px solid rgba(255,255,255,.2);border-radius:12px;background:#1e293b;color:#cbd5e1;cursor:pointer}',
      '#cgm-ai-panel .ai-ql-btn:hover{background:#334155}',
      '#cgm-ai-panel .ai-ql-status{font-size:10px;opacity:.7;margin-top:3px;min-height:12px}',
      '#cgm-ai-panel .ai-pcard{padding:5px 8px;margin-bottom:4px;border-left:2px solid rgba(99,102,241,.6);background:rgba(255,255,255,.03);border-radius:0 4px 4px 0}',
      '#cgm-ai-panel .ai-pcard-t{font-size:10px;font-weight:700;opacity:.85}',
      '#cgm-ai-panel .ai-pcard-b{font-size:11px;line-height:1.35}',
      '#cgm-ai-panel .ai-hday{display:flex;flex-direction:column;gap:1px;padding:5px 8px;margin-bottom:3px;border-radius:5px;border:1px solid rgba(255,255,255,.1);border-left-width:3px;cursor:pointer}',
      '#cgm-ai-panel .ai-hday:hover{background:rgba(255,255,255,.05)}',
      '#cgm-ai-panel .ai-hday.sel{background:rgba(99,102,241,.16)}',
      '#cgm-ai-panel .ai-hday.ok{border-left-color:#34d399}',
      '#cgm-ai-panel .ai-hday.low{border-left-color:#f43f5e}',
      '#cgm-ai-panel .ai-hday.high{border-left-color:#fbbf24}',
      '#cgm-ai-panel .ai-hday-d{font-size:11px;font-weight:700}',
      '#cgm-ai-panel .ai-hday-m{font-size:10px;opacity:.7}',
      '#cgm-ai-panel .ai-settings{margin-top:10px;border-top:1px solid rgba(255,255,255,.12);padding-top:6px}',
      '#cgm-ai-panel .ai-set-row{display:flex;justify-content:space-between;align-items:center;font-size:11px;margin-bottom:4px}',
      '#cgm-ai-panel .ai-set-row select{font-size:11px;background:#1e293b;color:#cbd5e1;border:1px solid rgba(255,255,255,.2);border-radius:4px;padding:2px 4px}',
      '#cgm-ai-panel .ai-tabs{display:flex;gap:4px;margin-bottom:8px}',
      '#cgm-ai-panel .ai-tab{flex:1;font-size:11px;font-weight:700;padding:5px 4px;border:1px solid rgba(255,255,255,.18);border-radius:5px;background:#1e293b;color:#cbd5e1;cursor:pointer}',
      '#cgm-ai-panel .ai-tab.active{background:#6366f1;color:#fff;border-color:#6366f1}',
      '#cgm-ai-panel .ai-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:6px}',
      '#cgm-ai-panel .ai-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:6px 4px;text-align:center}',
      '#cgm-ai-panel .ai-card.ok{border-color:rgba(74,222,128,.5)}',
      '#cgm-ai-panel .ai-card.low{border-color:rgba(251,113,133,.5)}',
      '#cgm-ai-panel .ai-card.high{border-color:rgba(250,204,21,.5)}',
      '#cgm-ai-panel .ai-card-v{font-size:15px;font-weight:900;line-height:1.1}',
      '#cgm-ai-panel .ai-card-l{font-size:9px;opacity:.7;margin-top:2px}',
      '#cgm-ai-panel .ai-card-d{display:inline-block;font-size:8px;font-weight:800;margin-top:3px;padding:1px 4px;border-radius:6px;line-height:1.3}',
      '#cgm-ai-panel .ai-card-d.up{color:#4ade80;background:rgba(74,222,128,.14)}',
      '#cgm-ai-panel .ai-card-d.down{color:#fb7185;background:rgba(251,113,133,.14)}',
      '#cgm-ai-panel .ai-card-d.flat{color:#cbd5e1;background:rgba(255,255,255,.08)}',
      '#cgm-ai-panel .ai-period{display:flex;gap:4px;margin:2px 0 8px}',
      '#cgm-ai-panel .ai-period button{flex:1;font-size:11px;font-weight:800;padding:5px 0;border:1px solid rgba(255,255,255,.18);border-radius:6px;background:#1e293b;color:#cbd5e1;cursor:pointer}',
      '#cgm-ai-panel .ai-period button.active{background:#16a34a;color:#fff;border-color:#16a34a}',
      '#cgm-ai-panel .ai-fine{font-size:10px;opacity:.6;margin-bottom:4px}',
      '#cgm-ai-panel .ai-targets{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px}',
      '#cgm-ai-panel .ai-tg{font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid rgba(255,255,255,.15)}',
      '#cgm-ai-panel .ai-tg.ok{color:#4ade80;border-color:rgba(74,222,128,.5)}',
      '#cgm-ai-panel .ai-tg.no{color:#fb7185;border-color:rgba(251,113,133,.5)}',
      '#cgm-ai-panel .ai-wd .ai-hbar label{font-size:8px;opacity:.7}',
      '#cgm-ai-panel .ai-hours{display:flex;align-items:flex-end;gap:2px;height:40px;margin-bottom:4px}',
      '#cgm-ai-panel .ai-hbar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}',
      '#cgm-ai-panel .ai-hbar span{width:100%;background:linear-gradient(180deg,#fb7185,#e11d48);border-radius:2px 2px 0 0;min-height:1px}',
      '#cgm-ai-panel .ai-hbar label{font-size:8px;opacity:.5;margin-top:1px}',
      '#cgm-ai-panel .ai-ep{border-top:1px solid rgba(255,255,255,.1);padding:5px 0}',
      '#cgm-ai-panel .ai-ep-head{font-weight:700}',
      '#cgm-ai-panel .ai-ep .ai-meta{font-size:10px;opacity:.6;margin-top:2px}',
      '#cgm-ai-panel .ai-home{display:flex;gap:10px;align-items:center;margin:2px 0 8px}',
      '#cgm-ai-panel .ai-donut{flex:0 0 76px;width:76px;height:76px;border-radius:50%;display:flex;align-items:center;justify-content:center}',
      '#cgm-ai-panel .ai-donut-h{width:52px;height:52px;border-radius:50%;background:#0b1220;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1}',
      '#cgm-ai-panel .ai-donut-h b{font-size:16px;font-weight:900;color:#4ade80}',
      '#cgm-ai-panel .ai-donut-h span{font-size:8px;opacity:.6;margin-top:1px}',
      '#cgm-ai-panel .ai-home-r{flex:1;min-width:0}',
      '#cgm-ai-panel .ai-home-cards{grid-template-columns:repeat(3,1fr);margin-bottom:4px}',
      '#cgm-ai-panel .ai-home-br{display:flex;gap:8px;font-size:9px;opacity:.75}',
      '#cgm-ai-panel .ai-home-br .lo{color:#fb7185}#cgm-ai-panel .ai-home-br .in{color:#4ade80}#cgm-ai-panel .ai-home-br .hi{color:#facc15}',
      '#cgm-ai-panel .ai-insight{border-left:3px solid #4ade80;padding:6px 8px;margin:2px 0 8px;background:rgba(74,222,128,.06);border-radius:0 6px 6px 0}',
      '#cgm-ai-panel .ai-insight-t{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:#4ade80;opacity:.9}',
      '#cgm-ai-panel .ai-insight-b{font-size:12px;line-height:1.4;margin-top:3px}',
      '#cgm-ai-panel .ai-agp{margin:3px 0 4px}',
      '#cgm-ai-panel .ai-agp svg{display:block;width:100%;height:auto}',
      '#cgm-ai-panel .ai-tirstrip{display:grid;grid-template-columns:repeat(24,1fr);gap:1px;height:18px;border-radius:3px;overflow:hidden;margin:3px 0 1px}',
      '#cgm-ai-panel .ai-tirstrip i{display:block;height:100%}',
      '#cgm-ai-panel .ai-tiraxis{display:grid;grid-template-columns:repeat(5,1fr);font-size:8px;opacity:.45;margin-bottom:6px}',
      '#cgm-ai-panel .ai-tiraxis span:last-child{text-align:right}',
      '#cgm-ai-panel .ai-evfeed{display:flex;flex-direction:column;margin:2px 0 6px}',
      '#cgm-ai-panel .ai-ev{display:flex;gap:7px;align-items:flex-start;padding:6px 0;border-top:1px solid rgba(255,255,255,.08)}',
      '#cgm-ai-panel .ai-ev-t{flex:0 0 38px;font-size:10px;opacity:.6;padding-top:2px}',
      '#cgm-ai-panel .ai-ev-ic{flex:0 0 18px;text-align:center;font-size:13px;opacity:.85}',
      '#cgm-ai-panel .ai-ev.rise_local_peak .ai-ev-ic{color:#a78bfa}',
      '#cgm-ai-panel .ai-ev.fall_local_trough .ai-ev-ic{color:#38bdf8}',
      '#cgm-ai-panel .ai-ev.high_episode .ai-ev-ic{color:#fb7185}',
      '#cgm-ai-panel .ai-ev.recovery_to_range .ai-ev-ic{color:#4ade80}',
      '#cgm-ai-panel .ai-ev.first_reading .ai-ev-ic{color:#fbbf24}',
      '#cgm-ai-panel .ai-ev.stable_window .ai-ev-ic{color:#4ade80}',
      '#cgm-ai-panel .ai-ev-b{flex:1;min-width:0}',
      '#cgm-ai-panel .ai-ev-l{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:700}',
      '#cgm-ai-panel .ai-ev-v{font-weight:900;white-space:nowrap}',
      '#cgm-ai-panel .ai-ev-d{display:block;font-size:10px;opacity:.65;margin-top:1px}',
      '#cgm-ai-panel .ai-ev-badge{display:inline-block;font-size:8px;font-weight:800;padding:1px 5px;border-radius:6px;background:rgba(250,204,21,.18);color:#fbbf24;margin-left:3px}',
      '#cgm-ai-panel .ai-ev.recovery_to_range .ai-ev-badge{background:rgba(74,222,128,.16);color:#4ade80}',
      '#cgm-ai-panel .ai-heatmap{margin:3px 0 8px}',
      '#cgm-ai-panel .ai-hm-row{display:grid;grid-template-columns:22px repeat(24,1fr);gap:1px;align-items:center;margin-bottom:1px}',
      '#cgm-ai-panel .ai-hm-day{font-size:8px;opacity:.65;text-align:right;padding-right:3px}',
      '#cgm-ai-panel .ai-hm-cell{display:block;min-width:4px;height:9px;border-radius:1px;background:rgba(255,255,255,.04)}',
      '#cgm-ai-panel .ai-hm-axis{display:grid;grid-template-columns:22px repeat(5,1fr);font-size:8px;opacity:.45;margin-top:2px}',
      '#cgm-ai-panel .ai-chatlog{max-height:300px;overflow:auto;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}',
      '#cgm-ai-panel .ai-msg{padding:6px 8px;border-radius:8px;max-width:88%;line-height:1.35}',
      '#cgm-ai-panel .ai-msg-user{align-self:flex-end;background:#6366f1;color:#fff}',
      '#cgm-ai-panel .ai-msg-ai{align-self:flex-start;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1)}',
      '#cgm-ai-panel .ai-typing{opacity:.6;font-style:italic}',
      '#cgm-ai-panel .ai-chatrow{display:flex;gap:6px}',
      '#cgm-ai-panel .ai-chatrow input{flex:1;min-width:0;font-size:12px;padding:6px;border-radius:5px;border:1px solid rgba(255,255,255,.2);background:#1e293b;color:#e2e8f0}',
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
    currentForecastRows = calculateRows(currentReadings, anchorEntry);
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

  function ensureMealBadge() {
    var existing = document.getElementById('cgm-meal-badge');
    if (existing) return existing;

    var badge = document.createElement('div');
    badge.id = 'cgm-meal-badge';
    badge.setAttribute('aria-label', 'Maaltijddetectie');
    document.body.appendChild(badge);
    return badge;
  }

  // ===== Maaltijddetectie — zelfkalibrerend & portable =====
  // Drie fasen, maximaal-vroeg afgesteld voor zo veel mogelijk lead-time vóór de
  // reactieve daling:
  //   - 'dip'    : cephale pre-dip (lichte daling vóór de stijging) → tentatief.
  //   - 'rising' : bevestigde maaltijdstijging, geklasseerd snel/normaal/langzaam,
  //                herkend op meerdere tijdschalen (steile spike vs sluipende drift).
  // Drempels komen uit loadMealCalibration() — per browser/persoon geleerd uit de
  // eigen data (calibrateMealFromHistory), met generieke defaults voor nieuwe
  // gebruikers. Niets is hardcoded op één persoon → drop-in voor anderen.
  var MEAL_TROUGH_WINDOW_MS = 60 * 60000;
  // Generieke defaults zolang er te weinig eigen data is (samples < MEAL_MIN_SAMPLES).
  var MEAL_DEFAULTS = {
    fastRate: 0.13,
    slowRate: 0.07,
    preDipMmol: 0.40,
    dipToNadirMin: 60,
    dropWatchRate: 0.07,
    dropHighRate: 0.12,
    dropUrgentRate: 0.18,
    typicalRiseMmol: 1.4,
    typicalDropMmol: 1.4,
    typicalUndershootMmol: 0.2,
    // Universele klinische niveau-drempels (mmol/L) voor de escalatie van een
    // reactieve daling. Level-1 hypo-alert = 3.9, klinisch significant = 3.0.
    watchMmol: 4.5,
    alertMmol: 3.9,
    seriousMmol: 3.0,
    samples: 0
  };
  var MEAL_MIN_SAMPLES = 12;
  var MEAL_SAMPLE_CAP = 200;

  function median(arr) {
    if (!arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  }
  function percentile(arr, p) {
    if (!arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  }

  function numericArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function (v) { return Number(v); })
      .filter(function (v) { return Number.isFinite(v); })
      .slice(-MEAL_SAMPLE_CAP);
  }

  function readJsonStorage(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_err) { return null; }
  }

  function normalizeMealCalibrationPayload(value) {
    if (!value || typeof value !== 'object') return null;
    var riseRates = numericArray(value.riseRates);
    if (!riseRates.length) return null;
    var lastTroughTime = Number(value.lastTroughTime) || 0;
    return {
      schemaVersion: 1,
      riseRates: riseRates,
      preDips: numericArray(value.preDips),
      peakToNadir: numericArray(value.peakToNadir),
      dropRates: numericArray(value.dropRates),
      rises: numericArray(value.rises),
      drops: numericArray(value.drops),
      undershoots: numericArray(value.undershoots),
      lastTroughTime: Number.isFinite(lastTroughTime) ? lastTroughTime : 0
    };
  }

  function loadMealEpisode() {
    var episode = readJsonStorage(MEAL_EPISODE_KEY);
    if (!episode || episode.schemaVersion !== 1) return null;
    if (!Number.isFinite(Number(episode.expiresAt)) || Date.now() > Number(episode.expiresAt)) return null;
    ['startedAt', 'troughTime', 'troughMmol', 'peakTime', 'peakMmol', 'baselineMmol', 'lastUpdatedAt', 'expiresAt'].forEach(function (key) {
      if (episode[key] !== null && episode[key] !== undefined) episode[key] = Number(episode[key]);
    });
    if (!Number.isFinite(episode.startedAt) || !Number.isFinite(episode.peakMmol)) return null;
    return episode;
  }

  function saveMealEpisode(episode) {
    try { localStorage.setItem(MEAL_EPISODE_KEY, JSON.stringify(episode)); } catch (_err) {}
  }

  function clearMealEpisode() {
    try { localStorage.removeItem(MEAL_EPISODE_KEY); } catch (_err) {}
  }

  function exportMealState() {
    return JSON.stringify({
      schemaVersion: 1,
      exportedAt: Date.now(),
      mealCalibration: normalizeMealCalibrationPayload(readJsonStorage(MEAL_CALIBRATION_KEY)),
      mealEpisode: loadMealEpisode()
    });
  }

  function importMealState(raw) {
    if (!raw || raw.length > 50000) throw new Error('Ongeldige of te grote import.');
    var parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== 1) throw new Error('Onbekende versie.');
    var cal = normalizeMealCalibrationPayload(parsed.mealCalibration);
    if (!cal) throw new Error('Geen geldige maaltijd-kalibratie gevonden.');
    try { localStorage.setItem(MEAL_CALIBRATION_KEY, JSON.stringify(cal)); } catch (_err) { throw new Error('Kon kalibratie niet opslaan.'); }
    if (parsed.mealEpisode && parsed.mealEpisode.schemaVersion === 1 && Number(parsed.mealEpisode.expiresAt) > Date.now()) {
      saveMealEpisode(parsed.mealEpisode);
    }
    return cal.riseRates.length;
  }

  function loadMealCalibration() {
    try {
      var parsed = JSON.parse(localStorage.getItem(MEAL_CALIBRATION_KEY) || 'null');
      if (!parsed || !Array.isArray(parsed.riseRates) || parsed.riseRates.length < MEAL_MIN_SAMPLES) {
        return Object.assign({}, MEAL_DEFAULTS);
      }
      // numericArray() saneert elke serie (alleen eindige getallen, gecapt op
      // MEAL_SAMPLE_CAP) — zelfde saneerder die import/normalize gebruiken, dus
      // ook NaN/strings uit getamperde localStorage vallen weg.
      var riseRates = numericArray(parsed.riseRates);
      var preDips = numericArray(parsed.preDips);
      var peakToNadir = numericArray(parsed.peakToNadir);
      var dropRates = numericArray(parsed.dropRates);
      var rises = numericArray(parsed.rises);
      var drops = numericArray(parsed.drops);
      var undershoots = numericArray(parsed.undershoots);
      var learnedDropWatch = percentile(dropRates, 0.50);
      var learnedDropHigh = percentile(dropRates, 0.75);
      var learnedDropUrgent = percentile(dropRates, 0.90);
      // fin(): geleerde waarde alleen overnemen als ze eindig is — anders de
      // generieke default. Niet `|| default`, want een legitiem-lage geleerde
      // waarde (bv. preDip/undershoot ~0) mag niet als "ontbrekend" wegvallen.
      function fin(v, d) { return Number.isFinite(v) ? v : d; }
      // Object.assign over MEAL_DEFAULTS: de klinische niveau-drempels
      // (watch/alert/seriousMmol) en eventuele toekomstige defaults komen zo
      // automatisch mee op het gekalibreerde pad. MEAL_DEFAULTS = enige bron.
      return Object.assign({}, MEAL_DEFAULTS, {
        fastRate: percentile(riseRates, 0.75),
        slowRate: percentile(riseRates, 0.25),
        preDipMmol: fin(median(preDips), MEAL_DEFAULTS.preDipMmol),
        dipToNadirMin: fin(median(peakToNadir), MEAL_DEFAULTS.dipToNadirMin),
        dropWatchRate: Math.max(0.04, fin(learnedDropWatch, MEAL_DEFAULTS.dropWatchRate)),
        dropHighRate: Math.max(0.07, fin(learnedDropHigh, MEAL_DEFAULTS.dropHighRate)),
        dropUrgentRate: Math.max(0.10, fin(learnedDropUrgent, MEAL_DEFAULTS.dropUrgentRate)),
        typicalRiseMmol: fin(median(rises), MEAL_DEFAULTS.typicalRiseMmol),
        typicalDropMmol: fin(median(drops), MEAL_DEFAULTS.typicalDropMmol),
        typicalUndershootMmol: fin(median(undershoots), MEAL_DEFAULTS.typicalUndershootMmol),
        samples: riseRates.length
      });
    } catch (_err) {
      return Object.assign({}, MEAL_DEFAULTS);
    }
  }

  // Leert per browser uit de eigen historie (~5,5 dag beschikbaar). Detecteert
  // stijg-segmenten (bodem → piek ≥0,8 mmol) en bewaart per segment de stijgsnelheid,
  // de pre-dip vóór de bodem en de tijd piek→dal. Rollend (cap MEAL_SAMPLE_CAP),
  // gededupliceerd op bodem-tijd zodat het over dagen verbetert. Spiegelt het patroon
  // van calibrateFromHistory (zelfde localStorage-aanpak).
  function calibrateMealFromHistory(readings) {
    if (!readings || readings.length < 60) return;
    var pts = readings.slice().filter(function (e) {
      return Number.isFinite(readingTime(e)) && Number.isFinite(Number(e.sgv)) && Number(e.sgv) > 20;
    }).sort(function (a, b) { return readingTime(a) - readingTime(b); });
    if (pts.length < 60) return;

    var store;
    try { store = JSON.parse(localStorage.getItem(MEAL_CALIBRATION_KEY) || 'null'); } catch (_e) { store = null; }
    if (!store || !Array.isArray(store.riseRates)) store = { riseRates: [], preDips: [], peakToNadir: [], lastTroughTime: 0 };
    if (!Array.isArray(store.preDips)) store.preDips = [];
    if (!Array.isArray(store.peakToNadir)) store.peakToNadir = [];
    if (!Array.isArray(store.dropRates)) store.dropRates = [];
    if (!Array.isArray(store.rises)) store.rises = [];
    if (!Array.isArray(store.drops)) store.drops = [];
    if (!Array.isArray(store.undershoots)) store.undershoots = [];
    var lastTrough = store.lastTroughTime || 0;
    var maxTrough = lastTrough;

    // Loop over lokale bodems: punt lager dan z'n directe buren.
    for (var i = 1; i < pts.length - 1; i++) {
      var tT = readingTime(pts[i]);
      if (tT <= lastTrough) continue;
      var tMmol = mmol(Number(pts[i].sgv));
      if (!(mmol(Number(pts[i - 1].sgv)) >= tMmol && mmol(Number(pts[i + 1].sgv)) > tMmol)) continue;

      // Piek ná de bodem: hoogste punt totdat het weer ≥0,4 mmol onder die piek zakt.
      var peakMmol = tMmol, peakIdx = i, peakTime = tT;
      for (var j = i + 1; j < pts.length; j++) {
        var v = mmol(Number(pts[j].sgv));
        if (v > peakMmol) { peakMmol = v; peakIdx = j; peakTime = readingTime(pts[j]); }
        else if (peakMmol - v >= 0.4) break;
      }
      var riseMmol = peakMmol - tMmol;
      var riseMin = (peakTime - tT) / 60000;
      if (riseMmol < 0.8 || riseMin <= 0 || riseMin > 90) { continue; }

      // Pre-dip: gemiddeld niveau 20–35 min vóór de bodem, min de bodem.
      var preSum = 0, preN = 0;
      for (var k = i - 1; k >= 0; k--) {
        var dtk = (tT - readingTime(pts[k])) / 60000;
        if (dtk > 35) break;
        if (dtk >= 20) { preSum += mmol(Number(pts[k].sgv)); preN++; }
      }
      // Dal ná de piek (binnen 120 min): laagste punt.
      var nadirMmol = peakMmol, nadirTime = peakTime;
      for (var m = peakIdx + 1; m < pts.length; m++) {
        var dtm = (readingTime(pts[m]) - peakTime) / 60000;
        if (dtm > 120) break;
        var vm = mmol(Number(pts[m].sgv));
        if (vm < nadirMmol) { nadirMmol = vm; nadirTime = readingTime(pts[m]); }
      }

      store.riseRates.push(riseMmol / riseMin);
      store.rises.push(riseMmol);
      if (preN > 0) store.preDips.push((preSum / preN) - tMmol);
      if (nadirTime > peakTime) {
        var dropMin = (nadirTime - peakTime) / 60000;
        var dropMmol = peakMmol - nadirMmol;
        store.peakToNadir.push(dropMin);
        if (dropMmol > 0 && dropMin > 0) store.dropRates.push(dropMmol / dropMin);
        if (dropMmol > 0) store.drops.push(dropMmol);
        store.undershoots.push(tMmol - nadirMmol);
      }
      if (tT > maxTrough) maxTrough = tT;
      i = peakIdx; // spring door naar ná de piek
    }

    function cap(a) { return a.length > MEAL_SAMPLE_CAP ? a.slice(a.length - MEAL_SAMPLE_CAP) : a; }
    store.riseRates = cap(store.riseRates);
    store.preDips = cap(store.preDips);
    store.peakToNadir = cap(store.peakToNadir);
    store.dropRates = cap(store.dropRates);
    store.rises = cap(store.rises);
    store.drops = cap(store.drops);
    store.undershoots = cap(store.undershoots);
    store.lastTroughTime = maxTrough;
    try { localStorage.setItem(MEAL_CALIBRATION_KEY, JSON.stringify(store)); } catch (_err2) {}
  }

  function classifyMealRisk(score) {
    if (score >= 80) return 'urgent';
    if (score >= 60) return 'high';
    if (score >= 35) return 'watch';
    return 'low';
  }

  // Verwachte bodem (mmol/L) van een lopende reactieve daling/plateau: huidig
  // niveau minus de resterende verwachte val (uit de zelf-gekalibreerde
  // typische val + undershoot). Personaliseert vanzelf.
  function projectReactiveNadir(meal, cal) {
    if (!meal || !Number.isFinite(meal.currentMmol)) return null;
    var expectedFall = (Number(cal.typicalDropMmol) || 0) + (Number(cal.typicalUndershootMmol) || 0);
    var alreadyFell = Number.isFinite(meal.dropFromPeak)
      ? meal.dropFromPeak
      : (Number.isFinite(meal.peakMmol) ? meal.peakMmol - meal.currentMmol : 0);
    var remainingFall = Math.max(0, expectedFall - alreadyFell);
    return meal.currentMmol - remainingFall;
  }

  // Escalatieniveau van het maaltijd-vak. Reactieve daling stuurt op de
  // VERWACHTE BODEM t.o.v. universele klinische drempels (niet op de kale
  // daalsnelheid): een daling die ruim boven 3.9 bodemt blijft 'low'; richting
  // <3.9 of <3.0 wordt high/urgent. Snelle val geeft een kleine extra
  // (adrenerge symptomen kunnen ook boven 3.9 optreden).
  function scoreReactiveMealRisk(meal, cal, hypoRisk, peakSignal) {
    if (!meal) return null;
    var score = 0;

    if (meal.phase === 'dip') {
      score += 18;
      if (Number.isFinite(meal.preDipMmol) && meal.preDipMmol >= cal.preDipMmol * 1.5) score += 12;
    } else if (meal.phase === 'plateau') {
      score += 22;
      if (Number.isFinite(meal.peakMmol) && Number.isFinite(meal.currentMmol) && meal.peakMmol - meal.currentMmol < 0.4) score += 6;
    } else if (meal.phase === 'rising') {
      score += 25;
      if (meal.speed === 'snel') score += 18;
      else if (meal.speed === 'normaal') score += 10;
      if (Number.isFinite(meal.riseFromTrough) && meal.riseFromTrough >= cal.typicalRiseMmol) score += 12;
      if (Number.isFinite(meal.effRate) && meal.effRate >= cal.fastRate) score += 12;
    } else if (meal.phase === 'reactive-drop') {
      score += 10;
      var nadir = projectReactiveNadir(meal, cal);
      var serious = Number.isFinite(cal.seriousMmol) ? cal.seriousMmol : MEAL_DEFAULTS.seriousMmol;
      var alert = Number.isFinite(cal.alertMmol) ? cal.alertMmol : MEAL_DEFAULTS.alertMmol;
      var watch = Number.isFinite(cal.watchMmol) ? cal.watchMmol : MEAL_DEFAULTS.watchMmol;
      if (Number.isFinite(nadir)) {
        if (nadir < serious) score += 70;
        else if (nadir < alert) score += 50;
        else if (nadir < watch) score += 25;
      }
      if (Number.isFinite(meal.dropRate)) {
        if (meal.dropRate >= cal.dropUrgentRate) score += 12;
        else if (meal.dropRate >= cal.dropHighRate) score += 6;
      }
    }

    if (peakSignal) {
      if (peakSignal.severity === 'urgent') score += 18;
      else if (peakSignal.severity === 'high') score += 12;
      else if (peakSignal.severity === 'watch') score += 7;
    }
    if (hypoRisk) {
      if (hypoRisk.css === 'urgent' || hypoRisk.css === 'hypo') score += 25;
      else if (hypoRisk.css === 'warning') score += 16;
      else if (hypoRisk.css === 'watch') score += 8;
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score: score, level: classifyMealRisk(score) };
  }

  function updateMealEpisodeMemory(readings, detectedMeal, cal, latestTime, currentMmol) {
    var existing = loadMealEpisode();
    if (existing && Number.isFinite(existing.baselineMmol) && currentMmol <= existing.baselineMmol + 0.3) {
      clearMealEpisode();
      existing = null;
    }

    if (detectedMeal && detectedMeal.phase === 'rising') {
      var episode = existing || {
        schemaVersion: 1,
        phase: 'rising',
        startedAt: latestTime,
        troughTime: latestTime - (detectedMeal.minutesSinceMeal || 0) * 60000,
        troughMmol: currentMmol - (detectedMeal.riseFromTrough || 0),
        baselineMmol: currentMmol - (detectedMeal.riseFromTrough || 0)
      };
      episode.phase = detectedMeal.speed === 'snel' ? 'rising' : (detectedMeal.riseFromTrough >= cal.typicalRiseMmol ? 'rising' : episode.phase);
      episode.lastUpdatedAt = latestTime;
      episode.peakMmol = Math.max(Number(episode.peakMmol) || currentMmol, currentMmol);
      if (episode.peakMmol <= currentMmol) episode.peakTime = latestTime;
      episode.troughTime = episode.troughTime || (latestTime - (detectedMeal.minutesSinceMeal || 0) * 60000);
      episode.troughMmol = Number.isFinite(episode.troughMmol) ? Math.min(episode.troughMmol, currentMmol - (detectedMeal.riseFromTrough || 0)) : currentMmol;
      episode.baselineMmol = Number.isFinite(episode.baselineMmol) ? episode.baselineMmol : episode.troughMmol;
      episode.expiresAt = latestTime + 180 * 60000;
      saveMealEpisode(episode);
      return episode;
    }

    if (!existing) return null;
    existing.lastUpdatedAt = latestTime;
    if (currentMmol > existing.peakMmol) {
      existing.peakMmol = currentMmol;
      existing.peakTime = latestTime;
      existing.phase = 'rising';
      existing.expiresAt = latestTime + 180 * 60000;
      saveMealEpisode(existing);
      return existing;
    }

    var minutesSincePeak = (latestTime - existing.peakTime) / 60000;
    var dropFromPeak = existing.peakMmol - currentMmol;
    var rate10 = null;
    var prev10 = findBaseline(readings, latestTime, 10);
    if (prev10) {
      var dt = (latestTime - readingTime(prev10)) / 60000;
      if (dt > 0) rate10 = (currentMmol - mmol(Number(prev10.sgv))) / dt;
    }
    if (minutesSincePeak >= 10 && dropFromPeak < 0.7 && Math.abs(rate10 || 0) <= 0.03) existing.phase = 'plateau';
    if (dropFromPeak >= 0.7 && (rate10 === null || rate10 < -0.02)) existing.phase = 'reactive-drop';
    if (Date.now() > existing.expiresAt) {
      clearMealEpisode();
      return null;
    }
    saveMealEpisode(existing);
    return existing;
  }

  function mealFromEpisodeMemory(episode, cal, latestTime, currentMmol) {
    if (!episode || !Number.isFinite(episode.peakTime) || !Number.isFinite(episode.peakMmol)) return null;
    var minutesSincePeak = (latestTime - episode.peakTime) / 60000;
    if (!Number.isFinite(minutesSincePeak) || minutesSincePeak < 0 || minutesSincePeak > 180) return null;
    var dropFromPeak = episode.peakMmol - currentMmol;
    var dropRate = minutesSincePeak > 0 ? dropFromPeak / minutesSincePeak : 0;
    if (episode.phase === 'reactive-drop' && dropFromPeak >= 0.7 && dropRate >= cal.dropWatchRate) {
      return {
        phase: 'reactive-drop',
        speed: dropRate >= cal.dropUrgentRate ? 'urgent' : (dropRate >= cal.dropHighRate ? 'hoog' : 'let op'),
        minutesSincePeak: Math.round(minutesSincePeak),
        dropRate: dropRate,
        dropFromPeak: dropFromPeak,
        peakMmol: episode.peakMmol,
        currentMmol: currentMmol,
        expectedDipAt: episode.peakTime + cal.dipToNadirMin * 60000,
        fromMemory: true
      };
    }
    if ((episode.phase === 'plateau' || episode.phase === 'rising') && dropFromPeak < 0.7 && currentMmol > (episode.baselineMmol || 0) + 0.6) {
      return {
        phase: 'plateau',
        speed: 'plateau',
        minutesSincePeak: Math.round(minutesSincePeak),
        peakMmol: episode.peakMmol,
        currentMmol: currentMmol,
        expectedDipAt: episode.peakTime + cal.dipToNadirMin * 60000
      };
    }
    return null;
  }

  function detectMealState(readings) {
    if (!readings || readings.length < 2) return null;
    var cal = loadMealCalibration();
    var latest = readings[0];
    var latestTime = readingTime(latest);
    var currentMmol = mmol(Number(latest.sgv));
    if (!Number.isFinite(latestTime) || !Number.isFinite(currentMmol)) return null;
    function finalizeMealState(meal) {
      var episode = updateMealEpisodeMemory(readings, meal, cal, latestTime, currentMmol);
      return meal || mealFromEpisodeMemory(episode, cal, latestTime, currentMmol);
    }

    var prev10 = findBaseline(readings, latestTime, 10);
    var rate10 = null;
    if (prev10) {
      var dt = (latestTime - readingTime(prev10)) / 60000;
      if (dt > 0) rate10 = (currentMmol - mmol(Number(prev10.sgv))) / dt;
    }

    // Fase 'reactive-drop': na een recente maaltijdpiek is de daling begonnen.
    // Dit voorkomt dat een losse daling zonder voorafgaande stijging als maaltijd wordt gelabeld.
    var recent = readings.filter(function (entry) {
      var time = readingTime(entry);
      var value = mmol(Number(entry.sgv));
      return Number.isFinite(time) && Number.isFinite(value) && time <= latestTime && time >= latestTime - 150 * 60000;
    });
    if (recent.length >= 4) {
      var peak = recent.reduce(function (best, entry) {
        return Number(entry.sgv) > Number(best.sgv) ? entry : best;
      }, recent[0]);
      var peakTime = readingTime(peak);
      var peakMmol = mmol(Number(peak.sgv));
      var minutesSincePeak = (latestTime - peakTime) / 60000;
      if (Number.isFinite(peakTime) && Number.isFinite(peakMmol) && minutesSincePeak >= 5 && minutesSincePeak <= cal.dipToNadirMin + 45) {
        var beforePeak = recent.filter(function (entry) {
          var time = readingTime(entry);
          return Number.isFinite(time) && time < peakTime && time >= peakTime - 90 * 60000;
        });
        if (beforePeak.length >= 2) {
          var priorTrough = beforePeak.reduce(function (lowest, entry) {
            return Number(entry.sgv) < Number(lowest.sgv) ? entry : lowest;
          }, beforePeak[0]);
          var priorTroughMmol = mmol(Number(priorTrough.sgv));
          var riseIntoPeak = peakMmol - priorTroughMmol;
          var dropFromPeak = peakMmol - currentMmol;
          var dropRate = minutesSincePeak > 0 ? dropFromPeak / minutesSincePeak : 0;
          var activelyFalling = rate10 === null || rate10 < -0.02;
          if (activelyFalling && riseIntoPeak >= 0.6 && dropFromPeak >= 0.7 && dropRate >= cal.dropWatchRate) {
            var dropSpeed = dropRate >= cal.dropUrgentRate ? 'urgent' : (dropRate >= cal.dropHighRate ? 'hoog' : 'let op');
            return finalizeMealState({
              phase: 'reactive-drop',
              speed: dropSpeed,
              minutesSincePeak: Math.round(minutesSincePeak),
              dropRate: dropRate,
              dropFromPeak: dropFromPeak,
              peakMmol: peakMmol,
              currentMmol: currentMmol,
              expectedDipAt: peakTime + cal.dipToNadirMin * 60000
            });
          }
        }
      }
    }

    // Lokale bodem (laagste meting) in de afgelopen 60 min — het vermoedelijke startpunt.
    var trough = null;
    var troughMmol = Infinity;
    for (var i = 0; i < readings.length; i++) {
      var t = readingTime(readings[i]);
      if (!Number.isFinite(t) || t > latestTime || t < latestTime - MEAL_TROUGH_WINDOW_MS) continue;
      var v = mmol(Number(readings[i].sgv));
      if (Number.isFinite(v) && v < troughMmol) { troughMmol = v; trough = readings[i]; }
    }
    if (!trough) return null;
    var ageMin = (latestTime - readingTime(trough)) / 60000;
    var riseFromTrough = currentMmol - troughMmol;
    var afterTrough = readings.filter(function (entry) {
      var time = readingTime(entry);
      return Number.isFinite(time) && time > readingTime(trough) && time <= latestTime;
    });
    var sustainedRisePoints = afterTrough.filter(function (entry) {
      return mmol(Number(entry.sgv)) >= troughMmol + 0.45;
    }).length;
    var sustainedRise = sustainedRisePoints >= 2;

    // --- Fase 'rising': bevestigde stijging (prioriteit) ---
    var rising = rate10 !== null ? rate10 > 0 : riseFromTrough >= 0.8;
    if (rising && riseFromTrough > 0) {
      var fastGate = rate10 !== null && rate10 >= cal.slowRate && riseFromTrough >= 0.5 && ageMin >= 5 && sustainedRise;
      var medium = riseFromTrough >= 0.6 && ageMin >= 10 && sustainedRise && (rate10 === null || rate10 >= 0.04 || riseFromTrough >= 1.2);
      var slow = riseFromTrough >= 0.9 && ageMin >= 25 && sustainedRise;
      if (fastGate || medium || slow) {
        var avgRate = ageMin > 0 ? riseFromTrough / ageMin : 0;
        var effRate = Math.max(rate10 || 0, avgRate);
        var speed = effRate >= cal.fastRate ? 'snel' : (effRate < cal.slowRate ? 'langzaam' : 'normaal');
        return finalizeMealState({
          phase: 'rising',
          speed: speed,
          minutesSinceMeal: Math.round(ageMin),
          expectedDipAt: latestTime + cal.dipToNadirMin * 60000,
          riseFromTrough: riseFromTrough,
          effRate: effRate,
          sustainedRisePoints: sustainedRisePoints,
          currentMmol: currentMmol
        });
      }
    }

    // --- Fase 'dip': tentatieve cephale pre-dip (alleen als niet rising) ---
    // Niveau 20–35 min vóór de bodem versus de bodem; bodem zeer recent en afvlakkend.
    var preSum = 0, preN = 0;
    for (var p = 0; p < readings.length; p++) {
      var pt = readingTime(readings[p]);
      var dtp = (latestTime - pt) / 60000;
      var ddt = (readingTime(trough) - pt) / 60000; // t.o.v. de bodem
      if (ddt >= 20 && ddt <= 35) { preSum += mmol(Number(readings[p].sgv)); preN++; }
      if (dtp > 50) break;
    }
    if (preN > 0) {
      var preDip = (preSum / preN) - troughMmol;
      var bottoming = rate10 === null || (rate10 >= -0.02 && rate10 <= 0.05);
      if (preDip >= cal.preDipMmol && ageMin <= 15 && riseFromTrough < 0.5 && bottoming) {
        return finalizeMealState({ phase: 'dip', preDipMmol: preDip, currentMmol: currentMmol });
      }
    }
    return finalizeMealState(null);
  }

  // Testmodus: toon het vak altijd, maar zonder fake maaltijdstatus.
  var MEAL_BADGE_ALWAYS_VISIBLE = true;

  // Spiegelt de getrapte rising-poort uit detectMealState() zodat de idle-reden
  // altijd verklaart waaróm er (nog) geen maaltijd vuurt. Eén bron van waarheid:
  // dezelfde fast/medium/slow-voorwaarden, dezelfde drempels.
  function mealGateReason(rate10, riseFromTrough, ageMin, sustainedRisePoints, cal) {
    if (rate10 !== null && rate10 < -0.02) return 'daling — geen reactieve drop';
    var rising = rate10 !== null ? rate10 > 0 : riseFromTrough >= 0.8;
    if (!(rising && riseFromTrough > 0)) return 'nog geen stijging';
    if (sustainedRisePoints < 2) return 'geen sustained rise';
    function unmet(conds) {
      return conds.filter(function (c) { return !c.ok; }).map(function (c) { return c.msg; });
    }
    var gates = [
      unmet([
        { ok: rate10 !== null && rate10 >= cal.slowRate, msg: 'sneller stijgen' },
        { ok: riseFromTrough >= 0.5, msg: '≥0.5 mmol' },
        { ok: ageMin >= 5, msg: '≥5m' }
      ]),
      unmet([
        { ok: riseFromTrough >= 0.6, msg: '≥0.6 mmol' },
        { ok: ageMin >= 10, msg: '≥10m' },
        { ok: rate10 === null || rate10 >= 0.04 || riseFromTrough >= 1.2, msg: 'meer momentum' }
      ]),
      unmet([
        { ok: riseFromTrough >= 0.9, msg: '≥0.9 mmol' },
        { ok: ageMin >= 25, msg: '≥25m' }
      ])
    ];
    var best = gates[0];
    for (var i = 1; i < gates.length; i++) {
      if (gates[i].length < best.length) best = gates[i];
    }
    if (!best.length) return 'maaltijd-poort open';
    return 'mist: ' + best.join(' + ');
  }

  function mealIdleContext(readings) {
    if (!readings || !readings.length) {
      return {
        label: 'Geen maaltijd',
        rows: ['geen CGM-data']
      };
    }
    var latest = readings[0];
    var latestTime = readingTime(latest);
    var currentMmol = mmol(Number(latest.sgv));
    if (!Number.isFinite(latestTime) || !Number.isFinite(currentMmol)) {
      return {
        label: 'Geen maaltijd',
        rows: ['laatste meting ongeldig']
      };
    }

    var cal = loadMealCalibration();
    var prev10 = findBaseline(readings, latestTime, 10);
    var rate10 = null;
    if (prev10) {
      var rateDt = (latestTime - readingTime(prev10)) / 60000;
      if (rateDt > 0) rate10 = (currentMmol - mmol(Number(prev10.sgv))) / rateDt;
    }

    var recent = readings.filter(function (entry) {
      var time = readingTime(entry);
      var value = mmol(Number(entry.sgv));
      return Number.isFinite(time) && Number.isFinite(value) && time <= latestTime && time >= latestTime - 60 * 60000;
    });

    var trough = null;
    var troughMmol = Infinity;
    var peak = null;
    var peakMmol = -Infinity;
    recent.forEach(function (entry) {
      var value = mmol(Number(entry.sgv));
      if (value < troughMmol) { troughMmol = value; trough = entry; }
      if (value > peakMmol) { peakMmol = value; peak = entry; }
    });

    var reason = 'wachten op patroon';
    var riseFromTrough = null;
    var ageMin = null;
    var sustainedRisePoints = 0;
    if (trough) {
      ageMin = (latestTime - readingTime(trough)) / 60000;
      riseFromTrough = currentMmol - troughMmol;
      sustainedRisePoints = readings.filter(function (entry) {
        var time = readingTime(entry);
        return Number.isFinite(time) && time > readingTime(trough) && time <= latestTime &&
          mmol(Number(entry.sgv)) >= troughMmol + 0.45;
      }).length;
      reason = mealGateReason(rate10, riseFromTrough, ageMin, sustainedRisePoints, cal);
    }
    if (recent.length < 4) reason = 'te weinig recente punten';

    var trend = 'vlak';
    if (rate10 !== null) {
      if (rate10 >= 0.04) trend = 'stijgt';
      else if (rate10 <= -0.04) trend = 'daalt';
    }

    var latestAgeMin = Math.max(0, Math.round((Date.now() - latestTime) / 60000));
    var rows = [
      currentMmol.toFixed(1) + ' mmol · ' + trend + (rate10 !== null ? ' ' + rate10.toFixed(2) + '/min' : ''),
      recent.length + ' punten · laatste ' + latestAgeMin + 'm',
      reason
    ];
    if (peak && trough) {
      rows.push('60m ' + troughMmol.toFixed(1) + '-' + peakMmol.toFixed(1));
    }
    if (Number.isFinite(riseFromTrough) && riseFromTrough > 0.2) {
      rows[2] = reason + ' · ↗ +' + riseFromTrough.toFixed(1);
    }
    return {
      label: 'Geen maaltijd',
      rows: rows.slice(0, 4)
    };
  }

  function renderMealBadge(readings, hypoRisk, peakSignal) {
    var badge = ensureMealBadge();
    var meal = detectMealState(readings);
    if (!meal) {
      if (!MEAL_BADGE_ALWAYS_VISIBLE) {
        badge.style.display = 'none';
        return;
      }
      var idle = mealIdleContext(readings);
      badge.className = 'meal-dip';
      badge.innerHTML = [
        '<span class="meal-ic">🍽</span>',
        '<span class="meal-label">' + idle.label + '</span>'
      ].concat(idle.rows.map(function (row) {
        return '<span class="meal-time">' + row + '</span>';
      })).join('');
      badge.style.display = 'flex';
      positionMealBadge();
      return;
    }
    var cal = loadMealCalibration();
    var risk = scoreReactiveMealRisk(meal, cal, hypoRisk, peakSignal);
    var riskClass = risk && risk.level !== 'low' ? ' meal-risk-' + risk.level : '';
    // Basiskleur van een reactieve daling volgt het risk-level: rood blijft
    // voorbehouden aan high/urgent (verwachte bodem in de hypo-zone); een daling
    // die veilig bodemt krijgt een rustige kleur i.p.v. alarmrood.
    var dropLevel = risk && risk.level ? risk.level : 'high';
    var dropBaseClass = (dropLevel === 'low' || dropLevel === 'watch') ? ('meal-reactive-drop-' + dropLevel) : 'meal-reactive-drop';

    function L(cls, txt) { return '<span class="' + cls + '">' + txt + '</span>'; }
    function num(v, d) { return Number.isFinite(v) ? v.toFixed(d) : null; }

    var rows = [];
    var riskLevelTxt = risk && risk.level && risk.level !== 'low'
      ? (risk.level === 'watch' ? 'let op' : risk.level) : '';
    var riskScore = risk && Number.isFinite(risk.score) ? risk.score.toFixed(2) : '';

    if (meal.phase === 'reactive-drop') {
      badge.className = dropBaseClass + riskClass;
      rows.push(L('meal-ic', '↘'));
      rows.push(L('meal-label', 'Reactieve daling ' + meal.speed));
      if (num(meal.peakMmol, 1) && num(meal.currentMmol, 1)) rows.push(L('meal-time', num(meal.peakMmol, 1) + ' → ' + num(meal.currentMmol, 1)));
      if (num(meal.dropFromPeak, 1)) rows.push(L('meal-time', 'Δ -' + num(meal.dropFromPeak, 1) + ' mmol'));
      if (num(meal.dropRate, 2)) rows.push(L('meal-time', num(meal.dropRate, 2) + '/min'));
      if (Number.isFinite(meal.minutesSincePeak)) rows.push(L('meal-time', meal.minutesSincePeak + 'm na piek'));
      if (Number.isFinite(meal.expectedDipAt)) rows.push(L('meal-time', 'dip ~' + formatClock(meal.expectedDipAt)));
    } else if (meal.phase === 'plateau') {
      badge.className = 'meal-snel' + riskClass;
      rows.push(L('meal-ic', '🍽️'));
      rows.push(L('meal-label', 'Maaltijd plateau'));
      if (num(meal.peakMmol, 1)) rows.push(L('meal-time', 'piek ' + num(meal.peakMmol, 1)));
      if (Number.isFinite(meal.minutesSincePeak)) rows.push(L('meal-time', meal.minutesSincePeak + 'm na piek'));
      if (Number.isFinite(meal.expectedDipAt)) rows.push(L('meal-time', 'dip ~' + formatClock(meal.expectedDipAt)));
    } else if (meal.phase === 'dip') {
      badge.className = 'meal-dip' + riskClass;
      rows.push(L('meal-ic', '🍽'));
      rows.push(L('meal-label', 'Dip — mogelijk maaltijd'));
      if (num(meal.preDipMmol, 1)) rows.push(L('meal-time', 'pre-dip +' + num(meal.preDipMmol, 1)));
      if (num(meal.currentMmol, 1)) rows.push(L('meal-time', num(meal.currentMmol, 1) + ' mmol'));
    } else {
      badge.className = 'meal-' + meal.speed + riskClass;
      rows.push(L('meal-ic', '🍽️'));
      rows.push(L('meal-label', 'Maaltijd ' + meal.speed));
      if (num(meal.currentMmol, 1)) rows.push(L('meal-time', num(meal.currentMmol, 1) + ' mmol'));
      if (num(meal.riseFromTrough, 1)) rows.push(L('meal-time', '↗ +' + num(meal.riseFromTrough, 1) + ' mmol'));
      if (num(meal.effRate, 2)) rows.push(L('meal-time', num(meal.effRate, 2) + '/min'));
      if (Number.isFinite(meal.minutesSinceMeal)) rows.push(L('meal-time', meal.minutesSinceMeal + 'm'));
      if (Number.isFinite(meal.expectedDipAt)) rows.push(L('meal-time', 'dip ~' + formatClock(meal.expectedDipAt)));
    }

    if (riskLevelTxt) rows.push(L('meal-time', 'risico ' + riskLevelTxt + (riskScore ? ' ' + riskScore : '')));

    badge.innerHTML = rows.join('');
    badge.style.display = 'flex';
    positionMealBadge();
  }

  function positionMealBadge() {
    var badge = document.getElementById('cgm-meal-badge');
    if (!badge || badge.style.display === 'none') return;
    // Links vóór de klok: anker op de linkerrand van #currentTime, vak ernaast
    // links, verticaal gecentreerd t.o.v. de klok.
    var clock = document.getElementById('currentTime');
    var bw = badge.getBoundingClientRect().width || 150;
    var bh = badge.getBoundingClientRect().height || 72;
    if (clock) {
      var crect = clock.getBoundingClientRect();
      var top = crect.top + window.scrollY + Math.max(0, (crect.height - bh) / 2);
      badge.style.top = Math.max(0, Math.round(top)) + 'px';
      badge.style.left = Math.max(0, Math.round(crect.left + window.scrollX - bw - 12)) + 'px';
      return;
    }
    var chart = document.querySelector('#chartContainer');
    if (!chart) return;
    var chrect = chart.getBoundingClientRect();
    badge.style.top = Math.max(0, Math.round(chrect.top + window.scrollY + 8)) + 'px';
    badge.style.left = Math.max(0, Math.round(chrect.left + window.scrollX + 8)) + 'px';
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
  var aiSelectedRunId = null;

  function ensureAiToggle() {
    var existing = document.getElementById('cgm-ai-toggle');
    if (existing) return existing;
    var btn = document.createElement('button');
    btn.id = 'cgm-ai-toggle';
    btn.type = 'button';
    btn.textContent = 'Stats & AI';
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
      '<div id="cgm-ai-banner" class="ai-banner"></div>',
      '<div class="ai-tabs">',
      '  <button type="button" class="ai-tab active" data-tab="inzichten">Inzichten</button>',
      '  <button type="button" class="ai-tab" data-tab="stats">Statistiek</button>',
      '  <button type="button" class="ai-tab" data-tab="history">History</button>',
      '  <button type="button" class="ai-tab" data-tab="explore">Explore</button>',
      '  <button type="button" class="ai-tab" data-tab="rapporten">Rapporten</button>',
      '  <button type="button" class="ai-tab" data-tab="chat">Chat</button>',
      '</div>',
      '<div class="ai-pane" data-pane="inzichten">',
      '  <div id="cgm-ai-home"></div>',
      '  <div id="cgm-ai-quicklog" class="ai-quicklog"></div>',
      '  <div id="cgm-ai-patterns"></div>',
      '  <div class="ai-row">',
      '    <select id="cgm-ai-model" aria-label="AI model"></select>',
      '    <button type="button" class="ai-run" id="cgm-ai-run">Review draaien</button>',
      '  </div>',
      '  <div class="ai-status" id="cgm-ai-status"></div>',
      '  <div class="ai-row ai-runrow"><label class="ai-runlabel" for="cgm-ai-run-select">Rapport:</label><select id="cgm-ai-run-select" aria-label="Kies een eerdere review"></select></div>',
      '  <div id="cgm-ai-body"></div>',
      '  <div id="cgm-ai-settings" class="ai-settings"></div>',
      '</div>',
      '<div class="ai-pane" data-pane="stats" hidden><div id="cgm-ai-stats"><div class="ai-empty">Laden…</div></div></div>',
      '<div class="ai-pane" data-pane="history" hidden>',
      '  <div id="cgm-ai-daydetail"></div>',
      '  <div id="cgm-ai-history"><div class="ai-empty">Laden…</div></div>',
      '</div>',
      '<div class="ai-pane" data-pane="explore" hidden>',
      '  <div id="cgm-ai-explore"><div class="ai-empty">Laden…</div></div>',
      '</div>',
      '<div class="ai-pane" data-pane="rapporten" hidden>',
      '  <div class="ai-row"><select id="cgm-ai-report-type" aria-label="Rapporttype"><option value="daily">Dag/14d rapport</option><option value="weekly">Weekrapport</option><option value="period">Periode rapport</option></select><select id="cgm-ai-report-days" aria-label="Rapportvenster"><option value="7">7d</option><option value="14" selected>14d</option><option value="30">30d</option><option value="90">90d</option></select><button type="button" class="ai-run" id="cgm-ai-genreport">Genereer</button></div>',
      '  <div class="ai-status" id="cgm-ai-repstatus"></div>',
      '  <div id="cgm-ai-reports"><div class="ai-empty">Nog geen rapporten.</div></div>',
      '</div>',
      '<div class="ai-pane" data-pane="chat" hidden>',
      '  <div id="cgm-ai-chatlog" class="ai-chatlog"><div class="ai-empty">Stel een vraag over je data. Let op: elk bericht kost AI-quota.</div></div>',
      '  <div id="cgm-ai-chatscope" class="ai-fine"></div>',
      '  <div class="ai-chatrow"><input id="cgm-ai-chatinput" type="text" placeholder="Vraag iets over je glucose…" aria-label="Chatvraag"><button type="button" class="ai-run" id="cgm-ai-chatsend">Stuur</button></div>',
      '</div>'
    ].join('');
    document.body.appendChild(panel);
    panel.querySelector('#cgm-ai-run').addEventListener('click', runAiReviewFromUi);
    panel.querySelector('#cgm-ai-genreport').addEventListener('click', generateAiReport);
    panel.querySelector('#cgm-ai-reports').addEventListener('click', onAiItemClick);
    panel.querySelector('#cgm-ai-chatsend').addEventListener('click', sendAiChat);
    panel.querySelector('#cgm-ai-chatinput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendAiChat(); }
    });
    panel.querySelector('#cgm-ai-model').addEventListener('change', function (e) {
      try { localStorage.setItem(AI_MODEL_KEY, e.target.value); } catch (err) {}
    });
    panel.querySelector('#cgm-ai-run-select').addEventListener('change', function (e) {
      aiSelectedRunId = e.target.value;
      loadAiRun(aiSelectedRunId);
    });
    panel.querySelector('#cgm-ai-body').addEventListener('click', onAiItemClick);
    panel.querySelector('#cgm-ai-stats').addEventListener('click', onAiStatsClick);
    panel.querySelector('#cgm-ai-banner').addEventListener('click', onAiBannerClick);
    panel.querySelector('#cgm-ai-quicklog').addEventListener('click', onAiQuickLogClick);
    panel.querySelector('#cgm-ai-history').addEventListener('click', onAiHistoryClick);
    panel.querySelector('#cgm-ai-explore').addEventListener('click', onAiStatsClick);
    panel.querySelector('#cgm-ai-daydetail').addEventListener('click', onAiStatsClick);
    panel.querySelector('#cgm-ai-daydetail').addEventListener('click', onAiDayActionClick);
    panel.querySelector('#cgm-ai-settings').addEventListener('change', onAiSettingsChange);
    panel.querySelector('#cgm-ai-settings').addEventListener('click', onAiSettingsClick);
    panel.querySelector('.ai-tabs').addEventListener('click', onAiTabClick);
    renderAiQuickLog();
    renderAiSettings();
    return panel;
  }

  function onAiTabClick(event) {
    var btn = event.target && event.target.closest ? event.target.closest('.ai-tab') : null;
    if (!btn) return;
    activateAiTab(btn.getAttribute('data-tab'));
  }

  // --- Rapporten-tab (C/D): genereren kost 1 LLM-call; lezen is gratis.
  var aiReportsLoaded = false;
  var aiPendingReportDate = null;
  function setRepStatus(t) { var el = document.getElementById('cgm-ai-repstatus'); if (el) el.textContent = t || ''; }

  function loadAiReports(force) {
    if (aiReportsLoaded && !force) return;
    aiReportsLoaded = true;
    fetchWithTimeout('/_ai-review/reports?limit=20', { cache: 'no-store' }, 15000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { if (json && json.ok) renderAiReports(json.reports || []); })
      .catch(function () { aiReportsLoaded = false; });
  }

  function generateAiReport() {
    var btn = document.getElementById('cgm-ai-genreport');
    if (btn) btn.disabled = true;
    var date = aiPendingReportDate;
    var typeSel = document.getElementById('cgm-ai-report-type');
    var daysSel = document.getElementById('cgm-ai-report-days');
    var type = date ? 'daily' : (typeSel ? typeSel.value : 'daily');
    var days = daysSel ? parseInt(daysSel.value, 10) || 14 : 14;
    setRepStatus((date ? 'Dagrapport ' + date : (type === 'weekly' ? 'Weekrapport' : (type === 'period' ? 'Periode rapport' : 'Rapport'))) + ' genereren… (kan ~10s duren)');
    fetchWithTimeout('/_ai-review/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: type, date: date || undefined, days: days })
    }, 120000)
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, json: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.json || res.json.ok === false) { setRepStatus('Fout: ' + ((res.json && res.json.message) || 'onbekend')); return; }
        if (res.json.skipped) { setRepStatus('Overgeslagen: ' + res.json.reason); return; }
        setRepStatus('Klaar — model ' + ((res.json.report && res.json.report.model) || res.json.model || '?'));
        aiPendingReportDate = null;
        loadAiReports(true);
      })
      .catch(function (err) { setRepStatus('Fout: ' + (err && err.message ? err.message : err)); })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function renderAiReports(reports) {
    var box = document.getElementById('cgm-ai-reports');
    if (!box) return;
    if (!reports.length) { box.innerHTML = '<div class="ai-empty">Nog geen rapporten. Klik "Genereer dagrapport".</div>'; return; }
    var h = [];
    // Nieuwste rapport bovenaan: sorteer op createdAt aflopend (kopie, bron blijft intact).
    var sorted = reports.slice().sort(function (a, b) {
      return (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0);
    });
    sorted.forEach(function (rep) {
      var scope = rep.scope && rep.scope.type === 'day' && rep.scope.date ? ' · dag ' + rep.scope.date : '';
      var meta = (rep.createdAt ? new Date(rep.createdAt).toLocaleString() : '') + ' · ' + (rep.type || '') + scope + (rep.model ? ' · ' + rep.model : '');
      var body = escapeHtml(rep.body || '').replace(/\n/g, '<br>');
      var statsLine = rep.stats ? '<div class="ai-d-meta">TIR ' + aiNum(rep.stats.tir, '%') + ' · CV ' + aiNum(rep.stats.cv, '%') +
        ' · lows ' + (rep.stats.lows ? rep.stats.lows.count : '–') + '</div>' : '';
      h.push('<div class="ai-item"><div class="ai-item-head"><span class="ai-chev">▸</span><span class="ai-item-title">' +
        escapeHtml(rep.title || 'Rapport') + '</span></div><div class="ai-meta">' + escapeHtml(meta) + '</div>' +
        '<div class="ai-detail"><div class="ai-d-row">' + body + '</div>' + statsLine + '</div></div>');
    });
    box.innerHTML = h.join('');
  }

  function toggleAiPanel() {
    var panel = ensureAiPanel();
    var open = panel.classList.toggle('open');
    if (open) {
      loadAiModels();
      loadAiRuns(true);
      loadAiBanner();
      loadAiPatterns();
      // Ververst alleen de run-lijst (selectie/inhoud blijven), zodat nieuwe
      // achtergrond-runs in de selector verschijnen zonder je weg te trekken.
      if (!aiLatestTimer) aiLatestTimer = window.setInterval(function () { loadAiRuns(false); }, 60000);
    } else if (aiLatestTimer) {
      window.clearInterval(aiLatestTimer);
      aiLatestTimer = null;
    }
  }

  // Vult de run-selector (puur Mongo-reads, geen LLM/quota). selectLatest=true
  // springt naar de nieuwste run (bij openen of na "Review draaien").
  function loadAiRuns(selectLatest) {
    fetchWithTimeout('/_ai-review/runs', { cache: 'no-store' }, 12000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        var sel = document.getElementById('cgm-ai-run-select');
        if (!sel) return;
        var runs = json && Array.isArray(json.runs) ? json.runs : [];
        if (!runs.length) {
          // Alleen oude data zonder runId: verberg selector, val terug op latest.
          sel.style.display = 'none';
          loadAiLatest();
          return;
        }
        sel.style.display = '';
        sel.innerHTML = runs.map(function (run) {
          var label = (run.createdAt ? new Date(run.createdAt).toLocaleString() : '?') +
            ' · ' + (run.model || '?') + ' · ' + (run.observations || 0) + ' obs';
          return '<option value="' + escapeHtml(run.runId) + '">' + escapeHtml(label) + '</option>';
        }).join('');
        var stillPresent = aiSelectedRunId && runs.some(function (run) { return run.runId === aiSelectedRunId; });
        var target = (selectLatest || !stillPresent) ? runs[0].runId : aiSelectedRunId;
        sel.value = target;
        if (target !== aiSelectedRunId) {
          aiSelectedRunId = target;
          loadAiRun(target);
        }
      })
      .catch(function () {});
  }

  function loadAiRun(runId) {
    fetchWithTimeout('/_ai-review/run?id=' + encodeURIComponent(runId), { cache: 'no-store' }, 12000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) {
        if (json && json.ok) renderAiLatest(json.observations || [], json.questions || []);
      })
      .catch(function () {});
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
        loadAiRuns(true);
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
  function aiClock(s) { return s ? new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
  function aiDayMon(s) { if (!s) return ''; var d = new Date(s); return d.getDate() + '-' + (d.getMonth() + 1); }
  // Klok, met datum-prefix als de dag afwijkt van refIso (voor koppelingen over middernacht).
  function aiClockRel(s, refIso) {
    if (!s) return '';
    return (refIso && aiDayMon(s) !== aiDayMon(refIso) ? aiDayMon(s) + ' ' : '') + aiClock(s);
  }
  function aiMinBetween(a, b) { return (a && b) ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000) : null; }
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

  // Statistiek-tab: zelfde accordion, maar bij een episode laden we lui de curve
  // (deterministisch, alleen Mongo-reads — geen LLM/quota).
  function onAiStatsClick(event) {
    var t = event.target;
    var periodBtn = t && t.closest ? t.closest('[data-stats-days]') : null;
    if (periodBtn) {
      event.preventDefault();
      var nd = parseInt(periodBtn.getAttribute('data-stats-days'), 10);
      if (nd && nd !== aiGetSettings().statsDays) {
        var s = aiGetSettings(); s.statsDays = nd;
        try { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
        renderAiSettings();
        aiExploreLoaded = false;
        loadAiStats(true);
      }
      return;
    }
    var secBtn = t && t.closest ? t.closest('[data-ai-section-toggle]') : null;
    if (secBtn) {
      event.preventDefault();
      var sec = secBtn.closest('[data-ai-section]');
      if (sec) sec.classList.toggle('open');
      return;
    }
    var navBtn = t && t.closest ? t.closest('[data-ep-nav]') : null;
    if (navBtn) { event.stopPropagation(); aiEpisodeNav(navBtn.closest('.ai-item'), navBtn.getAttribute('data-ep-nav')); return; }
    var noteBtn = t && t.closest ? t.closest('[data-ep-note]') : null;
    if (noteBtn) { event.stopPropagation(); aiEpisodeNote(noteBtn.closest('.ai-item')); return; }
    var askBtn = t && t.closest ? t.closest('[data-ep-ask]') : null;
    if (askBtn) { event.stopPropagation(); aiEpisodeAsk(askBtn.closest('.ai-item')); return; }
    var simBtn = t && t.closest ? t.closest('[data-sim-peak]') : null;
    if (simBtn) {
      event.stopPropagation();
      var host = simBtn.closest('.ai-item');
      if (host) {
        host.setAttribute('data-ep-kind', simBtn.getAttribute('data-sim-kind') || 'low');
        host.setAttribute('data-ep-peak', simBtn.getAttribute('data-sim-peak'));
        host.removeAttribute('data-curve-loaded');
        aiLoadEpisodeCurve(host);
      }
      return;
    }
    var item = t && t.closest ? t.closest('.ai-item') : null;
    if (!item) return;
    item.classList.toggle('open');
    if (item.classList.contains('open') && item.getAttribute('data-ep-peak') && !item.getAttribute('data-curve-loaded')) {
      aiLoadEpisodeCurve(item);
    }
  }

  // --- Explore-tab: blader door recente high- en low-episodes. Klik = open het
  // bestaande episode-detail (metrics/context/severity/pattern/similar). Geen LLM.
  var aiExploreLoaded = false;
  function loadAiExplore(force) {
    if (aiExploreLoaded && !force) return;
    aiExploreLoaded = true;
    var box = document.getElementById('cgm-ai-explore');
    if (box) box.innerHTML = '<div class="ai-empty">Laden…</div>';
    var days = aiGetSettings().statsDays;
    fetchWithTimeout('/_ai-review/explore-episodes?days=' + days + '&limit=30', { cache: 'no-store' }, 15000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { renderAiExplore(d); })
      .catch(function () { aiExploreLoaded = false; if (box) box.innerHTML = '<div class="ai-empty">Kon episodes niet laden.</div>'; });
  }

  function aiExploreItem(kind, peakAt, badge, head, meta) {
    return '<div class="ai-ep ai-item" data-ep-kind="' + kind + '" data-ep-peak="' + escapeHtml(peakAt || '') + '">' +
      '<div class="ai-ep-head ai-item-head"><span class="ai-chev">▸</span>' +
      '<span class="ai-ex-badge ' + kind + '">' + escapeHtml(badge) + '</span> ' +
      '<span class="ai-item-title">' + escapeHtml(head) + '</span></div>' +
      (meta ? '<div class="ai-meta">' + escapeHtml(meta) + '</div>' : '') +
      '<div class="ai-detail"><div class="ai-curve"></div></div></div>';
  }

  function renderAiExplore(d) {
    var box = document.getElementById('cgm-ai-explore');
    if (!box) return;
    if (!d || !d.ok) { box.innerHTML = '<div class="ai-empty">Geen episodes beschikbaar.</div>'; return; }
    var h = ['<div class="ai-sec">Explore · laatste ' + (d.window ? d.window.days : '') + ' dagen · tik voor diepteanalyse</div>'];
    var highs = d.highs || [], lows = d.lows || [];
    h.push('<div class="ai-sec">High-episodes (' + highs.length + ')</div>');
    if (!highs.length) h.push('<div class="ai-empty">Geen high-episodes in dit venster.</div>');
    highs.forEach(function (e) {
      var head = aiTime(e.peakAt) + ' · piek ' + aiNum(e.peakMmol, '') + ' mmol';
      var meta = (e.durationMinutes != null ? e.durationMinutes + ' min boven 10.0' : '');
      h.push(aiExploreItem('high', e.peakAt, '↑ High', head, meta));
    });
    h.push('<div class="ai-sec">Low-episodes (' + lows.length + ')</div>');
    if (!lows.length) h.push('<div class="ai-empty">Geen low-episodes in dit venster.</div>');
    lows.forEach(function (e) {
      var lbl = e.nadirMmol != null && e.nadirMmol < 3.9 ? '↓ Low' : '↓ Dip';
      var head = aiTime(e.nadirAt || e.peakAt) + ' · dal ' + aiNum(e.nadirMmol, '') + ' mmol';
      var bits = [];
      if (e.peakMmol != null) bits.push('piek ' + e.peakMmol);
      if (e.minutesPeakToNadir != null) bits.push(e.minutesPeakToNadir + 'm');
      if (e.severity) bits.push(e.severity);
      h.push(aiExploreItem('low', e.peakAt, lbl, head, bits.join(' · ')));
    });
    box.innerHTML = h.join('');
  }

  function aiSiblingEpisode(item, dir) {
    var n = dir === 'next' ? item.nextElementSibling : item.previousElementSibling;
    while (n && !(n.classList && n.classList.contains('ai-item') && n.getAttribute('data-ep-peak'))) {
      n = dir === 'next' ? n.nextElementSibling : n.previousElementSibling;
    }
    return n;
  }

  function aiEpisodeNav(item, dir) {
    if (!item) return;
    var target = aiSiblingEpisode(item, dir);
    if (!target) return;
    item.classList.remove('open');
    target.classList.add('open');
    if (target.getAttribute('data-ep-peak') && !target.getAttribute('data-curve-loaded')) aiLoadEpisodeCurve(target);
    if (target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
  }

  function aiEpisodeNote(item) {
    if (!item) return;
    var peak = item.getAttribute('data-ep-peak');
    var note = window.prompt('Notitie bij deze episode (maaltijd/symptoom/context):', '');
    if (note === null || !note.trim()) return;
    fetchWithTimeout('/_ai-review/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'note', note: note, eventAt: peak })
    }, 10000).then(function (r) { return r.ok ? r.json() : null; }).then(function () {
      item.removeAttribute('data-curve-loaded');
      aiLoadEpisodeCurve(item);
      aiPatternsLoaded = false; loadAiPatterns(true);
    }).catch(function () {});
  }

  function aiEpisodeAsk(item) {
    if (!item) return;
    var peak = item.getAttribute('data-ep-peak');
    var kind = item.getAttribute('data-ep-kind') || 'low';
    aiChatScope = null;
    activateAiTab('chat');
    var input = document.getElementById('cgm-ai-chatinput');
    if (input) {
      input.value = 'Analyseer deze ' + (kind === 'high' ? 'high' : 'low/dip') + ' rond ' + aiTime(peak) + ': waarom is hij opvallend, welke context ontbreekt en lijkt hij op eerdere episodes?';
      input.focus();
    }
  }

  function aiLoadEpisodeCurve(item) {
    var host = item.querySelector('.ai-curve');
    if (!host) return;
    var peak = item.getAttribute('data-ep-peak');
    var kind = item.getAttribute('data-ep-kind') || 'low';
    if (!peak) { host.innerHTML = ''; return; }
    item.setAttribute('data-curve-loaded', '1');
    host.innerHTML = '<div class="ai-empty">Curve laden…</div>';
    fetchWithTimeout('/_ai-review/episode-detail?type=' + encodeURIComponent(kind) + '&peakAt=' + encodeURIComponent(peak), { cache: 'no-store' }, 15000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok) { host.innerHTML = '<div class="ai-empty">Curve niet beschikbaar.</div>'; item.removeAttribute('data-curve-loaded'); return; }
        host.innerHTML = aiRenderEpisodeCurve(d);
      })
      .catch(function () { host.innerHTML = '<div class="ai-empty">Curve laden mislukt.</div>'; item.removeAttribute('data-curve-loaded'); });
  }

  var AI_EVENT_GLYPH = { meal: '🍽', snack: '🍪', symptom: '😵', fingerstick: '🩸', exercise: '🏃', stress: '⚡', sleep: '🛌', illness: '🤒', alcohol: '🍷', action: '✅', note: '📝' };
  function aiHM(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  // Afgeleide rate (mmol/L/min) uit een delta en een duur in minuten.
  function aiRate(deltaMmol, minutes) {
    if (deltaMmol == null || minutes == null || !Number.isFinite(Number(minutes)) || Number(minutes) <= 0) return null;
    return Math.round((Number(deltaMmol) / Number(minutes)) * 100) / 100;
  }
  function aiRateStr(deltaMmol, minutes) {
    var r = aiRate(deltaMmol, minutes);
    if (r == null) return '–';
    return (r > 0 ? '+' : '') + r.toFixed(2) + ' mmol/L/min';
  }
  // Compacte metrics-grid (zoals het detailscherm in de screenshots).
  function aiMetricGrid(cells) {
    return '<div class="ai-mgrid">' + cells.map(function (c) {
      return '<div class="ai-mcell ' + (c[2] || '') + '"><div class="ai-mcell-v">' + escapeHtml(String(c[1])) + '</div><div class="ai-mcell-l">' + escapeHtml(c[0]) + '</div></div>';
    }).join('') + '</div>';
  }

  // Focused review (deterministisch, Mongo-reads, geen LLM). GEEN curve: Nightscout
  // toont de glucose-grafiek al — wij geven alleen de analyse (metrics/context/severity).
  function aiRenderEpisodeCurve(d) {
    var kind = d.type === 'high' ? 'high' : 'low';
    var events = d.events || [];
    var headLine = '';
    var h = [];
    if (kind === 'low' && d.episode) {
      var e = d.episode;
      var lowLbl = (Number(e.nadirMmol) < 3.9) ? 'Low' : 'Dip';
      headLine = lowLbl + ' · ' + aiTime(e.nadirAt || e.peakAt) + ' · piek ' + aiNum(e.peakMmol, '') + ' → dal ' + aiNum(e.nadirMmol, '') + ' mmol';
      h.push('<div class="ai-rev-head">' + escapeHtml(headLine) + '</div>');
      // Metrics-grid: nadir, duur, daal-/herstelsnelheid, herstel, hypo-belasting.
      var descRate = e.fallRateMmolPerMin != null ? '-' + Math.abs(Number(e.fallRateMmolPerMin)).toFixed(2) + ' mmol/L/min' : (e.dropFromPeakMmol != null && e.minutesPeakToNadir ? aiRateStr(-e.dropFromPeakMmol, e.minutesPeakToNadir) : '–');
      var recRate = (e.recoveryMinutes && e.nadirMmol != null) ? aiRateStr(3.9 - Number(e.nadirMmol), e.recoveryMinutes) : '–';
      h.push(aiMetricGrid([
        ['Nadir', aiNum(e.nadirMmol, '') + ' mmol', 'low'],
        ['Daalsnelheid', descRate, 'low'],
        ['Piek→nadir', aiNum(e.minutesPeakToNadir, ' min'), ''],
        ['Herstelsnelheid', recRate, ''],
        ['Herstel', aiNum(e.recoveryMinutes, ' min'), ''],
        ['Hypo-belasting', aiNum(e.areaBelow3_9, ' mmol·min'), 'low']
      ]));
      var lm = [];
      if (e.timeBelow3_9Minutes != null) lm.push('onder 3.9: ' + aiNum(e.timeBelow3_9Minutes, 'm'));
      if (e.timeBelow3_0Minutes) lm.push('onder 3.0: ' + aiNum(e.timeBelow3_0Minutes, 'm'));
      if (e.fallRateMmolPerMin != null) lm.push('daling ' + aiNum(e.fallRateMmolPerMin, '') + '/min');
      if (e.recoveryMinutes != null) lm.push('herstel ' + aiNum(e.recoveryMinutes, 'm'));
      if (e.areaBelow3_9 != null) lm.push(aiLabel('areaBelow3_9') + ' ' + aiNum(e.areaBelow3_9, ''));
      if (e.reboundHigh) lm.push('rebound ' + aiNum(e.reboundPeakMmol, '') + ' mmol');
      h.push('<div class="ai-d-row"><b>Metrics:</b> ' + escapeHtml(lm.join(' · ')) + '</div>');
    } else if (kind === 'high' && d.metrics) {
      var m = d.metrics;
      headLine = aiTime(m.peakAt) + ' · piek ' + aiNum(m.peakMmol, '') + ' mmol';
      h.push('<div class="ai-rev-head">' + escapeHtml(headLine) + '</div>');
      // Onset/recovery-rate t.o.v. de 10.0-drempel (geen baseline opgeslagen).
      var onsetMin = (m.startAt && m.peakAt) ? (Date.parse(m.peakAt) - Date.parse(m.startAt)) / 60000 : null;
      var onsetRate = (onsetMin && m.peakMmol != null) ? aiRateStr(Number(m.peakMmol) - 10.0, onsetMin) : '–';
      var hRecRate = (m.recoveryMinutes && m.peakMmol != null) ? aiRateStr(10.0 - Number(m.peakMmol), m.recoveryMinutes) : '–';
      h.push(aiMetricGrid([
        ['Piek', aiNum(m.peakMmol, '') + ' mmol', 'high'],
        ['Boven 10', aiNum(m.durationAbove10Minutes, ' min'), 'high'],
        ['Stijgsnelheid', onsetRate, 'high'],
        ['Herstelsnelheid', hRecRate, ''],
        ['Herstel', aiNum(m.recoveryMinutes, ' min'), ''],
        ['High-belasting', aiNum(m.areaAbove10, ' mmol·min'), 'high']
      ]));
      var mh = [];
      mh.push('boven 10: ' + aiNum(m.durationAbove10Minutes, 'm'));
      if (m.durationAbove13_9Minutes) mh.push('boven 13.9: ' + aiNum(m.durationAbove13_9Minutes, 'm'));
      mh.push(aiLabel('areaAbove10') + ' ' + aiNum(m.areaAbove10, ''));
      if (m.recoveryMinutes != null) mh.push('herstel ' + aiNum(m.recoveryMinutes, 'm'));
      if (m.followedByLow) mh.push('→ low na ' + aiNum(m.followedByLow.minutesToLowPeak, 'm') + ' (nadir ' + aiNum(m.followedByLow.nadirMmol, '') + ')');
      h.push('<div class="ai-d-row"><b>Metrics:</b> ' + escapeHtml(mh.join(' · ')) + '</div>');
    }

    // Wat gebeurde eromheen — trigger, events, nabije highs, feedback.
    var ctx = [];
    if (d.trigger) ctx.push('<div class="ai-d-row"><b>Mogelijke trigger:</b> ' + escapeHtml((AI_EVENT_GLYPH[d.trigger.type] || '') + ' ' + d.trigger.type + ' ~' + d.trigger.minutesBefore + ' min vóór de piek' + (d.trigger.note ? ' (' + d.trigger.note + ')' : '')) + '</div>');
    if (events.length) {
      ctx.push('<div class="ai-d-row"><b>Notities/events:</b> ' + events.map(function (ev) {
        var bits = [(AI_EVENT_GLYPH[ev.type] || '•') + ' ' + ev.type, aiHM(ev.eventAt)];
        if (ev.fingerstickMmol != null) bits.push(ev.fingerstickMmol + ' mmol');
        if (ev.note) bits.push(ev.note);
        return '<span class="ai-ev-chip">' + escapeHtml(bits.join(' ')) + '</span>';
      }).join(' ') + '</div>');
    }
    if (kind === 'low' && d.nearbyHighs && d.nearbyHighs.length) {
      var nh = d.nearbyHighs[d.nearbyHighs.length - 1];
      ctx.push('<div class="ai-d-row"><b>Hoge piek vooraf:</b> ' + escapeHtml(aiNum(nh.peakMmol, '') + ' mmol om ' + aiHM(nh.peakAt)) + '</div>');
    }
    if (d.feedback && d.feedback.length) {
      ctx.push('<div class="ai-d-row"><b>Feedback in venster:</b> ' + escapeHtml(d.feedback.map(function (f) { return f.type + (f.note ? ' (' + f.note + ')' : ''); }).join(' · ')) + '</div>');
    }
    if (ctx.length) h.push('<div class="ai-rev-ctx"><div class="ai-rev-ctx-t">Wat gebeurde eromheen</div>' + ctx.join('') + '</div>');
    else h.push('<div class="ai-rev-ctx"><div class="ai-rev-ctx-t">Wat gebeurde eromheen</div><div class="ai-fine">Geen notities/events in dit venster. Voeg context toe ↓</div></div>');

    // Severity-banden (alleen low) — afgeleid van de nadir.
    if (kind === 'low' && d.episode && d.episode.nadirMmol != null) {
      var nadir = Number(d.episode.nadirMmol);
      var bands = [['Mild', '3.0–3.9', nadir >= 3.0 && nadir < 3.9], ['Significant', '2.8–3.0', nadir >= 2.8 && nadir < 3.0], ['Severe', '<2.8', nadir < 2.8]];
      h.push('<div class="ai-rev-ctx"><div class="ai-rev-ctx-t">Severity</div>' + bands.map(function (b) {
        return '<div class="ai-sevband' + (b[2] ? ' on' : '') + '"><b>' + escapeHtml(b[0]) + '</b>' + (b[2] ? ' <span class="ai-sev-tag">deze</span>' : '') + ' <span class="ai-fine">' + escapeHtml(b[1]) + ' mmol/L</span></div>';
      }).join('') + '</div>');
    }

    // Vergelijking met je normaal (alleen low).
    if (kind === 'low' && d.cohort && d.cohort.count > 2 && d.episode) {
      var c = d.cohort, cmp = [];
      if (c.medianNadirMmol != null) cmp.push('nadir ' + aiNum(d.episode.nadirMmol, '') + ' vs mediaan ' + c.medianNadirMmol);
      if (c.medianDropMmol != null && d.episode.dropFromPeakMmol != null) cmp.push('daling ' + aiNum(d.episode.dropFromPeakMmol, '') + ' vs ' + c.medianDropMmol);
      if (c.medianRecoveryMin != null && d.episode.recoveryMinutes != null) cmp.push('herstel ' + aiNum(d.episode.recoveryMinutes, 'm') + ' vs ' + c.medianRecoveryMin + 'm');
      if (cmp.length) h.push('<div class="ai-d-row"><b>Vergeleken met je ' + c.count + ' recente dips:</b> ' + escapeHtml(cmp.join(' · ')) + '</div>');
    }

    // Pattern-analyse (zelfde tijdvenster, over 30d low / 14d high).
    if (d.pattern && d.pattern.total) {
      var p = d.pattern, plabel = kind === 'low' ? 'lows' : 'highs';
      var pr = ['<div class="ai-rev-ctx"><div class="ai-rev-ctx-t">Patroon</div>'];
      pr.push('<div class="ai-d-row"><b>' + p.count + '/' + p.total + '</b> ' + escapeHtml(p.bucketLabel) + '-' + plabel + ' in ' + escapeHtml(p.window) + (p.fromHM ? ' · tussen ' + escapeHtml(p.fromHM + '–' + p.toHM) : '') + '</div>');
      // Per-dag dot-rij (laatste 7 dagen; gevuld = episode in dit dagdeel).
      if (p.days && p.days.length) {
        pr.push('<div class="ai-dots">' + p.days.map(function (dd) {
          var lbl = (dd.date || '').slice(5).replace('-', '/');
          return '<div class="ai-dot-col"><span class="ai-dot ' + (dd.hit ? ('on ' + kind) : '') + '" title="' + escapeHtml(dd.date + (dd.hit ? ' · episode' : '')) + '"></span><label>' + escapeHtml(lbl) + '</label></div>';
        }).join('') + '</div>');
      }
      var dist = (p.distribution || []).filter(function (x) { return x.count; }).map(function (x) { return x.label + ' ' + x.pct + '%'; }).join(' · ');
      if (dist) pr.push('<div class="ai-fine">verdeling: ' + escapeHtml(dist) + '</div>');
      pr.push('</div>');
      h.push(pr.join(''));
    }

    // Vergelijkbare episodes (klikbaar → laadt die episode in dezelfde kaart).
    if (d.similar && d.similar.length) {
      var sr = ['<div class="ai-rev-ctx"><div class="ai-rev-ctx-t">Vergelijkbare episodes</div>'];
      d.similar.forEach(function (s) {
        var val = kind === 'low' ? aiNum(s.nadirMmol, '') + ' mmol' : aiNum(s.peakMmol, '') + ' mmol';
        var dur = kind === 'low' ? aiNum(s.minutesPeakToNadir, 'm') : aiNum(s.durationMinutes, 'm');
        sr.push('<div class="ai-sim" data-sim-kind="' + kind + '" data-sim-peak="' + escapeHtml(s.peakAt) + '"><span>' + escapeHtml(aiTime(s.peakAt)) + '</span><span><b>' + escapeHtml(val) + '</b> · ' + escapeHtml(dur) + '</span></div>');
      });
      sr.push('</div>');
      h.push(sr.join(''));
    }

    if (d.notableReasons && d.notableReasons.length) {
      h.push('<div class="ai-reasons"><b>Waarom opvallend</b><ul>' +
        d.notableReasons.map(function (r) { return '<li>' + escapeHtml(r) + '</li>'; }).join('') + '</ul></div>');
    }

    // Acties: vorige/volgende episode + notitie bij deze episode.
    h.push('<div class="ai-rev-actions">' +
      '<button type="button" class="ai-rev-btn" data-ep-nav="prev">‹ vorige</button>' +
      '<button type="button" class="ai-rev-btn" data-ep-note="1">+ notitie</button>' +
      '<button type="button" class="ai-rev-btn" data-ep-ask="1">vraag AI</button>' +
      '<button type="button" class="ai-rev-btn" data-ep-nav="next">volgende ›</button>' +
      '</div>');
    h.push('<div class="ai-d-id">review, geen behandeladvies · alleen je eigen data</div>');
    return h.join('');
  }

  // --- Niet-klinische UI-labels (SmartXdrip §20.6): vertaal interne velden naar
  // begrijpelijke taal. API-veldnamen blijven intern; dit is alleen presentatie.
  var AI_LABELS = {
    areaBelow3_9: 'Hypo-belasting (diepte × duur)',
    areaBelow3_0: 'Zware hypo-belasting',
    areaAbove10: 'High-belasting (hoogte × duur)',
    nadir: 'Laagste punt',
    peak: 'Hoogste punt',
    qualityFlags: 'Datakwaliteit',
    single_point_low: 'Losse lage meting',
    possible_compression_low: 'Mogelijk sensor-/drukartefact',
    data_gap_before: 'Datagat ervoor',
    data_gap_during: 'Datagat tijdens',
    data_gap_after: 'Datagat erna',
    lag_sensitive: 'Snelle verandering; CGM kan achterlopen',
    fingerstick_confirmed: 'Vingerprik bevestigd',
    fingerstick_disagreed: 'Vingerprik wijkt af',
    sensor_warmup_or_stale: 'Sensor opwarmen/verouderd',
    postprandialCandidate: 'Mogelijk na maaltijd'
  };
  function aiLabel(key) { return AI_LABELS[key] || String(key); }

  // --- Banner: source-health + helper-reminders (SmartXdrip §20.1/§20.2). Gratis.
  function loadAiBanner() {
    Promise.all([
      fetchWithTimeout('/_ai-review/source-health', { cache: 'no-store' }, 12000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/reminders', { cache: 'no-store' }, 12000).then(function (r) { return r.ok ? r.json() : null; })
    ]).then(function (res) {
      renderAiBanner(res[0], res[1] && res[1].reminders ? res[1].reminders : []);
    }).catch(function () {});
  }

  function renderAiBanner(health, reminders) {
    var el = document.getElementById('cgm-ai-banner');
    if (!el) return;
    var h = [];
    if (health && health.ok) {
      var lvl = health.status === 'good' ? 'goed' : (health.status === 'watch' ? 'let op' : 'slecht');
      var cls = health.status === 'good' ? 'ok' : (health.status === 'watch' ? 'watch' : 'bad');
      h.push('<div class="ai-srchealth ' + cls + '">Bron: <b>' + escapeHtml(lvl) + '</b> · laatste ' +
        (health.ageMinutes != null ? health.ageMinutes + 'm geleden' : '?') + ' · dekking 14d ' + aiNum(health.coverage14d, '%') + '</div>');
    }
    (reminders || []).forEach(function (r) {
      h.push('<div class="ai-reminder ' + escapeHtml(r.severity || 'info') + '" data-rem-key="' + escapeHtml(r.key) + '">' +
        '<div class="ai-rem-txt"><b>' + escapeHtml(r.title || '') + '</b> ' + escapeHtml(r.message || '') + '</div>' +
        '<div class="ai-rem-act"><button type="button" data-rem-action="snooze">snooze 30m</button>' +
        '<button type="button" data-rem-action="ack">gezien</button></div></div>');
    });
    el.innerHTML = h.join('');
  }

  function onAiBannerClick(event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-rem-action]') : null;
    if (!btn) return;
    var row = btn.closest('[data-rem-key]');
    if (!row) return;
    var key = row.getAttribute('data-rem-key');
    var action = btn.getAttribute('data-rem-action');
    row.style.opacity = '0.4';
    fetchWithTimeout('/_ai-review/reminders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: key, action: action })
    }, 10000).then(function () { loadAiBanner(); }).catch(function () { row.style.opacity = ''; });
  }

  // --- Quick-log (SmartXdrip §20.4 / §14): notitie/event toevoegen. POST /events.
  var AI_QUICKLOG = [
    { type: 'meal', label: '🍽 maaltijd' },
    { type: 'snack', label: '🍪 snack' },
    { type: 'symptom', label: '😵 voelde hypo' },
    { type: 'fingerstick', label: '🩸 vingerprik' },
    { type: 'exercise', label: '🏃 beweging' },
    { type: 'action', label: '✅ gegeten/actie' }
  ];
  function renderAiQuickLog() {
    var el = document.getElementById('cgm-ai-quicklog');
    if (!el) return;
    el.innerHTML = '<div class="ai-ql-title">+ notitie (koppelt context aan dips)</div><div class="ai-ql-btns">' +
      AI_QUICKLOG.map(function (q) { return '<button type="button" class="ai-ql-btn" data-ql-type="' + q.type + '">' + escapeHtml(q.label) + '</button>'; }).join('') +
      '</div><div class="ai-ql-status" id="cgm-ai-ql-status"></div>';
  }

  function onAiQuickLogClick(event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-ql-type]') : null;
    if (!btn) return;
    var type = btn.getAttribute('data-ql-type');
    var note = null;
    if (type === 'fingerstick' || type === 'meal' || type === 'snack' || type === 'symptom') {
      note = window.prompt(type === 'fingerstick' ? 'Vingerprik mmol/L (optioneel notitie):' : 'Korte notitie (optioneel):', '');
      if (note === null) return; // geannuleerd
    }
    var body = { type: type, note: note || null };
    if (type === 'fingerstick' && note) { var v = parseFloat(String(note).replace(',', '.')); if (isFinite(v)) body.fingerstickMmol = v; }
    var st = document.getElementById('cgm-ai-ql-status');
    if (st) st.textContent = 'Opslaan…';
    fetchWithTimeout('/_ai-review/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, 10000).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (st) st.textContent = j && j.ok ? 'Genoteerd ✓' : 'Mislukt';
      loadAiPatterns(true);
      window.setTimeout(function () { if (st) st.textContent = ''; }, 2500);
    }).catch(function () { if (st) st.textContent = 'Mislukt'; });
  }

  // --- Pattern cards + recente events in Inzichten (SmartXdrip §19.5). Gratis.
  var aiPatternsLoaded = false;
  function loadAiPatterns(force) {
    if (aiPatternsLoaded && !force) return;
    aiPatternsLoaded = true;
    Promise.all([
      fetchWithTimeout('/_ai-review/patterns', { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/events?limit=8', { cache: 'no-store' }, 12000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/stats?days=1', { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/stats?days=7', { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; })
    ]).then(function (res) {
      renderAiHome(res[2], res[3], res[0]);
      renderAiPatterns(res[0], res[1] && res[1].events ? res[1].events : []);
    }).catch(function () { aiPatternsLoaded = false; });
  }

  // Home-samenvatting: TIR-donut (24u) + AVG/TIR/CV-kaarten + "Inzicht van vandaag".
  function renderAiHome(s24, s7, patterns) {
    var el = document.getElementById('cgm-ai-home');
    if (!el) return;
    if (!s24 || !s24.ok) { el.innerHTML = ''; return; }
    var tir = s24.tir || 0, low = s24.tbr || 0, high = (s24.tar || 0);
    // Conic-gradient ring: laag (rood) · in bereik (groen) · hoog (geel).
    var a1 = low, a2 = low + tir;
    var ring = 'conic-gradient(#fb7185 0 ' + a1 + '%, #4ade80 ' + a1 + '% ' + a2 + '%, #facc15 ' + a2 + '% 100%)';
    var h = ['<div class="ai-home">'];
    h.push('<div class="ai-donut" style="background:' + ring + '"><div class="ai-donut-h"><b>' + Math.round(tir) + '%</b><span>TIR</span></div></div>');
    h.push('<div class="ai-home-r">');
    h.push('<div class="ai-cards ai-home-cards">');
    h.push(aiCard('Gem. 24u', aiNum(s24.mean, ''), ''));
    h.push(aiCard('TIR 24u', aiNum(s24.tir, '%'), 'ok'));
    h.push(aiCard('CV 7d', aiNum(s7 && s7.ok ? s7.cv : null, '%'), ''));
    h.push('</div>');
    h.push('<div class="ai-home-br"><span class="lo">laag ' + aiNum(low, '%') + '</span><span class="in">bereik ' + aiNum(tir, '%') + '</span><span class="hi">hoog ' + aiNum(high, '%') + '</span></div>');
    h.push('</div></div>');
    // Inzicht van vandaag (eerste patroon-kaart als tekst).
    if (patterns && patterns.ok && patterns.cards && patterns.cards.length) {
      var c = patterns.cards[0];
      h.push('<div class="ai-insight"><div class="ai-insight-t">✦ Inzicht van vandaag</div><div class="ai-insight-b">' + escapeHtml(c.body || c.title || '') + '</div></div>');
    }
    el.innerHTML = h.join('');
  }

  function renderAiPatterns(patterns, events) {
    var el = document.getElementById('cgm-ai-patterns');
    if (!el) return;
    var h = [];
    if (patterns && patterns.ok && patterns.cards && patterns.cards.length) {
      h.push('<div class="ai-sec">Patronen</div>');
      patterns.cards.forEach(function (c) {
        h.push('<div class="ai-pcard"><div class="ai-pcard-t">' + escapeHtml(c.title) + '</div><div class="ai-pcard-b">' + escapeHtml(c.body) + '</div></div>');
      });
    }
    if (events && events.length) {
      h.push('<div class="ai-sec">Recente notities</div>');
      events.forEach(function (e) {
        var extra = [];
        if (e.fingerstickMmol != null) extra.push(e.fingerstickMmol + ' mmol');
        if (e.note) extra.push(e.note);
        if (e.relatedEntryMmol != null) extra.push('CGM ' + e.relatedEntryMmol);
        h.push('<div class="ai-fine">' + escapeHtml((e.eventAt ? new Date(e.eventAt).toLocaleString() : '') + ' · ' + (e.type || '') + (extra.length ? ' · ' + extra.join(' · ') : '')) + '</div>');
      });
    }
    el.innerHTML = h.join('');
  }

  // --- History-tab (SmartXdrip §19.2): dagcards, klik -> dagdetail. Gratis.
  var aiHistoryLoaded = false;
  function loadAiHistory(force) {
    if (aiHistoryLoaded && !force) return;
    aiHistoryLoaded = true;
    var box = document.getElementById('cgm-ai-history');
    if (box) box.innerHTML = '<div class="ai-empty">Laden…</div>';
    var days = aiGetSettings().historyDays;
    fetchWithTimeout('/_ai-review/history?days=' + days, { cache: 'no-store' }, 15000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { if (json && json.ok) renderAiHistory(json.history || []); else if (box) box.innerHTML = '<div class="ai-empty">Geen history.</div>'; })
      .catch(function () { aiHistoryLoaded = false; if (box) box.innerHTML = '<div class="ai-empty">Kon history niet laden.</div>'; });
  }

  // Toont bij het openen van History meteen de feed van vandaag, tenzij de
  // gebruiker al een dag heeft aangeklikt (dan blijft die selectie staan).
  var aiTodayEventsLoaded = false;
  function loadAiTodayEvents() {
    if (aiTodayEventsLoaded) return;
    var box = document.getElementById('cgm-ai-daydetail');
    if (box && box.querySelector('.ai-evfeed')) { aiTodayEventsLoaded = true; return; }
    var now = new Date();
    var key = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    aiTodayEventsLoaded = true;
    loadAiDayDetail(key);
  }

  function renderAiHistory(history) {
    var box = document.getElementById('cgm-ai-history');
    if (!box) return;
    if (!history.length) { box.innerHTML = '<div class="ai-empty">Geen dagen met data.</div>'; return; }
    var h = ['<div class="ai-sec">Dag-voor-dag (klik voor detail)</div>'];
    // Nieuwste dag bovenaan: sorteer op datum aflopend (kopie, bron blijft intact).
    var sorted = history.slice().sort(function (a, b) {
      return (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0);
    });
    sorted.forEach(function (d) {
      var sev = d.lowCount > 0 || (d.tbr || 0) >= 4 ? 'low' : (d.highCount > 2 ? 'high' : 'ok');
      var lvl = d.sourceLevel && d.sourceLevel !== 'goed' ? ' · dekking ' + d.coverage + '%' : '';
      var parts = [
        'TIR ' + aiNum(d.tir, '%'),
        'laag ' + aiNum(d.tbr, '%'),
        (d.lowCount || 0) + ' low',
        (d.nearHypoCount || 0) + ' near',
        (d.dipCount || 0) + ' dip',
        (d.highCount || 0) + ' high'
      ];
      if (d.hypoBurden3_9) parts.push('burden ' + d.hypoBurden3_9);
      if (d.worstLowMmol != null) parts.push('diepste low ' + d.worstLowMmol);
      else if (d.worstEpisodeMmol != null) parts.push('laagste episode ' + d.worstEpisodeMmol);
      h.push('<div class="ai-hday ' + sev + '" data-hist-date="' + escapeHtml(d.date) + '">' +
        '<span class="ai-hday-d">' + escapeHtml(d.date) + '</span>' +
        '<span class="ai-hday-m">' + escapeHtml(parts.join(' · ') + lvl) + '</span></div>');
    });
    box.innerHTML = h.join('');
  }

  function onAiHistoryClick(event) {
    var row = event.target && event.target.closest ? event.target.closest('[data-hist-date]') : null;
    if (!row) return;
    event.preventDefault();
    var date = row.getAttribute('data-hist-date');
    Array.prototype.forEach.call(document.querySelectorAll('#cgm-ai-history .ai-hday'), function (r) { r.classList.toggle('sel', r === row); });
    loadAiDayDetail(date);
  }

  function activateAiTab(tab) {
    var panel = document.getElementById('cgm-ai-panel');
    if (!panel) return;
    Array.prototype.forEach.call(panel.querySelectorAll('.ai-tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === tab);
    });
    Array.prototype.forEach.call(panel.querySelectorAll('.ai-pane'), function (p) {
      p.hidden = p.getAttribute('data-pane') !== tab;
    });
    if (tab === 'stats') loadAiStats(true);
    if (tab === 'history') { loadAiHistory(); loadAiTodayEvents(); }
    if (tab === 'explore') loadAiExplore(true);
    if (tab === 'inzichten') loadAiPatterns();
    if (tab === 'rapporten') loadAiReports(true);
    if (tab === 'chat') { renderAiChatScope(); renderAiChat(); }
  }

  function onAiDayActionClick(event) {
    var chatBtn = event.target && event.target.closest ? event.target.closest('[data-day-chat]') : null;
    var reportBtn = event.target && event.target.closest ? event.target.closest('[data-day-report]') : null;
    if (!chatBtn && !reportBtn) return;
    event.preventDefault();
    var date = (chatBtn || reportBtn).getAttribute(chatBtn ? 'data-day-chat' : 'data-day-report');
    if (chatBtn) {
      aiChatScope = { type: 'day', date: date };
      activateAiTab('chat');
      var input = document.getElementById('cgm-ai-chatinput');
      if (input) {
        input.placeholder = 'Vraag over ' + date + '…';
        var q = chatBtn.getAttribute('data-day-question');
        if (q) input.value = q;
        input.focus();
      }
      renderAiChatScope();
      return;
    }
    aiPendingReportDate = date;
    activateAiTab('rapporten');
    generateAiReport();
  }

  function loadAiDayDetail(date) {
    var box = document.getElementById('cgm-ai-daydetail');
    if (!box) return;
    box.innerHTML = '<div class="ai-empty">Dag laden…</div>';
    if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
    Promise.all([
      fetchWithTimeout('/_ai-review/day?date=' + encodeURIComponent(date), { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/glucose-events?date=' + encodeURIComponent(date), { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/day-compare?date=' + encodeURIComponent(date), { cache: 'no-store' }, 20000).then(function (r) { return r.ok ? r.json() : null; })
    ]).then(function (res) {
        var day = res[0], feed = res[1], compare = res[2];
        if ((!day || !day.ok) && (!feed || !feed.ok)) { box.innerHTML = '<div class="ai-empty">Geen dagdetail.</div>'; return; }
        var h = ['<div class="ai-sec">Dagdetail ' + escapeHtml(date) + '</div>'];
        h.push('<div class="ai-rev-actions">' +
          '<button type="button" class="ai-rev-btn" data-day-chat="' + escapeHtml(date) + '">Vraag over deze dag</button>' +
          '<button type="button" class="ai-rev-btn" data-day-report="' + escapeHtml(date) + '">Dagrapport</button>' +
          '</div>');
        if (feed && feed.ok) h.push(renderAiGlucoseEvents(feed));
        if (day && day.ok) {
          h.push(renderAiDayReview(day));
          if (compare && compare.ok) h.push(renderAiDayCompare(compare));
          if (day.suggestions && day.suggestions.length) h.push(renderAiDaySuggestions(day.suggestions, date));
          if (day.contextEvents && day.contextEvents.length) {
            h.push(renderAiContextEvents(day.contextEvents));
          }
          if (day.thresholdLows && day.thresholdLows.length) {
            h.push(renderTodayThresholdLows('Lows < 3.9 dagdetail (alle)', day.thresholdLows));
          }
          if (day.lowEpisodes && day.lowEpisodes.length) {
            h.push(renderDayEpisodeGroup('Reactieve lows dagdetail (piek→daling)', day.lowEpisodes.filter(function (e) { return e.nadirMmol != null && e.nadirMmol < 3.9; })));
            h.push(renderDayEpisodeGroup('Near-hypo’s dagdetail', day.lowEpisodes.filter(function (e) { return e.nadirMmol != null && e.nadirMmol >= 3.9 && e.nadirMmol < 4.5; })));
            h.push(renderDayEpisodeGroup('Dips dagdetail', day.lowEpisodes.filter(function (e) { return !(e.nadirMmol != null && e.nadirMmol < 4.5); })));
          }
        }
        box.innerHTML = h.join('');
      })
      .catch(function () { box.innerHTML = '<div class="ai-empty">Kon dag niet laden.</div>'; });
  }

  function renderAiContextEvents(events) {
    var h = ['<div class="ai-sec">Notities/context deze dag</div>'];
    events.slice(0, 20).forEach(function (e) {
      var bits = [];
      if (e.fingerstickMmol != null) bits.push('vingerprik ' + e.fingerstickMmol + ' mmol');
      if (e.relatedEntryMmol != null) bits.push('CGM ' + e.relatedEntryMmol);
      if (e.note) bits.push(e.note);
      if (e.symptoms && e.symptoms.length) bits.push(e.symptoms.join(', '));
      h.push('<div class="ai-fine">' + escapeHtml(aiHM(e.eventAt) + ' · ' + (AI_EVENT_GLYPH[e.type] || '•') + ' ' + (e.type || 'note') + (bits.length ? ' · ' + bits.join(' · ') : '')) + '</div>');
    });
    return h.join('');
  }

  function renderAiDayCompare(c) {
    var h = ['<div class="ai-sec">Vergelijking</div>'];
    function row(label, cmp) {
      if (!cmp || !cmp.delta) return '';
      var d = cmp.delta;
      var parts = [
        'TIR ' + aiSigned(d.tir, 'pp'),
        'laag ' + aiSigned(d.tbr, 'pp'),
        'gem ' + aiSigned(d.mean, ''),
        'CV ' + aiSigned(d.cv, 'pp'),
        'lows ' + aiSigned(d.lows, ''),
        'burden ' + aiSigned(d.burden3_9, '')
      ];
      return '<div class="ai-fine"><b>' + escapeHtml(label) + ':</b> ' + escapeHtml(parts.join(' · ')) + '</div>';
    }
    h.push(row('vs vorige dag', c.comparisons && c.comparisons.previous));
    h.push(row('vs zelfde weekdag', c.comparisons && c.comparisons.sameWeekday));
    h.push(row('vs 14d baseline', c.comparisons && c.comparisons.baseline14d));
    return h.join('');
  }

  function aiSigned(v, unit) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '–';
    var n = Number(v);
    return (n > 0 ? '+' : '') + n + (unit || '');
  }

  function renderAiDaySuggestions(suggestions, date) {
    var h = ['<div class="ai-sec">Slimme vragen</div>', '<div class="ai-ql-btns">'];
    suggestions.forEach(function (s) {
      h.push('<button type="button" class="ai-ql-btn" data-day-chat="' + escapeHtml(date) + '" data-day-question="' + escapeHtml(s.question || '') + '">' + escapeHtml(s.label || 'Vraag') + '</button>');
    });
    h.push('</div>');
    return h.join('');
  }

  // Glucose Events feed: dag-tegels (TIR/AVG/PEAK/CV) + high-banner + event-tijdlijn.
  var AI_EVENT_ICONS = { first_reading: '☀', rise_local_peak: '↗', fall_local_trough: '↘', high_episode: '↑', recovery_to_range: '↘', stable_window: '〜' };
  function renderAiGlucoseEvents(feed) {
    var s = feed.summary || {};
    var h = [];
    h.push('<div class="ai-cards">');
    h.push(aiCard('TIR', aiNum(s.tir, '%'), 'ok'));
    h.push(aiCard('Gemiddelde', aiNum(s.mean, ''), ''));
    h.push(aiCard('Piek', aiNum(s.max, ''), 'high'));
    h.push(aiCard('CV', aiNum(s.cv, '%'), ''));
    h.push('</div>');
    // High-episodes → uitklapbare diepteanalyse (hergebruikt de Explore-detailcurve).
    var highs = (feed.events || []).filter(function (e) { return e.type === 'high_episode'; });
    if (highs.length) {
      h.push('<div class="ai-sec">High-episode' + (highs.length > 1 ? 's (' + highs.length + ')' : '') + ' · tik voor analyse</div>');
      // Nieuwste bovenaan: sorteer op tijdstip aflopend (kopie, bron blijft intact).
      highs = highs.slice().sort(function (a, b) {
        return (new Date(b.at).getTime() || 0) - (new Date(a.at).getTime() || 0);
      });
      highs.forEach(function (hi) {
        var head = aiTime(hi.at) + ' · piek ' + aiNum(hi.mmol, ' mmol/L');
        h.push(aiExploreItem('high', hi.peakAt, '↑ High', head, hi.detail || ''));
      });
    }
    h.push('<div class="ai-sec">Glucose-events</div>');
    var evs = feed.events || [];
    if (!evs.length) { h.push('<div class="ai-empty">Geen events op deze dag.</div>'); return h.join(''); }
    // Nieuwste bovenaan: sorteer op tijdstip aflopend (kopie, bron blijft intact).
    evs = evs.slice().sort(function (a, b) {
      return (new Date(b.at).getTime() || 0) - (new Date(a.at).getTime() || 0);
    });
    h.push('<div class="ai-evfeed">');
    evs.forEach(function (e) {
      h.push('<div class="ai-ev ' + e.type + '">' +
        '<span class="ai-ev-t">' + escapeHtml(aiTime(e.at)) + '</span>' +
        '<span class="ai-ev-ic">' + (AI_EVENT_ICONS[e.type] || '•') + '</span>' +
        '<span class="ai-ev-b"><span class="ai-ev-l">' + escapeHtml(e.label || '') +
        '<b class="ai-ev-v">' + aiNum(e.mmol, ' mmol/L') + '</b></span>' +
        '<span class="ai-ev-d">' + escapeHtml(e.detail || '') + (e.badge ? ' <span class="ai-ev-badge">' + escapeHtml(e.badge) + '</span>' : '') + '</span></span></div>');
    });
    h.push('</div>');
    return h.join('');
  }

  function renderDayEpisodeGroup(title, list) {
    if (!list || !list.length) return '';
    var h = ['<div class="ai-sec">' + escapeHtml(title + ' (' + list.length + ')') + '</div>'];
    // Nieuwste bovenaan: sorteer op peakAt aflopend (kopie, laat de bron-volgorde intact).
    var sorted = list.slice().sort(function (a, b) {
      return (new Date(b.peakAt).getTime() || 0) - (new Date(a.peakAt).getTime() || 0);
    });
    sorted.forEach(function (e) {
      var head = aiTime(e.peakAt) + ' · ' + aiNum(e.peakMmol, '') + '→' + aiNum(e.nadirMmol, '') + ' mmol' +
        (e.outcome ? ' · ' + e.outcome : '');
      h.push('<div class="ai-ep ai-item" data-ep-kind="low" data-ep-peak="' + escapeHtml(e.peakAt || '') + '">' +
        '<div class="ai-ep-head ai-item-head"><span class="ai-chev">▸</span>' + escapeHtml(head) + '</div>' +
        '<div class="ai-detail"><div class="ai-curve"></div></div></div>');
    });
    return h.join('');
  }

  // --- Settings (SmartXdrip §20.3): vensters in localStorage. Raakt de detector niet.
  var AI_SETTINGS_KEY = 'cgmAiSettings';
  function aiGetSettings() {
    var def = { statsDays: 14, historyDays: 14 };
    try { var s = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}'); return { statsDays: s.statsDays || def.statsDays, historyDays: s.historyDays || def.historyDays }; }
    catch (e) { return def; }
  }
  function renderAiSettings() {
    var el = document.getElementById('cgm-ai-settings');
    if (!el) return;
    var s = aiGetSettings();
    function opts(vals, sel) { return vals.map(function (v) { return '<option value="' + v + '"' + (v === sel ? ' selected' : '') + '>' + v + 'd</option>'; }).join(''); }
    el.innerHTML = '<div class="ai-sec">Instellingen</div>' +
      '<div class="ai-set-row"><label>Statistiek-venster</label><select data-set="statsDays">' + opts([7, 14, 30, 90], s.statsDays) + '</select></div>' +
      '<div class="ai-set-row"><label>History-venster</label><select data-set="historyDays">' + opts([7, 14, 30], s.historyDays) + '</select></div>' +
      '<div class="ai-set-row"><label>Maaltijd-kalibratie</label><span><button type="button" class="ai-rev-btn" data-meal-cal="export">Export</button> <button type="button" class="ai-rev-btn" data-meal-cal="import">Import</button></span></div>' +
      '<div id="cgm-meal-cal-status" class="ai-fine"></div>' +
      '<div class="ai-fine">Doelbereik: laag 3.9 · zeer laag 3.0 · hoog 10.0 · zeer hoog 13.9 mmol/L (vast; detector ongemoeid).</div>';
  }
  function onAiSettingsChange(event) {
    var sel = event.target && event.target.closest ? event.target.closest('[data-set]') : null;
    if (!sel) return;
    var s = aiGetSettings();
    s[sel.getAttribute('data-set')] = parseInt(sel.value, 10) || s[sel.getAttribute('data-set')];
    try { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
    aiStatsLoaded = false; aiHistoryLoaded = false;
    loadAiStats(true); loadAiHistory(true);
  }

  function onAiSettingsClick(event) {
    var btn = event.target && event.target.closest ? event.target.closest('[data-meal-cal]') : null;
    if (!btn) return;
    var status = document.getElementById('cgm-meal-cal-status');
    function setStatus(text) { if (status) status.textContent = text; }
    try {
      if (btn.getAttribute('data-meal-cal') === 'export') {
        var payload = exportMealState();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(payload).then(function () { setStatus('Kalibratie gekopieerd.'); })
            .catch(function () { window.prompt('Kopieer maaltijd-kalibratie:', payload); setStatus('Export klaar.'); });
        } else {
          window.prompt('Kopieer maaltijd-kalibratie:', payload);
          setStatus('Export klaar.');
        }
      } else {
        var raw = window.prompt('Plak maaltijd-kalibratie JSON:');
        if (!raw) return;
        var samples = importMealState(raw);
        setStatus('Import gelukt · ' + samples + ' samples.');
        scheduleRefresh(0, true);
      }
    } catch (err) {
      setStatus('Import/export fout: ' + (err && err.message ? err.message : err));
    }
  }

  // --- Statistiek-tab (A + B): deterministisch, puur Mongo-reads, geen LLM/quota.
  var aiStatsLoaded = false;
  function loadAiStats(force) {
    if (aiStatsLoaded && !force) return;
    aiStatsLoaded = true;
    var box = document.getElementById('cgm-ai-stats');
    if (box) box.innerHTML = '<div class="ai-empty">Laden…</div>';
    var days = aiGetSettings().statsDays;
    Promise.all([
      fetchWithTimeout('/_ai-review/stats?days=' + days, { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/episodes?days=' + days + '&limit=200', { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/day', { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithTimeout('/_ai-review/evaluation?days=' + days, { cache: 'no-store' }, 15000).then(function (r) { return r.ok ? r.json() : null; })
    ]).then(function (res) {
      renderAiStats(res[0], res[1] && res[1].episodes ? res[1].episodes : [], res[2], res[3], res[1]);
    }).catch(function () {
      aiStatsLoaded = false;
      if (box) box.innerHTML = '<div class="ai-empty">Kon statistiek niet laden.</div>';
    });
  }

  function aiNum(v, unit) { return (v === null || v === undefined) ? '–' : (v + (unit || '')); }

  function renderVolatilityImpact(stats, episodes) {
    var rows = [];
    (episodes || []).forEach(function (e) {
      var drop = Number(e.dropFromPeakMmol);
      var min = Number(e.minutesPeakToNadir);
      if (!Number.isFinite(drop) || !Number.isFinite(min) || min <= 0) return;
      var rate = drop / min;
      rows.push({
        at: e.nadirAt || e.peakAt,
        from: e.peakMmol,
        to: e.nadirMmol,
        drop: drop,
        minutes: min,
        rate: rate,
        outcome: e.outcome || '',
        severity: e.severity || ''
      });
    });
    rows = rows.sort(function (a, b) { return b.drop - a.drop; }).slice(0, 6);
    var fastestDrop = stats && Number.isFinite(Number(stats.fastestDrop)) ? Math.abs(Number(stats.fastestDrop)) : null;
    var score = fastestDrop === null ? null : Math.max(0, Math.min(100, Math.round(fastestDrop / 0.35 * 100)));
    var level = score === null ? '' : (score >= 80 ? 'hoog' : (score >= 55 ? 'verhoogd' : (score >= 30 ? 'let op' : 'rustig')));
    var h = ['<div class="ai-sec">Glucose-volatiliteit · snelle sprongen</div>'];
    h.push('<div class="ai-cards">');
    h.push(aiCard('Impactscore 24u', score === null ? '–' : score + '/100', score >= 55 ? 'low' : ''));
    h.push(aiCard('Snelste stijging', stats && stats.fastestRise != null ? signed(stats.fastestRise, 3) + '/min' : '–', 'high'));
    h.push(aiCard('Snelste daling', stats && stats.fastestDrop != null ? signed(stats.fastestDrop, 3) + '/min' : '–', 'low'));
    h.push('</div>');
    h.push('<div class="ai-fine">Interpretatie: dit is een snelheid/volatiliteitssignaal, geen diagnose. Bij snelle dalingen kan CGM achterlopen; bevestig lage waarden bij klachten met vingerprik.</div>');
    if (level) h.push('<div class="ai-fine">Huidige volatiliteitsklasse: ' + escapeHtml(level) + ' · score is gebaseerd op de snelste 24u-samplebeweging.</div>');
    if (rows.length) {
      h.push('<div class="ai-sec">Grootste recente piek→dal sprongen</div>');
      rows.forEach(function (r) {
        var line = aiTime(r.at) + ': ' + aiNum(r.from, '') + ' → ' + aiNum(r.to, '') + ' mmol/L' +
          ' (-' + r.drop.toFixed(1) + ' in ' + Math.round(r.minutes) + 'm, ' + r.rate.toFixed(3) + '/min)' +
          (r.outcome ? ' · ' + r.outcome : '') + (r.severity ? ' · ' + r.severity : '');
        h.push('<div class="ai-fine">' + escapeHtml(line) + '</div>');
      });
    }
    return h.join('');
  }

  function renderAiStats(stats, episodes, day, evaluation, episodeMeta) {
    var box = document.getElementById('cgm-ai-stats');
    if (!box) return;
    if (!stats || !stats.ok) { box.innerHTML = '<div class="ai-empty">Geen statistiek beschikbaar.</div>'; return; }
    var h = [];
    // Periodeknoppen (7/14/30/90) — zetten statsDays en herladen.
    var curDays = stats.window.days;
    h.push('<div class="ai-period">' + [7, 14, 30, 90].map(function (v) {
      return '<button type="button" data-stats-days="' + v + '"' + (v === curDays ? ' class="active"' : '') + '>' + v + 'd</button>';
    }).join('') + '</div>');
    // Metric-kaartjes (TIR/TBR/TAR + gemiddelde/CV) met Δ vs vorige periode.
    var tr = stats.trend || {};
    h.push('<div class="ai-sec">Laatste ' + stats.window.days + ' dagen · dekking ' + aiNum(stats.coveragePct, '%') + '</div>');
    h.push('<div class="ai-cards">');
    h.push(aiCard('In bereik (TIR)', aiNum(stats.tir, '%'), 'ok', aiDelta(tr.tirDelta, 'pp', false)));
    h.push(aiCard('Onder (TBR)', aiNum(stats.tbr, '%'), 'low', aiDelta(tr.lowPctDelta, 'pp', true)));
    h.push(aiCard('Boven (TAR)', aiNum(stats.tar, '%'), 'high'));
    h.push(aiCard('Gemiddelde', aiNum(stats.mean, ''), '', aiDelta(tr.meanDelta, '', 'neutral')));
    h.push(aiCard('Variabiliteit (CV)', aiNum(stats.cv, '%'), '', aiDelta(tr.cvDelta, 'pp', true)));
    h.push(aiCard('Lows', aiNum(stats.lows ? stats.lows.count : null, '') + (stats.lows && stats.lows.longestMin ? ' · ' + stats.lows.longestMin + 'm' : ''), 'low'));
    h.push('</div>');
    h.push('<div class="ai-fine">GMI ' + aiNum(stats.gmi, '%') + ' · mediaan ' + aiNum(stats.median, '') + ' (IQR ' + aiNum(stats.p25, '') + '–' + aiNum(stats.p75, '') + ') · very-low &lt;3.0: ' + aiNum(stats.veryLow, '%') + ' · very-high &gt;13.9: ' + aiNum(stats.veryHigh, '%') + ' · min ' + aiNum(stats.min, '') + ' · max ' + aiNum(stats.max, '') + '</div>');
    h.push(renderStatsFreshness(stats));
    h.push(renderVolatilityImpact(stats, episodes));
    if (stats.reactive) h.push(renderReactiveHypoSummary(stats.reactive));
    if (stats.highToLowContext) h.push(renderHighToLowContext(stats.highToLowContext));
    h.push(renderReactiveHypoInfo());
    if (day && day.ok) {
      h.push(renderAiDayReview(day));
    }
    // Klinische doelen (ADA): TIR>=70, TBR<4, CV<36, GMI<7.
    h.push('<div class="ai-targets">' +
      aiTarget('TIR ≥70%', stats.tir != null && stats.tir >= 70) +
      aiTarget('TBR <4%', stats.tbr != null && stats.tbr < 4) +
      aiTarget('CV <36%', stats.cv != null && stats.cv < 36) +
      aiTarget('GMI <7%', stats.gmi != null && stats.gmi < 7) +
      '</div>');
    // Trend: huidige periode vs direct voorafgaande gelijke periode.
    if (stats.trend && stats.trend.recentTir != null && stats.trend.prevTir != null) {
      var d = stats.trend.tirDelta;
      var arrow = d > 0.5 ? '▲' : (d < -0.5 ? '▼' : '▬');
      var pd = stats.trend.prevDays || stats.window.days;
      h.push('<div class="ai-fine">Trend TIR (laatste ' + pd + 'd vs vorige ' + pd + 'd): ' + stats.trend.prevTir + '% → ' + stats.trend.recentTir + '% ' + arrow +
        ' · laag ' + aiNum(stats.trend.prevLowPct, '%') + ' → ' + aiNum(stats.trend.recentLowPct, '%') + '</div>');
    }
    // AGP-percentielprofiel + 24u TIR-balk (beide uit perHour).
    if (stats.perHour && stats.perHour.length) {
      h.push(renderAiAgp(stats.perHour));
      h.push(renderAiHourlyTir(stats.perHour));
    }
    // Per-uur risicoprofiel (%low per uur) als mini-balken.
    if (stats.perHour && stats.perHour.length) {
      var maxLow = 0;
      stats.perHour.forEach(function (p) { if (p.lowPct > maxLow) maxLow = p.lowPct; });
      h.push('<div class="ai-sec">Wanneer dip ik (% laag per uur)</div>');
      h.push('<div class="ai-hours">');
      stats.perHour.forEach(function (p) {
        var ht = maxLow > 0 ? Math.round((p.lowPct / maxLow) * 26) : 0;
        var title = p.hour + ':00 · ' + p.lowPct + '% laag · gem ' + aiNum(p.mean, '') + ' (n=' + p.n + ')';
        h.push('<div class="ai-hbar" title="' + escapeHtml(title) + '"><span style="height:' + ht + 'px"></span><label>' + (p.hour % 6 === 0 ? p.hour : '') + '</label></div>');
      });
      h.push('</div>');
    }
    // Per-weekdag (%low per dag).
    if (stats.perWeekday && stats.perWeekday.length) {
      var maxWd = 0;
      stats.perWeekday.forEach(function (p) { if (p.lowPct > maxWd) maxWd = p.lowPct; });
      h.push('<div class="ai-sec">Per weekdag (% laag)</div>');
      h.push('<div class="ai-hours ai-wd">');
      stats.perWeekday.forEach(function (p) {
        var ht = maxWd > 0 ? Math.round((p.lowPct / maxWd) * 26) : 0;
        var title = p.day + ' · ' + p.lowPct + '% laag · gem ' + aiNum(p.mean, '') + ' (n=' + p.n + ')';
        h.push('<div class="ai-hbar" title="' + escapeHtml(title) + '"><span style="height:' + ht + 'px"></span><label>' + escapeHtml(p.day) + '</label></div>');
      });
      h.push('</div>');
    }
    if (stats.heatmap && stats.heatmap.length) {
      h.push(renderAiHeatmap(stats.heatmap));
    }
    var totalEpisodes = episodeMeta && episodeMeta.total != null ? episodeMeta.total : episodes.length;
    var returnedEpisodes = episodeMeta && episodeMeta.returned != null ? episodeMeta.returned : episodes.length;
    h.push('<div class="ai-sec">Reactieve episodes in dit venster: ' + totalEpisodes + '</div>');
    if (episodeMeta && episodeMeta.truncated) {
      h.push('<div class="ai-fine">Toont ' + returnedEpisodes + ' van ' + totalEpisodes + ' episodes. Kies een kleiner statistiekvenster als je alles tegelijk wilt zien.</div>');
    }
    // Episode-samenvatting (uit de B-lijst, client-side).
    if (episodes.length) {
      var sumDrop = 0, dropN = 0, sumMin = 0, minN = 0, byOutcome = {}, bySeverity = {};
      var burden39 = 0, poorQuality = 0;
      episodes.forEach(function (e) {
        if (e.dropFromPeakMmol != null) { sumDrop += e.dropFromPeakMmol; dropN++; }
        if (e.minutesPeakToNadir != null) { sumMin += e.minutesPeakToNadir; minN++; }
        var o = e.outcome || 'onbekend'; byOutcome[o] = (byOutcome[o] || 0) + 1;
        var s = e.severity || 'onbekend'; bySeverity[s] = (bySeverity[s] || 0) + 1;
        if (e.areaBelow3_9 != null) burden39 += Number(e.areaBelow3_9) || 0;
        if (e.qualityScore != null && e.qualityScore < 70) poorQuality++;
      });
      var oc = Object.keys(byOutcome).map(function (k) { return k + ': ' + byOutcome[k]; }).join(' · ');
      var sc = Object.keys(bySeverity).map(function (k) { return k + ': ' + bySeverity[k]; }).join(' · ');
      h.push('<div class="ai-fine">Gem. daling ' + (dropN ? (Math.round(sumDrop / dropN * 10) / 10) : '–') + ' mmol · gem. piek→dal ' +
        (minN ? Math.round(sumMin / minN) : '–') + ' min · ' + escapeHtml(oc) + '</div>');
      h.push('<div class="ai-fine">Hypo-burden &lt;3.9: ' + (Math.round(burden39 * 10) / 10) + ' mmol·min · ernst ' +
        escapeHtml(sc || '–') + (poorQuality ? ' · ' + poorQuality + ' met matige/slechte datakwaliteit' : '') + '</div>');
    }
    // Splitsen: echte lows (nadir <3.9) vs dips (daling vanaf piek, niet onder 3.9).
    var lowsList = episodes.filter(function (e) { return e.nadirMmol != null && e.nadirMmol < 3.9; });
    var nearList = episodes.filter(function (e) { return e.nadirMmol != null && e.nadirMmol >= 3.9 && e.nadirMmol < 4.5; });
    var dipsList = episodes.filter(function (e) { return !(e.nadirMmol != null && e.nadirMmol < 4.5); });
    h.push(renderRecentEpisodes(episodes));
    h.push(aiEpisodeSection('Lows (' + lowsList.length + ' getoond) · nadir onder 3.9', lowsList, 'Geen echte lows in dit venster.'));
    if (nearList.length) {
      h.push(aiEpisodeSection('Near-hypo’s (' + nearList.length + ' getoond) · nadir 3.9–4.5', nearList, null));
    }
    if (dipsList.length) {
      h.push(aiEpisodeSection('Dips (' + dipsList.length + ' getoond) · daling vanaf piek — vroeg signaal, niet onder 4.5', dipsList, null));
    }
    if (evaluation && evaluation.ok) h.push(renderAiEvaluation(evaluation));
    box.innerHTML = h.join('');
  }

  // Freshness (nieuwste CGM/episode/build) staat al in renderStatsFreshness;
  // hier alleen de records zelf, om dubbele weergave te voorkomen.
  function renderRecentEpisodes(episodes) {
    // Nieuwste bovenaan: sorteer op nadir/piek aflopend (kopie) en pak dan de eerste 8.
    var recent = (episodes || []).slice().sort(function (a, b) {
      return (new Date(b.nadirAt || b.peakAt).getTime() || 0) - (new Date(a.nadirAt || a.peakAt).getTime() || 0);
    }).slice(0, 8);
    var h = ['<div class="ai-sec">Laatste episode-records</div>'];
    if (!recent.length) {
      h.push('<div class="ai-empty">Geen episode-records in dit venster.</div>');
      return h.join('');
    }
    recent.forEach(function (e) {
      var kind = e.nadirMmol != null && e.nadirMmol < 3.9 ? 'Low' : 'Dip';
      var line = kind + ' · ' + aiTime(e.nadirAt || e.peakAt) + ' · piek ' + aiNum(e.peakMmol, '') +
        ' → nadir ' + aiNum(e.nadirMmol, '') + ' mmol';
      var epMeta = [];
      if (e.minutesPeakToNadir != null) epMeta.push(e.minutesPeakToNadir + 'm');
      if (e.dropFromPeakMmol != null) epMeta.push('daling ' + e.dropFromPeakMmol + ' mmol');
      if (e.outcome) epMeta.push(e.outcome);
      if (e.severity) epMeta.push(e.severity);
      h.push('<div class="ai-fine">' + escapeHtml(line + (epMeta.length ? ' · ' + epMeta.join(' · ') : '')) + '</div>');
    });
    return h.join('');
  }

  function aiEpisodeSection(title, list, emptyText) {
    var rows = [];
    (list || []).forEach(function (e) { rows.push(aiEpisodeListItem(e)); });
    if (!rows.length && emptyText) rows.push('<div class="ai-empty">' + escapeHtml(emptyText) + '</div>');
    return '<div class="ai-episode-section" data-ai-section>' +
      '<button type="button" class="ai-sec" data-ai-section-toggle><span class="ai-chev">▸</span><span>' + escapeHtml(title) + '</span></button>' +
      '<div class="ai-section-body">' + rows.join('') + '</div></div>';
  }

  function renderReactiveHypoSummary(r) {
    var h = ['<div class="ai-sec">Reactieve-hypo profiel</div>', '<div class="ai-cards">'];
    h.push(aiCard('Reactieve episodes', aiNum(r.total, ''), 'low'));
    h.push(aiCard('Hypo / near-hypo', aiNum(r.hypo, '') + ' / ' + aiNum(r.nearHypo, ''), 'low'));
    h.push(aiCard('Mediane nadir', aiNum(r.medianNadirMmol, '') + ' mmol', 'low'));
    h.push(aiCard('Mediane daling', aiNum(r.medianDropMmol, '') + ' mmol', ''));
    h.push(aiCard('Piek→nadir', aiNum(r.medianPeakToNadirMin, 'm'), ''));
    h.push(aiCard('Herstel', aiNum(r.medianRecoveryMin, 'm'), ''));
    h.push('</div>');
    h.push('<div class="ai-fine">Burden &lt;3.9: ' + aiNum(r.totalAreaBelow3_9, '') + ' mmol·min · tijd &lt;3.9: ' + aiNum(r.totalTimeBelow3_9Min, 'm') +
      ' · rebound-high: ' + aiNum(r.reboundHigh, '') + ' · mogelijk postprandiaal: ' + aiNum(r.pctPostprandialCandidate, '%') + ' · matige datakwaliteit: ' + aiNum(r.pctPoorQuality, '%') + '</div>');
    h.push('<div class="ai-fine">Uitkomsten — ' + escapeHtml(aiCounts(r.byOutcome)) + '</div>');
    h.push('<div class="ai-fine">Ernst — ' + escapeHtml(aiCounts(r.bySeverity)) + ' · curvevorm — ' + escapeHtml(aiCounts(r.byShape)) + '</div>');
    if (r.artefactFlags && (r.artefactFlags.singlePoint || r.artefactFlags.possibleCompression)) {
      h.push('<div class="ai-fine">Artefact-check: single-point lows ' + r.artefactFlags.singlePoint + ' · mogelijke compressie-lows ' + r.artefactFlags.possibleCompression + '</div>');
    }
    return h.join('');
  }

  function renderStatsFreshness(stats) {
    var latestEntry = stats.latestEntryAt ? new Date(stats.latestEntryAt) : null;
    var latestEpisode = stats.reactive && stats.reactive.latestPeakAt ? new Date(stats.reactive.latestPeakAt) : null;
    var builtAt = stats.episodesBuiltAt ? new Date(stats.episodesBuiltAt) : null;
    var parts = [];
    if (latestEntry) parts.push('nieuwste CGM ' + latestEntry.toLocaleString());
    if (latestEpisode) parts.push('nieuwste episode ' + latestEpisode.toLocaleString());
    if (builtAt) parts.push('episodes bijgewerkt ' + builtAt.toLocaleString());
    if (!parts.length) return '';
    // Stale = de build heeft de nieuwste metingen nog niet verwerkt — NIET dat er
    // simpelweg geen recente daling was (dat is juist de gezonde toestand).
    var stale = latestEntry && builtAt && (latestEntry.getTime() - builtAt.getTime()) > 60 * 60 * 1000;
    return '<div class="ai-fine">' + escapeHtml(parts.join(' · ')) +
      (stale ? ' · build loopt achter: draai episodes:build om episodes bij te werken' : '') + '</div>';
  }

  function renderHighToLowContext(ctx) {
    var h = ['<div class="ai-sec">High→low context · relevant</div>'];
    h.push('<div class="ai-fine">' + aiNum(ctx.relevant, '') + ' relevante koppeling(en) van ' + aiNum(ctx.total, '') + ' high→low patroon(en) in dit venster.</div>');
    var list = (ctx.top && ctx.top.length ? ctx.top : (ctx.recent || [])).slice(0, 5);
    if (!list.length) {
      h.push('<div class="ai-empty">Geen high→low koppelingen in dit venster.</div>');
      return h.join('');
    }
    list.forEach(function (x) { h.push(renderHighToLowItem(x)); });
    return h.join('');
  }

  // Toont alle vier de tijdstippen expliciet (high-piek, high-einde, low-piek =
  // start daling, low-nadir) + de deelintervallen, zodat de getoonde tijden en de
  // minuten op hetzelfde meten. Datum één keer als anker; afwijkende dagen krijgen
  // een eigen datum-prefix (koppelingen over middernacht).
  function renderHighToLowItem(x) {
    var ref = x.highPeakAt;
    var line = aiDayMon(x.highPeakAt) + ': high-piek ' + aiClock(x.highPeakAt) + ' ' + aiNum(x.highPeakMmol, '') + ' mmol' +
      (x.highEndAt ? ' · high-einde ' + aiClockRel(x.highEndAt, ref) : '') +
      (x.lowPeakAt ? ' → daling vanaf ' + aiClockRel(x.lowPeakAt, ref) : '') +
      ' → nadir ' + aiClockRel(x.lowNadirAt || x.lowPeakAt, ref) + ' ' + aiNum(x.lowNadirMmol, '') + ' mmol';
    var descentMin = aiMinBetween(x.lowPeakAt, x.lowNadirAt);
    var meta = [];
    if (x.highDurationMinutes != null) meta.push('high duurde ' + x.highDurationMinutes + 'm');
    if (x.minutesHighEndToLowPeak != null) meta.push(x.minutesHighEndToLowPeak + 'm high→daling');
    if (descentMin != null) meta.push(descentMin + 'm daling');
    if (x.lowDropFromPeakMmol != null) meta.push('Δ ' + x.lowDropFromPeakMmol + ' mmol');
    if (x.lowAreaBelow3_9 != null) meta.push('burden ' + x.lowAreaBelow3_9);
    if (x.lowOutcome) meta.push(x.lowOutcome);
    if (x.lowSeverity) meta.push(x.lowSeverity);
    if (x.relevantReasons && x.relevantReasons.length) meta.push('relevant: ' + x.relevantReasons.join(', '));
    return '<div class="ai-fine">' + escapeHtml(line + ' · ' + meta.join(' · ')) + '</div>';
  }

  function renderReactiveHypoInfo() {
    return '<div class="ai-sec">Wat telt hier als reactief patroon</div>' +
      '<div class="ai-fine">Reactieve/postprandiale hypoglykemie betekent meestal: klachten of lage glucose na eten, vaak binnen enkele uren. De app telt daarom vooral piek→nadir episodes, near-hypo (&lt;4.5), hypo (&lt;4.0), duur onder 3.9, rebound, herstel en datakwaliteit. Medisch blijft Whipple belangrijk: passende klachten, lage glucose op dat moment en verbetering na koolhydraten.</div>' +
      '<div class="ai-fine">Let op interpretatie: CGM loopt bij snelle dalingen achter op bloedglucose en losse nachtelijke lage punten kunnen compressie/meetartefact zijn. Vingerprik en context-notities maken deze statistiek veel betrouwbaarder.</div>';
  }

  function aiCounts(obj) {
    var keys = Object.keys(obj || {});
    if (!keys.length) return '–';
    return keys.map(function (k) { return k + ': ' + obj[k]; }).join(' · ');
  }

  // Eén episode-rij (low of dip). data-ep-kind blijft 'low' want beide staan in
  // reactive_hypo_episodes en worden via episode-detail?type=low opgehaald.
  function aiEpisodeListItem(e) {
    var when = e.peakAt ? new Date(e.peakAt).toLocaleString() : '?';
    var tags = [];
    if (e.outcome) tags.push(e.outcome);
    if (e.severity) tags.push(e.severity);
    if (e.shape) tags.push(e.shape);
    var head = (e.peakMmol != null ? e.peakMmol : '?') + '→' + (e.nadirMmol != null ? e.nadirMmol : '?') + ' mmol · ' +
      (e.minutesPeakToNadir != null ? e.minutesPeakToNadir + 'm' : '?') + (tags.length ? ' · ' + tags.join(' · ') : '');
    var meta = [];
    if (e.dropFromPeakMmol != null) meta.push('daling ' + e.dropFromPeakMmol + ' mmol');
    if (e.dropFromPeakPercent != null) meta.push(e.dropFromPeakPercent + '%');
    if (e.fallRateMmolPerMin != null) meta.push('gem. val ' + e.fallRateMmolPerMin + '/min');
    if (e.maxFallRate30m != null) meta.push('max ' + e.maxFallRate30m + '/min');
    if (e.timeBelow3_9Minutes != null) meta.push('<3.9 ' + e.timeBelow3_9Minutes + 'm');
    if (e.areaBelow3_9 != null) meta.push('burden ' + e.areaBelow3_9);
    if (e.recoveryMinutes != null) meta.push('herstel ' + e.recoveryMinutes + 'm');
    if (e.reboundHigh) meta.push('rebound ' + aiNum(e.reboundPeakMmol, ''));
    if (e.qualityScore != null) meta.push('datakwaliteit ' + e.qualityScore + '%');
    if (e.qualityFlags && e.qualityFlags.length) meta.push(e.qualityFlags.map(aiLabel).join(', '));
    meta.push(when);
    return '<div class="ai-ep ai-item" data-ep-kind="low" data-ep-peak="' + escapeHtml(e.peakAt || '') + '"><div class="ai-ep-head ai-item-head"><span class="ai-chev">▸</span>' + escapeHtml(head) + '</div><div class="ai-meta">' + escapeHtml(meta.join(' · ')) + '</div>' + aiEpisodeDetailHtml(e) + '</div>';
  }

  function renderAiEvaluation(ev) {
    var h = ['<div class="ai-sec">Evaluatie (' + ev.window.days + 'd) · meet of het beter wordt</div>'];
    var sev = Object.keys(ev.bySeverity || {}).map(function (k) { return k + ': ' + ev.bySeverity[k]; }).join(' · ');
    h.push('<div class="ai-cards">');
    h.push(aiCard('Episodes', aiNum(ev.episodes, ''), 'low'));
    h.push(aiCard(aiLabel('areaBelow3_9'), aiNum(ev.areaBelow3_9, ''), 'low'));
    h.push(aiCard('Mediane herstel', aiNum(ev.medianRecoveryMin, 'm'), ''));
    h.push(aiCard('Matige datakwaliteit', aiNum(ev.pctPoorQuality, '%'), ''));
    h.push(aiCard('Vingerprik-bevestigd', aiNum(ev.pctFingerstickConfirmed, '%'), 'ok'));
    h.push(aiCard('Mogelijk na maaltijd', aiNum(ev.pctPostprandial, '%'), ''));
    h.push('</div>');
    if (sev) h.push('<div class="ai-fine">Ernst — ' + escapeHtml(sev) + '</div>');
    var tod = Object.keys(ev.byTimeOfDay || {}).map(function (k) { return k + ': ' + ev.byTimeOfDay[k]; }).join(' · ');
    if (tod) h.push('<div class="ai-fine">Tijd van dag — ' + escapeHtml(tod) + '</div>');
    var fb = Object.keys(ev.feedback || {}).map(function (k) { return k + ': ' + ev.feedback[k]; }).join(' · ');
    if (fb) h.push('<div class="ai-fine">Feedback — ' + escapeHtml(fb) + '</div>');
    return h.join('');
  }

  function renderAiDayReview(day) {
    var h = [];
    var stat = day.stats || {};
    var notable = day.notable || {};
    var source = day.sourceHealth || {};
    h.push('<div class="ai-sec">Vandaag</div>');
    h.push('<div class="ai-fine">' + escapeHtml(day.summary || '') + '</div>');
    h.push('<div class="ai-cards">');
    h.push(aiCard('Vandaag TIR', aiNum(stat.tir, '%'), 'ok'));
    h.push(aiCard('Vandaag laag', aiNum(stat.tbr, '%'), 'low'));
    h.push(aiCard('High episodes', aiNum(day.highEpisodes ? day.highEpisodes.length : null, ''), 'high'));
    h.push(aiCard('Lows <3.9', aiNum(day.thresholdLows ? day.thresholdLows.length : (day.lowEpisodes ? day.lowEpisodes.length : null), ''), 'low'));
    h.push(aiCard('Daal-episodes', aiNum(day.lowEpisodes ? day.lowEpisodes.length : null, ''), 'low'));
    h.push(aiCard('Burden <3.9', aiNum(notable.hypoBurden3_9, ''), 'low'));
    h.push(aiCard('Datakwaliteit', source.level || '–', source.level === 'goed' ? 'ok' : ''));
    h.push('</div>');
    var notes = [];
    if (notable.worstLow) notes.push('diepste low ' + notable.worstLow.nadirMmol + ' mmol om ' + aiTime(notable.worstLow.nadirAt));
    if (notable.worstHigh) notes.push('hoogste high ' + notable.worstHigh.peakMmol + ' mmol om ' + aiTime(notable.worstHigh.peakAt));
    if (source.longestGapMinutes != null) notes.push('langste datagat ' + source.longestGapMinutes + 'm');
    if (day.highToLow && day.highToLow.length) notes.push(day.highToLow.length + ' high→low koppeling(en)');
    if (notes.length) h.push('<div class="ai-fine">' + escapeHtml(notes.join(' · ')) + '</div>');
    if (day.highEpisodes && day.highEpisodes.length) {
      h.push('<div class="ai-sec">High episodes vandaag</div>');
      day.highEpisodes.slice(0, 5).forEach(function (e) {
        h.push('<div class="ai-ep ai-item" data-ep-kind="high" data-ep-peak="' + escapeHtml(e.peakAt || '') + '">' +
          '<div class="ai-ep-head ai-item-head"><span class="ai-chev">▸</span>' + escapeHtml(aiTime(e.peakAt) + ' · piek ' + e.peakMmol + ' mmol · ' + e.durationMinutes + 'm') + '</div>' +
          '<div class="ai-detail"><div class="ai-curve"></div></div></div>');
      });
    }
    if (day.thresholdLows && day.thresholdLows.length) {
      h.push(renderTodayThresholdLows('Lows < 3.9 vandaag (alle)', day.thresholdLows));
    }
    if (day.lowEpisodes && day.lowEpisodes.length) {
      h.push(renderTodayEpisodeGroup('Reactieve lows vandaag (piek→daling)', day.lowEpisodes.filter(function (e) { return e.nadirMmol != null && e.nadirMmol < 3.9; })));
      h.push(renderTodayEpisodeGroup('Near-hypo’s vandaag', day.lowEpisodes.filter(function (e) { return e.nadirMmol != null && e.nadirMmol >= 3.9 && e.nadirMmol < 4.5; })));
      h.push(renderTodayEpisodeGroup('Dips vandaag', day.lowEpisodes.filter(function (e) { return !(e.nadirMmol != null && e.nadirMmol < 4.5); })));
    }
    if (day.highToLow && day.highToLow.length) {
      h.push('<div class="ai-sec">High→low context</div>');
      day.highToLow.slice(0, 5).forEach(function (x) {
        h.push(renderHighToLowItem(x));
      });
    }
    return h.join('');
  }

  // Drempel-lows: elke dip onder 3.9 (zoals Libre / de gekleurde puntjes op de lijn),
  // los van de reactieve piek→daling-detectie. Uitklapbaar (.ai-item) met een inline
  // metrics-detail uit de eigen velden — geen peakAt-anchor/curve-fetch nodig: deze runs
  // staan niet in de reactieve_hypo_episodes-store.
  function thresholdLowBand(nadirMmol) {
    var v = Number(nadirMmol);
    if (v < 3.0) return 'Zeer laag (<3.0)';
    if (v < 3.5) return 'Laag (3.0–3.5)';
    return 'Mild laag (3.5–3.9)';
  }
  function renderTodayThresholdLows(title, list) {
    if (!list || !list.length) return '';
    var h = ['<div class="ai-sec">' + escapeHtml(title + ' (' + list.length + ') · tik voor detail') + '</div>'];
    // Nieuwste bovenaan: sorteer op nadirAt aflopend (kopie, laat de bron-volgorde intact).
    var sorted = list.slice().sort(function (a, b) {
      return (new Date(b.nadirAt).getTime() || 0) - (new Date(a.nadirAt).getTime() || 0);
    });
    sorted.slice(0, 12).forEach(function (e) {
      var meta = [];
      if (e.durationMinutes != null) meta.push('<3.9 ' + e.durationMinutes + 'm');
      if (e.pointCount != null) meta.push(e.pointCount + ' pt');
      if (e.areaBelow3_9 != null) meta.push('burden ' + e.areaBelow3_9);
      var head = aiTime(e.nadirAt) + ' · dal ' + aiNum(e.nadirMmol, '') + ' mmol' + (meta.length ? ' · ' + meta.join(' · ') : '');
      var grid = aiMetricGrid([
        ['Nadir', aiNum(e.nadirMmol, '') + ' mmol', 'low'],
        ['Duur <3.9', aiNum(e.durationMinutes, ' min'), ''],
        ['Metingen', aiNum(e.pointCount, ''), ''],
        ['Hypo-belasting', aiNum(e.areaBelow3_9, ' mmol·min'), 'low'],
        ['Start', aiHM(e.startAt), ''],
        ['Eind', aiHM(e.endAt), '']
      ]);
      h.push('<div class="ai-ep ai-item">' +
        '<div class="ai-ep-head ai-item-head"><span class="ai-chev">▸</span>' + escapeHtml(head) + '</div>' +
        '<div class="ai-detail">' +
          '<div class="ai-rev-head">' + escapeHtml(thresholdLowBand(e.nadirMmol) + ' · ' + aiTime(e.nadirAt)) + '</div>' +
          grid +
        '</div></div>');
    });
    return h.join('');
  }

  function renderTodayEpisodeGroup(title, list) {
    if (!list || !list.length) return '';
    var h = ['<div class="ai-sec">' + escapeHtml(title + ' (' + list.length + ')') + '</div>'];
    // Nieuwste bovenaan: sorteer op peakAt aflopend (kopie, laat de bron-volgorde intact).
    var sorted = list.slice().sort(function (a, b) {
      return (new Date(b.peakAt).getTime() || 0) - (new Date(a.peakAt).getTime() || 0);
    });
    sorted.slice(0, 5).forEach(function (e) {
      var meta = [];
      if (e.outcome) meta.push(e.outcome);
      if (e.severity) meta.push(e.severity);
      if (e.shape) meta.push(e.shape);
      if (e.timeBelow3_9Minutes != null) meta.push('<3.9 ' + e.timeBelow3_9Minutes + 'm');
      if (e.areaBelow3_9 != null) meta.push('burden ' + e.areaBelow3_9);
      h.push('<div class="ai-ep ai-item" data-ep-kind="low" data-ep-peak="' + escapeHtml(e.peakAt || '') + '">' +
        '<div class="ai-ep-head ai-item-head"><span class="ai-chev">▸</span>' +
        escapeHtml(aiTime(e.peakAt) + ' · ' + aiNum(e.peakMmol, '') + '→' + aiNum(e.nadirMmol, '') + ' mmol' + (meta.length ? ' · ' + meta.join(' · ') : '')) +
        '</div><div class="ai-detail"><div class="ai-curve"></div></div></div>');
    });
    return h.join('');
  }

  // AGP: gevulde percentielbanden (p10–p90 licht, p25–p75 donker) + medianlijn p50,
  // over 24 uur. Puur SVG uit stats.perHour; geen externe lib.
  function renderAiAgp(perHour) {
    if (!perHour || !perHour.length) return '';
    var pts = perHour.filter(function (p) { return p.p50 != null; });
    if (pts.length < 4) return '';
    var W = 320, H = 120, padL = 22, padR = 6, padT = 6, padB = 14;
    var yMin = 3, yMax = 14;
    var x = function (hour) { return padL + (hour / 23) * (W - padL - padR); };
    var y = function (v) {
      var cl = Math.max(yMin, Math.min(yMax, v));
      return padT + (1 - (cl - yMin) / (yMax - yMin)) * (H - padT - padB);
    };
    // Gesloten band-polygoon tussen twee percentiel-series (heen langs lo, terug langs hi).
    function band(loKey, hiKey) {
      var fwd = pts.map(function (p) { return x(p.hour) + ',' + y(p[loKey]); });
      var bwd = pts.slice().reverse().map(function (p) { return x(p.hour) + ',' + y(p[hiKey]); });
      return fwd.concat(bwd).join(' ');
    }
    function line(key) { return pts.map(function (p) { return x(p.hour) + ',' + y(p[key]); }).join(' '); }
    var parts = ['<div class="ai-sec">AGP — 24-uurs patroon (' + pts[0].n + '+ p/uur)</div>', '<div class="ai-agp">'];
    parts.push('<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="AGP percentielprofiel">');
    // Doellijnen 3.9 en 10.0.
    [[3.9, '#22c55e'], [10.0, '#eab308']].forEach(function (t) {
      parts.push('<line x1="' + padL + '" y1="' + y(t[0]).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(t[0]).toFixed(1) + '" stroke="' + t[1] + '" stroke-opacity=".35" stroke-dasharray="3 3" stroke-width="1"/>');
    });
    parts.push('<polygon points="' + band('p10', 'p90') + '" fill="#4ade80" fill-opacity=".14"/>');
    parts.push('<polygon points="' + band('p25', 'p75') + '" fill="#4ade80" fill-opacity=".28"/>');
    parts.push('<polyline points="' + line('p50') + '" fill="none" stroke="#4ade80" stroke-width="1.6"/>');
    // Y-labels.
    [3.9, 7, 10, 14].forEach(function (v) {
      parts.push('<text x="2" y="' + (y(v) + 3).toFixed(1) + '" fill="#9ca3af" font-size="7">' + v + '</text>');
    });
    parts.push('</svg>');
    parts.push('<div class="ai-tiraxis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>');
    parts.push('</div>');
    return parts.join('');
  }

  // 24-cellen TIR-balk: kleur per uur van rood (laag TIR) → groen (hoog TIR).
  function renderAiHourlyTir(perHour) {
    if (!perHour || !perHour.length) return '';
    var cells = [];
    for (var hh = 0; hh < 24; hh++) {
      var p = perHour[hh] || {};
      var tir = p.n ? (p.tir || 0) : null;
      var bg;
      if (tir == null) { bg = 'rgba(255,255,255,.05)'; }
      else { var hue = Math.round((tir / 100) * 130); bg = 'hsl(' + hue + ',62%,45%)'; }
      var title = String(hh).padStart ? String(hh).padStart(2, '0') : ('0' + hh).slice(-2);
      title += ':00 · TIR ' + (tir == null ? '–' : tir + '%') + ' · n=' + (p.n || 0);
      cells.push('<i title="' + escapeHtml(title) + '" style="background:' + bg + '"></i>');
    }
    return '<div class="ai-sec">TIR per uur (24u)</div>' +
      '<div class="ai-tirstrip">' + cells.join('') + '</div>' +
      '<div class="ai-tiraxis"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>';
  }

  function renderAiHeatmap(heatmap) {
    var h = ['<div class="ai-sec">Heatmap laag-risico (weekdag × uur)</div>', '<div class="ai-heatmap">'];
    heatmap.forEach(function (row) {
      h.push('<div class="ai-hm-row"><span class="ai-hm-day">' + escapeHtml(row[0] ? row[0].day : '') + '</span>');
      row.forEach(function (c) {
        var pct = c.lowPct || 0;
        var alpha = Math.min(1, pct / 20);
        var title = c.day + ' ' + c.hour + ':00 · laag ' + pct + '% · hoog ' + (c.highPct || 0) + '% · TIR ' + (c.tir || 0) + '% · n=' + c.n;
        h.push('<span class="ai-hm-cell" title="' + escapeHtml(title) + '" style="background:rgba(251,113,133,' + alpha.toFixed(2) + ')"></span>');
      });
      h.push('</div>');
    });
    h.push('<div class="ai-hm-axis"><span></span><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>');
    h.push('</div>');
    return h.join('');
  }

  function aiEpisodeDetailHtml(e) {
    var rows = [];
    rows.push('<div class="ai-d-row"><b>Tijdlijn:</b> piek ' + escapeHtml(aiTime(e.peakAt)) + ' → nadir ' + escapeHtml(aiTime(e.nadirAt)) + (e.recoveredAt ? ' → herstel ' + escapeHtml(aiTime(e.recoveredAt)) : '') + '</div>');
    rows.push('<div class="ai-d-row"><b>Diepte/duur:</b> nadir ' + escapeHtml(aiNum(e.nadirMmol, '')) + ' mmol · <3.9 ' + escapeHtml(aiNum(e.timeBelow3_9Minutes, 'm')) + ' · burden ' + escapeHtml(aiNum(e.areaBelow3_9, '')) + '</div>');
    rows.push('<div class="ai-d-row"><b>Herstel/context:</b> herstel ' + escapeHtml(aiNum(e.recoveryMinutes, 'm')) + ' · rebound ' + escapeHtml(e.reboundHigh ? aiNum(e.reboundPeakMmol, '') + ' mmol' : 'nee') + '</div>');
    rows.push('<div class="ai-d-row"><b>Classificatie:</b> ' + escapeHtml([e.outcome, e.severity, e.shape, 'kwaliteit ' + aiNum(e.qualityScore, '%')].filter(Boolean).join(' · ')) + '</div>');
    if (e.qualityFlags && e.qualityFlags.length) rows.push('<div class="ai-d-row"><b>Datakwaliteit:</b> ' + escapeHtml(e.qualityFlags.join(', ')) + '</div>');
    rows.push('<div class="ai-curve"></div>');
    return '<div class="ai-detail">' + rows.join('') + '</div>';
  }

  function aiCard(label, value, cls, deltaHtml) {
    return '<div class="ai-card ' + (cls || '') + '"><div class="ai-card-v">' + escapeHtml(String(value)) + '</div><div class="ai-card-l">' + escapeHtml(label) + '</div>' + (deltaHtml || '') + '</div>';
  }

  // Δ-badge t.o.v. de vorige periode. lowerIsBetter keert de kleur om (CV/laag).
  function aiDelta(delta, unit, lowerIsBetter) {
    if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) return '';
    var d = Number(delta);
    var dir = d > 0.05 ? 'up' : (d < -0.05 ? 'down' : 'flat');
    var cls;
    if (lowerIsBetter === 'neutral' || dir === 'flat') cls = 'flat';
    else cls = (lowerIsBetter ? d < 0 : d > 0) ? 'up' : 'down';
    var sign = d > 0 ? '+' : '';
    return '<span class="ai-card-d ' + cls + '">' + sign + (Math.round(d * 10) / 10) + (unit || '') + ' vs vorige</span>';
  }

  function aiTarget(label, ok) {
    return '<span class="ai-tg ' + (ok ? 'ok' : 'no') + '">' + (ok ? '✓' : '✗') + ' ' + escapeHtml(label) + '</span>';
  }

  // --- Chat-tab: 1 LLM-call per bericht (kost quota). History in geheugen.
  var aiChatHistory = [];
  var aiChatScope = null;
  function renderAiChatScope() {
    var el = document.getElementById('cgm-ai-chatscope');
    if (!el) return;
    if (aiChatScope && aiChatScope.type === 'day' && aiChatScope.date) {
      el.innerHTML = 'Context: dag ' + escapeHtml(aiChatScope.date) +
        ' · <button type="button" class="ai-rev-btn" id="cgm-ai-clearscope">wis context</button>';
      var btn = document.getElementById('cgm-ai-clearscope');
      if (btn) btn.onclick = function () {
        aiChatScope = null;
        var input = document.getElementById('cgm-ai-chatinput');
        if (input) input.placeholder = 'Vraag iets over je glucose…';
        renderAiChatScope();
      };
    } else {
      el.textContent = 'Context: laatste 14 dagen';
    }
  }
  function renderAiChat() {
    var log = document.getElementById('cgm-ai-chatlog');
    if (!log) return;
    renderAiChatScope();
    if (!aiChatHistory.length) {
      log.innerHTML = '<div class="ai-empty">Stel een vraag over je data. Let op: elk bericht kost AI-quota.</div>';
      return;
    }
    log.innerHTML = aiChatHistory.map(function (m) {
      var cls = m.role === 'user' ? 'ai-msg-user' : 'ai-msg-ai';
      return '<div class="ai-msg ' + cls + '">' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }

  function sendAiChat() {
    var input = document.getElementById('cgm-ai-chatinput');
    var sendBtn = document.getElementById('cgm-ai-chatsend');
    if (!input) return;
    var text = (input.value || '').trim();
    if (!text) return;
    aiChatHistory.push({ role: 'user', content: text });
    input.value = '';
    renderAiChat();
    var log = document.getElementById('cgm-ai-chatlog');
    if (log) { log.insertAdjacentHTML('beforeend', '<div class="ai-msg ai-msg-ai ai-typing">AI denkt na…</div>'); log.scrollTop = log.scrollHeight; }
    if (sendBtn) sendBtn.disabled = true;
    input.disabled = true;
    fetchWithTimeout('/_ai-review/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: aiChatHistory.slice(-10), scope: aiChatScope || undefined })
    }, 120000)
      .then(function (r) {
        return r.text().then(function (text) {
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) {}
          return { ok: r.ok, json: json, text: text };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.json || res.json.ok === false) aiChatHistory.push({ role: 'assistant', content: 'Fout: ' + ((res.json && res.json.message) || (res.text && res.text.slice(0, 120)) || 'onbekend') });
        else if (res.json.skipped) aiChatHistory.push({ role: 'assistant', content: 'Overgeslagen: ' + res.json.reason });
        else aiChatHistory.push({ role: 'assistant', content: res.json.reply || '(geen antwoord)' });
        renderAiChat();
      })
      .catch(function (err) { aiChatHistory.push({ role: 'assistant', content: 'Fout: ' + (err && err.message ? err.message : err) }); renderAiChat(); })
      .then(function () { if (sendBtn) sendBtn.disabled = false; input.disabled = false; input.focus(); });
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
    var line = 'vergelijkbaar: top ' + count + ' matches · ' + hypoText + ' onder 4.5' + ratioText;
    var curveCount = Number(pattern.curveMatchCount);
    if (Number.isFinite(curveCount) && curveCount >= 3) {
      var curveHypo = Number(pattern.curveHypoCount);
      var curveRatio = Number(pattern.curveHypoRatio);
      line += ' · curve top ' + curveCount + ': ' + (Number.isFinite(curveHypo) ? curveHypo : '?') + ' onder 4.5';
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
    var fallbackPrimaryRate = currentForecastRows && currentForecastRows.length ? getPrimaryRate(currentForecastRows) : null;
    var safeRisk = risk || { css: 'ok', title: 'HYPO OK', detail: 'Patroon actief', rate: fallbackPrimaryRate ? fallbackPrimaryRate.rateMmol : 0 };
    var hadCarb = alert.classList.contains('has-carb');
    alert.className = safeRisk.css + (hadCarb ? ' has-carb' : '');
    var dropLine = dropFromPeakText(currentReadings);

    // Bij lows leest de armsensor te hoog/te traag (interstitieel loopt achter en
    // onderschat ernstige lows — bloed kan onder 2.0 zitten terwijl de sensor 2.4 toont).
    // Een precies voorspeld getal is daar misleidend; toon risico + onzekerheid i.p.v. een cijfer.
    var nowMmol = latestReading ? mmol(Number(latestReading.sgv)) : NaN;
    var blendedRateNow = getForecastRateMmol(currentForecastRows);
    var primaryNow = getPrimaryRate(currentForecastRows);
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
    var alertHeight = alertRect.height || 0;
    var alertBottom = alertTop + alertHeight;
    containerTop = Math.max(containerTop, alertBottom + 8);
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
      var alertLeft = (window.innerWidth - alertRect.width) / 2 + window.scrollX;
      var alertRight = alertLeft + alertRect.width;
      var stackLeft = alertRight + 10;
      var stackTop = alertTop + Math.max(0, (alertHeight - stackHeight) / 2);
      if (stackLeft + maxButtonWidth > window.scrollX + window.innerWidth - 8) {
        stackLeft = alertLeft - maxButtonWidth - 10;
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
    positionMealBadge();
  }

  function renderStatsPanel(stats) {
    var panel = ensureStatsPanel();
    if (!stats) {
      panel.style.display = 'none';
      return;
    }

    function fmtNumber(value, digits, fallback) {
      var n = Number(value);
      if (!Number.isFinite(n)) return fallback || '--';
      return n.toFixed(digits);
    }
    function fmtInt(value, fallback) {
      var n = Number(value);
      if (!Number.isFinite(n)) return fallback || '--';
      return String(Math.round(n));
    }

    panel.style.display = 'grid';
    panel.innerHTML = [
      '<div class="stats-title">Laatste 24 uur (update: ' + new Date().toLocaleTimeString() + ')</div>',
      '<div class="stat low"><span class="stat-label">Laag</span><span class="stat-value">', aiNum(stats.lowPct, '%'), '</span></div>',
      '<div class="stat range"><span class="stat-label">In bereik</span><span class="stat-value">', aiNum(stats.inRangePct, '%'), '</span></div>',
      '<div class="stat high"><span class="stat-label">Hoog</span><span class="stat-value">', aiNum(stats.highPct, '%'), '</span></div>',
      '<div class="stat"><span class="stat-label">Gemiddelde</span><span class="stat-value">', fmtNumber(stats.average, 1), ' mmol/L</span></div>',
      '<div class="stat"><span class="stat-label">Min</span><span class="stat-value">', fmtNumber(stats.min, 1), ' mmol/L</span></div>',
      '<div class="stat"><span class="stat-label">Max</span><span class="stat-value">', fmtNumber(stats.max, 1), ' mmol/L</span></div>',
      '<div class="stat"><span class="stat-label">Std. afwijking</span><span class="stat-value">', fmtNumber(stats.stdDev, 1), ' mmol/L</span></div>',
      '<div class="stat"><span class="stat-label">CV</span><span class="stat-value">', fmtInt(stats.cv), '% ', escapeHtml(stats.stability || ''), '</span></div>',
      '<div class="stat"><span class="stat-label">Gesch. HbA1c</span><span class="stat-value">', fmtNumber(stats.estimatedA1c, 1), '%</span></div>',
      '<div class="stat"><span class="stat-label">Metingen</span><span class="stat-value">', aiNum(stats.count, ''), '</span></div>',
      '<div class="stat low"><span class="stat-label">Onder 3.0</span><span class="stat-value">', aiNum(stats.urgentLowPct, '%'), '</span></div>',
      '<div class="stat low"><span class="stat-label">Hypo events</span><span class="stat-value">', aiNum(stats.hypoEvents, ''), '</span></div>',
      '<div class="stat"><span class="stat-label">Laatste hypo</span><span class="stat-value">', stats.lastHypoMinutes === null ? 'geen' : stats.lastHypoMinutes + 'm', '</span></div>',
      '<div class="stat ', stats.impactLevel === 'urgent' || stats.impactLevel === 'high' ? 'low' : (stats.impactLevel === 'watch' ? 'high' : ''), '"><span class="stat-label">Volatiliteit score</span><span class="stat-value">', aiNum(stats.impactScore, '/100'), '</span></div>',
      '<div class="stat high"><span class="stat-label">Snelste stijging</span><span class="stat-value">', stats.fastestRise === null ? '--' : signed(stats.fastestRise, 3) + '/min', '</span></div>',
      '<div class="stat low"><span class="stat-label">Snelste daling</span><span class="stat-value">', stats.fastestDrop === null ? '--' : signed(stats.fastestDrop, 3) + '/min', '</span></div>',
      '<div class="stat"><span class="stat-label">Gemiste gaten</span><span class="stat-value">', aiNum(stats.missingIntervals, ''), '</span></div>',
      '<div class="stat"><span class="stat-label">Nacht min</span><span class="stat-value">', stats.nightMin === null ? '--' : fmtNumber(stats.nightMin, 1) + ' mmol/L', '</span></div>'
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
    var usableRows = currentForecastRows.filter(function (row) {
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
        calibrateMealFromHistory(readings);
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
        // Forecast/risk altijd uit verhouding-rijen, los van de weergave-toggle.
        currentForecastRows = calculateRows(readings, anchorEntry);
        latestReading = readings[0] || null;
        renderCurrentGlucose(anchorEntry || readings[0]);
        renderCurrentDelta();
        currentHypoRisk = calculateHypoRisk(readings, currentForecastRows);
        var peakSignal = detectPeakDropSignal(readings);
        currentPatternCorrection = computePatternCorrection(readings, peakSignal);
        if (peakSignal && currentHypoRisk) {
          var trendRate = getForecastRateMmol(currentForecastRows);
          if (!Number.isFinite(trendRate)) {
            var fallbackPrimary = getPrimaryRate(currentForecastRows);
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
        renderMealBadge(readings, currentHypoRisk, peakSignal);
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
