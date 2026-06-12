/**
 * Independent replication of the friend's Divergence + Choch backtest
 * (Reference A in COMPARE-SPEC.md), run on BINANCE data as a cross-venue
 * check of the Bybit original.
 *
 * Spec implemented verbatim:
 *  - BTC/ETH USDT · 4h + 1h · 2020-01-01 -> 2025-12-31
 *  - Pivot: fractal lookback 5/5, CONFIRMED 5 bars later (no lookahead),
 *    deduped into an alternating high/low sequence (keep the extreme)
 *  - Signal (bull; bear mirrored): regular divergence at the 2 latest pivot
 *    lows — price lower low + RSI(14) higher low; wave3=L1, wave4=H (pivot
 *    high between), wave5=L2
 *  - Strength: fib extension of the leg into L2 vs the sideway range:
 *    (H-L2)/(H-L1) >= 1.382 MEDIUM / >= 1.618 STRONG
 *  - Trigger: Choch External = close breaks wave4 H, within 80 bars
 *  - Entry: limit at 38.2% retrace of M1 (M1 = L2 -> highest high up to the
 *    Choch bar); variants 50% / 61.8%; wait max 60 bars
 *  - Cancel: close beyond wave5 before entry / Choch wait > 80 / entry wait > 60
 *  - SL: wave5 extreme (L2) · TP: 100% of A projected from entry -> RR fixed
 *  - Timeout: held > 180 bars -> close at close
 *  - One setup at a time per symbol+TF · no partials/pyramid/trailing
 *  - Same-bar SL+TP -> SL (conservative) · fee 0.1%/round · fixed 1R sizing
 *  - Metrics: Win%, AvgR, TotalR, PF, MaxDD(R), exposure% · per-year split
 *  - Benchmarks: B&H · random-entry MC 5,000 rounds keeping SL/TP geometry,
 *    pass if actual TotalR >= p95 of random
 *
 * Implementation choice noted for comparison: M1 top is frozen at the Choch
 * bar (highest high L2..choch); if the original lets M1 extend after Choch,
 * entries differ slightly.
 *
 * Run: node bench/divchoch.js
 */

const B = require('./benchmark.js');

const SYMS = ['BTCUSDT', 'ETHUSDT'];
const TFS = ['4h', '1h'];
const START = Date.UTC(2020, 0, 1);
const END = Date.UTC(2025, 11, 31);
const FEE_RT_PCT = 0.1;
const PIVOT_LB = 5;
const CHOCH_MAX = 80, ENTRY_MAX = 60, HOLD_MAX = 180;
const EXT_MIN = 1.382;
const MC_ROUNDS = 5000;

const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const pad = (s, n) => String(s).padStart(n);
const d8 = ms => new Date(ms).toISOString().slice(0, 10);

function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= n) { avgG += g / n; avgL += l / n; if (i === n) out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-9)); }
    else { avgG = (avgG * (n - 1) + g) / n; avgL = (avgL * (n - 1) + l) / n; out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-9)); }
  }
  return out;
}

// Pivots confirmed PIVOT_LB bars after the pivot bar; emitted in confirm order
function confirmedPivots(candles) {
  const events = []; // { confirmAt, idx, price, type }
  for (let i = PIVOT_LB; i < candles.length - PIVOT_LB; i++) {
    let isH = true, isL = true;
    for (let j = i - PIVOT_LB; j <= i + PIVOT_LB; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isH = false;
      if (candles[j].low <= candles[i].low) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) events.push({ confirmAt: i + PIVOT_LB, idx: i, price: candles[i].high, type: 'H' });
    if (isL) events.push({ confirmAt: i + PIVOT_LB, idx: i, price: candles[i].low, type: 'L' });
  }
  return events.sort((a, b) => a.confirmAt - b.confirmAt || a.idx - b.idx);
}

