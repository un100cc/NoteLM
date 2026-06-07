const START = 1000;

// Backtest 4h EV: TP1(57%)+4%, TP2(23%)+8%, TP3(3.5%)+12%, SL(16%)-2.5%
const tpDistrib = [
  { pct: 4.0,  w: 0.570 },
  { pct: 8.0,  w: 0.233 },
  { pct: 12.0, w: 0.035 },
  { pct: -2.5, w: 0.161 },
];
const EV   = tpDistrib.reduce((s, t) => s + t.pct * t.w, 0); // +4.16%
const SL   = 0.015; // SL เฉลี่ย 1.5% จาก entry
const TRADES = 44;  // 4h · 6 เดือน · 1 เหรียญ

function compound(start, riskPct, trades) {
  let p = start;
  for (let i = 0; i < trades; i++) {
    const pos = Math.min(p * (riskPct / SL), p);
    p += pos * (EV / 100);
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────
console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║  KLAUD — $1,000 พอร์ต: แบ่งกี่ไม้ และได้เท่าไร          ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// ── 1. Position Sizing ────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log('  💼 แบ่งไม้: $1,000 → กี่ไม้? ขนาดไม้ละเท่าไร?');
console.log('  สูตร: Position Size = (Portfolio × Risk%) ÷ SL%');
console.log('        SL เฉลี่ยจาก Backtest = ~1.5% จาก entry');
console.log('═══════════════════════════════════════════════════════════\n');

const profiles = [
  { name: 'Conservative 🛡️ ', risk: 0.02, maxPos: 3, reserve: 0.40 },
  { name: 'Balanced     ⚖️ ', risk: 0.03, maxPos: 4, reserve: 0.25 },
  { name: 'Aggressive   🚀 ', risk: 0.05, maxPos: 5, reserve: 0.10 },
];

for (const p of profiles) {
  const deploy   = START * (1 - p.reserve);
  const posSize  = START * p.risk / SL;                          // ขนาด 1 ไม้
  const posCap   = Math.min(posSize, deploy / p.maxPos);         // cap ไม่เกิน deploy/n
  const riskDollar = posCap * SL;
  const worstDD  = riskDollar * p.maxPos;

  console.log('  ' + p.name);
  console.log('  ┌─────────────────────────────────────────────────┐');
  console.log('  │  ทุน Deploy   : $' + deploy.toFixed(0).padStart(6) + '  (สำรอง $' + (START*p.reserve).toFixed(0) + ')       │');
  console.log('  │  ขนาด/ไม้     : $' + posCap.toFixed(0).padStart(6) + '  (' + p.maxPos + ' ไม้พร้อมกัน)         │');
  console.log('  │  Risk/ไม้      : $' + riskDollar.toFixed(1).padStart(6) + '  (' + (riskDollar/START*100).toFixed(1) + '% ของพอร์ต)      │');
  console.log('  │  Worst DD     : -$' + worstDD.toFixed(0).padStart(5) + '  (' + (worstDD/START*100).toFixed(1) + '%) ถ้าแพ้พร้อมกัน│');
  console.log('  └─────────────────────────────────────────────────┘\n');
}

// ── 2. Projection ─────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════');
console.log('  📈 Projection 6 เดือน (4h TF · Compound ทุก trade)');
console.log('  Expected Value/trade = +' + EV.toFixed(2) + '% ของ position');
console.log('═══════════════════════════════════════════════════════════\n');

console.log('  ' + 'Profile'.padEnd(20) + '$เริ่ม'.padStart(8) + '$จบ (Backtest)'.padStart(16) + '$จบ (Realistic)'.padStart(17) + 'x'.padStart(6));
console.log('  ' + '─'.repeat(67));

for (const p of profiles) {
  const gross     = compound(START, p.risk, TRADES);
  const realistic = START + (gross - START) * 0.75; // -25% friction
  const x         = (realistic / START).toFixed(1);
  console.log('  ' + p.name.padEnd(20)
    + ('$' + START).padStart(8)
    + ('$' + gross.toFixed(0)).padStart(16)
    + ('$' + realistic.toFixed(0)).padStart(17)
    + (x + 'x').padStart(6));
}

// ── 3. Monthly Balanced ────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  📅 รายเดือน — Balanced Risk 3% (4h · $1,000)');
console.log('═══════════════════════════════════════════════════════════');
{
  const perMonth = Math.ceil(TRADES / 6);
  const months   = ['ธ.ค.25','ม.ค.26','ก.พ.26','มี.ค.26','เม.ย.26','พ.ค.26'];
  let port = START, prev = START;
  for (let m = 0; m < 6; m++) {
    for (let t = 0; t < perMonth; t++) {
      const pos = Math.min(port * (0.03 / SL), port);
      port += pos * (EV / 100);
    }
    const diff    = port - prev;
    const diffPct = (diff / prev * 100).toFixed(1);
    const bar     = '█'.repeat(Math.min(Math.round(diff / 40), 28));
    console.log('  ' + months[m] + '  $' + String(port.toFixed(0)).padStart(7)
      + '  (+$' + String(diff.toFixed(0)).padStart(4) + ' / +' + diffPct + '%)  ' + bar);
    prev = port;
  }
  const real = START + (port - START) * 0.75;
  console.log('\n  Backtest  : $1,000 → $' + port.toFixed(0) + '  (+' + ((port-START)/START*100).toFixed(0) + '%)');
  console.log('  Realistic : $1,000 → $' + real.toFixed(0)  + '  (+' + ((real-START)/START*100).toFixed(0)  + '%)');
}

// ── 4. สรุปแนะนำ ──────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  ✅ สรุปแนะนำ: $1,000 ควรแบ่งแบบ Balanced');
console.log('═══════════════════════════════════════════════════════════');
console.log();
console.log('  ┌─────────────────────────────────────────────────────┐');
console.log('  │  พอร์ต $1,000                                        │');
console.log('  │  ├─ Deploy $750 → แบ่ง 4 ไม้ @ $187/ไม้             │');
console.log('  │  │    Risk/ไม้  = $2.8  (0.3% ของพอร์ต)              │');
console.log('  │  │    SL ห่าง  = 1.5%  ($2.8 จาก $187)              │');
console.log('  │  │    TP1      = +4%   → +$7.5/ไม้                   │');
console.log('  │  │    TP2      = +8%   → +$15/ไม้                    │');
console.log('  │  └─ สำรอง $250 — เผื่อ drawdown / เพิ่มไม้เมื่อชนะ  │');
console.log('  └─────────────────────────────────────────────────────┘');
console.log();
console.log('  กฎเหล็ก:');
console.log('  1. ต้องครบ 5 เงื่อนไข (M1→M2→Shock→Retest→Fib) ก่อนเข้า');
console.log('  2. TP1 ปิด 50% ก่อน → ย้าย SL มา Breakeven');
console.log('  3. ไม่เปิดไม้ใหม่ถ้า Open PnL ติดลบเกิน -$60 (-6%)');
console.log('  4. เพิ่มขนาดไม้ได้เมื่อพอร์ต +30% (เพิ่มทีละ 10%)');
console.log();
console.log('  คาดหวัง (Realistic after fee):');
console.log('  6 เดือน: $1,000 → $1,800–2,200');
console.log('  ต่อเดือน: +$130–200/เดือน');
console.log('═══════════════════════════════════════════════════════════\n');
