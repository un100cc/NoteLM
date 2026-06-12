/**
 * Audit of shockretest.html's claim:
 *   "พารามิเตอร์ชุดผ่าน out-of-sample 2020–2025 (+0.29R/ไม้)"
 *
 * Faithful port of the page's logic (BTC/ETH/SOL/BNB · 1h):
 *   - context: lower highs + lower lows (for long; mirrored for short)
 *   - shock: candle closes through last confirmed pivot level, body >= 1.0 x ATR14
 *   - A leg: extend while closes keep running; entry = 50% retrace of A
 *   - SL = A origin (structure invalidation) · TP1 = 100% of A · TP2 = 161.8%
 *   - cancel: SL breached before fill, or wait > 72 bars
 *   - daily filter: trade only the strong side of the big 1D swing
 *     (price position > 50% of last confirmed daily pivot range -> long only)
 *   - exits per page: half at TP1 then SL -> breakeven, rest at TP2
 *
 * Execution honesty added (per bench/COMPARE-SPEC.md):
 *   SL-first on ambiguous bars · fee 0.1% RT · one live setup per symbol ·
 *   pivots used only after confirmation (no lookahead)
 *
 * Tests:
 *   1. Replicate 2020–2025 -> does +0.29R/trade survive realistic execution?
 *   2. Per-year breakdown (regime concentration check)
 *   3. TRUE holdout: 2026 YTD (data after the claim window)
 *   4. Parameter sensitivity (atrMult, pivot k)
 *
 * Run: node bench/shockretest-audit.js
 */

const B = require('./benchmark.js');

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const START = Date.UTC(2020, 0, 1);
const SPLIT = Date.UTC(2026, 0, 1);     // claim window ends 2025-12
const END = 1781222400000;              // 2026-06-12
const D1_START = Date.UTC(2019, 5, 1);  // daily warmup for pivots
const FEE_RT_PCT = 0.1;
const BASE = { k1h: 4, kD: 6, atrMult: 1.0, entryFib: 0.5, maxWait: 72, horizon: 500 };

const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const pad = (s, n) => String(s).padStart(n);

function atr14(cs) {
  const out = new Array(cs.length).fill(NaN);
  let trs = [];
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].high - cs[i].low, Math.abs(cs[i].high - cs[i - 1].close), Math.abs(cs[i].low - cs[i - 1].close));
    trs.push(tr);
    if (trs.length > 14) trs.shift();
    if (trs.length === 14) out[i] = trs.reduce((a, b) => a + b, 0) / 14;
  }
  return out;
}
function pivots(cs, k) {
  const out = [];
  for (let i = k; i < cs.length - k; i++) {
    let isH = true, isL = true;
    for (let j = i - k; j <= i + k; j++) {
      if (cs[j].high > cs[i].high) isH = false;
      if (cs[j].low < cs[i].low) isL = false;
    }
    if (isH) out.push({ i, type: 'H', px: cs[i].high, conf: i + k });
    if (isL) out.push({ i, type: 'L', px: cs[i].low, conf: i + k });
  }
  return out.sort((a, b) => a.conf - b.conf || a.i - b.i);
}

// daily strong-side filter, point-in-time
function dailyAllowed(d1, kD) {
  const pv = pivots(d1, kD);
  return (tMs, px) => {
    let hi = null, lo = null;
    for (const p of pv) {
      if (d1[p.conf] && d1[p.conf].time <= tMs) {
        if (p.type === 'H') hi = p.px; else lo = p.px;
      } else break;
    }
    if (hi === null || lo === null || hi <= lo) return null;
    const pos = Math.max(0, Math.min(1, (px - lo) / (hi - lo)));
    return pos > 0.5 ? 'long' : 'short';
  };
}

