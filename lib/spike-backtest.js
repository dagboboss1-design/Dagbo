"use strict";

const { normalizeCandles, analyze } = require("./spike-engine");

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

/**
 * Historical walk-forward evaluation. Each signal sees only candles available
 * at that timestamp. Future candles are used only to score the outcome.
 * Results are gross of costs unless roundTripCost is supplied.
 */
function runBacktest(input, options = {}) {
  const candles = normalizeCandles(input);
  const pair = String(options.pair || "UNKNOWN").toUpperCase();
  const horizonBars = Math.max(1, Number(options.horizonBars || 3));
  const step = Math.max(1, Number(options.step || 1));
  const spikeThreshold = Number(options.spikeThreshold ?? 60);
  const spikeAtrMultiple = Number(options.spikeAtrMultiple || 1.5);
  const targetAtr = Number(options.targetAtr || 1);
  const stopAtr = Number(options.stopAtr || 0.75);
  const minAgreementPct = Number(options.minAgreementPct ?? 75);
  const roundTripCost = Math.max(0, Number(options.roundTripCost || 0));

  const detection = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const directions = { trades: 0, wins: 0, losses: 0, unresolved: 0, totalR: 0, grossWinsR: 0, grossLossesR: 0 };
  const buckets = [
    { label: "0-39", min: 0, max: 39, samples: 0, futureSpikes: 0 },
    { label: "40-59", min: 40, max: 59, samples: 0, futureSpikes: 0 },
    { label: "60-74", min: 60, max: 74, samples: 0, futureSpikes: 0 },
    { label: "75-100", min: 75, max: 100, samples: 0, futureSpikes: 0 }
  ];

  let evaluated = 0;
  for (let end = 29; end + horizonBars < candles.length; end += step) {
    const history = candles.slice(0, end + 1);
    const future = candles.slice(end + 1, end + 1 + horizonBars);
    const result = analyze(history, pair, "LIVE", null);
    if (!result.ready || !Number.isFinite(result.metrics.atr) || result.metrics.atr <= 0) continue;

    const atr = result.metrics.atr;
    const priorClose = candles[end].close;
    const futureSpike = future.some((c, index) => {
      const previousClose = index === 0 ? priorClose : future[index - 1].close;
      const trueRange = Math.max(c.high - c.low, Math.abs(c.high - previousClose), Math.abs(c.low - previousClose));
      return trueRange >= atr * spikeAtrMultiple;
    });
    const predictedSpike = result.spikeScore >= spikeThreshold;
    evaluated++;
    if (predictedSpike && futureSpike) detection.tp++;
    else if (predictedSpike) detection.fp++;
    else if (futureSpike) detection.fn++;
    else detection.tn++;

    const bucket = buckets.find(item => result.spikeScore >= item.min && result.spikeScore <= item.max);
    if (bucket) {
      bucket.samples++;
      if (futureSpike) bucket.futureSpikes++;
    }

    if (predictedSpike && result.direction !== "WAIT" && result.directionAgreementPct >= minAgreementPct) {
      const entry = candles[end].close;
      const risk = atr * stopAtr;
      const target = atr * targetAtr;
      let outcome = null;
      let realizedR = 0;
      for (const bar of future) {
        const hitTarget = result.direction === "BUY"
          ? bar.high >= entry + target
          : bar.low <= entry - target;
        const hitStop = result.direction === "BUY"
          ? bar.low <= entry - risk
          : bar.high >= entry + risk;
        // Conservative: if target and stop occur in the same candle, count stop first.
        if (hitStop) { outcome = "loss"; realizedR = -1 - roundTripCost / risk; break; }
        if (hitTarget) { outcome = "win"; realizedR = (target - roundTripCost) / risk; break; }
      }
      if (outcome === null) {
        directions.unresolved++;
      } else {
        directions.trades++;
        directions.totalR += realizedR;
        if (outcome === "win") {
          directions.wins++;
          directions.grossWinsR += realizedR;
        } else {
          directions.losses++;
          directions.grossLossesR += Math.abs(realizedR);
        }
      }
    }
  }

  const precision = ratio(detection.tp, detection.tp + detection.fp);
  const recall = ratio(detection.tp, detection.tp + detection.fn);
  const f1 = precision !== null && recall !== null && precision + recall
    ? Number((2 * precision * recall / (precision + recall)).toFixed(4)) : null;

  return {
    pair, evaluatedSignals: evaluated,
    spikeDetection: {
      ...detection, precision, recall, f1,
      falsePositiveRate: ratio(detection.fp, detection.fp + detection.tn)
    },
    directional: {
      ...directions,
      winRate: ratio(directions.wins, directions.trades),
      averageR: directions.trades ? Number((directions.totalR / directions.trades).toFixed(4)) : null,
      profitFactor: directions.grossLossesR ? Number((directions.grossWinsR / directions.grossLossesR).toFixed(4))
        : directions.grossWinsR ? "infinite" : null
    },
    scoreBuckets: buckets.map(bucket => ({
      score: bucket.label, samples: bucket.samples, futureSpikes: bucket.futureSpikes,
      observedSpikeRate: ratio(bucket.futureSpikes, bucket.samples)
    })),
    assumptions: {
      horizonBars, spikeThreshold, spikeAtrMultiple, targetAtr, stopAtr,
      minAgreementPct, roundTripCost,
      sameCandleTargetAndStop: "counted as a loss",
      dataSplit: "This report evaluates the supplied series only; use a separate later date range for out-of-sample validation.",
      caveat: "Historical results are not a guarantee of future performance. Data quality, spread, slippage, sessions and provider symbol mapping affect results."
    }
  };
}

module.exports = { runBacktest };
