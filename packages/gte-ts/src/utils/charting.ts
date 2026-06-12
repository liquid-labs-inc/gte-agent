import type { Candle } from "../internal/generated/types.gen";

export function calculateRsi(candles: Candle[], n = 14): number[] {
  if (candles.length <= n) {
    return [];
  }
  const closes = candles.map((c) => c.close ?? 0);
  const { avgGain: initialAvgGain, avgLoss: initialAvgLoss } = computeInitialAverages(closes, n);
  const firstRsi = computeRsi(initialAvgGain, initialAvgLoss);

  return computeRemainingRsi(closes, n, initialAvgGain, initialAvgLoss, [firstRsi]);
}

function computeInitialAverages(closes: number[], n: number): { avgGain: number; avgLoss: number } {
  let totalGain = 0;
  let totalLoss = 0;
  for (let i = 1; i <= n; i++) {
    const change = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (change > 0) {
      totalGain += change;
    } else {
      totalLoss += Math.abs(change);
    }
  }
  return { avgGain: totalGain / n, avgLoss: totalLoss / n };
}

function computeRsi(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeRemainingRsi(
  closes: number[],
  n: number,
  avgGain: number,
  avgLoss: number,
  result: number[],
): number[] {
  let currentAvgGain = avgGain;
  let currentAvgLoss = avgLoss;

  for (let i = n + 1; i < closes.length; i++) {
    const change = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    currentAvgGain = (currentAvgGain * (n - 1) + gain) / n;
    currentAvgLoss = (currentAvgLoss * (n - 1) + loss) / n;

    result.push(computeRsi(currentAvgGain, currentAvgLoss));
  }

  return result;
}