function run(cs, d1, P) {
  const atr = atr14(cs);
  const pv = pivots(cs, P.k1h);
  const allowedAt = dailyAllowed(d1, P.kD);
  const trades = [];
  let pvPtr = 0;
  const confH = [], confL = [];
  let busyUntil = -1; // one live setup at a time

  for (let i = 120; i < cs.length; i++) {
    while (pvPtr < pv.length && pv[pvPtr].conf <= i) {
      (pv[pvPtr].type === 'H' ? confH : confL).push(pv[pvPtr]);
      pvPtr++;
    }
    if (i <= busyUntil) continue;
    if (confH.length < 2 || confL.length < 2) continue;

    const side = allowedAt(cs[i].time, cs[i].close);
    if (!side) continue;
    const sgn = side === 'long' ? 1 : -1;

    const h1 = confH[confH.length - 1], h2 = confH[confH.length - 2];
    const l1 = confL[confL.length - 1], l2 = confL[confL.length - 2];
    const ctx = side === 'long'
      ? h1.px < h2.px && l1.px < l2.px
      : l1.px > l2.px && h1.px > h2.px;
    if (!ctx || isNaN(atr[i])) continue;

    const lvl = side === 'long' ? h1.px : l1.px;
    const origin = side === 'long' ? l1 : h1;
    const body = Math.abs(cs[i].close - cs[i].open);
    const shock = sgn * (cs[i].close - lvl) > 0 && sgn * (cs[i].close - cs[i].open) > 0 && body >= P.atrMult * atr[i];
    if (!shock) continue;

    // extend the A leg while closes keep running
    let ext = i, j = i + 1;
    while (j < cs.length && sgn * (cs[j].close - cs[j - 1].close) > 0) { ext = j; j++; }
    if (ext >= cs.length - 1) break;
    const aEnd = side === 'long' ? cs[ext].high : cs[ext].low;
    const aLen = sgn * (aEnd - origin.px);
    if (aLen <= 0) continue;

    const entry = aEnd - sgn * aLen * P.entryFib;
    const stop = origin.px;
    const tp1 = entry + sgn * aLen;
    const tp2 = entry + sgn * aLen * 1.618;
    const riskPct = Math.abs(entry - stop) / entry * 100;
    const feeR = FEE_RT_PCT / riskPct;

    // wait for fill
    let fill = -1, dead = false;
    for (let m = ext + 1; m < Math.min(ext + 1 + P.maxWait, cs.length); m++) {
      const hitStop = side === 'long' ? cs[m].low < stop : cs[m].high > stop;
      const touch = side === 'long' ? cs[m].low <= entry : cs[m].high >= entry;
      if (touch) { fill = m; dead = hitStop; break; } // same bar both -> conservative SL
      if (hitStop) { dead = true; break; }
    }
    if (fill < 0) { busyUntil = Math.min(ext + P.maxWait, cs.length - 1); continue; }
    if (dead) {
      trades.push({ R: -1 - feeR, t: cs[fill].time, side });
      busyUntil = fill;
      continue;
    }

    // manage: half at TP1 -> BE, rest TP2; SL-first on ambiguous bars
    let R = 0, half = false, exitIdx = Math.min(fill + P.horizon, cs.length - 1);
    let stopNow = stop;
    for (let m = fill + 1; m <= Math.min(fill + P.horizon, cs.length - 1); m++) {
      const lo = cs[m].low, hi = cs[m].high;
      const hitStop = side === 'long' ? lo <= stopNow : hi >= stopNow;
      if (hitStop) {
        const stopR = sgn * (stopNow - entry) / Math.abs(entry - stop);
        R += (half ? 0.5 : 1) * stopR;
        exitIdx = m; break;
      }
      if (!half && (side === 'long' ? hi >= tp1 : lo <= tp1)) {
        R += 0.5 * (Math.abs(tp1 - entry) / Math.abs(entry - stop));
        half = true; stopNow = entry; // breakeven
        // TP2 same bar after TP1: allow (price already ran through)
      }
      if (half && (side === 'long' ? hi >= tp2 : lo <= tp2)) {
        R += 0.5 * (Math.abs(tp2 - entry) / Math.abs(entry - stop));
        exitIdx = m; half = 'done'; break;
      }
    }
    if (half !== 'done' && exitIdx === Math.min(fill + P.horizon, cs.length - 1)) {
      const px = cs[exitIdx].close;
      R += (half ? 0.5 : 1) * (sgn * (px - entry) / Math.abs(entry - stop));
    }
    trades.push({ R: R - feeR, t: cs[fill].time, side });
    busyUntil = exitIdx;
  }
  return trades;
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: 0, avgR: 0, totalR: 0 };
  const wins = trades.filter(t => t.R > 0).length;
  const totalR = trades.reduce((s, t) => s + t.R, 0);
  return { n, wr: wins / n * 100, avgR: totalR / n, totalR };
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

