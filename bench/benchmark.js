/**
 * KLAUD Strategy Benchmark Harness
 * Evaluates the 3 Swings & Shock Retest strategy for real edge vs overfit.
 *
 * Phases:
 *   A. Replicate original backtest logic (anchor the claimed numbers)
 *   B. Bias-corrected ("realistic") simulation:
 *        - entry requires price to actually trade through Fib 50% (limit fill)
 *        - same-bar TP/SL ambiguity resolves to SL (conservative)
 *        - partial exits 1/3 @ TP1 / TP2 / TP3 (per strategy doc)
 *        - round-trip fee deducted
 *   C. Walk-forward across 7 six-month windows (out-of-sample)
 *   D. Random-entry baseline (same exit geometry, random timing)
 *   E. Parameter sensitivity (one-at-a-time perturbation)
 *
 * Run: node bench/benchmark.js          (full, fetches + caches data)
 *      node bench/benchmark.js --phase=A,B   (subset)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const COINS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOTUSDT','LINKUSDT','AVAXUSDT','SUIUSDT',
  'STXUSDT','XLMUSDT','ICPUSDT','DOGEUSDT','APTUSDT',
  'FETUSDT','RUNEUSDT','NEARUSDT','ATOMUSDT','LTCUSDT'
];

const BASE_PARAMS = {
  M1_MIN_PCT:    0.03,
  M1_MIN_BARS:   3,
  M1_MAX_BARS:   40,
  M2_MIN_RET:    0.30,
  M2_MAX_RET:    0.68,
  M2_MAX_BARS:   80,
  FIB_ENTRY_MIN: 0.333,
  FIB_ENTRY_MAX: 0.618,
  SL_BUFFER:     0.005,
  TP1_PCT:       0.25,
  RR_MIN:        1.5,
};

const FEE_RT_PCT = 0.1;   // round-trip fee+slippage, in pct points of notional

// 6-month windows, newest first. W0 = the in-sample window the original used.
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1781222400000; // 2026-06-12 00:00 UTC (fixed for reproducible cache keys)
const WINDOWS = [];
for (let i = 0; i < 6; i++) {
  WINDOWS.push({ name: `W${i}`, start: NOW - (i + 1) * 182 * DAY, end: NOW - i * 182 * DAY });
}
WINDOWS.push({ name: 'W6-2022bear', start: Date.UTC(2022, 0, 1), end: Date.UTC(2022, 6, 1) });
const fmtD = ms => new Date(ms).toISOString().slice(0, 10);

// ── Fetch with pagination + disk cache ────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchKlines(symbol, interval, startMs, endMs) {
  const key = `${symbol}-${interval}-${startMs}-${endMs}.json`;
  const file = path.join(CACHE_DIR, key);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));

  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const raw = await fetchJSON(url);
    if (!Array.isArray(raw)) throw new Error(`bad response: ${JSON.stringify(raw).slice(0, 120)}`);
    if (raw.length === 0) break;
    for (const k of raw) out.push({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    cursor = raw[raw.length - 1][0] + 1;
    await sleep(120);
    if (raw.length < 1000) break;
  }
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

// ── Detection (verbatim port of backtest.js, parameterized) ───────
function findSwingHighs(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].high;
    let isHigh = true;
    for (let j = i - left; j <= i + right; j++)
      if (j !== i && candles[j].high >= h) { isHigh = false; break; }
    if (isHigh) out.push({ idx: i, price: h });
  }
  return out;
}
function findSwingLows(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const l = candles[i].low;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++)
      if (j !== i && candles[j].low <= l) { isLow = false; break; }
    if (isLow) out.push({ idx: i, price: l });
  }
  return out;
}

function detectM1s(candles, P) {
  const swingHighs = findSwingHighs(candles);
  const swingLows = findSwingLows(candles);
  const m1s = [];
  for (const lo of swingLows) {
    for (const hi of swingHighs) {
      if (hi.idx <= lo.idx) continue;
      if (hi.idx - lo.idx > P.M1_MAX_BARS) break;
      const bars = hi.idx - lo.idx;
      const pct = (hi.price - lo.price) / lo.price;
      if (pct >= P.M1_MIN_PCT && bars >= P.M1_MIN_BARS) {
        m1s.push({ dir: 'bull', startIdx: lo.idx, startPrice: lo.price, endIdx: hi.idx, endPrice: hi.price, length: hi.price - lo.price, bars, pct });
        break;
      }
    }
  }
  for (const hi of swingHighs) {
    for (const lo of swingLows) {
      if (lo.idx <= hi.idx) continue;
      if (lo.idx - hi.idx > P.M1_MAX_BARS) break;
      const bars = lo.idx - hi.idx;
      const pct = (hi.price - lo.price) / hi.price;
      if (pct >= P.M1_MIN_PCT && bars >= P.M1_MIN_BARS) {
        m1s.push({ dir: 'bear', startIdx: hi.idx, startPrice: hi.price, endIdx: lo.idx, endPrice: lo.price, length: hi.price - lo.price, bars, pct });
        break;
      }
    }
  }
  return m1s.sort((a, b) => a.endIdx - b.endIdx);
}

function findSetups(candles, P) {
  const m1s = detectM1s(candles, P);
  const setups = [];
  for (const m1 of m1s) {
    const endI = m1.endIdx;
    const bull = m1.dir === 'bull';
    const fib = pct => bull ? m1.endPrice - pct * m1.length : m1.endPrice + pct * m1.length;
    const fib333 = fib(P.FIB_ENTRY_MIN);
    const fib500 = fib(0.5);
    const fib618 = fib(P.FIB_ENTRY_MAX);

    let m2Idx = null, m2Low = null, m2High = null;
    for (let i = endI + 1; i < Math.min(endI + P.M2_MAX_BARS, candles.length); i++) {
      const c = candles[i];
      const ret = bull ? (m1.endPrice - c.low) / m1.length : (c.high - m1.endPrice) / m1.length;
      if (ret >= P.M2_MIN_RET && ret <= P.M2_MAX_RET) {
        m2Idx = i;
        m2Low = bull ? c.low : m1.endPrice;
        m2High = bull ? m1.endPrice : c.high;
        break;
      }
    }
    if (m2Idx === null) continue;

    let shockIdx = null;
    for (let i = m2Idx + 1; i < Math.min(m2Idx + P.M2_MAX_BARS, candles.length); i++) {
      const c = candles[i];
      if (bull ? c.close > m1.endPrice : c.close < m1.endPrice) { shockIdx = i; break; }
    }
    if (shockIdx === null) continue;

    for (let i = shockIdx + 1; i < Math.min(shockIdx + 40, candles.length); i++) {
      const c = candles[i];
      const structureBroken = bull
        ? c.low < m2Low * (1 - P.SL_BUFFER)
        : c.high > m2High * (1 + P.SL_BUFFER);
      if (structureBroken) break;
      const inZone = bull
        ? c.low <= fib333 && c.high >= fib618
        : c.high >= fib333 && c.low <= fib618;
      if (!inZone) continue;

      const entryPrice = fib500;
      const sl = bull ? fib618 * (1 - P.SL_BUFFER) : fib618 * (1 + P.SL_BUFFER);
      const tp1 = bull ? entryPrice + m1.length * P.TP1_PCT : entryPrice - m1.length * P.TP1_PCT;
      const tp2 = m1.endPrice;
      const tp3 = bull ? m2Low + m1.length : m2High - m1.length;
      const rr = bull ? (tp2 - entryPrice) / (entryPrice - sl) : (entryPrice - tp2) / (sl - entryPrice);
      if (rr < P.RR_MIN) continue;

      setups.push({ m1, m2Idx, m2Low, m2High, shockIdx, retestIdx: i, dir: m1.dir, entryPrice, sl, tp1, tp2, tp3, rr });
      break;
    }
  }
  const seen = new Set();
  return setups.filter(s => {
    const key = `${s.m1.endIdx}-${s.dir}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Simulators ────────────────────────────────────────────────────
// Original: assumes fill at fib500 always; checks TP3→TP2→TP1→SL per bar
// (win if a bar touches both TP and SL); no fees. Verbatim port.
function simOriginal(candles, setup) {
  const { dir, entryPrice, sl, tp1, tp2, tp3, retestIdx } = setup;
  const bull = dir === 'bull';
  for (let i = retestIdx + 1; i < Math.min(retestIdx + 60, candles.length); i++) {
    const { high, low, time } = candles[i];
    if (bull ? high >= tp3 : low <= tp3)
      return { result: 'win', tp: 'TP3', pct: Math.abs(tp3 - entryPrice) / entryPrice * 100, time };
    if (bull ? high >= tp2 : low <= tp2)
      return { result: 'win', tp: 'TP2', pct: Math.abs(tp2 - entryPrice) / entryPrice * 100, time };
    if (bull ? high >= tp1 : low <= tp1)
      return { result: 'win', tp: 'TP1', pct: Math.abs(tp1 - entryPrice) / entryPrice * 100, time };
    if (bull ? low <= sl : high >= sl)
      return { result: 'loss', tp: 'SL', pct: -Math.abs(entryPrice - sl) / entryPrice * 100, time };
  }
  const last = candles[Math.min(retestIdx + 59, candles.length - 1)];
  const pct = (last.close - entryPrice) / entryPrice * 100 * (bull ? 1 : -1);
  return { result: pct >= 0 ? 'win' : 'loss', tp: 'Expire', pct, time: last.time };
}

// Realistic: limit fill must actually trade; partial exits 1/3 each at
// TP1/TP2/TP3; fee deducted. Returns null if never filled.
// opts.slPriority: on a bar touching both TP and SL, true = SL fills first
// (pessimistic bound), false = TPs fill first (optimistic bound). The truth
// is between the two; resolving it needs lower-timeframe data.
// opts.exitModel: 'partial' (1/3 each, per strategy doc), 'tp1' or 'tp2'
// (full exit at that single target).
// opts.horizon: max bars held after fill before force-close (default 60).
function simRealistic(candles, setup, feePct = FEE_RT_PCT, opts = { slPriority: true, exitModel: 'partial' }) {
  const HORIZON = opts.horizon || 60;
  const { dir, entryPrice, sl, tp1, tp2, tp3, retestIdx, m2Low, m2High } = setup;
  const bull = dir === 'bull';
  const P = BASE_PARAMS;

  // 1) Wait for fill at fib500 (limit order), valid while structure holds, max 40 bars
  let fillIdx = null;
  for (let i = retestIdx; i < Math.min(retestIdx + 40, candles.length); i++) {
    const c = candles[i];
    const structureBroken = bull
      ? c.low < m2Low * (1 - P.SL_BUFFER)
      : c.high > m2High * (1 + P.SL_BUFFER);
    const touched = bull ? c.low <= entryPrice : c.high >= entryPrice;
    if (touched) { fillIdx = i; break; }
    if (structureBroken) return null; // order cancelled before fill
  }
  if (fillIdx === null) return null;

  // Same-bar conservative check: if the fill bar also breached SL, count full loss
  const fb = candles[fillIdx];
  if (bull ? fb.low <= sl : fb.high >= sl) {
    const pct = -Math.abs(entryPrice - sl) / entryPrice * 100 - feePct;
    return { result: 'loss', tp: 'SL', pct, time: fb.time, fillIdx };
  }

  // 2) Partial exits, SL priority when a bar touches both sides
  const tps = opts.exitModel === 'tp1' ? [{ name: 'TP1', price: tp1, frac: 1, hit: false }]
    : opts.exitModel === 'tp2' ? [{ name: 'TP2', price: tp2, frac: 1, hit: false }]
    : [
      { name: 'TP1', price: tp1, frac: 1 / 3, hit: false },
      { name: 'TP2', price: tp2, frac: 1 / 3, hit: false },
      { name: 'TP3', price: tp3, frac: 1 / 3, hit: false },
    ];
  let pnl = 0, remaining = 1, lastName = null, lastTime = null;
  const pctOf = px => (bull ? (px - entryPrice) : (entryPrice - px)) / entryPrice * 100;

  for (let i = fillIdx + 1; i < Math.min(fillIdx + HORIZON, candles.length) && remaining > 1e-9; i++) {
    const { high, low, time } = candles[i];
    const slTouched = bull ? low <= sl : high >= sl;
    if (slTouched && opts.slPriority) { // pessimistic: SL fills first on ambiguous bars
      pnl += remaining * pctOf(sl);
      remaining = 0; lastName = lastName ? `${lastName}+SL` : 'SL'; lastTime = time;
      break;
    }
    for (const tp of tps) {
      if (tp.hit) continue;
      if (bull ? high >= tp.price : low <= tp.price) {
        tp.hit = true;
        pnl += tp.frac * pctOf(tp.price);
        remaining -= tp.frac;
        lastName = tp.name; lastTime = time;
      }
    }
    if (slTouched && !opts.slPriority && remaining > 1e-9) { // optimistic: SL takes leftover only
      pnl += remaining * pctOf(sl);
      remaining = 0; lastName = lastName ? `${lastName}+SL` : 'SL'; lastTime = time;
      break;
    }
  }
  if (remaining > 1e-9) { // expire: close leftover at last bar close
    const last = candles[Math.min(fillIdx + HORIZON - 1, candles.length - 1)];
    pnl += remaining * pctOf(last.close);
    lastName = lastName ? `${lastName}+Exp` : 'Expire'; lastTime = last.time;
  }
  pnl -= feePct;
  return { result: pnl > 0 ? 'win' : 'loss', tp: lastName, pct: pnl, time: lastTime, fillIdx };
}

// ── Metrics ───────────────────────────────────────────────────────
function metrics(trades) {
  const n = trades.length;
  if (!n) return { n: 0, wr: 0, ev: 0, pf: 0, pnl: 0 };
  const wins = trades.filter(t => t.result === 'win');
  const pnl = trades.reduce((s, t) => s + t.pct, 0);
  const grossW = trades.filter(t => t.pct > 0).reduce((s, t) => s + t.pct, 0);
  const grossL = Math.abs(trades.filter(t => t.pct <= 0).reduce((s, t) => s + t.pct, 0));
  return {
    n,
    wr: wins.length / n * 100,
    ev: pnl / n,
    pf: grossL > 0 ? grossW / grossL : Infinity,
    pnl,
  };
}

function bootstrapCI(trades, iters = 2000, seed = 42) {
  if (trades.length < 2) return [0, 0];
  const rng = mulberry32(seed);
  const evs = [];
  for (let k = 0; k < iters; k++) {
    let s = 0;
    for (let i = 0; i < trades.length; i++)
      s += trades[Math.floor(rng() * trades.length)].pct;
    evs.push(s / trades.length);
  }
  evs.sort((a, b) => a - b);
  return [evs[Math.floor(iters * 0.025)], evs[Math.floor(iters * 0.975)]];
}

function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Random-entry baseline ─────────────────────────────────────────
// Keeps each real setup's exit geometry (% distances) but enters at a random
// bar's close in the same coin/window. Isolates entry-timing skill.
function randomBaseline(candleMap, setupsBySym, shuffles = 50, seed = 7) {
  const rng = mulberry32(seed);
  const evDist = [];
  for (let k = 0; k < shuffles; k++) {
    const trades = [];
    for (const [sym, setups] of Object.entries(setupsBySym)) {
      const candles = candleMap[sym];
      if (!candles || candles.length < 80) continue;
      for (const s of setups) {
        const bull = s.dir === 'bull';
        const slD = Math.abs(s.entryPrice - s.sl) / s.entryPrice;
        const tpD = [s.tp1, s.tp2, s.tp3].map(tp => Math.abs(tp - s.entryPrice) / s.entryPrice);
        const idx = 1 + Math.floor(rng() * (candles.length - 70));
        const entry = candles[idx].close;
        const sl = bull ? entry * (1 - slD) : entry * (1 + slD);
        const tps = tpD.map(d => bull ? entry * (1 + d) : entry * (1 - d));
        const fake = {
          dir: s.dir, entryPrice: entry, sl, tp1: tps[0], tp2: tps[1], tp3: tps[2],
          retestIdx: idx, m2Low: 0, m2High: Infinity, // structure check disabled
        };
        const r = simRealistic(candles, fake);
        if (r) trades.push(r);
      }
    }
    evDist.push(metrics(trades).ev);
  }
  evDist.sort((a, b) => a - b);
  const mean = evDist.reduce((s, v) => s + v, 0) / evDist.length;
  return { mean, p5: evDist[Math.floor(evDist.length * 0.05)], p95: evDist[Math.floor(evDist.length * 0.95)], dist: evDist };
}

// ── Runners ───────────────────────────────────────────────────────
async function loadWindow(tf, win) {
  const map = {};
  for (const sym of COINS) {
    try {
      const c = await fetchKlines(sym, tf, win.start, win.end);
      if (c.length >= 80) map[sym] = c;
    } catch (e) {
      process.stdout.write(`(${sym}: ${e.message}) `);
    }
  }
  return map;
}

function runMode(candleMap, P, mode, feePct = FEE_RT_PCT) {
  const trades = [];
  const setupsBySym = {};
  for (const [sym, candles] of Object.entries(candleMap)) {
    const setups = findSetups(candles, P);
    setupsBySym[sym] = setups;
    for (const s of setups) {
      const r = mode === 'original' ? simOriginal(candles, s)
        : simRealistic(candles, s, feePct, { slPriority: mode !== 'realistic-opt' });
      if (r) trades.push({ ...r, sym });
    }
  }
  return { trades, setupsBySym };
}

function buyHold(candleMap) {
  const rets = Object.values(candleMap).map(c => (c[c.length - 1].close - c[0].close) / c[0].close * 100);
  return rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
}

const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const pad = (s, n) => String(s).padStart(n);

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const phases = (process.argv.find(a => a.startsWith('--phase=')) || '--phase=A,B,C,D,E').slice(8).split(',');
  const results = {};

  console.log('KLAUD Strategy Benchmark');
  console.log(`Windows: ${WINDOWS.map(w => `${w.name}=${fmtD(w.start)}..${fmtD(w.end)}`).join('  ')}\n`);

  // ── Phase A+B: replicate vs realistic on W0 (in-sample window) ──
  if (phases.includes('A') || phases.includes('B')) {
    console.log('═══ Phase A/B — In-sample window W0: original vs bias-corrected ═══');
    for (const tf of ['1d', '4h', '1h']) {
      process.stdout.write(`  loading ${tf}... `);
      const cmap = await loadWindow(tf, WINDOWS[0]);
      console.log(`${Object.keys(cmap).length} coins`);
      const orig = runMode(cmap, BASE_PARAMS, 'original');
      const real = runMode(cmap, BASE_PARAMS, 'realistic');
      const ropt = runMode(cmap, BASE_PARAMS, 'realistic-opt');
      const mo = metrics(orig.trades), mr = metrics(real.trades), mp = metrics(ropt.trades);
      const ci = bootstrapCI(real.trades);
      console.log(`  ${tf.padEnd(3)} original       : n=${pad(mo.n, 4)}  WR=${pad(r1(mo.wr), 6)}%  EV=${pad(r2(mo.ev), 7)}%/trade  PF=${r2(mo.pf)}`);
      console.log(`  ${tf.padEnd(3)} corrected-opt  : n=${pad(mp.n, 4)}  WR=${pad(r1(mp.wr), 6)}%  EV=${pad(r2(mp.ev), 7)}%/trade  PF=${r2(mp.pf)}   (upper bound)`);
      console.log(`  ${tf.padEnd(3)} corrected-pess : n=${pad(mr.n, 4)}  WR=${pad(r1(mr.wr), 6)}%  EV=${pad(r2(mr.ev), 7)}%/trade  PF=${r2(mr.pf)}   (lower bound, EV 95%CI=[${r2(ci[0])}, ${r2(ci[1])}])`);
      results[`AB-${tf}`] = { original: mo, correctedOpt: mp, correctedPess: mr, ci };
    }
    console.log();
  }

  // ── Phase C: walk-forward (4h, realistic) ──
  if (phases.includes('C')) {
    console.log('═══ Phase C — Walk-forward, 4h, bias-corrected (pess | opt bounds) ═══');
    console.log(`  ${'window'.padEnd(13)}${pad('period', 23)}${pad('n', 5)}${pad('WR%p', 7)}${pad('EVp', 7)}${pad('WR%o', 7)}${pad('EVo', 7)}${pad('PFo', 6)}${pad('B&H%', 8)}`);
    results.walkforward = [];
    for (const win of WINDOWS) {
      const cmap = await loadWindow('4h', win);
      const { trades, setupsBySym } = runMode(cmap, BASE_PARAMS, 'realistic');
      const opt = runMode(cmap, BASE_PARAMS, 'realistic-opt');
      const m = metrics(trades), mo = metrics(opt.trades);
      const ci = bootstrapCI(trades);
      const bh = buyHold(cmap);
      console.log(`  ${win.name.padEnd(13)}${pad(fmtD(win.start) + '..' + fmtD(win.end).slice(5), 23)}${pad(m.n, 5)}${pad(r1(m.wr), 7)}${pad(r2(m.ev), 7)}${pad(r1(mo.wr), 7)}${pad(r2(mo.ev), 7)}${pad(r2(mo.pf), 6)}${pad(r1(bh), 8)}`);
      results.walkforward.push({ win: win.name, ...m, evOpt: mo.ev, wrOpt: mo.wr, pfOpt: mo.pf, ci, bh, _setupsBySym: setupsBySym, _cmap: Object.keys(cmap).length });
      // stash for phase D
      win._cmap = cmap;
      win._setupsBySym = setupsBySym;
      win._trades = trades;
    }
    console.log();
  }

  // ── Phase D: random-entry baseline per window ──
  if (phases.includes('D')) {
    console.log('═══ Phase D — Random-entry baseline (same exits, random timing, 4h) ═══');
    console.log(`  ${'window'.padEnd(13)}${pad('strat EV', 10)}${pad('rand mean', 11)}${pad('rand p5..p95', 18)}${pad('beats rand?', 14)}`);
    results.baseline = [];
    for (const win of WINDOWS) {
      if (!win._cmap) { win._cmap = await loadWindow('4h', win); const r = runMode(win._cmap, BASE_PARAMS, 'realistic'); win._setupsBySym = r.setupsBySym; win._trades = r.trades; }
      const stratEV = metrics(win._trades).ev;
      const nSetups = Object.values(win._setupsBySym).reduce((s, v) => s + v.length, 0);
      if (nSetups < 5) { console.log(`  ${win.name.padEnd(13)}${pad('—', 10)}  (too few setups)`); continue; }
      const rb = randomBaseline(win._cmap, win._setupsBySym);
      const pctile = rb.dist.filter(v => v < stratEV).length / rb.dist.length * 100;
      const verdict = stratEV > rb.p95 ? 'YES (>p95)' : stratEV > rb.mean ? `weak (p${Math.round(pctile)})` : `NO (p${Math.round(pctile)})`;
      console.log(`  ${win.name.padEnd(13)}${pad(r2(stratEV), 10)}${pad(r2(rb.mean), 11)}${pad(`[${r2(rb.p5)},${r2(rb.p95)}]`, 18)}${pad(verdict, 14)}`);
      results.baseline.push({ win: win.name, stratEV, randMean: rb.mean, p5: rb.p5, p95: rb.p95, pctile });
    }
    console.log();
  }

  // ── Phase E: parameter sensitivity (W0, 4h, realistic) ──
  if (phases.includes('E')) {
    console.log('═══ Phase E — Parameter sensitivity (W0, 4h, bias-corrected) ═══');
    const cmap = WINDOWS[0]._cmap || await loadWindow('4h', WINDOWS[0]);
    const variations = [
      ['baseline', {}],
      ['M1_MIN_PCT=0.02', { M1_MIN_PCT: 0.02 }],
      ['M1_MIN_PCT=0.025', { M1_MIN_PCT: 0.025 }],
      ['M1_MIN_PCT=0.035', { M1_MIN_PCT: 0.035 }],
      ['M1_MIN_PCT=0.04', { M1_MIN_PCT: 0.04 }],
      ['M2 25–70%', { M2_MIN_RET: 0.25, M2_MAX_RET: 0.70 }],
      ['M2 35–65%', { M2_MIN_RET: 0.35, M2_MAX_RET: 0.65 }],
      ['SL_BUFFER=0.003', { SL_BUFFER: 0.003 }],
      ['SL_BUFFER=0.010', { SL_BUFFER: 0.010 }],
      ['TP1_PCT=0.20', { TP1_PCT: 0.20 }],
      ['TP1_PCT=0.30', { TP1_PCT: 0.30 }],
      ['RR_MIN=1.0', { RR_MIN: 1.0 }],
      ['RR_MIN=2.0', { RR_MIN: 2.0 }],
    ];
    console.log(`  ${'variation'.padEnd(20)}${pad('n', 5)}${pad('WR%', 7)}${pad('EV%/tr', 8)}${pad('PF', 6)}`);
    results.sensitivity = [];
    for (const [name, over] of variations) {
      const P = { ...BASE_PARAMS, ...over };
      const { trades } = runMode(cmap, P, 'realistic');
      const m = metrics(trades);
      console.log(`  ${name.padEnd(20)}${pad(m.n, 5)}${pad(r1(m.wr), 7)}${pad(r2(m.ev), 8)}${pad(r2(m.pf), 6)}`);
      results.sensitivity.push({ name, ...m });
    }
    console.log();
  }

  // ── Phase F: exit-model comparison (walk-forward, 4h, fill+fee corrected) ──
  if (phases.includes('F')) {
    console.log('═══ Phase F — Exit models: partial(1/3×3) vs TP1-only vs TP2-only (4h, pess|opt EV) ═══');
    console.log(`  ${'window'.padEnd(13)}${pad('n', 5)}${pad('partial', 14)}${pad('tp1-only', 16)}${pad('tp2-only', 16)}`);
    results.exitModels = [];
    for (const win of WINDOWS) {
      const cmap = win._cmap || await loadWindow('4h', win);
      const row = { win: win.name };
      const cells = [];
      for (const em of ['partial', 'tp1', 'tp2']) {
        const evs = [];
        for (const slp of [true, false]) {
          const trades = [];
          for (const [sym, candles] of Object.entries(cmap)) {
            for (const s of findSetups(candles, BASE_PARAMS)) {
              const r = simRealistic(candles, s, FEE_RT_PCT, { slPriority: slp, exitModel: em });
              if (r) trades.push(r);
            }
          }
          const m = metrics(trades);
          evs.push(m);
        }
        row[em] = { evPess: evs[0].ev, evOpt: evs[1].ev, wrPess: evs[0].wr, wrOpt: evs[1].wr, n: evs[0].n };
        cells.push(`${r2(evs[0].ev)}|${r2(evs[1].ev)}`);
      }
      console.log(`  ${win.name.padEnd(13)}${pad(row.partial.n, 5)}${pad(cells[0], 14)}${pad(cells[1], 16)}${pad(cells[2], 16)}`);
      results.exitModels.push(row);
    }
    console.log();
  }

  // strip non-serializable stash
  for (const w of results.walkforward || []) { delete w._setupsBySym; }
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Saved bench/results.json`);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = {
  BASE_PARAMS, COINS, WINDOWS, FEE_RT_PCT, fmtD,
  fetchKlines, loadWindow, findSetups, detectM1s,
  simOriginal, simRealistic, metrics, bootstrapCI, mulberry32, buyHold,
};
