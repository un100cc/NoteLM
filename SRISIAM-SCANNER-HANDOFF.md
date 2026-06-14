# SRISIAM Scanner — Handoff สำหรับ Claude Code

> สรุปโปรเจกต์ scanner ตาม SRISIAM Waves เพื่อให้ Claude Code ทำต่อ
> เขียนเมื่อ 14 มิ.ย. 2026 · repo: `un100cc/NoteLM`

---

## 1. เป้าหมายโปรเจกต์ (อ่านก่อนทำ)

สร้าง **scanner ช่วยตัดสินใจ** ตามระบบ SRISIAM Waves (เอกสารต้นฉบับ: Divergence + 3 Swings + 100 of A) ไม่ใช่ระบบเทรดอัตโนมัติ

หลักการที่เจ้าของยึด:
- **Top-down เสมอ** — ดู degree ใหญ่ (1D) ก่อนว่าทิศไหน แล้วค่อยหา setup เล็ก (4h) ที่ไปทางเดียวกัน
- **เสียน้อยได้เยอะ** — cut loss เร็ว ปล่อยกำไรวิ่ง แต่ SL ต้องไม่แคบจนโดน noise สะบัด
- scanner ควร "เงียบ" เป็นส่วนใหญ่ ร้องเตือนเฉพาะตอนมีของจริง

## 2. ⚠️ ข้อจำกัดสำคัญจาก BACKTEST — ห้ามฝืน

มี backtest จริงแล้วใน `bench/` (รันบนข้อมูล Binance จริง, 20 เหรียญ, 7 ช่วงตลาด 2022–2026, รวม ~4,900 ไม้) อ่าน `bench/REPORT.md` ให้จบก่อนแก้อะไร

> ⚠️ **โฟลเดอร์ `bench/` อยู่บน branch `strategy-benchmark` ไม่ใช่ `main`** — ต้อง `git checkout strategy-benchmark` (หรืออ่านผ่าน `git show origin/strategy-benchmark:bench/REPORT.md`) ก่อน ไม่งั้นจะหาไฟล์ไม่เจอ

ผลสรุป:

1. **อย่า implement TP Matrix 4 แบบจากเอกสาร (หน้า 13) เป็นตัวปรับ TP** — REPORT.md ไม่ได้ทดสอบ matrix นี้ จึงไม่มีหลักฐาน backtest รองรับว่ามันช่วย ใช้แค่ "100 of A" เป็นเป้าทั่วไป (เป้าหลักที่ scanner คำนวณอยู่แล้ว) **อย่าอ้างตัวเลข correlation ใดๆ — ไม่มีการวิเคราะห์ correlation/TP-matrix ใน REPORT.md**

2. **ระบบมี edge บางมาก** — entry signal ชนะ random baseline เกิน p95 (มี edge จริง) แต่บางกว่าต้นทุน fee+SL → EV จริง ≈ 0 บน 4h, ติดลบบน 1h **ดังนั้นนี่คือเครื่องมือช่วยตา ไม่ใช่ auto-trade**

3. **ทุกพารามิเตอร์ถูกหมุนครบแล้ว** (exit×3, SL หลายแบบ, filter×8, fee×2, TF×3) ทุกเส้นทางจบที่ EV≈0 **การ tune พารามิเตอร์ต่อบนข้อมูลเดิม = overfit** (พิสูจน์แล้วใน REPORT §4: full-spec train +0.20R → validation +0.01R)

4. **Top-down (1D bias) เป็นหลักการ ไม่ใช่ edge ที่ REPORT พิสูจน์** — REPORT.md §4 ระบุชัดว่า filter ที่ลองแล้ว (trend SMA99, volume) **ไม่ช่วยหรือแย่ลง** และไม่มีการทดสอบ "กรองด้วยทิศ 1D" บันทึกไว้ ดังนั้นการดูทิศ 1D ก่อนให้ถือเป็น **วิจารณญาณ/risk management** ไม่ใช่ edge เชิงสถิติที่ backtest ยืนยัน (อย่าเขียนว่า "ถอด filter แล้วติดลบ" — ไม่มีหลักฐานในรายงาน)

5. **ตัวเลขที่ต้องโชว์ให้ผู้ใช้เห็น** (ตรงกับ REPORT.md §3 — verified):
   - **76.1%** ของไม้ที่โดน SL ราคาวิ่งถึง TP1 ทีหลัง → SL แคบเกินคือศัตรู
   - **21%** ของ setup ราคาไปไม่ถึง entry → ต้องเตือนเรื่อง fill
   - SL เฉลี่ย **1.34%** แต่แท่ง 4h กว้าง **2.56%** → SL อยู่ในเขต noise (90.1% ของไม้แตะ SL ภายใน 60 แท่ง)
   - WR จริง **29%** · EV pooled **−0.08 ถึง −0.01%/ไม้** (≈ ศูนย์) · ถ่าง SL 20% → WR 73% แต่ EV **แย่ลง** (−0.25%)