// Walk bars; maintain alternating dedup sequence; run the trade state machine.
function runStrategy(candles, retrace) {
  const closes = candles.map(c => c.close);
  const rsi = rsiSeries(closes);
  const pivotEvents = confirmedPivots(candles);
  const seq = [];            // alternating pivots (deduped, extreme kept)
  let pe = 0;
  const trades = [];
  const stats = { signals: 0, noChoch: 0, brokeWave5: 0, noFill: 0, filled: 0 };
  // state: null | {phase:'choch'|'fill', ...}
  let st = null;

  for (let t = 0; t < candles.length; t++) {
    // 1) absorb pivots confirmed at this bar into the alternating sequence
    let newPivot = null;
    while (pe < pivotEvents.length && pivotEvents[pe].confirmAt === t) {
      const p = pivotEvents[pe++];
      const last = seq[seq.length - 1];
      if (last && last.type === p.type) {
        const better = p.type === 'H' ? p.price > last.price : p.price < last.price;
        if (better) { seq[seq.length - 1] = p; newPivot = p; }
      } else { seq.push(p); newPivot = p; }
    }

    const c = candles[t];

    // 2) active setup state machine (one at a time)
    if (st) {
      const bull = st.dir === 'bull';
      const brokeW5 = bull ? c.close < st.w5 : c.close > st.w5;
      if (st.phase === 'choch') {
        if (brokeW5) { stats.brokeWave5++; st = null; }
        else {
          const choch = bull ? c.close > st.w4 : c.close < st.w4;
          if (choch) {
            let m1top = bull ? -Infinity : Infinity;
            for (let j = st.w5idx; j <= t; j++)
              m1top = bull ? Math.max(m1top, candles[j].high) : Math.min(m1top, candles[j].low);
            const L = Math.abs(m1top - st.w5);
            const entry = bull ? m1top - retrace * L : m1top + retrace * L;
            const tp = bull ? entry + L : entry - L;
            st = { ...st, phase: 'fill', deadline: t + ENTRY_MAX, entry, tp, m1len: L, sl: st.w5 };
          } else if (t >= st.deadline) { stats.noChoch++; st = null; }
        }
      } else if (st.phase === 'fill') {
        const touched = bull ? c.low <= st.entry : c.high >= st.entry;
        if (touched) {
          stats.filled++;
          st.fillIdx = t;
          // same-bar conservative: SL touched on the fill bar = immediate loss
          const slHit0 = bull ? c.low <= st.sl : c.high >= st.sl;
          const trade = simFrom(candles, st, slHit0 ? t : null);
          trades.push(trade);
          st = null;
        } else if (brokeW5 || t >= st.deadline) {
          stats[brokeW5 ? 'brokeWave5' : 'noFill']++; st = null;
        }
      }
    }

    // 3) look for a fresh divergence signal (only when idle, on a new LOW/HIGH pivot)
    if (!st && newPivot && seq.length >= 3) {
      const p2 = seq[seq.length - 1], mid = seq[seq.length - 2], p1 = seq[seq.length - 3];
      if (newPivot === p2) {
        const bull = p2.type === 'L';
        const ok = bull
          ? p2.price < p1.price && rsi[p2.idx] !== null && rsi[p1.idx] !== null && rsi[p2.idx] > rsi[p1.idx]
          : p2.price > p1.price && rsi[p2.idx] !== null && rsi[p1.idx] !== null && rsi[p2.idx] < rsi[p1.idx];
        if (ok) {
          const range = Math.abs(mid.price - p1.price);
          const ext = range > 0 ? Math.abs(mid.price - p2.price) / range : 0;
          if (ext >= EXT_MIN) {
            stats.signals++;
            st = {
              phase: 'choch', dir: bull ? 'bull' : 'bear',
              w5: p2.price, w5idx: p2.idx, w4: mid.price,
              grade: ext >= 1.618 ? 'STRONG' : 'MEDIUM',
              deadline: t + CHOCH_MAX,
            };
          }
        }
      }
    }
  }
  return { trades, stats, bars: candles.length };
}

