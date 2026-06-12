/**
 * Full-spec test — implement the doc's checklist items that backtest.js
 * never coded, then evaluate with train/validation discipline:
 *
 *   F1 shockStrong : shock bar range >= 1.5 x ATR(14)   ("โมเมนตัมรุนแรง")
 *   F2 emaSide     : retest close on the right side of EMA30
 *   F3 rsiConfirm  : RSI(14) improving at retest vs M2 ("divergence ยืนยันจุดจบสวิง")
 *
 * Execution model: structure stop (per doc), partial 1/3 exits, SL priority,
 * maker fee 0.05% (limit entry + limit TP).
 *
 * Discipline: all 8 filter combos are ranked on TRAIN windows (W1, W3, W5).
 * The best combo (min trades >= 150) is then tested ONCE on VALIDATION
 * windows (W0, W2, W4, W6). No peeking, no re-picking.
 *
 * Run: node bench/full-spec.js
 */

const B = require('./benchmark.js');
const P = B.BASE_PARAMS;

const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const pad = (s, n) => String(s).padStart(n);

const TRAIN = ['W1', 'W3', 'W5'];
const VALID = ['W0', 'W2', 'W4', 'W6-2022bear'];
const FEE = 0.05;

// ── Indicators ────────────────────────────────────────────────────
function rsiSeries(candles, n = 14) {
  const out = new Array(candles.length).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < candles.length; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= n) { avgG += g / n; avgL += l / n; if (i === n) out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-9)); }
    else {
      avgG = (avgG * (n - 1) + g) / n;
      avgL = (avgL * (n - 1) + l) / n;
      out[i] = 100 - 100 / (1 + avgG / (avgL || 1e-9));
    }
  }
  return out;
}
function emaSeries(candles, n = 30) {
  const out = new Array(candles.length).fill(null);
  const k = 2 / (n + 1);
  let e = candles[0].close;
  for (let i = 0; i < candles.length; i++) {
    e = i === 0 ? e : candles[i].close * k + e * (1 - k);
    if (i >= n) out[i] = e;
  }
  return out;
}
function atrSeries(candles, n = 14) {
  const out = new Array(candles.length).fill(null);
  let atr = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close));
    if (i <= n) { atr += tr / n; if (i === n) out[i] = atr; }
    else { atr = (atr * (n - 1) + tr) / n; out[i] = atr; }
  }
  return out;
}

function structureSL(s) {
  const bull = s.dir === 'bull';
  const sl = bull ? s.m2Low * (1 - 0.005) : s.m2High * (1 + 0.005);
  const rr = bull ? (s.tp2 - s.entryPrice) / (s.entryPrice - sl)
                  : (s.entryPrice - s.tp2) / (sl - s.entryPrice);
  if (!(rr > 0) || rr < P.RR_MIN) return null;
  return { ...s, sl };
}

// ── Filters ───────────────────────────────────────────────────────
function passes(s, ind, mask) {
  const bull = s.dir === 'bull';
  if (mask.f1) {
    const atr = ind.atr[s.shockIdx];
    const bar = ind.candles[s.shockIdx];
    if (atr === null || (bar.high - bar.low) < 1.5 * atr) return false;
  }
  if (mask.f2) {
    const e = ind.ema[s.retestIdx];
    if (e === null) return false;
    const px = ind.candles[s.retestIdx].close;
    if (bull ? px < e : px > e) return false;
  }
  if (mask.f3) {
    const a = ind.rsi[s.retestIdx], b = ind.rsi[s.m2Idx];
    if (a === null || b === null) return false;
    if (bull ? a <= b : a >= b) return false;
  }
  return true;
}

function runSet(cmaps, mask) {
  const trades = [];
  for (const { cmap, ind } of cmaps) {
    for (const [sym, candles] of Object.entries(cmap)) {
      const I = ind[sym];
      for (let s of B.findSetups(candles, P)) {
        if (!passes(s, I, mask)) continue;
        s = structureSL(s);
        if (!s) continue;
        const r = B.simRealistic(candles, s, FEE, { slPriority: true, exitModel: 'partial' });
        if (r) trades.push(r);
      }
    }
  }
  return trades;
}

async function load(names) {
  const out = [];
  for (const win of B.WINDOWS.filter(w => names.includes(w.name))) {
    const cmap = await B.loadWindow('4h', win);
    const ind = {};
    for (const [sym, candles] of Object.entries(cmap)) {
      ind[sym] = { candles, rsi: rsiSeries(candles), ema: emaSeries(candles), atr: atrSeries(candles) };
    }
    out.push({ win, cmap, ind });
  }
  return out;
}

async function main() {
  const train = await load(TRAIN);
  const valid = await load(VALID);

  const combos = [];
  for (const f1 of [false, true]) for (const f2 of [false, true]) for (const f3 of [false, true])
    combos.push({ f1, f2, f3 });
  const label = m => [m.f1 && 'shock', m.f2 && 'ema30', m.f3 && 'rsi'].filter(Boolean).join('+') || 'none';

  console.log(`═══ TRAIN (${TRAIN.join(', ')}) — full-spec filters, structure stop, maker fee ${FEE}% ═══`);
  console.log(`  ${'filters'.padEnd(20)}${pad('n', 6)}${pad('WR%', 7)}${pad('EV%/tr', 8)}${pad('PF', 6)}${pad('EV 95%CI', 18)}`);
  const rows = [];
  for (const mask of combos) {
    const t = runSet(train, mask);
    const m = B.metrics(t);
    const ci = B.bootstrapCI(t);
    rows.push({ mask, m, ci });
    console.log(`  ${label(mask).padEnd(20)}${pad(m.n, 6)}${pad(r1(m.wr), 7)}${pad(r2(m.ev), 8)}${pad(r2(m.pf), 6)}${pad(`[${r2(ci[0])},${r2(ci[1])}]`, 18)}`);
  }

  const eligible = rows.filter(r => r.m.n >= 150);
  const best = eligible.reduce((a, b) => (b.m.ev > a.m.ev ? b : a), eligible[0]);
  console.log(`\n  -> selected on TRAIN only: "${label(best.mask)}" (EV ${r2(best.m.ev)}%, n=${best.m.n})`);

  console.log(`\n═══ VALIDATION (${VALID.join(', ')}) — one shot, no re-picking ═══`);
  for (const mask of [{ f1: false, f2: false, f3: false }, best.mask]) {
    const t = runSet(valid, mask);
    const m = B.metrics(t);
    const ci = B.bootstrapCI(t);
    console.log(`  ${label(mask).padEnd(20)}${pad(m.n, 6)}${pad(r1(m.wr), 7)}${pad(r2(m.ev), 8)}${pad(r2(m.pf), 6)}${pad(`[${r2(ci[0])},${r2(ci[1])}]`, 18)}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