## 3. สิ่งที่ทำเสร็จแล้ว: `srisiam-scanner.html`

ไฟล์ใหม่ใน repo root (ระดับเดียวกับ `scanner.html` เดิม) สถานะ: **เขียนเสร็จ + logic ผ่าน unit test แล้ว แต่ยังไม่ได้ทดสอบ live** (ต้องรันบนเครื่องที่ต่อ Binance ได้)

### Logic แกน — ฝังอยู่ใน `srisiam-scanner.html` แบบ self-contained
logic ทั้งหมดอยู่ inline ในไฟล์ html (ไม่ได้ import จากไฟล์อื่น) สอดคล้องกับสูตรที่ใช้ใน benchmark suite (`bench/benchmark.js` บน branch `strategy-benchmark`)
> หมายเหตุ: handoff ฉบับก่อนเขียนว่า "ยกมาจาก `bench/divchoch.js` verbatim" — **ไฟล์ชื่อนั้นไม่มีอยู่จริงในทุก branch** logic เป็นของจริงและครบถ้วน แต่ที่มาที่อ้างไว้ผิด อย่าไปตามหาไฟล์นั้น
- `confirmedPivots()` — fractal lookback 5 แท่ง, ยืนยัน 5 แท่งทีหลัง (กัน lookahead/repaint)
- alternating dedup — pivot ทิศเดียวกันเก็บตัวที่สุดกว่า
- divergence — 3 pivot ล่าสุด (p1=wave3, mid=wave4, p2=wave5), regular div + RSI(14)
- ความแรง: `ext = |mid−p2| / |mid−p1|` ต้อง ≥ 1.382 (STRONG ≥ 1.618)
- CHoCH: close ทะลุ wave4 ภายใน 80 แท่ง
- entry: limit ที่ retrace 38.2% ของ M1, รอ ≤ 60 แท่ง
- **SL = ยอด wave5 (structure stop)** · **TP = 100% of A (1× ระยะ M1)**

### ฟีเจอร์เพิ่มเติมใน scanner (นอกเหนือ logic แกน)
- `htfBias(candles1d)` — วัดทิศ degree ใหญ่จาก swing 1D (HH/HL=ขึ้น, LH/LL=ลง) **ผ่าน test แล้ว**
- near-miss tier — โชว์ setup ที่ ext อยู่ช่วง 1.20–1.382 (ยังไม่ถึงเกณฑ์) แต่ mark ชัดว่า "ต่ำกว่าเกณฑ์ ดูเฉยๆ"
- decision strip ต่อ setup: RR / SL-vs-ATR / เสี่ยงต่อไม้ % + flag เตือนตามตัวเลข backtest
- layout top-down: แถบ regime 1D บนสุด → การ์ดเรียง aligned-first

### ต่อข้อมูลยังไง
ใช้ `klaudFetch()` จาก `api-client.js` (ตัวเดียวกับ scanner เดิม):
```js
klaudFetch(`/api/candles/${sym}?interval=4h&limit=500`)  // setup
klaudFetch(`/api/candles/${sym}?interval=1d&limit=300`)  // degree ใหญ่
```
คืน `[{time,open,high,low,close,volume}]`

## 4. ⚠️ ปัญหาที่ค้างอยู่ — ต้องแก้ก่อน

**อาการ:** เปิดบนมือถือผ่าน Claude artifact viewer แล้วทุกค่าเป็น 0 หมด แถบ regime ว่างเปล่า

**สาเหตุ:** ทุก fetch โดน throw เข้า catch — เพราะ artifact sandbox / `file://` โหลด `api-client.js` ไม่ได้ หรือต่อ Binance ไม่ได้ (CORS) **ไม่ใช่ bug ใน logic**

**วิธีแก้/ทดสอบที่ถูกต้อง:**
- รัน `node server.js` แล้วเปิด `localhost:3000/srisiam-scanner.html` **หรือ**
- push ขึ้น GitHub Pages เปิดผ่าน `un100cc.github.io/NoteLM/srisiam-scanner.html`
- เปิดไฟล์ตรงๆ (`file://`) ไม่ทำงานแน่นอน

**งานแรกที่ Claude Code ควรทำ:** รันบนเครื่องที่ต่อ Binance ได้ เปิด DevTools Console เช็ค error ว่า:
1. `api-client.js` โหลดติดไหม (`klaudFetch` มีใน window ไหม)
2. `/api/candles/...` คืนข้อมูลหรือ throw
3. ถ้าใช้ผ่าน server.js ต้องเช็คว่า route `/api/candles/:symbol` มีจริง (ดู `api-client.js` บรรทัด ~85 `getCandles`)

## 5. งานที่เหลือ (ตามลำดับความสำคัญ)

