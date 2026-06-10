/**
 * Wide stop-loss experiment — "ยอม SL 20% ต่อไม้แล้วผลเป็นยังไง"
 *
 * Same setups/entries as the corrected KLAUD baseline (pooled 7 windows, 4h),
 * but the executed SL is a fixed % from entry: 1.34% (baseline avg), 5%,
 * 10%, 20%. TP1/2/3 unchanged (partial 1/3 exits), fee 0.10% RT,
 * SL priority on ambiguous bars.
 *
 * Two holding horizons:
 *   60 bars  (~10 days on 4h — original behavior)
 *   240 bars (~40 days — "ถือรอจนกว่าจะถึง TP หรือ SL")
 *
 * Also reports loss-tail stats and a $1,000 portfolio simulation:
 * trades taken chronologically per window, capital split into 10 slots,
 * each trade uses one free slot (10% of current equity).
 *
 * Run: node bench/wide-sl.js
 */

const B = require('./benchmark.js');
const P = B.BASE_PARAMS;

const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const pad = (s, n) => String(s).padStart(n);

const VARIANTS = [
  { name: 'baseline (fib618+0.5%)', fixed: null },
  { name: 'SL 5% from entry', fixed: 0.05 },
  { name: 'SL 10% from entry', fixed: 0.10 },
  { name: 'SL 20% from entry', fixed: 0.20 },
];

function withFixedSL(s, pct) {
  if (pct === null) return s;
  const bull = s.dir === 'bull';
  return { ...s, sl: bull ? s.entryPrice * (1 - pct) : s.entryPrice * (1 + pct) };
}

async function main() {
  const cmaps = [];
  for (const win of B.WINDOWS) cmaps.push([win, await B.loadWindow('4h', win)]);

  for (const horizon of [60, 240]) {
    console.log(`═══ Horizon ${horizon} bars (~${Math.round(horizon / 6)} days) — pooled 7 windows, 4h, corrected-pess + fee ═══`);
    console.log(`  ${'variant'.padEnd(24)}${pad('n', 6)}${pad('WR%', 7)}${pad('EV%/tr', 8)}${pad('PF', 6)}${pad('avgW%', 7)}${pad('avgL%', 8)}${pad('SLhit%', 8)}${pad('worst10%', 10)}`);
    for (const v of VARIANTS) {
      const trades = [];
      for (const [, cmap] of cmaps) {
        for (const [sym, candles] of Object.entries(cmap)) {
          for (const s of B.findSetups(candles, P)) {
            const sv = withFixedSL(s, v.fixed);
            const r = B.simRealistic(candles, sv, B.FEE_RT_PCT, { slPriority: true, exitModel: 'partial', horizon });
            if (r) trades.push({ ...r, entryTime: candles[r.fillIdx].time, win: r.pct > 0 });
          }
        }
      }
      const m = B.metrics(trades);
      const wins = trades.filter(t => t.pct > 0), losses = trades.filter(t => t.pct <= 0);
      const avgW = wins.reduce((s, t) => s + t.pct, 0) / (wins.length || 1);
      const avgL = losses.reduce((s, t) => s + t.pct, 0) / (losses.length || 1);
      const slHit = trades.filter(t => (t.tp || '').includes('SL')).length / trades.length * 100;
      const sortedPnl = trades.map(t => t.pct).sort((a, b) => a - b);
      const worst10 = sortedPnl.slice(0, Math.ceil(sortedPnl.length * 0.1));
      const worst10avg = worst10.reduce((s, x) => s + x, 0) / worst10.length;
      console.log(`  ${v.name.padEnd(24)}${pad(m.n, 6)}${pad(r1(m.wr), 7)}${pad(r2(m.ev), 8)}${pad(r2(m.pf), 6)}${pad(r2(avgW), 7)}${pad(r2(avgL), 8)}${pad(r1(slHit), 8)}${pad(r2(worst10avg), 10)}`);
      v[`trades${horizon}`] = trades;
    }
    console.log();
  }

  // ── $1,000 portfolio simulation, 10 slots, per window then averaged ──
  console.log('═══ $1,000 portfolio sim — 10 slots, 10% of equity per trade, horizon 240 ═══');
  console.log(`  ${'variant'.padEnd(24)}${pad('median end$', 12)}${pad('worst win.$', 12)}${pad('best win.$', 12)}${pad('maxDD%', 8)}`);
  for (const v of VARIANTS) {
    const perWindow = [];
    let maxDDAll = 0;
    for (const [win] of cmaps) {
      const trades = (v.trades240 || [])
        .filter(t => {
          const ts = t.entryTime;
          return ts >= win.start && ts < win.end;
        })
        .sort((a, b) => a.entryTime - b.entryTime);
      if (!trades.length) continue;
      let eq = 1000, peak = 1000, maxDD = 0;
      for (const t of trades) {
        eq += eq * 0.10 * (t.pct / 100);
        peak = Math.max(peak, eq);
        maxDD = Math.max(maxDD, 1 - eq / peak);
      }
      perWindow.push(eq);
      maxDDAll = Math.max(maxDDAll, maxDD);
    }
    perWindow.sort((a, b) => a - b);
    const median = perWindow[Math.floor(perWindow.length / 2)];
    console.log(`  ${v.name.padEnd(24)}${pad(Math.round(median), 12)}${pad(Math.round(perWindow[0]), 12)}${pad(Math.round(perWindow[perWindow.length - 1]), 12)}${pad(r1(maxDDAll * 100), 8)}`);
  }
  console.log('\n  (each window = 6 months starting fresh at $1,000; slots ignore overlap limits)');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
