---
name: cdc-actionzone
description: >
  Operate the CDC ActionZone daily trend-following system in this repo.
  Use this skill whenever the user asks about CDC signals, "วันนี้ซื้อได้ยัง",
  "สัญญาณวันนี้", "ขายยัง", daily trading routine, position sizing for the
  CDC system, whether to deviate from a signal, or anything about cdc.html,
  the Telegram alert, or following the EMA12/26 system. Also use when the
  user is tempted to trade intraday or override the system — the answer
  lives here.
---

# CDC ActionZone — คู่มือปฏิบัติการ

ระบบเดียวใน repo นี้ที่ผ่าน benchmark (`bench/REPORT.md` §5):
CAGR ~30% (มี survivorship bias, BTC-only ~20%) · **MaxDD -55%** · Sharpe 0.84 ·
มีปีขาดทุน (2025: -22%) · ที่มา: `bench/cdc.js`

## กฎของระบบ (ห้ามดัดแปลงโดยไม่ผ่าน backtest-audit)

- EMA12/26 บนแท่ง **daily ที่ปิดแล้วเท่านั้น** (ปิด 07:00 น. ไทย)
- แท่งเขียวแรก (EMA12>EMA26 และ close>EMA12) = **ซื้อ** · แท่งแดงแรก = **ขาย ถือเงินสด**
- Long/flat เท่านั้น — ไม่ short (ทดสอบแล้ว long/short แย่กว่า: Sharpe 0.62 vs 0.84)
- แบ่งเงินเท่ากัน 20 เหรียญ (รายชื่อใน `cdc.html`)

## เครื่องมือ

| อะไร | ที่ไหน |
|---|---|
| Dashboard + "วันนี้ต้องทำอะไร" | `cdc.html` หรือ https://un100cc.github.io/NoteLM/cdc.html |
| แจ้งเตือน Telegram อัตโนมัติ 07:15 น. | `.github/workflows/cdc-alert.yml` (setup ใน README) |
| เช็คจาก CLI | `node alert/cdc-alert.js` (dry-run ถ้าไม่มี token) |
| ตรวจว่าหน้าเว็บคำนวณตรง backtest | `node bench/check-cdc-page.js` |

## Routine รายวัน (ทั้งหมดที่ต้องทำ)

1. หลัง 07:15 น. — ดูแบนเนอร์ใน cdc.html หรือรอ Telegram
2. มีสัญญาณ → ทำที่ราคาตลาด **วันนั้น** แล้วบันทึกลง log.html ทันที
3. ไม่มีสัญญาณ → ปิดจอ (ปีหนึ่งมีสัญญาณ ~11 ครั้ง/เหรียญ — การไม่ทำอะไรคือการทำตามระบบ)

## ตอบยังไงเมื่อ user อยากแหกระบบ

- **"กราฟกำลังวิ่ง ซื้อเลยได้ไหม ยังไม่ปิดแท่ง"** → ไม่ได้ สัญญาณยืนยันที่ราคาปิดเท่านั้น
  intraday คือ noise ที่ benchmark พิสูจน์แล้วว่ากิน EV (REPORT §2: TF ต่ำ = ขาดทุน)
- **"ขอถือต่ออีกหน่อย มันน่าจะเด้ง"** → ระบบขายเพราะ regime เปลี่ยน การถือต่อคือการเปลี่ยน
  ระบบที่วัดแล้วเป็นความรู้สึกที่วัดไม่ได้ — เตือนเรื่อง SL กว้าง (REPORT §4): WR สูงขึ้น
  แต่จนเร็วขึ้น
- **"ขาดทุนมา 3 เดือนแล้ว เลิกดีไหม"** → เปิดผลรายปีให้ดู: 2025 ทั้งปี -22% คือ
  ค่าผ่านทางปกติของ trend following ตัดสินระบบที่ 12 เดือนขึ้นไป ไม่ใช่ 3 เดือน
  ถ้าทนไม่ไหวจริง ให้**ลด size** ไม่ใช่เลิกกลางทาง
- **"เพิ่ม indicator กรองสัญญาณหลอกดีไหม"** → ทุกการแก้ต้องผ่าน skill `backtest-audit`
  ก่อน (volume filter ที่ "ฟังดูดี" เคยทดสอบแล้วทำให้แย่ลง — REPORT §4)

## Position sizing

- ต่อเหรียญ = พอร์ต ÷ 20 (เครื่องคิดอยู่ใน cdc.html)
- ก่อนเริ่ม ให้ user เห็นตัวเลขนี้เสมอ: "พอร์ต X → จุดลึกสุดตาม backtest เหลือ 0.45X รับได้ไหม"
  รับไม่ได้ → ลดขนาดจนรับได้ ไม่ใช่หวังว่าจะไม่เกิด
- เงินที่ใช้ต้องไม่ใช่เงินที่มีกำหนดใช้ภายใน 2-3 ปี

## ความคาดหวังที่ถูกต้อง

ระบบนี้ไม่ใช่ทางรวยเร็ว — มันคือ "ได้ผลตอบแทนใกล้ตลาดโดยเจ็บครึ่งเดียว และรอดทุก bear"
ถ้า user อยากได้มากกว่านี้ ชี้ไปที่: forward test ฝีมือตัวเอง 30-50 ไม้ (log.html),
structural edge research (`node bench/funding-scan.js`), หรือ freqtrade ถ้าจะ automate จริงจัง
