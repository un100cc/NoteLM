/**
 * Rescue plan experiments — stack the fixes the strategy doc already
 * implies but the code never applied, measured with the bias-corrected
 * simulator (pess + fees), pooled over 7 windows, 4h.
 *
 *   A base (current code geometry, taker fee 0.10%)
 *   B + structure stop (SL at M2 extreme, per doc)
 *   C + volume filter (retest volume < 10-bar SMA, per doc)
 *   D + trend filter (trade only in direction of SMA99, per doc)
 *   E = B+C+D combined, taker fee 0.10%
 *   F = E with maker fee 0.05%
 *
 * Best combo also gets a per-window breakdown to check consistency
 * (a combo that only wins in some windows = curve fitting).
 *
 * Run: node bench/improve.js
 */

const B = require('./benchmark.js');
const P = B.BASE_PARAMS;

const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const pad = (s, n) => String(s).padStart(n);

function volSMA(candles, idx, n = 10) {
  const start = Math.max(0, idx - n);
  const slice = candles.slice(start, idx);
  return slice.length ? slice.reduce((s, c) => s + c.volume, 0) / slice.length : 0;
}
function sma(candles, idx, n) {
  if (idx < n) return null;
  let s = 0;
  for (let i = idx - n; i < idx; i++) s += candles[i].close;
  return s / n;
}

function structureSL(s) {
  const bull = s.dir === 'bull';
  const sl = bull ? s.m2Low * (1 - 0.005) : s.m2High * (1 + 0.005);
  const rr = bull ? (s.tp2 - s.entryPrice) / (s.entryPrice - sl)
                  : (s.entryPrice - s.tp2) / (sl - s.entryPrice);
  if (!(rr > 0) || rr < P.RR_MIN) return null;
  return { ...s, sl };
}

const CONFIGS = {
  A: { structStop: false, volFilter: false, trendFilter: false, fee: 0.10, label: 'A base (current geometry)' },
  B: { structStop: true,  volFilter: false, trendFilter: false, fee: 0.10, label: 'B + structure stop' },
  C: { structStop: false, volFilter: true,  trendFilter: false, fee: 0.10, label: 'C + volume filter' },
  D: { structStop: false, volFilter: false, trendFilter: true,  fee: 0.10, label: 'D + trend filter (SMA99)' },
  E: { structStop: true,  volFilter: true,  trendFilter: true,  fee: 0.10, label: 'E all three, taker 0.10%' },
  F: { structStop: true,  volFilter: true,  trendFilter: true,  fee: 0.05, label: 'F all three, maker 0.05%' },
};

function runConfig(cmap, cfg) {
  const trades = [];
  for (const [sym, candles] of Object.entries(cmap)) {
    for (let s of B.findSetups(candles, P)) {
      if (cfg.volFilter) {
        const c = candles[s.retestIdx];
        if (!(c.volume < volSMA(candles, s.retestIdx))) continue;
      }
      if (cfg.trendFilter) {
        const m = sma(candles, s.retestIdx, 99);
        if (m === null) continue;
        const px = candles[s.retestIdx].close;
        if (s.dir === 'bull' && px < m) continue;
        if (s.dir === 'bear' && px > m) continue;
      }
      if (cfg.structStop) {
        s = structureSL(s);
        if (!s) continue;
      }
      const r = B.simRealistic(candles, s, cfg.fee, { slPriority: true, exitModel: 'partial' });
      if (r) trades.push(r);
    }
  }
  return trades;
}

async function main() {
  const cmaps = [];
  for (const win of B.WINDOWS) cmaps.push([win, await B.loadWindow('4h', win)]);

  console.log('═══ Rescue-plan combos — pooled 7 windows, 4h, corrected-pess ═══');
  console.log(`  ${'config'.padEnd(30)}${pad('n', 6)}${pad('WR%', 7)}${pad('EV%/tr', 8)}${pad('PF', 6)}${pad('EV 95%CI', 18)}`);
  const pooled = {};
  for (const [key, cfg] of Object.entries(CONFIGS)) {
    const all = [];
    for (const [, cmap] of cmaps) all.push(...runConfig(cmap, cfg));
    pooled[key] = all;
    const m = B.metrics(all);
    const ci = B.bootstrapCI(all);
    console.log(`  ${cfg.label.padEnd(30)}${pad(m.n, 6)}${pad(r1(m.wr), 7)}${pad(r2(m.ev), 8)}${pad(r2(m.pf), 6)}${pad(`[${r2(ci[0])},${r2(ci[1])}]`, 18)}`);
  }

  console.log('\n═══ Config F per window (consistency check) ═══');
  console.log(`  ${'window'.padEnd(13)}${pad('n', 6)}${pad('WR%', 7)}${pad('EV%/tr', 8)}${pad('PF', 6)}`);
  for (const [win, cmap] of cmaps) {
    const m = B.metrics(runConfig(cmap, CONFIGS.F));
    console.log(`  ${win.name.padEnd(13)}${pad(m.n, 6)}${pad(r1(m.wr), 7)}${pad(r2(m.ev), 8)}${pad(r2(m.pf), 6)}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
