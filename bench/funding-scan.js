/**
 * Funding-arb scanner — Hyperliquid vs Binance USDT-perp funding rates.
 * Read-only public APIs, no keys, zero dependencies.
 *
 * The trade this surfaces (delta-neutral): when venue A pays meaningfully
 * more funding than venue B for the same coin, short the rich side / long
 * the cheap side and collect the spread while price exposure nets to zero.
 * This is the "structural edge" family — profit from market plumbing,
 * not from predicting direction.
 *
 * HONEST CAVEATS (read before dreaming):
 *  - Funding changes every hour (HL) / 8h (Binance); a fat spread can
 *    vanish before you finish opening both legs
 *  - You pay taker fees + slippage on 2 venues x 2 legs (entry+exit)
 *  - Spread must persist long enough to beat ~0.2-0.3% round-trip cost
 *  - Liquidation risk on the short leg if price moves fast and margin is thin
 *  - This scanner is a RESEARCH STARTING POINT, not a signal to trade
 *
 * Run: node bench/funding-scan.js
 */

const https = require('https');

const MIN_HL_VOLUME = 5_000_000; // skip markets thinner than $5M/day

function post(host, path, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path, method: 'POST', timeout: 20000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(data);
  });
}
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const pct = v => (v * 100).toFixed(2) + '%';
const pad = (s, n) => String(s).padStart(n);
const padE = (s, n) => String(s).padEnd(n);

async function main() {
  console.log('Fetching Hyperliquid + Binance funding...\n');
  const [hl, bn] = await Promise.all([
    post('api.hyperliquid.xyz', '/info', { type: 'metaAndAssetCtxs' }),
    get('https://fapi.binance.com/fapi/v1/premiumIndex'),
  ]);

  const [meta, ctxs] = hl;
  const bnMap = new Map(bn.map(r => [r.symbol, +r.lastFundingRate]));

  const rows = [];
  meta.universe.forEach((u, i) => {
    if (u.isDelisted) return;
    const ctx = ctxs[i];
    const vol = +ctx.dayNtlVlm;
    if (vol < MIN_HL_VOLUME) return;
    const bnRate8h = bnMap.get(u.name + 'USDT');
    if (bnRate8h === undefined) return;
    const hlApr = +ctx.funding * 24 * 365;        // HL funding is hourly
    const bnApr = bnRate8h * 3 * 365;             // Binance funding is per-8h
    rows.push({
      coin: u.name, hlApr, bnApr, spread: hlApr - bnApr,
      mark: +ctx.markPx, oi: +ctx.openInterest * +ctx.markPx, vol,
    });
  });

  rows.sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));

  console.log(`  ${padE('coin', 8)}${pad('HL APR', 10)}${pad('BN APR', 10)}${pad('spread APR', 12)}${pad('HL OI $M', 10)}${pad('HL vol $M', 11)}  direction (collect spread)`);
  console.log(`  ${'-'.repeat(88)}`);
  for (const r of rows.slice(0, 15)) {
    const dir = r.spread > 0 ? 'short HL / long BN' : 'long HL / short BN';
    console.log(`  ${padE(r.coin, 8)}${pad(pct(r.hlApr), 10)}${pad(pct(r.bnApr), 10)}${pad(pct(r.spread), 12)}${pad((r.oi / 1e6).toFixed(1), 10)}${pad((r.vol / 1e6).toFixed(1), 11)}  ${dir}`);
  }

  const fat = rows.filter(r => Math.abs(r.spread) > 0.10);
  console.log(`\n  ${rows.length} markets compared · ${fat.length} with |spread| > 10% APR`);
  console.log('  ⚠️  snapshot only — rates reset hourly. Verify persistence over days');
  console.log('     (node bench/funding-scan.js ซ้ำๆ หรือเก็บ log) ก่อนคิดเรื่องเงินจริง');
  console.log('     และอ่าน caveats ในหัวไฟล์นี้ก่อน — fee สองขา + liquidation risk เป็นของจริง');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
