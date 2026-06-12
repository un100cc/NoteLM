// Client-side API — ports server.js endpoints so the site runs on GitHub Pages (no backend).
// Pages call klaudFetch() with the same URLs they used against localhost:3000;
// the path after /api is parsed and served from Binance + local computation.
(function () {
  const BINANCE = 'https://api.binance.com/api/v3';

  // ─── In-memory cache (mirrors server.js TTLs) ───
  const cache = new Map();
  const CACHE_TTL = { analysis: 60000, candles: 30000, prices: 10000 };
  function getCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > entry.ttl) { cache.delete(key); return null; }
    return entry.data;
  }
  function setCache(key, data, ttl) { cache.set(key, { data, ts: Date.now(), ttl }); }

  // ─── Indicator calculations (ported from server.js) ───
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

  // ─── Route: /candles/:symbol ───
  async function getCandles(symbol, interval = '1h', limit = 200) {
    const key = `candles:${symbol}:${interval}:${limit}`;
    const cached = getCache(key);
    if (cached) return cached;
    const r = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const data = await r.json();
    const candles = data.map(k => ({
      time: Math.floor(k[0] / 1000),
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
    }));
    setCache(key, candles, CACHE_TTL.candles);
    return candles;
  }

  // ─── Route: /prices ───
  async function getPrices(symbols) {
    const syms = symbols.filter(Boolean);
    if (!syms.length) return [];
    const key = `prices:${syms.join(',')}`;
    const cached = getCache(key);
    if (cached) return cached;
    const r = await fetch(`${BINANCE}/ticker/24hr?symbols=[${syms.map(s => `"${s}"`).join(',')}]`);
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const data = await r.json();
    setCache(key, data, CACHE_TTL.prices);
    return data;
  }

  // ─── Route: /analysis/:symbol ───
  async function getAnalysis(symbol, tf = '1h') {
    const key = `analysis:${symbol}:${tf}`;
    const cached = getCache(key);
    if (cached) return cached;

    const raw = await fetch(`${BINANCE}/klines?symbol=${symbol}&interval=${tf}&limit=200`).then(r => r.json());
    if (!Array.isArray(raw) || raw.length < 30) throw new Error('No candle data');

    const candles = raw.map(k => ({ time: Math.floor(k[0]/1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    const closes = candles.map(c => c.close);
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

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

    const emaSignals = [emas.ema20, emas.ema50].filter(Boolean).map(e => last.close > e);
    const bullish = emaSignals.filter(Boolean).length;
    const bias = bullish >= 2 ? 'Bullish' : bullish === 0 ? 'Bearish' : 'Neutral';

    const recent5 = candles.slice(-5);
    const pivotH = Math.max(...recent5.map(c => c.high));
    const pivotL = Math.min(...recent5.map(c => c.low));
    const pivot  = (pivotH + pivotL + last.close) / 3;
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
      source: 'binance-client',
    };

    const isBull = bias === 'Bullish';
    const pullbackEntry = isBull
      ? Math.round((emas.ema20 || s1) * 10000) / 10000
      : Math.round(r1 * 10000) / 10000;
    const breakoutEntry = isBull
      ? Math.round(r1 * 10000) / 10000
      : Math.round(s1 * 10000) / 10000;
    const stopLoss = isBull
      ? Math.round(Math.min(s1, pullbackEntry * 0.985) * 10000) / 10000
      : Math.round(Math.max(r1, pullbackEntry * 1.015) * 10000) / 10000;
    const slDist = Math.abs(pullbackEntry - stopLoss);
    const tp1 = isBull
      ? Math.round((pullbackEntry + slDist * 1.5) * 10000) / 10000
      : Math.round((pullbackEntry - slDist * 1.5) * 10000) / 10000;
    const tp2 = isBull
      ? Math.round((pullbackEntry + slDist * 2.5) * 10000) / 10000
      : Math.round((pullbackEntry - slDist * 2.5) * 10000) / 10000;
    const slPct = Math.round(Math.abs((stopLoss - pullbackEntry) / pullbackEntry) * 10000) / 100;

    data.trade_setup = {
      setup_types: isBull ? ['pullback', 'breakout'] : ['pullback'],
      entry_points: { pullback_entry: pullbackEntry, breakout_entry: breakoutEntry },
      stop_loss: stopLoss,
      stop_distance_pct: slPct,
      targets: { target_1: tp1, target_2: tp2 },
      risk_reward: { to_target_1: 1.5, to_target_2: 2.5, quality: 'Good' },
      supports: [Math.round(s1*10000)/10000, Math.round(s1*0.985*10000)/10000],
      resistances: [Math.round(r1*10000)/10000, Math.round(r1*1.015*10000)/10000],
      trade_notes: [
        isBull ? 'รอ Retest EMA20 เป็น Entry (Pullback)' : 'รอ Bounce จาก S1 ก่อนเข้า',
        `SL ไว้ใต้ S1 ห่าง ${slPct}%`,
        `TP1 : TP2 = 1.5R : 2.5R`,
      ],
    };
    data.trade_quality = slPct < 3 ? 'Good Setup' : slPct < 6 ? 'Normal Setup' : 'Wide Stop';
    data.trade_quality_score = slPct < 3 ? 70 : 55;

    setCache(key, data, CACHE_TTL.analysis);
    return data;
  }

  // ─── Fetch-compatible entry point ───
  // Accepts the same URLs pages built for the old backend (http://localhost:3000/api/...)
  // and returns a Response-like object: { ok, status, json() }.
  window.klaudFetch = async function (url) {
    const u = new URL(url, location.origin);
    const path = u.pathname.replace(/^.*\/api/, '');
    const respond = data => ({ ok: true, status: 200, json: async () => data });
    const fail = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

    try {
      let m;
      if ((m = path.match(/^\/candles\/([A-Z0-9]+)$/i))) {
        return respond(await getCandles(m[1], u.searchParams.get('interval') || '1h', u.searchParams.get('limit') || 200));
      }
      if ((m = path.match(/^\/analysis\/([A-Z0-9]+)$/i))) {
        return respond(await getAnalysis(m[1], u.searchParams.get('tf') || '1h'));
      }
      if (path === '/prices') {
        return respond(await getPrices((u.searchParams.get('symbols') || '').split(',')));
      }
      if (path === '/status') {
        return respond({ mcp: false, ts: new Date().toISOString() });
      }
      // /tv-analysis, /gainers, /breakout, /mtf need the TradingView MCP backend
      return fail(503, 'endpoint requires local server (server.js)');
    } catch (e) {
      return fail(500, e.message);
    }
  };
})();
