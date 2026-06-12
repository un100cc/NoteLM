---
name: backtest-audit
description: >
  Audit any trading strategy or backtest claim before anyone risks real money.
  Use this skill whenever the user shares a trading strategy, backtest results,
  a Pine Script, win-rate claims ("WR 80%", "กำไรชัวร์", "ผ่าน out-of-sample แล้ว"),
  or asks "กลยุทธ์นี้ดีไหม", "ตรวจสูตรนี้ให้หน่อย", "backtest นี้เชื่อได้ไหม",
  "audit this strategy", or wants to compare two backtests. Also use when the
  user is about to trade real money based on any backtest numbers.
---

# Backtest Audit

ทุกคำเคลมกลยุทธ์คือ hypothesis ไม่ใช่ edge จนกว่าจะผ่านขั้นตอนนี้
Repo นี้เคยมี backtest ที่เคลม WR 84% / EV +1.6%/ไม้ — ความจริงหลังแก้ bias คือ
WR 29% / EV ≈ 0 (ดู `bench/REPORT.md`) อย่าให้ประวัติศาสตร์ซ้ำรอย

## ขั้นที่ 0 — อ่านบริบทก่อนเสมอ

1. `bench/REPORT.md` — ผล audit ทั้งหมดที่เคยทำ + บทเรียน
2. `bench/COMPARE-SPEC.md` — มาตรฐานเทียบ backtest หมวดต่อหมวด
3. `bench/benchmark.js` — harness ที่ export `findSetups`, `simRealistic`,
   `metrics`, `bootstrapCI`, `fetchKlines` (มี disk cache) ใช้ต่อยอดได้เลย

## ขั้นที่ 1 — เช็คลิสต์ bias 5 จุด (จุดที่ backtest โกหกบ่อยสุด)

| # | คำถาม | ถ้าผิด ผลโป่งเท่าไหร่ (เคสจริงใน repo นี้) |
|---|---|---|
| 1 | แท่งเดียวแตะทั้ง TP และ SL → นับอะไร? ต้องนับ SL (conservative) | เคยพลิก WR 84%→29% |
| 2 | Entry แบบ limit ต้องเช็คว่าราคา "วิ่งถึงจริง" ไหม? | ไม้ผี 21% มี WR ปลอม 97% |
| 3 | หัก fee + slippage หรือยัง? (ขั้นต่ำ 0.1%/รอบ) | กิน EV -0.10%/ไม้ |
| 4 | Pivot/swing ยืนยันเมื่อไหร่ — มี lookahead แอบไหม? | หัวใจของ "สวยใน backtest พังตอนจริง" |
| 5 | ดึงข้อมูลครบช่วงที่เคลมจริงไหม? (เช็ค pagination) | เคยเคลม 6 เดือนแต่ข้อมูลจริง 42 วัน |

## ขั้นที่ 2 — การทดสอบขั้นต่ำที่ต้องผ่านครบ

1. **Corrected simulation** — SL-first, fill-required, fees (ใช้ `simRealistic` ใน harness)
2. **Walk-forward หลายช่วงตลาด** — ต้องเห็นผลแยกราย window/รายปี ไม่ใช่ก้อนเดียว
   กำไรที่กระจุกปีเดียว = regime bet ไม่ใช่ edge (เคสจริง: divchoch กำไรทั้งหมดมาจากปี 2022)
3. **Random-entry Monte Carlo** — คงเรขาคณิต SL/TP เดิม สุ่มจุดเข้า ≥1,000 รอบ
   ต้อง ≥ p95 ถึงนับว่า entry มีข้อมูลจริง
4. **ถ้ามีการ tune parameter** — บังคับ train/validation split แตะ validation ครั้งเดียว
   (เคสจริง: filter ที่ดู +0.20%/ไม้ บน train เหลือ +0.01% บน validation)

## ขั้นที่ 3 — กติกาเทียบข้าม backtest

เทียบได้ตรงๆ: Win% เทียบกับ RR ของตัวเอง · Profit Factor · percentile เหนือ random ·
ความสม่ำเสมอข้ามช่วงเวลา
**ห้ามเทียบ**: TotalR vs Total% (sizing คนละแบบ) · WR ข้าม exit model ต่างกัน ·
MaxDD(R) vs MaxDD(%) — เปิด `bench/COMPARE-SPEC.md` กรอกหมวดต่อหมวดก่อนเทียบเลขใดๆ

## ขั้นที่ 4 — รูปแบบรายงานผล

- ตัวเลขที่เคลม vs ตัวเลขหลังแก้ bias (ระบุว่า bias ตัวไหนกินเท่าไหร่)
- ผลราย window + MC percentile + CI
- คำตัดสินสามระดับ: ❌ ไม่มี edge / ⚠️ มี edge แต่บางกว่า cost / ✅ ผ่าน → ไป forward test
- **ห้ามจบที่ "ผ่าน backtest = เทรดได้"** — ขั้นถัดไปเสมอคือ forward test 30–50 ไม้
  บันทึกก่อนเข้า ห้ามแก้ย้อนหลัง (log.html ใน repo นี้ใช้ได้)

## หลักยึด

- ผลที่ดูดีเกินจริง = bias จน proven otherwise (WR >70% + เทรดถี่ + TF ต่ำ = ธงแดง 3 ผืน)
- การถ่าง SL ไม่สร้าง EV — มันแค่เปลี่ยน "แพ้ถี่" เป็น "แพ้หนัก" (ดู REPORT §4: SL 20% → WR 73% แต่ EV แย่ลง)
- อย่า tune ต่อบนข้อมูลที่ใช้ตัดสินไปแล้ว — นั่นคือนิยามของ overfit
