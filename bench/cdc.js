/**
 * CDC ActionZone V3 (piriya33) — faithful port of the Pine Script basic rule:
 *
 *   Fast = EMA(close,12), Slow = EMA(close,26)
 *   Green = Fast>Slow and close>Fast   -> first green bar = BUY next bar
 *   Red   = Fast<Slow and close<Fast   -> first red bar   = SELL next bar
 *   (alternating via bullish/bearish state, exactly like barssince logic)
 *
 * Tested as designed: DAILY timeframe, 2021-01 -> 2026-06, fee 0.10%/side,
 * signal at close -> position from next bar.  Variants:
 *   - long/flat  (spot-realistic)
 *   - long/short (futures, funding not modeled)
 *   - BTC only and equal-weight 20 coins
 * Baselines recomputed for the same period: B&H and Donchian 55/20.
 *
 * Run: node bench/cdc.js
 */

const B = require('./benchmark.js');

const FEE_SIDE = 0.001;
const START = Date.UTC(2021, 0, 1);
const END = 1781222400000;

const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const pad = (s, n) => String(s).padStart(n);

function emaSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  const k = 2 / (n + 1);
  let e = closes[0];
  for (let i = 0; i < closes.length; i++) {
    e = i === 0 ? e : closes[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// CDC ActionZone position series. mode: 'lf' long/flat, 'ls' long/short
function posCDC(candles, mode) {
  const closes = candles.map(c => c.close);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const pos = new Array(candles.length).fill(0);
  let state = 0; // 0 flat/bearish-start, 1 long, -1 short
  let prevGreen = false, prevRed = false;
  for (let i = 0; i < candles.length; i++) {
    const green = fast[i] > slow[i] && closes[i] > fast[i];
    const red = fast[i] < slow[i] && closes[i] < fast[i];
    const buycond = green && !prevGreen;
    const sellcond = red && !prevRed;
    if (i >= 30) { // warmup like the indicator needs
      if (buycond && state !== 1) state = 1;
      else if (sellcond && state === 1) state = mode === 'ls' ? -1 : 0;
      else if (sellcond && state === 0 && mode === 'ls') state = -1;
    }
    if (i + 1 < candles.length) pos[i + 1] = mode === 'ls' ? state : Math.max(state, 0);
    prevGreen = green; prevRed = red;
  }
  return pos;
}

function posDonchian(candles, NIn = 55, NOut = 20) {
  const pos = new Array(candles.length).fill(0);
  let inPos = false;
  for (let i = NIn; i + 1 < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - NIn; j < i; j++) hi = Math.max(hi, candles[j].high);
    for (let j = i - NOut; j < i; j++) lo = Math.min(lo, candles[j].low);
    if (!inPos && candles[i].close > hi) inPos = true;
    else if (inPos && candles[i].close < lo) inPos = false;
    pos[i + 1] = inPos ? 1 : 0;
  }
  return pos;
}
const posHold = candles => new Array(candles.length).fill(1);

function coinReturns(candles, pos) {
  const out = {};
  let flips = 0;
  for (let i = 1; i < candles.length; i++) {
    const r = candles[i].close / candles[i - 1].close - 1;
    const flip = Math.abs(pos[i] - pos[i - 1]);
    flips += flip;
    out[candles[i].time] = pos[i] * r - flip * FEE_SIDE;
  }
  out.__flips = flips;
  return out;
}

function portfolio(allCoinRets) {
  const days = new Set();
  for (const m of allCoinRets) for (const t of Object.keys(m)) if (t !== '__flips') days.add(+t);
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.map(t => {
    let s = 0, n = 0;
    for (const m of allCoinRets) if (m[t] !== undefined) { s += m[t]; n++; }
    return { t, r: n ? s / n : 0 };
  });
}

function stats(series) {
  let eq = 1, peak = 1, maxDD = 0, sum = 0, sum2 = 0;
  const byYear = {};
  for (const { t, r } of series) {
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
    sum += r; sum2 += r * r;
    const y = new Date(t).getUTCFullYear();
    byYear[y] = (byYear[y] || 1) * (1 + r);
  }
  const n = series.length;
  const mean = sum / n, sd = Math.sqrt(Math.max(sum2 / n - mean * mean, 1e-12));
  return {
    total: (eq - 1) * 100,
    cagr: (Math.pow(eq, 365 / n) - 1) * 100,
    maxDD: maxDD * 100,
    sharpe: mean / sd * Math.sqrt(365),
    byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, (v - 1) * 100])),
  };
}

async function main() {
  console.log('Loading daily data...');
  const data = {};
  for (const sym of B.COINS) {
    try {
      const c = await B.fetchKlines(sym, '1d', START, END);
      if (c.length > 250) data[sym] = c;
    } catch (e) { console.log(`  (${sym}: ${e.message})`); }
  }
  const syms = Object.keys(data);

  const strategies = {
    'CDC long/flat EW-20': syms.map(s => coinReturns(data[s], posCDC(data[s], 'lf'))),
    'CDC long/short EW-20': syms.map(s => coinReturns(data[s], posCDC(data[s], 'ls'))),
    'CDC long/flat BTC': [coinReturns(data.BTCUSDT, posCDC(data.BTCUSDT, 'lf'))],
    'Donchian 55/20': syms.map(s => coinReturns(data[s], posDonchian(data[s]))),
    'BTC buy & hold': [coinReturns(data.BTCUSDT, posHold(data.BTCUSDT))],
    'EW-20 buy & hold': syms.map(s => coinReturns(data[s], posHold(data[s]))),
  };

  const years = ['2021', '2022', '2023', '2024', '2025', '2026'];
  console.log(`\n  ${'strategy'.padEnd(21)}${pad('total%', 9)}${pad('CAGR%', 8)}${pad('maxDD%', 8)}${pad('Sharpe', 8)}${pad('trades/y', 9)}  ${years.map(y => pad(y, 7)).join('')}`);
  console.log(`  ${'-'.repeat(21 + 9 + 8 + 8 + 8 + 9 + 2 + 7 * years.length)}`);
  for (const [name, rets] of Object.entries(strategies)) {
    const s = stats(portfolio(rets));
    const flips = rets.reduce((sum, m) => sum + (m.__flips || 0), 0);
    const tradesPerYear = flips / rets.length / 5.45;
    const yearCols = years.map(y => pad(s.byYear[y] === undefined ? '–' : r1(s.byYear[y]), 7)).join('');
    console.log(`  ${name.padEnd(21)}${pad(r1(s.total), 9)}${pad(r1(s.cagr), 8)}${pad(r1(s.maxDD), 8)}${pad(r2(s.sharpe), 8)}${pad(r1(tradesPerYear), 9)}  ${yearCols}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
