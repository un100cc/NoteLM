/**
 * Literature-based strategies test — no parameters tuned on our data.
 * All rules taken verbatim from published/practitioner standards:
 *
 *   TSMOM-SMA200 : long coin while close > 200d SMA, else flat (Faber-style)
 *   TSMOM-90d    : long while 90d return > 0, else flat (classic TS momentum)
 *   Donchian 55/20: enter on 55d-high breakout, exit on 20d-low break (Turtle)
 *
 * Portfolio = equal weight across the same 20 coins (daily-rebalanced average
 * of per-coin strategy returns; coins enter at their listing date).
 * Costs: 0.10% per side on every position flip.
 * Baselines: BTC buy & hold, equal-weight-20 buy & hold.
 * Period: 2021-01-01 -> 2026-06 (covers 2021 bull, 2022 bear, 2023 recovery,
 * 2024 bull, 2025-26 decline).
 *
 * Robustness: SMA filter also reported at 100/150/300d — a real effect
 * should not be knife-edge in N.
 *
 * Run: node bench/proven.js
 */

const B = require('./benchmark.js');

const FEE_SIDE = 0.001; // 0.10% per side
const START = Date.UTC(2021, 0, 1);
const END = 1781222400000; // 2026-06-12, matches benchmark NOW

const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const pad = (s, n) => String(s).padStart(n);

// ── Per-coin daily position series builders (signal at close i-1 → hold day i)
function posSMA(candles, N) {
  const pos = new Array(candles.length).fill(0);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= N) sum -= candles[i - N].close;
    if (i + 1 < candles.length && i >= N - 1) {
      pos[i + 1] = candles[i].close > sum / N ? 1 : 0;
    }
  }
  return pos;
}
function posTSMOM(candles, N) {
  const pos = new Array(candles.length).fill(0);
  for (let i = N; i + 1 < candles.length; i++) {
    pos[i + 1] = candles[i].close > candles[i - N].close ? 1 : 0;
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
function posHold(candles) { return new Array(candles.length).fill(1); }

// Daily strategy returns for one coin, fees charged on position changes
function coinReturns(candles, pos) {
  const out = {}; // dayTs -> return
  for (let i = 1; i < candles.length; i++) {
    const r = candles[i].close / candles[i - 1].close - 1;
    const flip = Math.abs(pos[i] - pos[i - 1]);
    out[candles[i].time] = pos[i] * r - flip * FEE_SIDE;
  }
  return out;
}

// Equal-weight portfolio: average across coins with data that day
function portfolio(allCoinRets) {
  const days = new Set();
  for (const m of allCoinRets) for (const t of Object.keys(m)) days.add(+t);
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.map(t => {
    let s = 0, n = 0;
    for (const m of allCoinRets) if (m[t] !== undefined) { s += m[t]; n++; }
    return { t, r: n ? s / n : 0 };
  });
}

function stats(series) {
  let eq = 1, peak = 1, maxDD = 0;
  let sum = 0, sum2 = 0;
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
  const years = n / 365;
  return {
    total: (eq - 1) * 100,
    cagr: (Math.pow(eq, 1 / years) - 1) * 100,
    maxDD: maxDD * 100,
    sharpe: mean / sd * Math.sqrt(365),
    byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, (v - 1) * 100])),
  };
}

async function main() {
  console.log('Loading daily data 2021-01 -> 2026-06 for 20 coins...');
  const data = {};
  for (const sym of B.COINS) {
    try {
      const c = await B.fetchKlines(sym, '1d', START, END);
      if (c.length > 250) data[sym] = c;
      else console.log(`  (skip ${sym}: only ${c.length} days)`);
    } catch (e) { console.log(`  (${sym}: ${e.message})`); }
  }
  const syms = Object.keys(data);
  console.log(`  ${syms.length} coins loaded (late listings enter at inception)\n`);

  const strategies = {
    'BTC buy & hold': [coinReturns(data.BTCUSDT, posHold(data.BTCUSDT))],
    'EW-20 buy & hold': syms.map(s => coinReturns(data[s], posHold(data[s]))),
    'TSMOM SMA200': syms.map(s => coinReturns(data[s], posSMA(data[s], 200))),
    'TSMOM SMA100': syms.map(s => coinReturns(data[s], posSMA(data[s], 100))),
    'TSMOM SMA150': syms.map(s => coinReturns(data[s], posSMA(data[s], 150))),
    'TSMOM SMA300': syms.map(s => coinReturns(data[s], posSMA(data[s], 300))),
    'TSMOM 90d ret>0': syms.map(s => coinReturns(data[s], posTSMOM(data[s], 90))),
    'Donchian 55/20': syms.map(s => coinReturns(data[s], posDonchian(data[s]))),
    'BTC TSMOM SMA200': [coinReturns(data.BTCUSDT, posSMA(data.BTCUSDT, 200))],
  };

  const years = ['2021', '2022', '2023', '2024', '2025', '2026'];
  console.log(`  ${'strategy'.padEnd(19)}${pad('total%', 9)}${pad('CAGR%', 8)}${pad('maxDD%', 8)}${pad('Sharpe', 8)}  ${years.map(y => pad(y, 7)).join('')}`);
  console.log(`  ${'-'.repeat(19 + 9 + 8 + 8 + 8 + 2 + 7 * years.length)}`);
  const results = {};
  for (const [name, rets] of Object.entries(strategies)) {
    const s = stats(portfolio(rets));
    results[name] = s;
    const yearCols = years.map(y => pad(s.byYear[y] === undefined ? '–' : r1(s.byYear[y]), 7)).join('');
    console.log(`  ${name.padEnd(19)}${pad(r1(s.total), 9)}${pad(r1(s.cagr), 8)}${pad(r1(s.maxDD), 8)}${pad(r2(s.sharpe), 8)}  ${yearCols}`);
  }

  require('fs').writeFileSync(require('path').join(__dirname, 'proven-results.json'), JSON.stringify(results, null, 2));
  console.log('\nSaved bench/proven-results.json');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