async function main() {
  console.log('Loading 1h + 1d data for BTC/ETH/SOL/BNB (2020 -> 2026-06)...');
  const H1 = {}, D1 = {};
  for (const s of SYMS) {
    H1[s] = await B.fetchKlines(s, '1h', START, END);
    D1[s] = await B.fetchKlines(s, '1d', D1_START, END);
    console.log(`  ${s}: ${H1[s].length} x 1h, ${D1[s].length} x 1d`);
  }

  // 1) replicate claim window + true holdout
  const inS = [], oos = [];
  for (const s of SYMS) {
    const tr = run(H1[s], D1[s], BASE);
    for (const t of tr) (t.t < SPLIT ? inS : oos).push({ ...t, sym: s });
  }
  const a = summarize(inS), b = summarize(oos);
  console.log('\n═══ 1) Claim window 2020–2025 (เคลม +0.29R/ไม้) ═══');
  console.log(`  n=${a.n}  WR=${r1(a.wr)}%  avgR=${r2(a.avgR)}  totalR=${r2(a.totalR)}  ${a.avgR >= 0.29 ? '✅ ทำได้ตามเคลม' : a.avgR > 0 ? '⚠️ บวกแต่ต่ำกว่าเคลม' : '❌ ไม่บวก'}`);
  const byYear = {};
  for (const t of inS) {
    const y = new Date(t.t).getUTCFullYear();
    (byYear[y] = byYear[y] || []).push(t);
  }
  console.log('  per-year: ' + Object.keys(byYear).sort().map(y => {
    const m = summarize(byYear[y]);
    return `${y}: ${r2(m.totalR)}R/${m.n}`;
  }).join('  '));
  console.log('\n═══ 2) TRUE holdout 2026 YTD (ม.ค.–มิ.ย. 2026) ═══');
  console.log(`  n=${b.n}  WR=${r1(b.wr)}%  avgR=${r2(b.avgR)}  totalR=${r2(b.totalR)}`);

  // 3) random-entry MC with same geometry (in-sample window)
  const rng = mulberry32(7);
  const rounds = 1000, totals = [];
  for (let k = 0; k < rounds; k++) {
    let tot = 0;
    for (const t of inS) {
      const cs = H1[t.sym];
      // random bar; reuse a representative 2R-target/1R-stop/partial profile
      const idx = 200 + Math.floor(rng() * (cs.length - 800));
      const e = cs[idx].close;
      const riskPct = 0.02; // median-ish risk distance 2%
      const stop = t.side === 'long' ? e * (1 - riskPct) : e * (1 + riskPct);
      const tp1 = t.side === 'long' ? e * (1 + 2 * riskPct) : e * (1 - 2 * riskPct);
      const tp2 = t.side === 'long' ? e * (1 + 3.236 * riskPct) : e * (1 - 3.236 * riskPct);
      let R = 0, half = false, stopNow = stop, done = false;
      for (let m = idx + 1; m < Math.min(idx + 500, cs.length); m++) {
        const lo = cs[m].low, hi = cs[m].high;
        const hitStop = t.side === 'long' ? lo <= stopNow : hi >= stopNow;
        if (hitStop) { R += (half ? 0.5 : 1) * ((t.side === 'long' ? stopNow - e : e - stopNow) / (e * riskPct)); done = true; break; }
        if (!half && (t.side === 'long' ? hi >= tp1 : lo <= tp1)) { R += 1; half = true; stopNow = e; }
        if (half && (t.side === 'long' ? hi >= tp2 : lo <= tp2)) { R += 1.618; done = true; break; }
      }
      if (!done && half) R += 0; // leftover BE-ish, ignore tail
      tot += R - 0.05;
    }
    totals.push(tot);
  }
  totals.sort((x, y) => x - y);
  const p95 = totals[Math.floor(rounds * 0.95)];
  const pct = totals.filter(v => v < a.totalR).length / rounds * 100;
  console.log('\n═══ 3) Random-entry MC 1,000 รอบ (เรขาคณิตเดียวกัน) ═══');
  console.log(`  random median=${r2(totals[Math.floor(rounds / 2)])}R  p95=${r2(p95)}R  | actual=${r2(a.totalR)}R -> percentile ${r1(pct)} ${a.totalR >= p95 ? '✅ ผ่าน p95' : '❌ ไม่ผ่าน p95'}`);

  // 4) sensitivity
  console.log('\n═══ 4) Parameter sensitivity (2020–2025) ═══');
  console.log(`  ${'variant'.padEnd(22)}${pad('n', 6)}${pad('WR%', 7)}${pad('avgR', 7)}${pad('totalR', 8)}`);
  for (const [name, over] of [
    ['baseline', {}],
    ['atrMult=0.75', { atrMult: 0.75 }],
    ['atrMult=1.25', { atrMult: 1.25 }],
    ['k1h=3', { k1h: 3 }],
    ['k1h=5', { k1h: 5 }],
    ['ไม่กรอง daily side', { noDaily: true }],
  ]) {
    const P = { ...BASE, ...over };
    const tr = [];
    for (const s of SYMS) {
      const d1 = over.noDaily
        ? D1[s] // still passed; bypass below
        : D1[s];
      const t = over.noDaily
        ? runNoDaily(H1[s], P)
        : run(H1[s], D1[s], P);
      tr.push(...t.filter(x => x.t < SPLIT));
    }
    const m = summarize(tr);
    console.log(`  ${name.padEnd(22)}${pad(m.n, 6)}${pad(r1(m.wr), 7)}${pad(r2(m.avgR), 7)}${pad(r2(m.totalR), 8)}`);
  }
}

