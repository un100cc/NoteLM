# Backtest Comparison Spec

มาตรฐานสำหรับเทียบ backtest สองตัวว่า "ตัวเลขต่างเพราะกลยุทธ์ หรือต่างเพราะ methodology"
เช็คทีละหมวด — ถ้าหมวดไหนไม่ตรง ให้ปรับให้ตรงก่อนเทียบตัวเลข

## Reference A: Divergence + Choch backtest (Bybit, spec จากเพื่อน)

| หมวด | รายละเอียด |
|---|---|
| **1. ข้อมูล** | Bybit (GitHub dataset) · BTC/ETH คู่ USDT · TF 4h + 1h · 2020/2021 → ธ.ค. 2025 (~4.7–5.7 ปี) |
| **2. Signal** | Pivot fractal lookback 5 แท่ง + dedup, **ยืนยันหลังผ่าน 5 แท่ง** (กัน lookahead) · Regular divergence เท่านั้น (ราคา new H/L + RSI(14) สวนทาง) ที่ 2 ยอดล่าสุด · ความแรง: Fibo extension จาก sideway ≥138.2% (MEDIUM) / ≥161.8% (STRONG) · Trigger: Choch External = close ทะลุ low/high ของ wave 4 |
| **3. Execution** | Entry: limit ที่ retrace 38.2% ของสวิง M1 (ตัวแปร: 50%, 61.8%) · SL: ยอด wave 5 · TP: 100 of A → RR โครงสร้างคงที่ ≈ 1.62 · ยกเลิก: close ทะลุ wave5 ก่อนเข้า / รอ Choch >80 แท่ง / รอ entry >60 แท่ง · Timeout: ถือเกิน 180 แท่ง → ปิดที่ close · ถือทีละ 1 setup · ไม่มี pyramid / partial TP / trailing |
| **4. สมมติฐาน** | ชน SL+TP แท่งเดียวกัน → นับ **SL** (conservative) · Fee 0.1%/รอบ · ไม่รวม slippage, funding · ขนาดไม้คงที่ **1R** (วัดเป็น R multiple ไม่ compound) |
| **5. Metrics** | Win%, AvgR, TotalR, PF, MaxDD(R), exposure% · Benchmark 1: Buy & Hold (% รวม + ต่อหน่วยเวลาที่ถือ) · Benchmark 2: Random entry MC **5,000 รอบ** คงเรขาคณิต SL/TP → percentile, เกณฑ์ผ่าน ≥p95 |

## Reference B: KLAUD corrected harness (`bench/benchmark.js`)

| หมวด | รายละเอียด |
|---|---|
| **1. ข้อมูล** | Binance spot API · 20 เหรียญ USDT · TF 4h (มี 1d/1h เสริม) · 7 หน้าต่าง × 6 เดือน 2022→2026 + daily 2021→2026 |
| **2. Signal** | Pivot fractal lookback 3/3 (**ไม่ได้ gate การยืนยันแบบ explicit** — setup trigger เกิดหลัง pivot หลายแท่งจึงเสี่ยงต่ำ แต่ไม่การันตีเท่าแบบ A) · 3 Swings: M1 impulse >3%, M2 retrace 30–68%, Shock BoS, Retest Fib 33.3–61.8% |
| **3. Execution** | Entry: limit ที่ Fib 50% **ต้องมีราคาวิ่งผ่านจริงถึงนับ fill** · SL: Fib61.8+0.5% (variant: M2 structure) · TP: partial 1/3 ที่ TP1/TP2/TP3 · ยกเลิกถ้า structure หักก่อน fill (40 แท่ง) · Horizon 60 แท่ง (ทดสอบ 240 ด้วย) · **อนุญาตหลาย setup ซ้อนกัน** (ไม่มี concurrency limit) |
| **4. สมมติฐาน** | แท่งกำกวมรายงานสองขอบ: SL-first (pess, ตัวหลัก) + TP-first (opt) · Fee 0.1%/รอบ (variant 0.05) · ไม่รวม slippage, funding · ขนาดไม้คงที่เป็น **% ของ notional** (EV เป็น %/ไม้ ไม่ใช่ R) |
| **5. Metrics** | WR, EV%/ไม้, PF, bootstrap 95% CI · Walk-forward 7 หน้าต่าง · Random entry MC 50 รอบ (เกณฑ์ >p95) · Parameter sensitivity · Train/validation split · Ablation (EV decomposition) |

