/**
 * Test of the "ความลับ Divergence" matrix (SRISIAM Waves, p.13):
 *   claim — stronger divergence + shallower M2 retrace => longer M3.
 *
 *   Case 1: Div >= 161.8% + M2 retrace < 38.2%  => expect M3 = 161.8–200% of M1
 *   Case 2: Div >= 161.8% + retrace 38.2–50%    => expect 138.2–161.8%
 *   Case 3: Div 138.2–161.8% + retrace < 38.2%  => expect 100–138.2%
 *   Case 4: Div 138.2–161.8% + retrace 38.2–50% => expect 100%
 *
 * Method (structural measurement, not a P&L sim):
 *   - Detect reversal structures exactly like divchoch.js (pivot 5/5
 *     confirmed +5 bars, regular RSI divergence at the two latest
 *     same-side pivots, Choch through the wave-4 level within 80 bars)
 *   - M1 = wave5 extreme -> next confirmed opposite pivot
 *   - M2 retrace = next confirmed same-side pivot, as % of M1
 *   - M3 extension = furthest excursion past M2 within 200 bars,
 *     measured in % of M1 length projected from M2 (100% = "100 of M1")
 *   - Group into the 4 claimed cases (+ weak-div and deep-retrace
 *     control groups) and compare the M3 distributions
 *
 * Honest check: if the matrix is real, median M3 must rank
 * Case1 > Case2 > Case3 > Case4 > controls, and each case should reach
 * its promised band at a decent rate.
 *
 * Data: BTC/ETH, 4h + 1h, 2020-2025 (cached by divchoch.js run).
 * Run: node bench/divmatrix.js
 */

const B = require('./benchmark.js');

const SYMS = ['BTCUSDT', 'ETHUSDT'];
const TFS = ['4h', '1h'];
const START = Date.UTC(2020, 0, 1);
const END = Date.UTC(2025, 11, 31);
const PIVOT_LB = 5;
const CHOCH_MAX = 80;
const M3_HORIZON = 200;

const r0 = v => Math.round(v);
const pad = (s, n) => String(s).padStart(n);
const padE = (s, n) => String(s).padEnd(n);

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

