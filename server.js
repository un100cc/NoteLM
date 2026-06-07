const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');

// Fix MaxListenersExceededWarning
process.setMaxListeners(50);
require('events').EventEmitter.defaultMaxListeners = 50;

const app = express();
app.use(cors());
app.use(express.json());

// ─── Clean URL routes — ต้องอยู่ก่อน static middleware ───
['/', '/dashboard'].forEach(r => app.get(r, (_, res) => res.sendFile(path.join(__dirname, 'index.html'))));
['scanner', 'watchlist', 'strategy'].forEach(p =>
  app.get(`/${p}`, (_, res) => res.sendFile(path.join(__dirname, `${p}.html`)))
);

app.use(express.static(__dirname));

// ─── In-memory cache ───
const cache = new Map();
const CACHE_TTL = { analysis: 60000, candles: 30000, prices: 10000, gainers: 120000 };
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data, ttl) { cache.set(key, { data, ts: Date.now(), ttl }); }

// ─── TradingView MCP Bridge ───
const MCP_EXE = 'C:\\Users\\kingd\\.local\\bin\\tradingview-mcp.exe';
let mcpReady = false;
let msgId = 1;
const pending = {};
let buf = '';

const mcp = spawn(MCP_EXE, ['stdio'], { windowsHide: true });

mcp.stdout.on('data', data => {
  buf += data.toString();
  const lines = buf.split('\n');
  buf = lines.pop();
  lines.forEach(line => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending[msg.id]) {
        clearTimeout(pending[msg.id].timer);
        pending[msg.id].resolve(msg);
        delete pending[msg.id];
      }
    } catch(e) {}
  });
});

mcp.stderr.on('data', d => process.env.DEBUG && console.error('[MCP]', d.toString().trim()));
mcp.on('error', e => console.error('MCP spawn error:', e.message));

function callMCP(method, params = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const timer = setTimeout(() => {
      delete pending[id];
      reject(new Error('MCP timeout'));
    }, timeout);
    pending[id] = { resolve, timer };
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function initMCP() {
  try {
    await callMCP('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'klaud', version: '1.0' }
    }, 15000);
    mcpReady = true;
    console.log('✅ TradingView MCP ready');
    // Pre-warm: โหลด BTC ล่วงหน้าทันที
    warmCache();
  } catch(e) {
    console.error('MCP init failed:', e.message);
  }
}

// Pre-warm cache สำหรับเหรียญหลัก
const WARM_COINS = ['BTCUSDT','ETHUSDT','STXUSDT','XLMUSDT','SOLUSDT'];
async function warmCache() {
  console.log('🔥 Pre-warming cache...');
  for (const sym of WARM_COINS) {
    try {
      const result = await callMCP('tools/call', {
        name: 'coin_analysis',
        arguments: { symbol: sym, exchange: 'BINANCE', timeframe: '1h' }
      }, 30000);
      const content = result.result?.content?.[0]?.text;
      if (content) {
        const data = JSON.parse(content);
        setCache(`analysis:${sym}:1h`, data, CACHE_TTL.analysis);
        console.log(`  ✓ ${sym} cached`);
      }
    } catch(e) {
      console.log(`  ✗ ${sym} failed: ${e.message}`);
    }
  }
  console.log('✅ Cache warm complete');
}

// ─── Indicator calculations ───
function calcEMA(closes, period) {
  const k = 2 / (period + 1); let prev = null;
  return closes.map((c, i) => {
    if (i < period - 1) return null;
    if (prev === null) { prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period; return prev; }
    prev = c * k + prev * (1 - k); return prev;
  });
}
function calcRSI(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  const rsis = new Array(period).fill(null);
  for (let i = period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    rsis.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  }
  return rsis;
}
function calcBB(closes, period = 20, mult = 2) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const sl = closes.slice(i - period + 1, i + 1);
    const avg = sl.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(sl.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
    return { upper: avg + mult * std, middle: avg, lower: avg - mult * std, width: (2 * mult * std) / avg };
  }).filter(Boolean);
}
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaF = calcEMA(closes, fast).filter(Boolean);
  const emaS = calcEMA(closes, slow).filter(Boolean);
  const len = Math.min(emaF.length, emaS.length);
  const macdLine = emaF.slice(emaF.length - len).map((v, i) => v - emaS[emaS.length - len + i]);
  const sigLine = calcEMA(macdLine, signal).filter(Boolean);
  const hist = sigLine[sigLine.length - 1];
  const macd = macdLine[macdLine.length - 1];
  const sig = sigLine[sigLine.length - 1];
  return { macd_line: macd, signal_line: sig, histogram: macd - sig, crossover: (macd - sig) > 0 ? 'Bullish' : 'Bearish' };
}
function calcADX(candles, period = 14) {
  if (candles.length < period + 1) return { value: 0, trend_strength: 'Weak' };
  let plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < candles.length; i++) {
    const hi = candles[i].high, lo = candles[i].low, ph = candles[i-1].high, pl = candles[i-1].low, pc = candles[i-1].close;
    plusDM.push(hi - ph > pl - lo ? Math.max(hi - ph, 0) : 0);
    minusDM.push(pl - lo > hi - ph ? Math.max(pl - lo, 0) : 0);
    tr.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  const smTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  const smP = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const smM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const diP = smTR > 0 ? (smP / smTR) * 100 : 0;
  const diM = smTR > 0 ? (smM / smTR) * 100 : 0;
  const dx = (diP + diM) > 0 ? (Math.abs(diP - diM) / (diP + diM)) * 100 : 0;
  const adx = Math.round(dx);
  return {
    value: adx, plus_di: Math.round(diP * 10) / 10, minus_di: Math.round(diM * 10) / 10,
    trend_strength: adx > 50 ? 'Very Strong' : adx > 25 ? 'Strong' : 'Weak',
    di_signal: diP > diM ? 'Bullish (+DI > -DI)' : 'Bearish (-DI > +DI)'
  };
}