### P0 — ทำให้ดึงข้อมูลได้จริง
แก้ปัญหาข้อ 4 ให้ scanner ดึง 1D + 4h ได้บนเครื่องจริง ยืนยันว่าแถบ regime 1D มีสีขึ้น และมีเหรียญแสดงทิศ

### P1 — ปุ่ม "บันทึกไม้นี้" → forward-test log
เหตุผล: backtest บอก EV≈0 บนข้อมูลอดีต ต้อง forward-test จริง (n=30–50) ก่อนเชื่อ
- เพิ่มปุ่มในการ์ด setup ที่ "พร้อมเข้า"
- เขียนเข้า `localStorage` key **`klaud_trade_log`** (ตัวเดียวกับ `log.html`)
- schema ที่ `log.html` ใช้ (ดู `log.html` ฟังก์ชัน `addLog`):
  ```js
  { id, date(ISO), sym, action('BUY'|'SELL'), setup, entry, tp, exit, pnl, note }
  ```
- เติม `setup: 'SRISIAM'`, `action` จากทิศ (bull→BUY/bear→SELL), entry/tp จากที่คำนวณ, `note` ใส่ grade + ext% + aligned/counter + RR + SL-vs-ATR เพื่อ audit ทีหลังว่า setup แบบไหน forward ได้จริง

### P2 — เก็บสถิติ forward แยกตามเงื่อนไข
ให้ `log.html` หรือ `stats.html` แยกผล forward ตาม: aligned vs counter-trend, STRONG vs MEDIUM div, SL-vs-ATR ≥1 vs <1 — เพื่อหาว่าเงื่อนไขไหนคุ้มจริงในตลาดปัจจุบัน (อันนี้คือ "ปรับให้คมขึ้น" ที่ไม่ overfit เพราะใช้ข้อมูล forward ใหม่ ไม่ใช่ tune บนอดีต)

### อย่าทำ (กับดัก overfit)
- ❌ อย่าลองค่า SL/entry/retrace ใหม่บนข้อมูลอดีตแล้วเลือกอันที่ TotalR สวยสุด
- ❌ อย่า implement TP matrix 4 แบบเป็นตัวปรับเป้า (correlation = −0.06)
- ❌ อย่าเพิ่ม indicator filter ใหม่เพื่อดันผล backtest (หมุนหมดแล้ว)

## 6. ไฟล์อ้างอิงใน repo
> ⚠️ ไฟล์ `bench/*` ทั้งหมดอยู่บน branch **`strategy-benchmark`** (ไม่ใช่ `main`) — `git checkout strategy-benchmark` ก่อนถึงจะเห็น

| ไฟล์ | branch | คืออะไร |
|---|---|---|
| `srisiam-scanner.html` | main | **scanner ใหม่ (งานหลัก)** — logic ฝัง inline ครบ |
| `bench/REPORT.md` | strategy-benchmark | **ผล backtest ฉบับเต็ม — อ่านก่อนแก้อะไร** |
| `bench/benchmark.js` | strategy-benchmark | replicate + แก้ bias + walk-forward + random baseline |
| `bench/ablation.js` | strategy-benchmark | EV decomposition + mechanism stats (ที่มาของเลข 76.1%/21%) |
| `bench/full-spec.js` | strategy-benchmark | doc filters + train/validation split (บทเรียน overfit) |
| `bench/sl-variants.js`, `wide-sl.js` | strategy-benchmark | ทดลอง SL placement / SL กว้าง |
| `bench/proven.js`, `cdc.js` | strategy-benchmark | กลยุทธ์ที่ work จริง (CDC/Donchian, daily) |
| `api-client.js` | main | `klaudFetch` + `getCandles` — วิธีดึงข้อมูล |
| `log.html` | main | trade log (`localStorage: klaud_trade_log`) — ปลายทางปุ่ม log |
| `scanner.html` | main | scanner เก่า (RSI+MACD+BB) — backtest พบว่าไม่มี edge, ใช้เทียบได้ |
| เอกสาร SRISIAM PDF | – | ต้นฉบับระบบ (เจ้าของมีไฟล์) |

> ❌ ไฟล์ `bench/divchoch.js` และ `bench/divmatrix.js` ที่ handoff ฉบับก่อนอ้าง **ไม่มีอยู่จริง** — ลบออกจากรายการแล้ว

## 7. สรุปหลักการใน 3 บรรทัด
1. Top-down: ทิศ 1D ก่อน → setup 4h ที่ align ก่อนตัวสวนเทรนด์
2. SL ที่ structure (wave5) ไม่ใช่ % คงที่ · TP 100 of A · โชว์ RR + SL-vs-ATR ให้ตัดสินใจ
3. ระบบนี้ EV≈0 บนอดีต → ใช้เป็นเครื่องมือช่วยตา + forward-test ก่อนเชื่อ ห้าม tune บนอดีต
