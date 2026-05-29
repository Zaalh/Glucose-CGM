(function () {
  'use strict';

  var MGDL_PER_MMOL = 18.0182;
  var WINDOWS_MINUTES = Array.from({ length: 60 }, function (_, index) { return index + 1; }).concat([90, 120]);
  var MAX_BASELINE_DIFF_MS = 45000;
  var POLL_MS = 30000;
  var COMPACT_WINDOWS_MINUTES = [1, 2, 3, 4, 5, 10, 15, 30];
  var CLASSIC_WINDOWS_MINUTES = [1, 2, 3, 4, 5, 10, 15, 20, 30, 45, 60, 90, 120];
  var RATE_MODE_KEY = 'cgm-rate-overlay-mode';
  var RATE_VIEW_KEY = 'cgm-rate-overlay-view';
  var SOUND_OFF_KEY = 'cgm-nightscout-sound-off';
  var ESTIMATE_LINE_CLASS = 'cgm-estimated-glucose-line';
  var ESTIMATE_GAP_MIN_MS = 150000;
  var ESTIMATE_OPEN_MAX_MS = 1200000;
  var ESTIMATE_PIXEL_GAP_MIN = 3;
  var latestReading = null;
  var updatingCurrentGlucose = false;
  var currentRows = [];
  var currentReadings = [];
  var selectedReadingTime = null;
  var currentHypoRisk = null;
  var currentPatternCorrection = null;
  var FORECAST_CALIBRATION_KEY = 'cgm-forecast-calibration-v1';
  var PEAK_DROP_THRESHOLDS = {
    watch: { minDrop: 1.4, minRate: 0.05, maxMinutes: 75 },
    high: { minDrop: 1.9, minRate: 0.07, maxMinutes: 60 },
    urgent: { minDrop: 2.6, minRate: 0.09, maxMinutes: 45 }
  };
  var chartReadingsAsc = [];
  var estimateRenderTimer = null;
  var chartObserver = null;
  var observedChart = null;

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

    var weighted = candidates.map(function (row) {
      var w;
      if (row.actualMinutes <= 5) w = 0.45;
      else if (row.actualMinutes <= 10) w = 0.30;
      else if (row.actualMinutes <= 15) w = 0.17;
      else w = 0.08;
      return { rate: row.rateMmol, weight: w };
    });

    var totalW = weighted.reduce(function (s, x) { return s + x.weight; }, 0);
    if (totalW <= 0) return null;
    var rate = weighted.reduce(function (s, x) { return s + x.rate * x.weight; }, 0) / totalW;

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
        title: 'HYPO NU',
        detail: predictedUrgentSoon ? '3.8 ' + lowEta + ' · 3.0 ' + urgentEta : valueMmol.toFixed(2) + ' mmol/L',
        rate: rateMmol
      };
    }

    if (predictedUrgentSoon) {
      return {
        css: 'urgent',
        title: 'URGENT RISICO',
        detail: '3.8 ' + lowEta + ' · 3.0 ' + urgentEta,
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
    var corr = currentPatternCorrection ? currentPatternCorrection.correction : 0;
    var calib = loadForecastCalibration();
    var horizons = [10, 15, 20, 30];
    var prev = null;
    var parts = horizons.map(function (minutes) {
      // Apply pattern correction progressively by horizon:
      // conservative at 10m, full effect by 20m+.
      var corrWeight = Math.min(1, minutes / 20);
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
      '#cgm-hypo-alert .hypo-line{display:flex;align-items:center;justify-content:center;gap:10px;white-space:nowrap}',
      '#cgm-hypo-alert .hypo-line.primary{display:flex;flex-direction:column;gap:2px;align-items:center;justify-content:center}',
      '#cgm-hypo-alert .hypo-title{font-size:15px;font-weight:900;line-height:1;text-transform:uppercase;white-space:nowrap}',
      '#cgm-hypo-alert .hypo-detail{font-size:24px;font-weight:900;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#cgm-hypo-alert .hypo-rate{font-family:monospace;font-size:19px;font-weight:900;line-height:1;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-average{font-family:monospace;font-size:14px;font-weight:900;line-height:1.1;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-predict{font-family:monospace;font-size:13px;font-weight:800;line-height:1.15;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert .hypo-drop{font-family:monospace;font-size:12px;font-weight:800;line-height:1.15;white-space:nowrap;opacity:.95}',
      '#cgm-hypo-alert.ok{color:#063b1d;border-color:#4ade80;background:linear-gradient(135deg,#bbf7d0 0%,#4ade80 100%)}',
      '#cgm-hypo-alert.watch{color:#2f1600;border-color:#facc15;background:linear-gradient(135deg,#fff3a3 0%,#fbbf24 100%)}',
      '#cgm-hypo-alert.warning{color:#2f1600;border-color:#f59e0b;background:linear-gradient(135deg,#ffe08a 0%,#fb923c 100%)}',
      '#cgm-hypo-alert.hypo,#cgm-hypo-alert.urgent{color:#fff7ed;border-color:#fb7185;background:linear-gradient(135deg,#f59e0b 0%,#e11d48 100%);text-shadow:0 1px 2px rgba(0,0,0,.45)}',
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
      '#cgm-rate-toggle,#cgm-rate-view-toggle{position:absolute!important;z-index:10003!important;border:1px solid rgba(255,255,255,.25);border-radius:5px;background:rgba(0,0,0,.72);color:#ddd;font:700 11px Arial,Helvetica,sans-serif;padding:5px 8px;cursor:pointer;min-width:64px;text-align:center}',
      '#cgm-rate-toggle{left:50%;transform:translateX(-50%);top:174px}',
      '#cgm-rate-view-toggle{top:174px}',
      '#cgm-rate-toggle:hover,#cgm-rate-view-toggle:hover{background:rgba(30,30,30,.9);color:#fff}',
      '#cgm-rate-history-nav{position:absolute!important;z-index:10003!important;display:none;align-items:center;gap:6px;border:1px solid rgba(255,255,255,.25);border-radius:5px;background:rgba(0,0,0,.72);padding:3px 6px;color:#ddd;font:700 11px Arial,Helvetica,sans-serif;white-space:nowrap}',
      '#cgm-rate-history-nav button{border:1px solid rgba(255,255,255,.25);background:rgba(30,30,30,.6);color:#ddd;border-radius:4px;padding:2px 6px;font:700 11px Arial,Helvetica,sans-serif;cursor:pointer}',
      '#cgm-rate-history-nav button:hover:not(:disabled){background:rgba(60,60,60,.9);color:#fff}',
      '#cgm-rate-history-nav button:disabled{opacity:.45;cursor:not-allowed}',
      '#cgm-rate-history-nav .hist-time{min-width:40px;text-align:center}',
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
      '@media(max-width:700px){#cgm-rate-overlay,#cgm-rate-overlay.classic,#cgm-rate-overlay.all{grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;width:98vw;align-items:start}#cgm-hypo-alert{left:50%;right:auto;transform:translateX(-50%);max-width:95vw;min-width:0;gap:2px;padding:5px 7px}#cgm-hypo-alert .hypo-line{gap:4px}#cgm-hypo-alert .hypo-title{font-size:11px}#cgm-hypo-alert .hypo-detail{font-size:16px}#cgm-hypo-alert .hypo-rate{font-size:12px}#cgm-hypo-alert .hypo-average{font-size:10px}#cgm-hypo-alert .hypo-predict{font-size:9px}#cgm-hypo-alert .hypo-drop{font-size:9px}#cgm-rate-toggle,#cgm-rate-view-toggle{min-width:58px;padding:4px 7px;font-size:10px}#cgm-rate-history-nav{font-size:10px;padding:2px 5px}#cgm-rate-overlay .rate-card{padding:3px 16px 3px 5px;min-height:0}#cgm-rate-overlay .rate-window{font-size:8px;line-height:1}#cgm-rate-overlay .rate-main,#cgm-rate-overlay .rate-card.primary .rate-main{font-size:12px;line-height:1.02;margin-top:1px}#cgm-rate-overlay .rate-arrow{right:4px;font-size:14px}#cgm-rate-overlay .rate-sub{font-size:7px;line-height:1.02;margin-top:1px}#cgm-stats-panel{grid-template-columns:repeat(3,minmax(0,1fr));gap:3px;width:98vw;padding:4px}#cgm-stats-panel .stat{padding:3px 4px}#cgm-stats-panel .stat-label{font-size:8px}#cgm-stats-panel .stat-value{font-size:11px}}'
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

  function ensureStatsPanel() {
    var existing = document.getElementById('cgm-stats-panel');
    if (existing) return existing;

    var panel = document.createElement('div');
    panel.id = 'cgm-stats-panel';
    panel.setAttribute('aria-label', 'Glucose statistieken laatste 24 uur');
    document.body.appendChild(panel);
    return panel;
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

  function renderHypoAlert(risk) {
    var alert = ensureHypoAlert();
    currentHypoRisk = risk;
    if (!risk) {
      alert.style.display = 'none';
      return;
    }

    alert.style.display = 'flex';
    alert.className = risk.css;
    var dropLine = dropFromPeakText(currentReadings);
    var patternLine = currentPatternCorrection
      ? ('patrooncorr: -' + currentPatternCorrection.correction.toFixed(1) + ' (n=' + currentPatternCorrection.episodes + ')')
      : '';
    alert.innerHTML = [
      '<div class="hypo-line primary">',
      '<span class="hypo-title">', risk.title, '</span>',
      '<span class="hypo-detail">', risk.detail, '</span>',
      '</div>',
      '<div class="hypo-line"><span class="hypo-rate">', signed(risk.rate, 3), '/min</span></div>',
      '<div class="hypo-line"><span class="hypo-average">', averageRateText(true), '</span></div>',
      '<div class="hypo-line"><span class="hypo-predict">verwacht: ', horizonPredictionText(), ' mmol/L</span></div>',
      dropLine ? '<div class="hypo-line"><span class="hypo-drop">' + dropLine + '</span></div>' : '',
      patternLine ? '<div class="hypo-line"><span class="hypo-drop">' + patternLine + '</span></div>' : ''
    ].join('');
  }

  function positionContainer() {
    var container = ensureContainer();
    var button = ensureToggle();
    var viewButton = ensureViewToggle();
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
    var containerTop = chartTop + 28;
    var alertTop = chartTop + 4;
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
      var mobileLeft = window.scrollX + 8;
      var mobileWidth = Math.max(260, window.innerWidth - 16);
      var mobileBaseTop = window.scrollY + 88;
      alertTop = mobileBaseTop;
      buttonTop = mobileBaseTop + 124;
      containerTop = mobileBaseTop + 158;

      alert.style.left = Math.round(mobileLeft + mobileWidth / 2) + 'px';
      alert.style.transform = 'translateX(-50%)';
      alert.style.width = Math.round(mobileWidth) + 'px';
      alert.style.maxWidth = Math.round(mobileWidth) + 'px';
      alert.style.minWidth = '0';

      button.style.top = Math.max(0, Math.round(buttonTop)) + 'px';
      button.style.left = Math.max(0, Math.round(mobileLeft)) + 'px';
      button.style.transform = 'none';
      viewButton.style.top = Math.max(0, Math.round(buttonTop)) + 'px';
      viewButton.style.left = Math.max(0, Math.round(mobileLeft + (button.getBoundingClientRect().width || 58) + 6)) + 'px';
      viewButton.style.transform = 'none';

      container.style.left = Math.round(mobileLeft) + 'px';
      container.style.transform = 'none';
      container.style.width = Math.round(mobileWidth) + 'px';
      statsPanel.style.top = Math.max(0, Math.round(chartBottom + 16)) + 'px';
    } else {
      alert.style.width = '';
      alert.style.maxWidth = '';
      alert.style.left = '50%';
      alert.style.transform = 'translateX(-50%)';
      container.style.left = '50%';
      container.style.transform = 'translateX(-50%)';
      container.style.width = '';
      statsPanel.style.top = Math.max(0, Math.round(chartBottom + 8)) + 'px';
      button.style.top = Math.max(0, Math.round(buttonTop)) + 'px';
      button.style.left = Math.round(window.scrollX + window.innerWidth / 2) + 'px';
      button.style.transform = 'translateX(-50%)';
      viewButton.style.top = Math.max(0, Math.round(buttonTop)) + 'px';
      var viewWidth = viewButton.getBoundingClientRect().width || 56;
      var btnRect = button.getBoundingClientRect();
      viewButton.style.left = Math.round(window.scrollX + btnRect.left - viewWidth - 8) + 'px';
      viewButton.style.transform = 'none';
    }
    var nav = ensureHistoryNav();
    var buttonRect = button.getBoundingClientRect();
    nav.style.top = Math.max(0, Math.round(buttonTop)) + 'px';
    nav.style.left = Math.round(window.scrollX + buttonRect.right + 8) + 'px';
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
      '<div class="stats-title">Laatste 24 uur</div>',
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
    window.requestAnimationFrame(positionContainer);
  }

  function render(rows) {
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
        ? event.target.closest('#cgm-rate-history-nav, #cgm-rate-toggle, #cgm-rate-view-toggle')
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
        currentReadings = readings;
        chartReadingsAsc = readings.slice().reverse();
        calibrateFromHistory(readings);
        var anchorEntry = null;
        if (getViewMode() === 'history' && selectedReadingTime !== null) {
          anchorEntry = readings.find(function (entry) {
            return readingTime(entry) === selectedReadingTime;
          }) || null;
          if (!anchorEntry) selectedReadingTime = null;
        }
        if (getViewMode() === 'history' && selectedReadingTime === null && readings.length) {
          selectedReadingTime = readingTime(readings[0]);
          anchorEntry = readings[0];
        }
        var rows = calculateRows(readings, anchorEntry);
        latestReading = readings[0] || null;
        renderCurrentGlucose(anchorEntry || readings[0]);
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
        renderStatsPanel(calculateStats(readings));
        render(rows);
        observeChartChanges();
        scheduleEstimatedGlucoseLine(0);
        window.setTimeout(scheduleEstimatedGlucoseLine, 500);
        window.setTimeout(scheduleEstimatedGlucoseLine, 1500);
      })
      .catch(function () {
        renderStatsPanel(null);
        render([]);
        renderEstimatedGlucoseLine();
      });
  }

  function start() {
    installSoundDefaultOff();
    installPointTooltip();
    installChartRangeListeners();
    observeCurrentGlucose();
    observeChartChanges();
    refresh();
    window.setInterval(refresh, POLL_MS);
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
