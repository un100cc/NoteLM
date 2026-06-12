# Strategy Benchmark Report — 3 Swings & Shock Retest (KLAUD)

วันที่ทดสอบ: 2026-06-12 · ข้อมูล: Binance spot klines · เครื่องมือทั้งหมดอยู่ใน `bench/`

## TL;DR

- ตัวเลขที่ `backtest.js` เคลม (**WR 84–89%, EV +1.6–4.0%/ไม้**) เป็นผลจาก bug ใน simulator ไม่ใช่ edge จริง
- หลังแก้ bias: **EV จริง ≈ 0** (-0.2 ถึง +0.2%/ไม้) ใน 7 ช่วงตลาด 2022–2026 รวม 4,900 ไม้
- กลยุทธ์**ไม่ใช่ overfit แบบ parameter** (เสถียรทุกค่า/ทุก regime) — entry signal มี edge จริง ~+0.5%/ไม้เหนือ random แต่ถูก noise + fee กินหมด
- การถ่าง SL เป็น 20% ทำ WR พุ่งเป็น 73% แต่ **EV แย่ลง** (-0.25%/ไม้) และ maxDD 50% — คือกลไกที่ทำให้ "เทรดมือแล้วรู้สึก work"
- ทางที่มีหลักฐานรองรับจริง: **trend following รายวัน** — CDC ActionZone (EMA12/26, long/flat) ให้ Sharpe 0.84, CAGR ~30% (มี survivorship bias), maxDD 55% บนเหรียญชุดเดียวกัน

## 1. Bias ที่พบใน backtest.js เดิม

| # | Bias | ที่อยู่ | ผลกระทบ (EV/ไม้, pooled 4h) |
|---|---|---|---|
| 1 | เช็ค TP3→TP2→TP1 ก่อน SL + ออกทั้งไม้ที่ TP ดีสุดของแท่ง | `simulateTrade()` | **-1.72** (ตัวการหลัก 81%) |
| 2 | สมมติ fill ที่ Fib 50% ทั้งที่ 21% ของ setup ราคาไปไม่ถึง (ไม้กลุ่มนี้ WR ปลอม 97%) | `findSetups()` เช็คแค่แตะ Fib 33.3% | **-0.30** |
| 3 | ไม่มี fee/slippage | ทั้งไฟล์ | **-0.10** |
| 4 | แท่งแตะทั้ง TP และ SL ถูกนับเป็นชนะเสมอ | `simulateTrade()` | **-0.08** |
| 5 | TF 1h ดึงข้อมูลแค่ 1,000 แท่ง (~42 วัน) แต่รายงานว่า "6 เดือน" | `fetchKlines()` ไม่ paginate | ตัวเลข 1h ทั้งหมดไม่ valid |

Waterfall: **+2.12 (เคลม) → -0.08 (จริง)** ดู `ablation.js`

## 2. ผลหลังแก้ bias (corrected simulator)

Walk-forward 7 ช่วง × 6 เดือน, 4h, partial exits ตาม spec, fee 0.1%:

| Window | n | EV (pess) | EV (opt) | B&H |
|---|---|---|---|---|
| 2025-12→2026-06 | 746 | -0.19 | -0.13 | -39.5% |
| 2025-06→12 | 696 | -0.10 | -0.05 | -23.6% |
| 2024-12→2025-06 | 830 | -0.18 | -0.10 | -46.6% |
| 2024-06→12 | 640 | +0.04 | +0.11 | +103.3% |
| 2023-12→2024-06 | 740 | -0.15 | -0.06 | +36.1% |
| 2023-06→12 | 689 | +0.10 | +0.17 | +125.2% |
| 2022-01→07 (bear) | 559 | -0.05 | +0.06 | -71.3% |

Pooled EV ≈ **-0.08 ถึง -0.01%/ไม้** — ไม่ต่างจากศูนย์ทางสถิติ

ข้อค้นพบสำคัญ: entry signal **ชนะ random entry เกิน p95 ทุก window** (random ได้ -0.4 ถึง -0.7) — framework มีข้อมูลจริง แต่ edge บางกว่าต้นทุน

## 3. Root cause ของการขาดทุน

- SL (Fib 61.8% + 0.5%) ห่าง entry เฉลี่ย **1.34%** แต่แท่ง 4h เฉลี่ยกว้าง **2.56%** → stop อยู่ลึกแค่ครึ่งแท่งของ noise
- **90.1%** ของไม้ที่เข้าจริง ราคามาแตะระดับ SL ภายใน 60 แท่ง
- **76.1%** ของไม้ที่โดน SL ราคาวิ่งไปถึง TP1 ในภายหลัง — ทิศถูกแต่โดนสะบัดออก
- ย้าย SL ไป structure invalidation (ตาม doc): EV ดีขึ้นเป็น -0.01 (PF 0.98) แต่ยังไม่บวก

## 4. การทดลองที่ล้มเหลว (บันทึกไว้กันทำซ้ำ)

| การทดลอง | ผล |
|---|---|
| Volume filter (ตาม doc) | แย่ลง (-0.10) |
| Trend filter SMA99 | ไม่ช่วย (-0.09) |
| รวมทุก filter + maker fee | -0.03, ไม่สม่ำเสมอข้าม window |
| Shock≥1.5×ATR + EMA30 + RSI (full spec ตาม doc) | **บทเรียน overfit**: train EV +0.20 (CI ไม่คร่อมศูนย์) → validation +0.01 — edge ระเหย |
| SL 20% ต่อไม้ | WR 73.3% แต่ EV -0.25, avg loss -10.9%, พอร์ตจำลอง $1,000 → median $737 ใน 6 เดือน, maxDD 50% |

