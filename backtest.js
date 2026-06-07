/**
 * KLAUD — 3 Swings & Shock Retest Backtest (6 เดือน)
 * ใช้ Price Structure Detection ตามกลยุทธ์จริง
 *
 * Algorithm:
 *   1. Detect M1 — impulse move >3% ใน >3 แท่ง
 *   2. Detect M2 — pullback กลับมา 30–68% ของ M1 (ภายใน 80 แท่ง)
 *   3. Detect Shock — close ทะลุ M1 End (Break of Structure)
 *   4. Retest — ราคากลับมาใน Fib 33.3–61.8% หลัง Shock
 *   5. Entry ที่ Fib 50% (Golden Zone ±1%)
 *   6. TP1=25% M1, TP2=M1End, TP3=M3 (100% extension)
 *   7. SL = ฝั่งตรงข้าม Fib ที่เข้า + buffer 0.5%
 *
 * Run: node backtest.js
 */

const https = require('https');

const COINS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'ADAUSDT','DOTUSDT','LINKUSDT','AVAXUSDT','SUIUSDT',
  'STXUSDT','XLMUSDT','ICPUSDT','DOGEUSDT','APTUSDT',
  'FETUSDT','RUNEUSDT','NEARUSDT','ATOMUSDT','LTCUSDT'
];

// ── Backtest Parameters (ตาม spec) ───────────────────────────────
const PARAMS = {
  M1_MIN_PCT:    0.03,  // >3%
  M1_MIN_BARS:   3,     // >3 แท่ง
  M2_MIN_RET:    0.30,  // pullback 30% ขึ้นไป
  M2_MAX_RET:    0.68,  // pullback ไม่เกิน 68%
  M2_MAX_BARS:   80,    // หา M2 ภายใน 80 แท่งหลัง M1 end
  FIB_ENTRY_MIN: 0.333, // Fib 33.3%
  FIB_ENTRY_MAX: 0.618, // Fib 61.8%
  FIB_GOLDEN:    0.50,  // Golden Zone ±1%
  SL_BUFFER:     0.005, // buffer 0.5%
  TP1_PCT:       0.25,  // TP1 = 25% ของ M1 length
  // TP2 = M1 End level
  // TP3 = M3 = M2 ± M1 length (100% extension)
  TIMEFRAMES: ['1d', '4h', '1h'],
};