function simFrom(candles, st, immediateSLBar) {
  const bull = st.dir === 'bull';
  const { entry, sl, tp, fillIdx } = st;
  const rPct = Math.abs(entry - sl) / entry * 100;
  const mk = (exitPx, exitIdx, tag) => {
    const pct = (bull ? exitPx - entry : entry - exitPx) / entry * 100;
    return {
      dir: st.dir, grade: st.grade, entry, sl, tp, fillIdx, exitIdx, tag,
      entryTime: candles[fillIdx].time, exitTime: candles[exitIdx].time,
      rPct, R: (pct - FEE_RT_PCT) / rPct, bars: exitIdx - fillIdx,
    };
  };
  if (immediateSLBar !== null) return mk(sl, immediateSLBar, 'SL0');
  for (let i = fillIdx + 1; i <= Math.min(fillIdx + HOLD_MAX, candles.length - 1); i++) {
    const c = candles[i];
    const slHit = bull ? c.low <= sl : c.high >= sl;
    if (slHit) return mk(sl, i, 'SL');            // SL-first on ambiguous bars
    const tpHit = bull ? c.high >= tp : c.low <= tp;
    if (tpHit) return mk(tp, i, 'TP');
  }
  const last = Math.min(fillIdx + HOLD_MAX, candles.length - 1);
  return mk(candles[last].close, last, 'Timeout');
}

function metricsR(trades, bars) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter(t => t.R > 0);
  const totalR = trades.reduce((s, t) => s + t.R, 0);
  const gw = trades.filter(t => t.R > 0).reduce((s, t) => s + t.R, 0);
  const gl = Math.abs(trades.filter(t => t.R <= 0).reduce((s, t) => s + t.R, 0));
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    eq += t.R; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
  }
  const exposure = trades.reduce((s, t) => s + t.bars, 0) / bars * 100;
  return { n, wr: wins.length / n * 100, avgR: totalR / n, totalR, pf: gl > 0 ? gw / gl : Infinity, maxDD, exposure };
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// MC: same per-trade SL/TP %-geometry at random entries, SL-first, timeout
function mcRandom(candles, trades, rounds = MC_ROUNDS, seed = 99) {
  const rng = mulberry32(seed);
  const totals = [];
  for (let k = 0; k < rounds; k++) {
    let tot = 0;
    for (const tr of trades) {
      const bull = tr.dir === 'bull';
      const slD = Math.abs(tr.entry - tr.sl) / tr.entry;
      const tpD = Math.abs(tr.tp - tr.entry) / tr.entry;
      const idx = 1 + Math.floor(rng() * (candles.length - HOLD_MAX - 2));
      const e = candles[idx].close;
      const sl = bull ? e * (1 - slD) : e * (1 + slD);
      const tp = bull ? e * (1 + tpD) : e * (1 - tpD);
      const rPct = slD * 100;
      let done = false;
      for (let i = idx + 1; i <= idx + HOLD_MAX; i++) {
        const c = candles[i];
        if (bull ? c.low <= sl : c.high >= sl) { tot += (-slD * 100 - FEE_RT_PCT) / rPct; done = true; break; }
        if (bull ? c.high >= tp : c.low <= tp) { tot += (tpD * 100 - FEE_RT_PCT) / rPct; done = true; break; }
      }
      if (!done) {
        const px = candles[idx + HOLD_MAX].close;
        tot += ((bull ? px - e : e - px) / e * 100 - FEE_RT_PCT) / rPct;
      }
    }
    totals.push(tot);
  }
  totals.sort((a, b) => a - b);
  return totals;
}