## 5. กลยุทธ์ที่มีหลักฐานจริง (ทดสอบ 2021-01 → 2026-06, daily, fee 0.1%/side, เหรียญชุดเดียวกัน)

| กลยุทธ์ | Total | CAGR | MaxDD | Sharpe | เทรด/เหรียญ/ปี |
|---|---|---|---|---|---|
| **CDC ActionZone long/flat EW-20** | **+329%** | **30.7%** | 55.5% | **0.84** | 11 |
| Donchian 55/20 (Turtle) | +177% | 20.6% | **42.5%** | 0.74 | 4 |
| CDC long/flat BTC only | +169% | 20.0% | 58.8% | 0.67 | 11 |
| TSMOM 90d | +119% | 15.5% | 51.0% | 0.55 | – |
| BTC buy & hold | +111% | 14.7% | 76.6% | 0.53 | 0 |
| EW-20 buy & hold | +346% | 31.6% | 82.6% | 0.75 | 0 |

หมายเหตุ: parameter ทุกตัวมาจาก literature/สูตรต้นฉบับ ไม่ได้ tune กับข้อมูลนี้ · EW-20 มี survivorship bias (เหรียญที่รอดถึง 2026) · CDC ขาดทุนต่อเนื่อง 2025 (-21.8%) และ 2026 YTD (-25.1%) — trend following จ่ายหนักช่วงไร้เทรนด์

## 6. ข้อสรุปและคำแนะนำ

1. **อย่าเทรดเงินจริงด้วยระบบ 3 Swings แบบ mechanical** — EV ≈ 0 ก่อนความเสี่ยง
2. **อย่า tune parameter ต่อบนข้อมูลเดิม** — ทุกปุ่มถูกหมุนครบแล้ว (exit ×3, SL ×3+wide, filter ×8, fee ×2, TF ×3, 7 windows) ทุกเส้นทางจบที่ ≈ 0; การ tune ต่อจะได้ overfit ของจริง (พิสูจน์แล้วใน §4)
3. ถ้าเชื่อว่า "เทรดมือ work" → **forward test 30–50 ไม้** บันทึกก่อนเข้าทุกไม้ใน log.html ห้ามแก้ย้อนหลัง แล้ววัดด้วยมาตรฐานเดียวกับรายงานนี้
4. ทางที่มีหลักฐาน: trend following รายวัน (CDC/Donchian) — ความคาดหวังที่ถูกต้องคือ CAGR 15–25%, maxDD 40–60%, มีปีที่ขาดทุน — ไม่มีทาง "รวยเร็ว" ที่ผ่านการทดสอบ
5. ควรแก้ bug 5 ข้อใน §1 ก่อนใช้ตัวเลขจาก backtest.js อีก และแก้/ลบ `calc1000.js` ที่ compound จาก EV ปลอม

## 7. Replication: Divergence + Choch backtest (Reference A ใน COMPARE-SPEC.md, เพิ่ม 2026-06-13)

ทดสอบซ้ำตาม spec บนข้อมูล **Binance** (ต้นฉบับใช้ Bybit) — BTC/ETH, 4h+1h, 2020→2025,
pivot ยืนยันหลัง 5 แท่ง (กัน lookahead), SL-first, fee 0.1%, fixed 1R, ถือทีละ 1 setup:

| TF · entry retrace | n | Win% | TotalR | PF | MaxDD | MC 5,000 รอบ (เกณฑ์ผ่าน ≥p95) |
|---|---|---|---|---|---|---|
| 4h · 38.2% | 47 | 44.7 | +6.29R | 1.24 | 9.6R | **percentile 68 → ❌ FAIL** |
| 4h · 50% | 40 | 37.5 | +5.44R | 1.22 | 10.5R | – |
| 4h · 61.8% | 36 | 33.3 | +7.41R | 1.31 | 13.1R | – |
| 1h · 38.2% | 184 | 39.1 | **-10.15R** | 0.91 | 16.9R | percentile 47 → ❌ FAIL |

ข้อสังเกต:
- 4h เป็นบวกแต่**กำไรกระจุกปี 2022 ปีเดียว** (+14.6R) — ปีอื่นรวม ≈ -8.3R (regime-dependent)
- ไม่ผ่านเกณฑ์ MC p95 ของ spec ตัวเอง → ที่ n=47 แยกไม่ออกจากโชค
- 1h ขาดทุนสุทธิ — TF ต่ำโดน noise+fee กินเหมือน KLAUD
- Implementation choice ที่อาจต่างจากต้นฉบับ: M1 top ถูก freeze ที่แท่ง Choch — ถ้าผลฝั่ง Bybit
  ต่างมาก ให้ไล่เช็ค 4 จุดใน `COMPARE-SPEC.md` ก่อนสรุป

รัน: `node bench/divchoch.js` · ผล: `bench/divchoch-results.json`

## วิธีรันซ้ำ

```bash
node bench/benchmark.js        # phases A-F: replicate, correct, walk-forward, random baseline, sensitivity, exit models
node bench/ablation.js         # EV decomposition + mechanism stats
node bench/sl-variants.js      # SL placement comparison
node bench/improve.js          # filter combos (vol/trend/structure stop)
node bench/full-spec.js        # doc filters with train/validation split
node bench/wide-sl.js          # SL 5/10/20% experiment + portfolio sim
node bench/proven.js           # literature strategies (daily, 2021-2026)
node bench/cdc.js              # CDC ActionZone V3 faithful port
```

ข้อมูล cache อัตโนมัติใน `bench/cache/` (gitignored, ~26MB, โหลดใหม่ได้เอง)