// ─── API: coin analysis — คำนวณจาก Binance candles ───
app.get('/api/analysis/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const { tf = '1h' } = req.query;
  const key = `analysis:${symbol}:${tf}`;
  const cached = getCache(key);
  if (cached) return res.json(cached);

  try {
    // ดึง candles จาก Binance
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=200`;
    const r = await fetch(url);
    const raw = await r.json();
    if (!Array.isArray(raw) || raw.length < 30) return res.status(404).json({ error: 'No candle data' });

    const candles = raw.map(k => ({ time: Math.floor(k[0]/1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    // Indicators
    const emas = {
      ema10: calcEMA(closes, 10).filter(Boolean).slice(-1)[0],
      ema20: calcEMA(closes, 20).filter(Boolean).slice(-1)[0],
      ema30: calcEMA(closes, 30).filter(Boolean).slice(-1)[0],
      ema50: calcEMA(closes, 50).filter(Boolean).slice(-1)[0],
      ema200: calcEMA(closes, 200).filter(Boolean).slice(-1)[0],
    };
    const rsiArr = calcRSI(closes, 14);
    const rsiVal = Math.round(rsiArr[rsiArr.length - 1] * 100) / 100;
    const rsiPrev = rsiArr[rsiArr.length - 2];
    const macd = calcMACD(closes);
    const bb = calcBB(closes).slice(-1)[0];
    const adx = calcADX(candles, 14);
    const changePercent = ((last.close - prev.close) / prev.close) * 100;

    // Bias
    const emaSignals = [emas.ema20, emas.ema50].filter(Boolean).map(e => last.close > e);
    const bullish = emaSignals.filter(Boolean).length;
    const bias = bullish >= 2 ? 'Bullish' : bullish === 0 ? 'Bearish' : 'Neutral';

    // Pivot — ใช้ candle ล่าสุด 5 ตัวคำนวณ S/R ที่ใกล้ราคาจริง
    const recent5 = candles.slice(-5);
    const pivotH = Math.max(...recent5.map(c => c.high));
    const pivotL = Math.min(...recent5.map(c => c.low));
    const pivot  = (pivotH + pivotL + last.close) / 3;
    // R1/S1 ต้องอยู่คนละฝั่งของราคาปัจจุบัน
    const r1 = Math.max(pivotH, last.close * 1.002);
    const s1 = Math.min(pivotL, last.close * 0.998);

    const data = {
      symbol: `BINANCE:${symbol}`,
      exchange: 'binance', timeframe: tf, timestamp: 'real-time',
      price_data: { current_price: last.close, open: last.open, high: last.high, low: last.low, close: last.close, change_percent: Math.round(changePercent * 1000) / 1000, volume: last.volume },
      rsi: { value: rsiVal, signal: rsiVal < 30 ? 'Oversold' : rsiVal > 70 ? 'Overbought' : 'Neutral', direction: rsiVal > rsiPrev ? 'Rising' : rsiVal < rsiPrev ? 'Falling' : 'Flat', previous: rsiPrev },
      macd: { ...macd },
      ema: emas,
      bollinger_bands: bb ? {
        upper:  Math.round(Math.max(bb.upper, bb.lower)*10000)/10000,
        middle: Math.round(bb.middle*10000)/10000,
        lower:  Math.round(Math.min(bb.upper, bb.lower)*10000)/10000,
        width:  Math.round(bb.width*10000)/10000,
        position: last.close > bb.middle ? 'Upper Half' : 'Lower Half'
      } : {},
      adx,
      support_resistance: {
        pivot:          Math.round(pivot*10000)/10000,
        resistance_1:   Math.round(r1*10000)/10000,
        resistance_2:   Math.round(r1*1.015*10000)/10000,
        support_1:      Math.round(s1*10000)/10000,
        support_2:      Math.round(s1*0.985*10000)/10000,
        nearest_resistance: Math.round(r1*10000)/10000,
        nearest_support:    Math.round(s1*10000)/10000,
      },
      stochastic: { k: Math.round(rsiVal), d: Math.round(rsiPrev || rsiVal) },
      market_structure: {
        trend: bias,
        trend_strength: adx.value > 50 ? 'Very Strong' : adx.value > 25 ? 'Strong' : 'Weak',
        candle: { type: last.close > last.open ? 'Bullish' : 'Bearish', body_ratio: Math.round(Math.abs(last.close - last.open) / (last.high - last.low) * 100) / 100 }
      },
      market_sentiment: { buy_sell_signal: macd.crossover === 'Bullish' && rsiVal > 50 ? 'BUY' : 'NEUTRAL', momentum: macd.histogram > 0 ? 'Bullish' : 'Bearish' },
      timeframe_context: {
        bias,
        bias_reasons: [
          last.close > (emas.ema20||0) ? `ราคาเหนือ EMA20 (${Math.round((emas.ema20||0)*10000)/10000})` : `ราคาใต้ EMA20 (${Math.round((emas.ema20||0)*10000)/10000})`,
          macd.crossover === 'Bullish' ? 'MACD Histogram Bullish' : 'MACD Histogram Bearish',
          rsiVal > 50 ? `RSI ${rsiVal} เหนือ 50` : `RSI ${rsiVal} ใต้ 50`,
        ],
        advice: bias === 'Bullish' ? 'รอ Retest EMA20 เพื่อเข้า Long — ท่ามาตรฐาน Shock Retest' : bias === 'Bearish' ? 'รอ Shock กลับขึ้นก่อน อย่าสวนเทรนด์' : 'Sideways รอ Breakout พร้อม Volume',
      },
      source: 'binance-calculated',
    };
    setCache(key, data, CACHE_TTL.analysis);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: top gainers ───
app.get('/api/gainers', async (req, res) => {
  const { exchange = 'BINANCE', tf = '1h', limit = 20 } = req.query;
  if (!mcpReady) return res.status(503).json({ error: 'MCP not ready' });
  try {
    const result = await callMCP('tools/call', {
      name: 'top_gainers',
      arguments: { exchange, timeframe: tf, limit: Number(limit) }
    });
    const content = result.result?.content?.[0]?.text;
    res.json(JSON.parse(content));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: volume breakout scanner ───
app.get('/api/breakout', async (req, res) => {
  const { exchange = 'BINANCE', tf = '1h' } = req.query;
  if (!mcpReady) return res.status(503).json({ error: 'MCP not ready' });
  try {
    const result = await callMCP('tools/call', {
      name: 'volume_breakout_scanner',
      arguments: { exchange, timeframe: tf, volume_multiplier: 1.5, price_change_min: 0.5, limit: 20 }
    });
    const content = result.result?.content?.[0]?.text;
    res.json(JSON.parse(content));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: multi timeframe ───
app.get('/api/mtf/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const { exchange = 'BINANCE' } = req.query;
  if (!mcpReady) return res.status(503).json({ error: 'MCP not ready' });
  try {
    const result = await callMCP('tools/call', {
      name: 'multi_timeframe_analysis',
      arguments: { symbol, exchange }
    });
    const content = result.result?.content?.[0]?.text;
    res.json(JSON.parse(content));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: candles from Binance (proxy to avoid CORS) ───
app.get('/api/candles/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const { interval = '1h', limit = 200 } = req.query;
  const key = `candles:${symbol}:${interval}`;
  const cached = getCache(key);
  if (cached) return res.json(cached);
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url);
    const data = await r.json();
    const candles = data.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
    }));
    setCache(key, candles, CACHE_TTL.candles);
    res.json(candles);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: prices ───
app.get('/api/prices', async (req, res) => {
  const syms = (req.query.symbols || '').split(',').filter(Boolean);
  if (!syms.length) return res.json([]);
  const key = `prices:${syms.join(',')}`;
  const cached = getCache(key);
  if (cached) return res.json(cached);
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=[${syms.map(s => `"${s}"`).join(',')}]`;
    const r = await fetch(url);
    const data = await r.json();
    setCache(key, data, CACHE_TTL.prices);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: MCP status ───
app.get('/api/status', (req, res) => res.json({ mcp: mcpReady, ts: new Date().toISOString() }));

const PORT = 3000;
app.listen(PORT, async () => {
  console.log(`🚀 KLAUD server → http://localhost:${PORT}`);
  await initMCP();
});