## ผลเทียบหมวดต่อหมวด (A vs B)

| หมวด | สถานะ | หมายเหตุ |
|---|---|---|
| ข้อมูล | ⚠️ ต่าง | A ใช้ 2 เหรียญใหญ่ (survivorship ต่ำ, ความหลากหลายต่ำ) · B ใช้ 20 เหรียญ (survivorship bias มี แต่ sample กว้าง) · Bybit vs Binance ราคาต่างกันเล็กน้อยไม่มีนัย |
| Pivot/lookahead | ⚠️ ต่าง | A เข้มกว่า (ยืนยันหลัง 5 แท่ง explicit) · B พึ่งระยะห่างเชิงโครงสร้างแทน — ถ้าผล B ดูดีกว่า A ผิดปกติ ให้สงสัยข้อนี้ก่อน |
| Entry fill | ✅ เทียบได้ | ทั้งคู่ limit-at-level + ตรวจ fill จริง |
| กติกาแท่งเดียวชน SL+TP | ✅ เทียบได้ | A = SL-first · B โหมด pess = SL-first (ใช้ pess เทียบ ไม่ใช้ opt) |
| Exit model | ⚠️ ต่าง | A = TP เดียว all-or-nothing (RR คงที่ 1.62) · B = partial 1/3×3 → WR ของ A จะ "แท้" กว่า ส่วน B WR แปลผลตรงๆ ไม่ได้ (ชนะ = pnl>0 หลัง partial) |
| Concurrency | ⚠️ ต่าง | A ถือทีละ 1 (trade อิสระ, exposure% มีความหมาย) · B ซ้อนได้ (trade ไม่อิสระ, ห้ามคูณ EV×n ตรงๆ) |
| Sizing/หน่วยผล | ❌ ห้ามเทียบตรง | A = R multiple · B = %notional → **แปลงก่อน: R ของ B ≈ EV% ÷ ระยะ SL เฉลี่ย (1.34% สำหรับ fib stop)** เช่น EV -0.08% ≈ -0.06R |
| Random baseline | ✅ เทียบได้ | เกณฑ์เดียวกัน (≥p95) · A ทำ 5,000 รอบ ละเอียดกว่า B (50 รอบ) — ทิศทางผลเทียบกันได้ |
| Robustness | ⚠️ B มีเพิ่ม | B มี walk-forward / sensitivity / train-valid — ถ้าจะเทียบความทนทาน ต้องรัน A แบบแบ่งช่วงเวลาด้วย |

## ตัวเลขที่เทียบข้ามกันได้ปลอดภัย

1. **Win% เทียบกับ RR โครงสร้างของตัวเอง** (A: ต้องชนะ >38.2% ที่ RR 1.62 ถึงคุ้มก่อน fee)
2. **Profit Factor** (ไร้หน่วย)
3. **Percentile เหนือ random baseline** (ทั้งคู่เกณฑ์ p95)
4. **ความสม่ำเสมอข้ามช่วงเวลา/เหรียญ** (ถ้ามีข้อมูลแบ่งช่วง)

ห้ามเทียบ: TotalR vs Total% · WR ข้าม exit model · MaxDD(R) vs MaxDD(%)

## เช็คลิสต์ 4 จุดที่ทำให้ backtest ต่างกันบ่อยสุด

ก่อนสรุปว่า "กลยุทธ์ A ดีกว่า B" ให้ตอบ 4 ข้อนี้ก่อน:

- [ ] **กติกาชนแท่งเดียว** — SL-first vs TP-first (พลิกผลแรงสุด: ใน KLAUD พลิก WR จาก 84%→29%)
- [ ] **นิยาม swing/pivot** — lookback กี่แท่ง ยืนยันเมื่อไหร่ (หัวใจของ lookahead ที่ซ่อนอยู่)
- [ ] **จุด entry fill** — limit ที่ level (ต้องเช็คราคาวิ่งถึง) vs close แท่งถัดไป (ใน KLAUD: ไม้ผี 21% มี WR ปลอม 97%)
- [ ] **Position sizing** — fixed R vs compound vs %notional (เปลี่ยนหน่วยของทุก metric)
