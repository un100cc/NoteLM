/**
 * CDC ActionZone daily alert — checks the last CLOSED daily candle of all
 * 20 coins for a fresh BUY/SELL signal and sends a Telegram message.
 *
 * Designed for GitHub Actions cron (see .github/workflows/cdc-alert.yml)
 * but runs anywhere:  node alert/cdc-alert.js
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   TELEGRAM_CHAT_ID    — your chat id (message the bot, then check
 *                         https://api.telegram.org/bot<TOKEN>/getUpdates)
 * Without env vars it runs in dry-run mode (prints instead of sending).
 *
 * Data: data-api.binance.vision (official public market-data endpoint,
 * not geo-restricted) with api.binance.com fallback. Zero dependencies.
 */

const https = require('https');

const COINS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOTUSDT', 'LINKUSDT', 'AVAXUSDT', 'SUIUSDT',
  'STXUSDT', 'XLMUSDT', 'ICPUSDT', 'DOGEUSDT', 'APTUSDT', 'FETUSDT', 'RUNEUSDT', 'NEARUSDT', 'ATOMUSDT', 'LTCUSDT'];
const HOSTS = ['data-api.binance.vision', 'api.binance.com'];

function get(host, path) {
  return new Promise((resolve, reject) => {
    https.get({ host, path, timeout: 20000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`bad json from ${host} (${res.statusCode})`)); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchKlines(sym) {
  for (const host of HOSTS) {
    try {
      const raw = await get(host, `/api/v3/klines?symbol=${sym}&interval=1d&limit=120`);
      if (Array.isArray(raw)) return raw;
    } catch (e) { /* try next host */ }
  }
  throw new Error(`all hosts failed for ${sym}`);
}

function emaSeries(closes, n) {
  const out = new Array(closes.length); const k = 2 / (n + 1);
  let e = closes[0];
  for (let i = 0; i < closes.length; i++) { e = i === 0 ? e : closes[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

// Returns the signal fired on the LAST CLOSED candle, or null.
// Same alternating long/flat state machine as cdc.html / bench/cdc.js.
function todaySignal(candles) {
  const closes = candles.map(c => c.close);
  const fast = emaSeries(closes, 12), slow = emaSeries(closes, 26);
  let state = 0, prevGreen = false, prevRed = false, lastEvent = null;
  for (let i = 0; i < closes.length; i++) {
    const green = fast[i] > slow[i] && closes[i] > fast[i];
    const red = fast[i] < slow[i] && closes[i] < fast[i];
    if (i >= 30) {
      if (green && !prevGreen && state !== 1) { state = 1; lastEvent = { type: 'BUY', i, price: closes[i] }; }
      else if (red && !prevRed && state === 1) { state = 0; lastEvent = { type: 'SELL', i, price: closes[i] }; }
    }
    prevGreen = green; prevRed = red;
  }
  return lastEvent && lastEvent.i === closes.length - 1 ? lastEvent : null;
}

function sendTelegram(token, chatId, text) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`telegram ${res.statusCode}: ${d.slice(0, 200)}`)));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const fmtP = p => p >= 1000 ? '$' + Math.round(p).toLocaleString('en') : p >= 1 ? '$' + p.toFixed(3) : '$' + p.toFixed(5);

async function main() {
  const buys = [], sells = [], failed = [];
  let lastClosedDate = null;
  for (const sym of COINS) {
    try {
      const raw = await fetchKlines(sym);
      const candles = raw.slice(0, -1).map(k => ({ time: k[0], close: +k[4] })); // drop unclosed candle
      if (candles.length < 60) continue;
      lastClosedDate = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
      const sig = todaySignal(candles);
      if (sig) (sig.type === 'BUY' ? buys : sells).push({ sym: sym.replace('USDT', ''), price: sig.price });
      await new Promise(r => setTimeout(r, 150));
    } catch (e) { failed.push(sym); }
  }

  console.log(`Checked ${COINS.length - failed.length}/${COINS.length} coins (last closed: ${lastClosedDate})`);
  if (failed.length) console.log(`Failed: ${failed.join(', ')}`);

  if (!buys.length && !sells.length) {
    console.log('No new signals today — nothing to send.');
    return;
  }

  const lines = [`🚦 <b>CDC ActionZone — ${lastClosedDate}</b>`];
  if (buys.length) lines.push('', '🟢 <b>ซื้อ (แท่งเขียวแรก):</b>', ...buys.map(s => `  • ${s.sym} @ ${fmtP(s.price)}`));
  if (sells.length) lines.push('', '🔴 <b>ขาย (แท่งแดงแรก):</b>', ...sells.map(s => `  • ${s.sym} @ ${fmtP(s.price)}`));
  lines.push('', 'ทำที่ราคาตลาด แล้วบันทึกลง Log · อย่าลืม: ทำตามระบบ 100%');
  const msg = lines.join('\n');

  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    await sendTelegram(token, chatId, msg);
    console.log(`Sent: ${buys.length} BUY, ${sells.length} SELL`);
  } else {
    console.log('--- DRY RUN (no TELEGRAM_BOT_TOKEN/CHAT_ID) ---');
    console.log(msg.replace(/<\/?b>/g, ''));
  }
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
module.exports = { todaySignal, emaSeries, fetchKlines };
