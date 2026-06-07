/**
 * KLAUD — 3 Swings Backtest Detail View
 * แสดงขั้นตอนเชิงลึกของแต่ละ Setup: M1 → M2 → Shock → Retest → Entry/Exit
 *
 * Run: node backtest-detail.js [SYMBOL] [TF]
 * Example: node backtest-detail.js BTCUSDT 4h
 *          node backtest-detail.js SOLUSDT 1h
 */

const https = require('https');

const DEFAULT_SYMBOL = process.argv[2] || 'BTCUSDT';
const DEFAULT_TF     = process.argv[3] || '4h';
const SHOW_LIMIT     = parseInt(process.argv[4]) || 999; // จำนวน setup สูงสุดที่แสดง

const PARAMS = {
  M1_MIN_PCT:    0.03,
  M1_MIN_BARS:   3,
  M2_MIN_RET:    0.30,
  M2_MAX_RET:    0.68,
  M2_MAX_BARS:   80,
  SL_BUFFER:     0.005,
  TP1_PCT:       0.25,
};

// ── Fetch ─────────────────────────────────────────────────────────
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function fetchKlines(symbol, interval, months = 6) {
  const startMs = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&limit=1000`;
  const raw = await fetch(url);
  return raw.map(k => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3],
    close: +k[4], volume: +k[5]
  }));
}

// ── Indicators ────────────────────────────────────────────────────
function findSwingHighs(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].high;
    let ok = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j !== i && candles[j].high >= h) { ok = false; break; }
    }
    if (ok) out.push({ idx: i, price: h });
  }
  return out;
}

function findSwingLows(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const l = candles[i].low;
    let ok = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j !== i && candles[j].low <= l) { ok = false; break; }
    }
    if (ok) out.push({ idx: i, price: l });
  }
  return out;
}

function volSMA(candles, idx, n = 10) {
  const slice = candles.slice(Math.max(0, idx - n), idx);
  return slice.length ? slice.reduce((s,c)=>s+c.volume,0)/slice.length : 0;
}

function fmt(p) {
  return p >= 1000 ? p.toLocaleString('en', { maximumFractionDigits: 2 })
       : p >= 1    ? p.toFixed(4)
       : p.toFixed(6);
}

function fmtDate(ts) {
  return new Date(ts).toISOString().replace('T',' ').slice(0,16);
}

function fmtPct(v) {
  const s = (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  return s;
}

// ── Core Detection ────────────────────────────────────────────────
function detectM1s(candles) {
  const highs = findSwingHighs(candles);
  const lows  = findSwingLows(candles);
  const m1s   = [];

  for (const lo of lows) {
    for (const hi of highs) {
      if (hi.idx <= lo.idx || hi.idx - lo.idx > 40) continue;
      const bars = hi.idx - lo.idx;
      const pct  = (hi.price - lo.price) / lo.price;
      if (pct >= PARAMS.M1_MIN_PCT && bars >= PARAMS.M1_MIN_BARS) {
        m1s.push({ dir:'bull', startIdx:lo.idx, startPrice:lo.price,
                   endIdx:hi.idx, endPrice:hi.price,
                   length:hi.price - lo.price, bars, pct });
        break;
      }
    }
  }
  for (const hi of highs) {
    for (const lo of lows) {
      if (lo.idx <= hi.idx || lo.idx - hi.idx > 40) continue;
      const bars = lo.idx - hi.idx;
      const pct  = (hi.price - lo.price) / hi.price;
      if (pct >= PARAMS.M1_MIN_PCT && bars >= PARAMS.M1_MIN_BARS) {
        m1s.push({ dir:'bear', startIdx:hi.idx, startPrice:hi.price,
                   endIdx:lo.idx, endPrice:lo.price,
                   length:hi.price - lo.price, bars, pct });
        break;
      }
    }
  }
  return m1s.sort((a,b) => a.endIdx - b.endIdx);
}

function findSetups(candles) {
  const m1s  = detectM1s(candles);
  const setups = [];
  const seen   = new Set();

  for (const m1 of m1s) {
    const bull = m1.dir === 'bull';
    const fib  = pct => bull
      ? m1.endPrice - pct * m1.length
      : m1.endPrice + pct * m1.length;

    const steps = {
      m1_detected: true,
      m2_found: false, m2_retrace: null, m2_idx: null, m2_price: null,
      shock_found: false, shock_idx: null, shock_close: null,
      retest_found: false, retest_idx: null, retest_price: null,
      in_fib_zone: false, vol_ok: null,
      skipped_reason: null,
    };

    // M2 detection
    let m2Idx = null, m2Low = null, m2High = null, m2RetracePct = null;
    for (let i = m1.endIdx + 1; i < Math.min(m1.endIdx + PARAMS.M2_MAX_BARS, candles.length); i++) {
      const c   = candles[i];
      const ret = bull
        ? (m1.endPrice - c.low) / m1.length
        : (c.high - m1.endPrice) / m1.length;
      if (ret >= PARAMS.M2_MIN_RET && ret <= PARAMS.M2_MAX_RET) {
        m2Idx = i;
        m2Low  = bull ? c.low  : m1.endPrice;
        m2High = bull ? m1.endPrice : c.high;
        m2RetracePct = ret;
        steps.m2_found    = true;
        steps.m2_retrace  = +(ret * 100).toFixed(1);
        steps.m2_idx      = i;
        steps.m2_price    = bull ? c.low : c.high;
        break;
      }
    }
    if (!steps.m2_found) { steps.skipped_reason = 'ไม่พบ M2 pullback ใน 80 แท่ง'; setups.push({ m1, steps, trade: null }); continue; }

    // Shock detection
    let shockIdx = null;
    for (let i = m2Idx + 1; i < Math.min(m2Idx + PARAMS.M2_MAX_BARS, candles.length); i++) {
      const broke = bull ? candles[i].close > m1.endPrice : candles[i].close < m1.endPrice;
      if (broke) {
        shockIdx = i;
        steps.shock_found = true;
        steps.shock_idx   = i;
        steps.shock_close = candles[i].close;
        break;
      }
    }
    if (!steps.shock_found) { steps.skipped_reason = 'ไม่พบ Shock (ราคาไม่ทะลุ M1 End)'; setups.push({ m1, steps, trade: null }); continue; }

    // Retest detection
    let trade = null;
    for (let i = shockIdx + 1; i < Math.min(shockIdx + 40, candles.length); i++) {
      const c = candles[i];
      const structBroken = bull
        ? c.low  < m2Low  * (1 - PARAMS.SL_BUFFER)
        : c.high > m2High * (1 + PARAMS.SL_BUFFER);
      if (structBroken) { steps.skipped_reason = `Structure ถูกทำลายที่ idx ${i} (M2 Low/High ถูก break)`; break; }

      const inZone = bull
        ? c.low <= fib(0.333) && c.high >= fib(0.618)
        : c.high >= fib(0.333) && c.low <= fib(0.618);
      if (!inZone) continue;

      const avgVol = volSMA(candles, i);
      const volOk  = c.volume < avgVol;
      const entry  = fib(0.50);
      const sl     = bull ? fib(0.618) * (1 - PARAMS.SL_BUFFER) : fib(0.618) * (1 + PARAMS.SL_BUFFER);
      const tp1    = bull ? entry + m1.length * PARAMS.TP1_PCT : entry - m1.length * PARAMS.TP1_PCT;
      const tp2    = m1.endPrice;
      const tp3    = bull ? m2Low  + m1.length : m2High - m1.length;
      const rr     = bull ? (tp2 - entry) / (entry - sl) : (entry - tp2) / (sl - entry);

      steps.retest_found = true;
      steps.retest_idx   = i;
      steps.retest_price = bull ? c.low : c.high;
      steps.in_fib_zone  = true;
      steps.vol_ok       = volOk;

      if (rr < 1.5) { steps.skipped_reason = `R:R ${rr.toFixed(2)} < 1.5 — กรองออก`; break; }

      trade = {
        entryPrice: entry, sl, tp1, tp2, tp3,
        fib333: fib(0.333), fib500: fib(0.500), fib618: fib(0.618),
        rr: +rr.toFixed(2), retestIdx: i, volOk,
      };
      break;
    }

    const key = `${m1.endIdx}-${m1.dir}`;
    if (!seen.has(key)) { seen.add(key); setups.push({ m1, steps, trade }); }
  }
  return setups;
}

function simulateTrade(candles, trade, dir) {
  const { entryPrice, sl, tp1, tp2, tp3, retestIdx } = trade;
  const bull = dir === 'bull';
  const log  = [];

  for (let i = retestIdx + 1; i < Math.min(retestIdx + 60, candles.length); i++) {
    const { high, low, close, time, volume } = candles[i];
    const bar = i - retestIdx;

    if (bull ? high >= tp3 : low <= tp3)
      return { result:'win', exitPrice:tp3, tp:'TP3', pct:+Math.abs(tp3-entryPrice)/entryPrice*100, bars:bar, time, exitIdx:i, log };
    if (bull ? high >= tp2 : low <= tp2)
      return { result:'win', exitPrice:tp2, tp:'TP2', pct:+Math.abs(tp2-entryPrice)/entryPrice*100, bars:bar, time, exitIdx:i, log };
    if (bull ? high >= tp1 : low <= tp1)
      return { result:'win', exitPrice:tp1, tp:'TP1', pct:+Math.abs(tp1-entryPrice)/entryPrice*100, bars:bar, time, exitIdx:i, log };
    if (bull ? low <= sl   : high >= sl)
      return { result:'loss', exitPrice:sl, tp:'SL', pct:-Math.abs(entryPrice-sl)/entryPrice*100, bars:bar, time, exitIdx:i, log };
  }
  const last = candles[Math.min(retestIdx + 59, candles.length - 1)];
  const pct  = (last.close - entryPrice) / entryPrice * 100 * (bull ? 1 : -1);
  return { result:pct>=0?'win':'loss', exitPrice:last.close, tp:'Expire', pct:+pct.toFixed(3), bars:60, time:last.time, exitIdx:retestIdx+59, log };
}

// ── Progress bar ─────────────────────────────────────────────────
function progressBar(val, max, width = 20) {
  const filled = Math.round((val / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Print one setup detail ────────────────────────────────────────
function printSetupDetail(n, total, sym, tf, candles, setup, result) {
  const { m1, steps, trade } = setup;
  const bull = m1.dir === 'bull';
  const dirIcon = bull ? '📈' : '📉';
  const dirWord = bull ? 'BULL' : 'BEAR';

  const m1Start = candles[m1.startIdx];
  const m1End   = candles[m1.endIdx];
  const m2C     = steps.m2_idx   ? candles[steps.m2_idx]   : null;
  const shockC  = steps.shock_idx ? candles[steps.shock_idx] : null;
  const retestC = steps.retest_idx ? candles[steps.retest_idx] : null;

  const resultIcon = !trade ? '⚪' : result?.result === 'win' ? '✅' : '❌';
  const divider = '─'.repeat(62);

  console.log(`\n${divider}`);
  console.log(`  Setup #${n}/${total}  ${sym} · ${tf}  ${dirIcon} ${dirWord}  ${resultIcon}`);
  console.log(divider);

  // ── STEP 1: M1 ────────────────────────────────────────────────
  console.log(`\n  📐 STEP 1 — M1 Impulse Move`);
  console.log(`  ${'─'.repeat(55)}`);
  const m1PctStr = fmtPct(m1.pct * 100);
  const m1Bar    = progressBar(m1.pct * 100, 15);
  console.log(`  Direction : ${dirWord} ${dirIcon}`);
  console.log(`  Start     : [idx ${String(m1.startIdx).padStart(4)}]  ${fmtDate(m1Start.time)}  @ $${fmt(m1.startPrice)}`);
  console.log(`  End       : [idx ${String(m1.endIdx).padStart(4)}]  ${fmtDate(m1End.time)}  @ $${fmt(m1.endPrice)}`);
  console.log(`  Move      : ${m1PctStr.padStart(7)}  ${m1Bar}  (${m1.bars} แท่ง)`);
  console.log(`  M1 Length : $${fmt(m1.length)}  ${m1.pct*100 >= PARAMS.M1_MIN_PCT*100 && m1.bars >= PARAMS.M1_MIN_BARS ? '✅ ผ่านเกณฑ์' : '❌ ไม่ผ่าน'}`);

  if (bull) {
    console.log(`  Fib Levels (คำนวณจาก M1):`);
    console.log(`    33.3% = $${fmt(m1.endPrice - 0.333 * m1.length)}  ← Retest Zone บน`);
    console.log(`    50.0% = $${fmt(m1.endPrice - 0.500 * m1.length)}  ← Golden Entry`);
    console.log(`    61.8% = $${fmt(m1.endPrice - 0.618 * m1.length)}  ← Retest Zone ล่าง`);
  } else {
    console.log(`  Fib Levels (คำนวณจาก M1):`);
    console.log(`    33.3% = $${fmt(m1.endPrice + 0.333 * m1.length)}  ← Retest Zone ล่าง`);
    console.log(`    50.0% = $${fmt(m1.endPrice + 0.500 * m1.length)}  ← Golden Entry`);
    console.log(`    61.8% = $${fmt(m1.endPrice + 0.618 * m1.length)}  ← Retest Zone บน`);
  }

  // ── STEP 2: M2 ────────────────────────────────────────────────
  console.log(`\n  🔄 STEP 2 — M2 Pullback`);
  console.log(`  ${'─'.repeat(55)}`);
  if (!steps.m2_found) {
    console.log(`  ❌ ไม่พบ M2 — ราคาไม่ pullback เข้า 30–68% ใน ${PARAMS.M2_MAX_BARS} แท่ง`);
    console.log(`\n  ⏭  Setup ถูกข้าม: ${steps.skipped_reason}`);
    return;
  }
  const m2RetBar = progressBar(steps.m2_retrace, 100);
  const m2Zone   = steps.m2_retrace >= 30 && steps.m2_retrace <= 68
    ? `✅ อยู่ใน 30–68%` : `❌ ออกนอก zone`;
  console.log(`  Found     : [idx ${String(steps.m2_idx).padStart(4)}]  ${fmtDate(m2C.time)}`);
  console.log(`  Price     : $${fmt(steps.m2_price)}`);
  console.log(`  Retrace   : ${steps.m2_retrace.toFixed(1)}%  ${m2Zone}`);
  console.log(`  Bar      : ${m2RetBar}`);
  console.log(`  ค่า OHLC  : O=${fmt(m2C.open)} H=${fmt(m2C.high)} L=${fmt(m2C.low)} C=${fmt(m2C.close)}`);
  const barsFromM1 = steps.m2_idx - m1.endIdx;
  console.log(`  ห่างจาก M1 End : ${barsFromM1} แท่ง ${barsFromM1 <= PARAMS.M2_MAX_BARS ? '✅' : '❌'}`);

  // ── STEP 3: Shock ─────────────────────────────────────────────
  console.log(`\n  ⚡ STEP 3 — Shock / Break of Structure`);
  console.log(`  ${'─'.repeat(55)}`);
  if (!steps.shock_found) {
    console.log(`  ❌ ไม่พบ Shock — ราคาไม่ทะลุ M1 End ($${fmt(m1.endPrice)})`);
    console.log(`\n  ⏭  Setup ถูกข้าม: ${steps.skipped_reason}`);
    return;
  }
  const shockDiff = bull
    ? ((shockC.close - m1.endPrice) / m1.endPrice * 100)
    : ((m1.endPrice - shockC.close) / m1.endPrice * 100);
  console.log(`  Found     : [idx ${String(steps.shock_idx).padStart(4)}]  ${fmtDate(shockC.time)}`);
  console.log(`  Close     : $${fmt(steps.shock_close)}  (ทะลุ $${fmt(m1.endPrice)} ไป ${fmtPct(shockDiff)})`);
  console.log(`  ค่า OHLC  : O=${fmt(shockC.open)} H=${fmt(shockC.high)} L=${fmt(shockC.low)} C=${fmt(shockC.close)}`);
  console.log(`  BOS       : ${bull ? 'Close > M1 High ✅' : 'Close < M1 Low ✅'}  → Break of Structure ยืนยัน`);
  const barsM2Shock = steps.shock_idx - steps.m2_idx;
  console.log(`  ห่างจาก M2 : ${barsM2Shock} แท่ง`);

  // ── STEP 4: Retest ────────────────────────────────────────────
  console.log(`\n  🎯 STEP 4 — Retest เข้า Fib Zone`);
  console.log(`  ${'─'.repeat(55)}`);
  if (!steps.retest_found) {
    const reason = steps.skipped_reason || 'ไม่พบ Retest ใน Fib 33.3–61.8%';
    console.log(`  ❌ ${reason}`);
    if (!trade) {
      console.log(`\n  ⏭  Setup ถูกข้าม`);
      return;
    }
  } else {
    const fib333 = bull ? m1.endPrice - 0.333*m1.length : m1.endPrice + 0.333*m1.length;
    const fib618 = bull ? m1.endPrice - 0.618*m1.length : m1.endPrice + 0.618*m1.length;
    console.log(`  Found     : [idx ${String(steps.retest_idx).padStart(4)}]  ${fmtDate(retestC.time)}`);
    console.log(`  Touch     : $${fmt(steps.retest_price)}`);
    console.log(`  Fib Zone  : $${fmt(fib618)} — $${fmt(fib333)}  ✅ ราคาแตะ zone`);
    console.log(`  ค่า OHLC  : O=${fmt(retestC.open)} H=${fmt(retestC.high)} L=${fmt(retestC.low)} C=${fmt(retestC.close)}`);

    const avgVol = volSMA(candles, steps.retest_idx);
    const volRatio = (retestC.volume / avgVol).toFixed(2);
    const volIcon  = steps.vol_ok ? '✅ ลด (Retest จริง)' : '⚠️  เพิ่ม (อาจ Reverse)';
    console.log(`  Volume    : ${fmt(retestC.volume)}  (avg: ${fmt(avgVol)})  ratio: ${volRatio}x  ${volIcon}`);

    // Structure check
    const structOk = bull
      ? steps.retest_price > steps.m2_price
      : steps.retest_price < steps.m2_price;
    console.log(`  M2 Structure : ${structOk ? '✅ ยังสมบูรณ์' : '❌ ถูกทำลาย'}  (M2 ${bull?'Low':'High'}: $${fmt(steps.m2_price)})`);
  }

  if (!trade) {
    console.log(`\n  ⏭  Setup ถูกข้าม: ${steps.skipped_reason}`);
    return;
  }

  // ── STEP 5: Entry Plan ────────────────────────────────────────
  console.log(`\n  📌 STEP 5 — Entry Plan`);
  console.log(`  ${'─'.repeat(55)}`);
  const rrBar = progressBar(Math.min(trade.rr, 5), 5, 15);
  console.log(`  Entry     : $${fmt(trade.entryPrice)}  (Fib 50% Golden Zone)`);
  console.log(`  Stop Loss : $${fmt(trade.sl)}  (${bull?'ใต้':'เหนือ'} Fib 61.8% + 0.5% buffer)`);
  console.log(`  Risk/Entry: ${fmtPct(Math.abs(trade.entryPrice-trade.sl)/trade.entryPrice*100)}`);
  console.log(`  TP1       : $${fmt(trade.tp1)}  (+${((Math.abs(trade.tp1-trade.entryPrice)/trade.entryPrice)*100).toFixed(2)}%)  [25% ของ M1]`);
  console.log(`  TP2       : $${fmt(trade.tp2)}  (+${((Math.abs(trade.tp2-trade.entryPrice)/trade.entryPrice)*100).toFixed(2)}%)  [M1 End = Shock level]`);
  console.log(`  TP3       : $${fmt(trade.tp3)}  (+${((Math.abs(trade.tp3-trade.entryPrice)/trade.entryPrice)*100).toFixed(2)}%)  [M3 = 100% extension]`);
  console.log(`  R:R       : 1:${trade.rr}  ${rrBar}`);

  // ── STEP 6: Outcome ───────────────────────────────────────────
  if (!result) {
    console.log(`\n  ⏳ STEP 6 — ยังไม่มีผล`);
    return;
  }
  console.log(`\n  🏁 STEP 6 — ผล Trade`);
  console.log(`  ${'─'.repeat(55)}`);
  const outcomeIcon = result.result === 'win' ? '✅ WIN' : '❌ LOSS';
  const pnlStr      = fmtPct(result.pct);
  console.log(`  ผล        : ${outcomeIcon}`);
  console.log(`  Exit      : $${fmt(result.exitPrice)}  → ออกที่ ${result.tp}`);
  console.log(`  P&L       : ${pnlStr}`);
  console.log(`  ใช้เวลา   : ${result.bars} แท่ง  (${fmtDate(result.time)})`);

  // Mini P&L bar
  const pnlAbs = Math.abs(result.pct);
  const pnlBar = result.result === 'win'
    ? '▓'.repeat(Math.min(Math.round(pnlAbs), 30))
    : '░'.repeat(Math.min(Math.round(pnlAbs), 30));
  console.log(`  ${result.result === 'win' ? '📈' : '📉'} ${pnlBar}  ${pnlStr}`);

  // ── Visual Timeline ───────────────────────────────────────────
  console.log(`\n  📅 Timeline`);
  console.log(`  ${'─'.repeat(55)}`);
  const events = [
    { idx: m1.startIdx, label: 'M1 Start', price: m1.startPrice },
    { idx: m1.endIdx,   label: 'M1 End',   price: m1.endPrice   },
    { idx: steps.m2_idx,    label: 'M2 Retest', price: steps.m2_price  },
    { idx: steps.shock_idx, label: 'Shock ⚡',  price: steps.shock_close },
    { idx: steps.retest_idx, label: 'Retest 🎯', price: trade.entryPrice },
    result ? { idx: result.exitIdx, label: `Exit (${result.tp})`, price: result.exitPrice } : null,
  ].filter(Boolean).sort((a,b)=>a.idx-b.idx);

  let prev = null;
  for (const e of events) {
    const gap = prev !== null ? ` (${e.idx - prev} แท่ง)` : '';
    const d   = candles[e.idx] ? fmtDate(candles[e.idx].time) : '–';
    console.log(`  [${String(e.idx).padStart(4)}] ${d}  ${e.label.padEnd(14)} @ $${fmt(e.price)}${gap}`);
    prev = e.idx;
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  const sym = DEFAULT_SYMBOL.toUpperCase();
  const tf  = DEFAULT_TF;

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║  KLAUD — 3 Swings Detail View                                ║`);
  console.log(`║  ${(sym + ' · ' + tf + ' · 6 เดือน').padEnd(60)}║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`\n  กำลังดึงข้อมูล ${sym} ${tf}...`);

  let candles;
  try {
    candles = await fetchKlines(sym, tf);
  } catch(e) {
    console.error('❌ Error:', e.message); process.exit(1);
  }

  console.log(`  ได้ ${candles.length} แท่ง  (${fmtDate(candles[0].time)} → ${fmtDate(candles.at(-1).time)})\n`);

  const setups = findSetups(candles);
  const validSetups = setups.filter(s => s.trade !== null);
  const skipSetups  = setups.filter(s => s.trade === null);

  // Simulate results
  const results = setups.map(s => s.trade ? simulateTrade(candles, s.trade, s.m1.dir) : null);

  // Summary header
  const wins   = results.filter(r=>r?.result==='win').length;
  const losses = results.filter(r=>r?.result==='loss').length;
  const wr     = (wins+losses) > 0 ? (wins/(wins+losses)*100).toFixed(1) : '–';
  const pnl    = results.reduce((s,r)=>s+(r?.pct||0),0).toFixed(2);

  console.log(`  พบ Setup ทั้งหมด : ${setups.length} รายการ`);
  console.log(`  ✅ เทรดได้         : ${validSetups.length} รายการ`);
  console.log(`  ⏭  ถูกข้าม         : ${skipSetups.length} รายการ`);
  console.log(`  Win Rate          : ${wr}%  (${wins}W / ${losses}L)`);
  console.log(`  P&L รวม           : ${parseFloat(pnl)>=0?'+':''}${pnl}%`);

  // Skip reason breakdown
  if (skipSetups.length > 0) {
    const reasons = {};
    skipSetups.forEach(s => {
      const r = s.steps.skipped_reason || 'ไม่ทราบ';
      reasons[r] = (reasons[r]||0) + 1;
    });
    console.log(`\n  เหตุผลที่ข้าม Setup:`);
    for (const [r, cnt] of Object.entries(reasons).sort((a,b)=>b[1]-a[1])) {
      console.log(`    · ${r.padEnd(45)} × ${cnt}`);
    }
  }

  // ── Show all setups detail ─────────────────────────────────────
  const showCount = Math.min(setups.length, SHOW_LIMIT);
  console.log(`\n  กำลังแสดงรายละเอียด ${showCount}/${setups.length} setups...`);
  console.log(`  (หยุดกด Ctrl+C ได้เมื่อดูพอแล้ว)\n`);

  for (let i = 0; i < showCount; i++) {
    printSetupDetail(i + 1, showCount, sym, tf, candles, setups[i], results[i]);
    // ถ้า setup ถูกข้าม ไม่ต้องรอ
  }

  // ── Final stats ───────────────────────────────────────────────
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  📊 สรุปรวม ${sym} ${tf}`);
  console.log(`${'═'.repeat(64)}`);
  const tpMap = {};
  results.filter(Boolean).forEach(r => { tpMap[r.tp] = (tpMap[r.tp]||0)+1; });
  console.log(`  Win/Loss : ${wins}W / ${losses}L  →  ${wr}% Win Rate`);
  console.log(`  P&L รวม  : ${parseFloat(pnl)>=0?'+':''}${pnl}%`);
  const avgBars = results.filter(Boolean).length
    ? (results.filter(Boolean).reduce((s,r)=>s+r.bars,0)/results.filter(Boolean).length).toFixed(1) : '–';
  console.log(`  Hold เฉลี่ย : ${avgBars} แท่งต่อ trade`);
  console.log(`\n  TP Breakdown:`);
  for (const [tp, cnt] of Object.entries(tpMap).sort()) {
    const pct = ((cnt / (wins+losses)) * 100).toFixed(1);
    console.log(`    ${tp.padEnd(8)} : ${cnt} ครั้ง (${pct}%)`);
  }
  console.log(`${'═'.repeat(64)}\n`);
}

main().catch(console.error);
