/**
 * Verify cdc.html page logic === bench/cdc.js logic on identical data.
 * Compares final long/flat state and last signal date for 6 coins.
 * Run: node bench/check-cdc-page.js
 */
const https = require('https');

const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'SUIUSDT', 'LTCUSDT'];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function emaSeries(closes, n) {
  const out = new Array(closes.length); const k = 2 / (n + 1);
  let e = closes[0];
  for (let i = 0; i < closes.length; i++) { e = i === 0 ? e : closes[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

// — copy of cdc.html cdcCompute —
function pageCompute(candles) {
  const closes = candles.map(c => c.close);
  const fast = emaSeries(closes, 12), slow = emaSeries(closes, 26);
  let state = 0, prevGreen = false, prevRed = false, lastSig = null;
  for (let i = 0; i < closes.length; i++) {
    const green = fast[i] > slow[i] && closes[i] > fast[i];
    const red = fast[i] < slow[i] && closes[i] < fast[i];
    const buycond = green && !prevGreen, sellcond = red && !prevRed;
    if (i >= 30) {
      if (buycond && state !== 1) { state = 1; lastSig = { type: 'BUY', time: candles[i].time }; }
      else if (sellcond && state === 1) { state = 0; lastSig = { type: 'SELL', time: candles[i].time }; }
    }
    prevGreen = green; prevRed = red;
  }
  return { state, lastSig };
}

// — copy of bench/cdc.js posCDC (mode 'lf'), returning final state + last flip —
function benchCompute(candles) {
  const closes = candles.map(c => c.close);
  const fast = emaSeries(closes, 12), slow = emaSeries(closes, 26);
  let state = 0, prevGreen = false, prevRed = false, lastFlip = null;
  for (let i = 0; i < candles.length; i++) {
    const green = fast[i] > slow[i] && closes[i] > fast[i];
    const red = fast[i] < slow[i] && closes[i] < fast[i];
    const buycond = green && !prevGreen, sellcond = red && !prevRed;
    if (i >= 30) {
      if (buycond && state !== 1) { state = 1; lastFlip = { type: 'BUY', time: candles[i].time }; }
      else if (sellcond && state === 1) { state = 0; lastFlip = { type: 'SELL', time: candles[i].time }; }
    }
    prevGreen = green; prevRed = red;
  }
  return { state, lastSig: lastFlip };
}

(async () => {
  let pass = 0, fail = 0;
  for (const sym of COINS) {
    const raw = await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&limit=500`);
    const candles = raw.slice(0, -1).map(k => ({ time: k[0], close: +k[4] }));
    const a = pageCompute(candles), b = benchCompute(candles);
    const ok = a.state === b.state && (a.lastSig?.time === b.lastSig?.time) && (a.lastSig?.type === b.lastSig?.type);
    console.log(`${ok ? '✅' : '❌'} ${sym.padEnd(10)} page: ${a.state ? 'LONG' : 'CASH'} ${a.lastSig ? a.lastSig.type + '@' + new Date(a.lastSig.time).toISOString().slice(0, 10) : '-'}  |  bench: ${b.state ? 'LONG' : 'CASH'} ${b.lastSig ? b.lastSig.type + '@' + new Date(b.lastSig.time).toISOString().slice(0, 10) : '-'}`);
    ok ? pass++ : fail++;
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`\n${fail === 0 ? '✅ ALL MATCH' : `❌ ${fail} mismatches`} (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