// ── Fetch helpers ─────────────────────────────────────────────────
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlines(symbol, interval, months = 6) {
  const startMs = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&limit=1000`;
  const raw = await fetch(url);
  if (!Array.isArray(raw)) throw new Error('Bad response');
  return raw.map(k => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3],
    close: +k[4], volume: +k[5]
  }));
}

// ── Swing High/Low (Pivot) ────────────────────────────────────────
function findSwingHighs(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const h = candles[i].high;
    let isHigh = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j !== i && candles[j].high >= h) { isHigh = false; break; }
    }
    if (isHigh) out.push({ idx: i, price: h });
  }
  return out;
}

function findSwingLows(candles, left = 3, right = 3) {
  const out = [];
  for (let i = left; i < candles.length - right; i++) {
    const l = candles[i].low;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j !== i && candles[j].low <= l) { isLow = false; break; }
    }
    if (isLow) out.push({ idx: i, price: l });
  }
  return out;
}

// ── Volume SMA helper ─────────────────────────────────────────────
function volSMA(candles, idx, n = 10) {
  const start = Math.max(0, idx - n);
  const slice = candles.slice(start, idx);
  return slice.length ? slice.reduce((s, c) => s + c.volume, 0) / slice.length : 0;
}

// ── Detect M1 Impulse Moves ───────────────────────────────────────
// หา Bullish M1: swing low → swing high  >3%  ใน >3 แท่ง
// หา Bearish M1: swing high → swing low  <-3% ใน >3 แท่ง
function detectM1s(candles) {
  const swingHighs = findSwingHighs(candles);
  const swingLows  = findSwingLows(candles);
  const m1s = [];

  // Bullish M1: from swing low to swing high
  for (const lo of swingLows) {
    for (const hi of swingHighs) {
      if (hi.idx <= lo.idx) continue;
      if (hi.idx - lo.idx > 40) break; // ไม่ยาวเกินไป
      const bars = hi.idx - lo.idx;
      const pct  = (hi.price - lo.price) / lo.price;
      if (pct >= PARAMS.M1_MIN_PCT && bars >= PARAMS.M1_MIN_BARS) {
        m1s.push({
          dir: 'bull',
          startIdx: lo.idx, startPrice: lo.price,
          endIdx:   hi.idx, endPrice:   hi.price,
          length: hi.price - lo.price,
          bars, pct
        });
        break; // เอาเพียง hi แรกที่เจอ
      }
    }
  }

  // Bearish M1: from swing high to swing low
  for (const hi of swingHighs) {
    for (const lo of swingLows) {
      if (lo.idx <= hi.idx) continue;
      if (lo.idx - hi.idx > 40) break;
      const bars = lo.idx - hi.idx;
      const pct  = (hi.price - lo.price) / hi.price;
      if (pct >= PARAMS.M1_MIN_PCT && bars >= PARAMS.M1_MIN_BARS) {
        m1s.push({
          dir: 'bear',
          startIdx: hi.idx, startPrice: hi.price,
          endIdx:   lo.idx, endPrice:   lo.price,
          length: hi.price - lo.price,
          bars, pct
        });
        break;
      }
    }
  }

  return m1s.sort((a, b) => a.endIdx - b.endIdx);
}

// ── Core: ตรวจหา Setup ทีละ M1 ────────────────────────────────────
function findSetups(candles) {
  const m1s    = detectM1s(candles);
  const setups = [];

  for (const m1 of m1s) {
    const endI  = m1.endIdx;
    const bull  = m1.dir === 'bull';

    // Fib levels relative to M1
    const fib = pct => bull
      ? m1.endPrice - pct * m1.length   // Bull: retest ลง
      : m1.endPrice + pct * m1.length;  // Bear: retest ขึ้น

    const fib333 = fib(0.333);
    const fib500 = fib(0.500);
    const fib618 = fib(0.618);

    // M2: ราคา retrace กลับมา 30–68% ภายใน 80 แท่ง
    let m2Idx = null, m2Low = null, m2High = null;
    for (let i = endI + 1; i < Math.min(endI + PARAMS.M2_MAX_BARS, candles.length); i++) {
      const c  = candles[i];
      const retLow  = bull ? (m1.endPrice - c.low)  / m1.length : null;
      const retHigh = !bull ? (c.high - m1.endPrice) / m1.length : null;
      const ret = bull ? retLow : retHigh;
      if (ret !== null && ret >= PARAMS.M2_MIN_RET && ret <= PARAMS.M2_MAX_RET) {
        m2Idx  = i;
        m2Low  = bull ? c.low  : m1.endPrice;
        m2High = bull ? m1.endPrice : c.high;
        break;
      }
    }
    if (m2Idx === null) continue;

    // Shock: close ทะลุ M1 End หลัง M2
    let shockIdx = null;
    for (let i = m2Idx + 1; i < Math.min(m2Idx + PARAMS.M2_MAX_BARS, candles.length); i++) {
      const c = candles[i];
      const broke = bull ? c.close > m1.endPrice : c.close < m1.endPrice;
      if (broke) { shockIdx = i; break; }
    }
    if (shockIdx === null) continue;

    // Retest: ราคากลับมาใน Fib 33.3–61.8% หลัง Shock
    for (let i = shockIdx + 1; i < Math.min(shockIdx + 40, candles.length); i++) {
      const c = candles[i];

      // เช็ค M2 structure ยังสมบูรณ์ (ไม่ทะลุ M2 Low/High)
      const structureBroken = bull
        ? c.low  < m2Low  * (1 - PARAMS.SL_BUFFER)
        : c.high > m2High * (1 + PARAMS.SL_BUFFER);
      if (structureBroken) break;

      // ราคาแตะ Fib zone ไหม?
      const inZone = bull
        ? c.low <= fib333 && c.high >= fib618
        : c.high >= fib333 && c.low <= fib618;
      if (!inZone) continue;

      // Volume ลดขณะ Retest (ดี) หรือเพิ่ม (เตือน)
      const avgVol = volSMA(candles, i);
      const volDecreasing = c.volume < avgVol;

      // Entry price = Fib 50%
      const entryPrice = fib500;

      // SL = ฝั่งตรงข้าม Fib 61.8% + buffer
      const sl = bull
        ? fib618 * (1 - PARAMS.SL_BUFFER)
        : fib618 * (1 + PARAMS.SL_BUFFER);

      // TP1 = entry ± 25% ของ M1 length
      const tp1 = bull
        ? entryPrice + m1.length * PARAMS.TP1_PCT
        : entryPrice - m1.length * PARAMS.TP1_PCT;

      // TP2 = M1 End (Shock level)
      const tp2 = m1.endPrice;

      // TP3 = M3 = M2 extreme ± M1 length (100% extension)
      const tp3 = bull
        ? m2Low  + m1.length
        : m2High - m1.length;

      const rr = bull
        ? (tp2 - entryPrice) / (entryPrice - sl)
        : (entryPrice - tp2) / (sl - entryPrice);

      // กรอง R:R < 1.5
      if (rr < 1.5) continue;

      setups.push({
        m1, m2Idx, shockIdx, retestIdx: i,
        dir: m1.dir,
        entryPrice, sl, tp1, tp2, tp3,
        rr: +rr.toFixed(2),
        volDecreasing,
        m1Pct: +(m1.pct * 100).toFixed(2),
      });
      break; // เอาเฉพาะ retest แรก
    }
  }

  // กรอง duplicates (M1 เดิมกัน ตาม endIdx)
  const seen = new Set();
  return setups.filter(s => {
    const key = `${s.m1.endIdx}-${s.dir}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ── Simulate Trade จาก Setup ──────────────────────────────────────
function simulateTrade(candles, setup) {
  const { dir, entryPrice, sl, tp1, tp2, tp3, retestIdx } = setup;
  const bull = dir === 'bull';

  // เริ่ม simulate จากแท่งถัดจาก retest
  for (let i = retestIdx + 1; i < Math.min(retestIdx + 60, candles.length); i++) {
    const { high, low, close, time } = candles[i];

    // TP3 hit (M3 target)
    const tp3Hit = bull ? high >= tp3 : low <= tp3;
    if (tp3Hit) {
      const pct = Math.abs(tp3 - entryPrice) / entryPrice * 100;
      return { result: 'win', exitPrice: tp3, tp: 'TP3', pct: +pct.toFixed(3),
               bars: i - retestIdx, time, exitIdx: i };
    }
    // TP2 hit
    const tp2Hit = bull ? high >= tp2 : low <= tp2;
    if (tp2Hit) {
      const pct = Math.abs(tp2 - entryPrice) / entryPrice * 100;
      return { result: 'win', exitPrice: tp2, tp: 'TP2', pct: +pct.toFixed(3),
               bars: i - retestIdx, time, exitIdx: i };
    }
    // TP1 hit
    const tp1Hit = bull ? high >= tp1 : low <= tp1;
    if (tp1Hit) {
      const pct = Math.abs(tp1 - entryPrice) / entryPrice * 100;
      return { result: 'win', exitPrice: tp1, tp: 'TP1', pct: +pct.toFixed(3),
               bars: i - retestIdx, time, exitIdx: i };
    }
    // SL hit
    const slHit = bull ? low <= sl : high >= sl;
    if (slHit) {
      const pct = -Math.abs(entryPrice - sl) / entryPrice * 100;
      return { result: 'loss', exitPrice: sl, tp: 'SL', pct: +pct.toFixed(3),
               bars: i - retestIdx, time, exitIdx: i };
    }
  }
  // หมดเวลา: ปิดที่ราคาสุดท้าย
  const last = candles[Math.min(retestIdx + 59, candles.length - 1)];
  const pct = (last.close - entryPrice) / entryPrice * 100 * (bull ? 1 : -1);
  return { result: pct >= 0 ? 'win' : 'loss', exitPrice: last.close, tp: 'Expire',
           pct: +pct.toFixed(3), bars: 60, time: last.time, exitIdx: retestIdx + 59 };
}

// ── Run one TF across all coins ───────────────────────────────────
async function runTimeframe(tf) {
  const delayMs = tf === '1h' ? 80 : tf === '4h' ? 100 : 150;
  const allTrades = [], coinResults = [];

  console.log(`\n┌──────────────────────────────────────────────────────────┐`);
  console.log(`│  ⏱  Timeframe: ${tf.padEnd(45)}│`);
  console.log(`└──────────────────────────────────────────────────────────┘`);

  for (let ci = 0; ci < COINS.length; ci++) {
    const sym = COINS[ci];
    process.stdout.write(`  [${ci+1}/${COINS.length}] ${sym.padEnd(12)} `);

    let candles;
    try {
      candles = await fetchKlines(sym, tf);
      await sleep(delayMs);
    } catch(e) {
      console.log(`❌ ${e.message}`); continue;
    }
    if (candles.length < 60) { console.log('⚠️  ข้อมูลน้อย'); continue; }

    const setups = findSetups(candles);
    const trades = setups.map(s => {
      const result = simulateTrade(candles, s);
      return { ...result, setup: s, sym };
    });

    const wins   = trades.filter(t => t.result === 'win').length;
    const losses = trades.filter(t => t.result === 'loss').length;
    const total  = wins + losses;
    const wr     = total > 0 ? (wins / total * 100).toFixed(1) : '–';
    const pnl    = trades.reduce((s, t) => s + t.pct, 0).toFixed(2);

    const icon = total === 0 ? '⚪' : parseFloat(wr) >= 60 ? '🟢' : parseFloat(wr) >= 50 ? '🟡' : '🔴';
    const tpBreak = {};
    trades.forEach(t => { tpBreak[t.tp] = (tpBreak[t.tp]||0)+1; });
    const tpStr = Object.entries(tpBreak).map(([k,v])=>`${k}:${v}`).join(' ');
    console.log(`${icon} ${String(total).padStart(3)} setups · ${String(wr).padStart(5)}% win · P&L ${parseFloat(pnl)>=0?'+':''}${pnl}%  [${tpStr||'–'}]`);

    coinResults.push({ sym, total, wins, losses, wr: parseFloat(wr)||0, pnl: parseFloat(pnl) });
    allTrades.push(...trades);
  }
  return { allTrades, coinResults, tf };
}

// ── Print Full Summary ────────────────────────────────────────────
function printSummary({ allTrades, coinResults, tf }) {
  const total  = allTrades.length;
  const wins   = allTrades.filter(t => t.result === 'win').length;
  const losses = allTrades.filter(t => t.result === 'loss').length;
  const wr     = total > 0 ? (wins / total * 100) : 0;
  const pnl    = allTrades.reduce((s, t) => s + t.pct, 0);
  const avgPnl = total > 0 ? pnl / total : 0;
  const grossW = allTrades.filter(t=>t.result==='win').reduce((s,t)=>s+t.pct, 0);
  const grossL = Math.abs(allTrades.filter(t=>t.result==='loss').reduce((s,t)=>s+t.pct, 0));
  const pf     = grossL > 0 ? (grossW/grossL).toFixed(2) : '∞';

  // Average R:R ของ setups ที่หาได้
  const avgRR = allTrades.length
    ? (allTrades.reduce((s,t)=>s+(t.setup?.rr||0),0)/allTrades.length).toFixed(2) : '–';

  // TP breakdown
  const tpMap = {};
  allTrades.forEach(t => { tpMap[t.tp] = (tpMap[t.tp]||0)+1; });

  // Monthly
  const monthly = {};
  allTrades.forEach(t => {
    const key = t.time ? new Date(t.time).toISOString().slice(0,7) : '?';
    if (!monthly[key]) monthly[key] = { win:0, loss:0, pnl:0 };
    monthly[key][t.result]++;
    monthly[key].pnl += t.pct;
  });

  // Volume filter impact
  const volOk   = allTrades.filter(t => t.setup?.volDecreasing);
  const volBad  = allTrades.filter(t => !t.setup?.volDecreasing);
  const wrVol   = volOk.length   ? (volOk.filter(t=>t.result==='win').length/volOk.length*100).toFixed(1) : '–';
  const wrNoVol = volBad.length  ? (volBad.filter(t=>t.result==='win').length/volBad.length*100).toFixed(1) : '–';

  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  📊 สรุปผล Backtest — ${tf} (6 เดือน · 3 Swings Structure)`);
  console.log(`${'═'.repeat(62)}`);
  console.log(`  Setups พบทั้งหมด   : ${total} รายการ`);
  console.log(`  ชนะ / แพ้          : ${wins} / ${losses}`);
  console.log(`  Win Rate           : ${wr.toFixed(2)}%`);
  console.log(`  Profit Factor      : ${pf}`);
  console.log(`  P&L รวม            : ${pnl>=0?'+':''}${pnl.toFixed(2)}%`);
  console.log(`  P&L เฉลี่ย/trade   : ${avgPnl>=0?'+':''}${avgPnl.toFixed(2)}%`);
  console.log(`  Avg R:R            : ${avgRR}`);

  console.log(`\n  ── TP Breakdown ─────────────────────────────────────`);
  for (const [tp, cnt] of Object.entries(tpMap).sort()) {
    const wins_tp = allTrades.filter(t=>t.tp===tp&&t.result==='win').length;
    const pct_tp  = (cnt/total*100).toFixed(1);
    console.log(`  ${tp.padEnd(8)} : ${String(cnt).padStart(4)} trades (${pct_tp}%) · wins: ${wins_tp}`);
  }

  console.log(`\n  ── Volume Filter Impact ─────────────────────────────`);
  console.log(`  Volume ลด (good) : ${volOk.length} trades · WR ${wrVol}%`);
  console.log(`  Volume เพิ่ม     : ${volBad.length} trades · WR ${wrNoVol}%`);

  console.log(`\n  ── Monthly P&L ──────────────────────────────────────`);
  for (const [mo, v] of Object.entries(monthly).sort()) {
    const tot = v.win + v.loss;
    const mwr = tot > 0 ? (v.win/tot*100).toFixed(0) : '–';
    const bar = v.pnl >= 0 ? '▲' : '▼';
    console.log(`  ${mo}  ${String(tot).padStart(3)} setups · ${mwr.padStart(3)}% win · ${bar} ${(v.pnl>=0?'+':'')+v.pnl.toFixed(1)}%`);
  }

  const ranked = coinResults.filter(c=>c.total>=2).sort((a,b)=>b.wr-a.wr);
  console.log(`\n  ── Top 5 เหรียญ (Win Rate) ──────────────────────────`);
  ranked.slice(0,5).forEach((c,i) => {
    const bar = '█'.repeat(Math.round(c.wr/10));
    console.log(`  ${i+1}. ${c.sym.padEnd(12)} ${c.wr.toFixed(1).padStart(5)}%  ${bar}  (${c.total} setups)`);
  });
  console.log(`\n  ── Bottom 5 เหรียญ ──────────────────────────────────`);
  [...ranked].reverse().slice(0,5).forEach((c,i) => {
    const bar = '█'.repeat(Math.round(c.wr/10));
    console.log(`  ${i+1}. ${c.sym.padEnd(12)} ${c.wr.toFixed(1).padStart(5)}%  ${bar}  (${c.total} setups)`);
  });

  let rating;
  if (wr >= 65)      rating = '⭐⭐⭐⭐⭐ ยอดเยี่ยม';
  else if (wr >= 60) rating = '⭐⭐⭐⭐  ดีมาก';
  else if (wr >= 55) rating = '⭐⭐⭐   ผ่านเกณฑ์ดี';
  else if (wr >= 50) rating = '⭐⭐    พอใช้';
  else               rating = '⭐     ต้องปรับปรุง';

  console.log(`\n  Rating : ${rating}  (Win Rate ${wr.toFixed(2)}%)`);
  console.log(`\n  ⚠️  ไม่รวม Slippage / Fee / Funding Rate`);
  console.log(`${'═'.repeat(62)}`);

  return { tf, wr: wr.toFixed(2), pf, pnl: pnl.toFixed(2), total, avgRR };
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  KLAUD — 3 Swings & Shock Retest Backtest (6M · Structure) ║');
  console.log('║  M1>3% · M2 30–68% · Shock BOS · Retest Fib 33–62%        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const results = [];
  for (const tf of PARAMS.TIMEFRAMES) {
    const data = await runTimeframe(tf);
    const res  = printSummary(data);
    results.push(res);
  }

  // Final comparison
  console.log(`\n${'═'.repeat(62)}`);
  console.log('  🏆 เปรียบเทียบ 3 Timeframe — 3 Swings Structure Backtest');
  console.log(`${'═'.repeat(62)}`);
  console.log(`  ${'TF'.padEnd(6)} ${'Setups'.padStart(7)} ${'WinRate'.padStart(8)} ${'PF'.padStart(6)} ${'AvgRR'.padStart(7)} ${'P&L'.padStart(9)}`);
  console.log(`  ${'-'.repeat(50)}`);
  for (const r of results) {
    const icon = parseFloat(r.wr) >= 60 ? '🟢' : parseFloat(r.wr) >= 50 ? '🟡' : '🔴';
    const pnlStr = (parseFloat(r.pnl)>=0?'+':'')+r.pnl+'%';
    console.log(`  ${icon} ${r.tf.padEnd(4)} ${String(r.total).padStart(7)} ${(r.wr+'%').padStart(8)} ${r.pf.padStart(6)} ${r.avgRR.padStart(7)} ${pnlStr.padStart(9)}`);
  }
  const best = results.filter(r=>r.total>0).reduce((a,b)=>parseFloat(a.wr)>parseFloat(b.wr)?a:b, results[0]);
  console.log(`\n  ✅ Timeframe ที่ดีที่สุด : ${best.tf} (Win Rate ${best.wr}%)`);
  console.log(`\n  ⚠️  Backtest นี้ใช้ Price Structure จริงตามกลยุทธ์ 3 Swings`);
  console.log(`     ไม่ใช่ Indicator-based — ผลสะท้อน logic กลยุทธ์จริง`);
  console.log(`${'═'.repeat(62)}\n`);
}

main().catch(console.error);