async function main() {
  const variants = [0.382, 0.5, 0.618];
  const out = {};
  for (const tf of TFS) {
    console.log(`\n═══ ${tf} · BTC+ETH · 2020-01 -> 2025-12 · Binance (replicating Bybit spec) ═══`);
    const dataBySym = {};
    for (const sym of SYMS) dataBySym[sym] = await B.fetchKlines(sym, tf, START, END);

    for (const retrace of variants) {
      const allTrades = [];
      let totBars = 0;
      const perSym = {};
      for (const sym of SYMS) {
        const { trades, stats, bars } = runStrategy(dataBySym[sym], retrace);
        trades.forEach(t => t.sym = sym);
        allTrades.push(...trades);
        totBars += bars;
        perSym[sym] = { trades, stats };
      }
      const m = metricsR(allTrades, totBars);
      const rrTheory = 1 / (1 - retrace);
      out[`${tf}-${retrace}`] = { m, perSym };

      console.log(`\n  — Entry retrace ${(retrace * 100).toFixed(1)}% (RR โครงสร้าง ${r2(rrTheory)}) —`);
      const st = SYMS.map(s => perSym[s].stats);
      console.log(`  signals=${st.reduce((a, b) => a + b.signals, 0)} -> filled=${st.reduce((a, b) => a + b.filled, 0)}` +
        `  (no-choch=${st.reduce((a, b) => a + b.noChoch, 0)}, broke-w5=${st.reduce((a, b) => a + b.brokeWave5, 0)}, no-fill=${st.reduce((a, b) => a + b.noFill, 0)})`);
      if (!m.n) { console.log('  (no trades)'); continue; }
      console.log(`  n=${m.n}  Win%=${r1(m.wr)}  AvgR=${r2(m.avgR)}  TotalR=${r2(m.totalR)}  PF=${r2(m.pf)}  MaxDD=${r2(m.maxDD)}R  exposure=${r1(m.exposure)}%`);

      // per-year
      const byYear = {};
      for (const t of allTrades) {
        const y = new Date(t.entryTime).getUTCFullYear();
        (byYear[y] = byYear[y] || []).push(t);
      }
      const yline = Object.keys(byYear).sort().map(y => {
        const tr = byYear[y];
        const tot = tr.reduce((s, t) => s + t.R, 0);
        return `${y}: ${r2(tot)}R/${tr.length}`;
      }).join('  ');
      console.log(`  per-year(TotalR/n): ${yline}`);

      // MC baseline (per symbol then combined by summing same-round totals)
      if (retrace === 0.382) {
        const roundTotals = new Array(MC_ROUNDS).fill(0);
        for (const sym of SYMS) {
          const tr = perSym[sym].trades;
          if (!tr.length) continue;
          const totals = mcRandom(dataBySym[sym], tr);
          for (let k = 0; k < MC_ROUNDS; k++) roundTotals[k] += totals[k];
        }
        roundTotals.sort((a, b) => a - b);
        const p95 = roundTotals[Math.floor(MC_ROUNDS * 0.95)];
        const p50 = roundTotals[Math.floor(MC_ROUNDS * 0.50)];
        const pctile = roundTotals.filter(v => v < m.totalR).length / MC_ROUNDS * 100;
        console.log(`  MC ${MC_ROUNDS} rounds: random median=${r2(p50)}R  p95=${r2(p95)}R  | actual=${r2(m.totalR)}R -> percentile ${r1(pctile)} ${m.totalR >= p95 ? '✅ PASS (>=p95)' : '❌ FAIL'}`);
      }

      // B&H context
      if (retrace === 0.382) {
        for (const sym of SYMS) {
          const cs = dataBySym[sym];
          const bh = (cs[cs.length - 1].close / cs[0].close - 1) * 100;
          console.log(`  B&H ${sym}: ${r1(bh)}% over period (strategy exposure only ${r1(metricsR(perSym[sym].trades, cs.length).exposure || 0)}% of bars)`);
        }
      }
    }
  }

  // sample trades for manual audit
  console.log('\n═══ Sample trades (4h, 38.2%) for manual audit ═══');
  const s = out['4h-0.382'];
  const sample = [...(s.perSym.BTCUSDT.trades || [])].slice(0, 3);
  for (const t of sample) {
    console.log(`  ${t.sym} ${t.dir} ${t.grade}  entry=${r2(t.entry)} sl=${r2(t.sl)} tp=${r2(t.tp)}  ` +
      `RRcheck=${r2(Math.abs(t.tp - t.entry) / Math.abs(t.entry - t.sl))}  ${d8(t.entryTime)} -> ${d8(t.exitTime)}  ${t.tag}  R=${r2(t.R)}`);
  }

  require('fs').writeFileSync(require('path').join(__dirname, 'divchoch-results.json'),
    JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.m])), null, 2));
  console.log('\nSaved bench/divchoch-results.json');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