function confirmedPivots(candles) {
  const events = [];
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

// Build alternating (deduped) pivot sequence over the whole series.
function alternatingSeq(pivotEvents) {
  const seq = [];
  for (const p of pivotEvents) {
    const last = seq[seq.length - 1];
    if (last && last.type === p.type) {
      const better = p.type === 'H' ? p.price > last.price : p.price < last.price;
      if (better) seq[seq.length - 1] = p;
    } else seq.push(p);
  }
  return seq;
}

// Collect reversal structures and measure M1/M2/M3.
function measure(candles) {
  const closes = candles.map(c => c.close);
  const rsi = rsiSeries(closes);
  const seq = alternatingSeq(confirmedPivots(candles));
  const out = [];

  for (let k = 2; k < seq.length - 2; k++) {
    const p2 = seq[k], mid = seq[k - 1], p1 = seq[k - 2];
    const bear = p2.type === 'H'; // top reversal -> M1/M3 go down
    const divOK = bear
      ? p2.price > p1.price && rsi[p2.idx] !== null && rsi[p1.idx] !== null && rsi[p2.idx] < rsi[p1.idx]
      : p2.price < p1.price && rsi[p2.idx] !== null && rsi[p1.idx] !== null && rsi[p2.idx] > rsi[p1.idx];
    if (!divOK) continue;
    const range = Math.abs(mid.price - p1.price);
    if (range <= 0) continue;
    const divExt = Math.abs(mid.price - p2.price) / range;

    // Choch must occur within CHOCH_MAX bars after wave-5 pivot confirm
    let choch = false;
    for (let i = p2.confirmAt; i < Math.min(p2.confirmAt + CHOCH_MAX, candles.length); i++) {
      if (bear ? candles[i].close < mid.price : candles[i].close > mid.price) { choch = true; break; }
      if (bear ? candles[i].high > p2.price : candles[i].low < p2.price) break; // structure invalidated
    }
    if (!choch) continue;

    // M1 = next opposite pivot, M2 = next same-side pivot after that
    const m1p = seq[k + 1], m2p = seq[k + 2];
    if (!m1p || !m2p) continue;
    if (m1p.type === p2.type || m2p.type !== p2.type) continue;
    const m1len = Math.abs(p2.price - m1p.price);
    if (m1len <= 0) continue;
    const retrace = Math.abs(m2p.price - m1p.price) / m1len;

    // M3 = furthest excursion past M2 within horizon, % of M1 from M2
    let extreme = m1p.price;
    const end = Math.min(m2p.idx + M3_HORIZON, candles.length);
    for (let i = m2p.idx + 1; i < end; i++) {
      extreme = bear ? Math.min(extreme, candles[i].low) : Math.max(extreme, candles[i].high);
    }
    const m3ext = Math.abs(m2p.price - extreme) / m1len * 100; // 100 = "100 of M1"
    // bias-free: how far past the M1 extreme price actually went (0 = stalled at M1)
    const m3net = (bear ? (m1p.price - extreme) : (extreme - m1p.price)) / m1len * 100;

    out.push({ divExt, retrace, m3ext, m3net });
  }
  return out;
}

function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
const shareGE = (a, x) => a.length ? a.filter(v => v >= x).length / a.length * 100 : NaN;

async function main() {
  const all = [];
  for (const tf of TFS) {
    for (const sym of SYMS) {
      const candles = await B.fetchKlines(sym, tf, START, END);
      const m = measure(candles);
      m.forEach(r => { r.tf = tf; r.sym = sym; });
      all.push(...m);
    }
  }
  console.log(`โครงสร้าง divergence+choch ที่วัดได้ทั้งหมด: ${all.length} (BTC+ETH, 4h+1h, 2020-2025)\n`);

  const cells = [
    ['Case 1: Div≥161.8 + ret<38.2', r => r.divExt >= 1.618 && r.retrace < 0.382, '161.8–200'],
    ['Case 2: Div≥161.8 + ret 38–50', r => r.divExt >= 1.618 && r.retrace >= 0.382 && r.retrace < 0.50, '138.2–161.8'],
    ['Case 3: Div 138–162 + ret<38.2', r => r.divExt >= 1.382 && r.divExt < 1.618 && r.retrace < 0.382, '100–138.2'],
    ['Case 4: Div 138–162 + ret 38–50', r => r.divExt >= 1.382 && r.divExt < 1.618 && r.retrace >= 0.382 && r.retrace < 0.50, '100'],
    ['ctrl A: Div อ่อน (<138.2)', r => r.divExt < 1.382 && r.retrace < 0.50, '(นอกตำรา)'],
    ['ctrl B: retrace ลึก (>50%)', r => r.retrace >= 0.50, '(นอกตำรา)'],
  ];

  console.log(`  ${'group'.padEnd(33)}${pad('n', 5)}${pad('median M3', 11)}${pad('≥100%', 8)}${pad('≥138.2%', 9)}${pad('≥161.8%', 9)}${pad('ทะลุM1', 9)}   เป้าตำรา`);
  console.log(`  ${'-'.repeat(97)}`);
  const medians = [];
  for (const [name, fn, target] of cells) {
    const rows = all.filter(fn);
    const g = rows.map(r => r.m3ext);
    const net = rows.map(r => r.m3net);
    medians.push({ name, med: median(g), n: g.length });
    console.log(`  ${padE(name, 33)}${pad(g.length, 5)}${pad(r0(median(g)) + '%', 11)}${pad(r0(shareGE(g, 100)) + '%', 8)}${pad(r0(shareGE(g, 138.2)) + '%', 9)}${pad(r0(shareGE(g, 161.8)) + '%', 9)}${pad(r0(median(net)) + '%', 9)}   ${target}`);
  }

  // rank-order check on the 4 claimed cases
  const m4 = medians.slice(0, 4).map(m => m.med);
  const ordered = m4[0] > m4[1] && m4[1] > m4[2] && m4[2] > m4[3];
  console.log(`\n  ลำดับ median ตามคำทำนาย (C1>C2>C3>C4): ${m4.map(r0).join(' > ')} → ${ordered ? '✅ เรียงถูก' : '❌ ไม่เรียงตามตำรา'}`);

  // simple monotonic association: correlation of divExt & shallowness vs m3
  const xs = all.map(r => r.divExt), ys = all.map(r => -r.retrace), zs = all.map(r => r.m3ext);
  const corr = (a, b) => {
    const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db);
  };
  console.log(`  correlation: divStrength↔M3 = ${corr(xs, zs).toFixed(3)} · retraceShallow↔M3 = ${corr(ys, zs).toFixed(3)}`);
  console.log(`  (ตำราทำนายว่าทั้งคู่ควรเป็นบวกชัดเจน)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