function runNoDaily(cs, P) {
  // same engine but allow both sides every bar
  const fakeD1 = null;
  // quick wrapper: monkey-run both directions by reusing run() with a permissive filter
  const atrCache = cs;
  const orig = dailyAllowedPermissive;
  return [...runWith(cs, P, 'long'), ...runWith(cs, P, 'short')].sort((a, b) => a.t - b.t);
}
function dailyAllowedPermissive() { return () => 'both'; }
function runWith(cs, P, side) {
  const d1Fake = [{ time: 0, high: 1, low: 0, close: 0.5 }];
  // simplest: temporarily reuse run() by injecting an allowed function — refactor inline:
  const atr = atr14(cs);
  const pv = pivots(cs, P.k1h);
  const trades = [];
  let pvPtr = 0;
  const confH = [], confL = [];
  let busyUntil = -1;
  for (let i = 120; i < cs.length; i++) {
    while (pvPtr < pv.length && pv[pvPtr].conf <= i) {
      (pv[pvPtr].type === 'H' ? confH : confL).push(pv[pvPtr]);
      pvPtr++;
    }
    if (i <= busyUntil) continue;
    if (confH.length < 2 || confL.length < 2) continue;
    const sgn = side === 'long' ? 1 : -1;
    const h1 = confH[confH.length - 1], h2 = confH[confH.length - 2];
    const l1 = confL[confL.length - 1], l2 = confL[confL.length - 2];
    const ctx = side === 'long' ? h1.px < h2.px && l1.px < l2.px : l1.px > l2.px && h1.px > h2.px;
    if (!ctx || isNaN(atr[i])) continue;
    const lvl = side === 'long' ? h1.px : l1.px;
    const origin = side === 'long' ? l1 : h1;
    const body = Math.abs(cs[i].close - cs[i].open);
    const shock = sgn * (cs[i].close - lvl) > 0 && sgn * (cs[i].close - cs[i].open) > 0 && body >= P.atrMult * atr[i];
    if (!shock) continue;
    let ext = i, j = i + 1;
    while (j < cs.length && sgn * (cs[j].close - cs[j - 1].close) > 0) { ext = j; j++; }
    if (ext >= cs.length - 1) break;
    const aEnd = side === 'long' ? cs[ext].high : cs[ext].low;
    const aLen = sgn * (aEnd - origin.px);
    if (aLen <= 0) continue;
    const entry = aEnd - sgn * aLen * P.entryFib;
    const stop = origin.px;
    const tp1 = entry + sgn * aLen, tp2 = entry + sgn * aLen * 1.618;
    const riskPct = Math.abs(entry - stop) / entry * 100;
    const feeR = FEE_RT_PCT / riskPct;
    let fill = -1, dead = false;
    for (let m = ext + 1; m < Math.min(ext + 1 + P.maxWait, cs.length); m++) {
      const hitStop = side === 'long' ? cs[m].low < stop : cs[m].high > stop;
      const touch = side === 'long' ? cs[m].low <= entry : cs[m].high >= entry;
      if (touch) { fill = m; dead = hitStop; break; }
      if (hitStop) { dead = true; break; }
    }
    if (fill < 0) { busyUntil = Math.min(ext + P.maxWait, cs.length - 1); continue; }
    if (dead) { trades.push({ R: -1 - feeR, t: cs[fill].time, side }); busyUntil = fill; continue; }
    let R = 0, half = false, exitIdx = Math.min(fill + P.horizon, cs.length - 1);
    let stopNow = stop;
    for (let m = fill + 1; m <= Math.min(fill + P.horizon, cs.length - 1); m++) {
      const lo = cs[m].low, hi = cs[m].high;
      const hitStop = side === 'long' ? lo <= stopNow : hi >= stopNow;
      if (hitStop) { R += (half ? 0.5 : 1) * (sgn * (stopNow - entry) / Math.abs(entry - stop)); exitIdx = m; break; }
      if (!half && (side === 'long' ? hi >= tp1 : lo <= tp1)) { R += 0.5 * 2; half = true; stopNow = entry; }
      if (half && (side === 'long' ? hi >= tp2 : lo <= tp2)) { R += 0.5 * 3.236; exitIdx = m; half = 'done'; break; }
    }
    if (half !== 'done' && exitIdx === Math.min(fill + P.horizon, cs.length - 1)) {
      const px = cs[exitIdx].close;
      R += (half ? 0.5 : 1) * (sgn * (px - entry) / Math.abs(entry - stop));
    }
    trades.push({ R: R - feeR, t: cs[fill].time, side });
    busyUntil = exitIdx;
  }
  return trades;
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
