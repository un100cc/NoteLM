/**
 * Root-cause confirmation: is the tight SL (Fib 61.8% + 0.5%) the killer?
 * Compare SL placements, pooled 7 windows, 4h, corrected-pess + fee.
 *   A. fib618 + 0.5% buffer   (current code)
 *   B. fib618 + 1.5% buffer   (wider buffer)
 *   C. structure stop: M2 extreme + 0.5%  (what the strategy doc prescribes)
 * R:R filter (>=1.5 vs TP2) is recomputed against each SL so setup
 * selection stays internally consistent.
 *
 * Run: node bench/sl-variants.js
 */

const B = require('./benchmark.js');
const P = B.BASE_PARAMS;

const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const pad = (s, n) => String(s).padStart(n);

function withSL(s, variant) {
  const bull = s.dir === 'bull';
  const L = s.m1.length;
  const fib618 = bull ? s.m1.endPrice - 0.618 * L : s.m1.endPrice + 0.618 * L;
  let sl;
  if (variant === 'A') sl = bull ? fib618 * (1 - 0.005) : fib618 * (1 + 0.005);
  if (variant === 'B') sl = bull ? fib618 * (1 - 0.015) : fib618 * (1 + 0.015);
  if (variant === 'C') sl = bull ? s.m2Low * (1 - 0.005) : s.m2High * (1 + 0.005);
  const rr = bull ? (s.tp2 - s.entryPrice) / (s.entryPrice - sl)
                  : (s.entryPrice - s.tp2) / (sl - s.entryPrice);
  if (!(rr > 0) || rr < P.RR_MIN) return null;
  return { ...s, sl };
}

async function main() {
  const variants = { A: [], B: [], C: [] };
  const rows = { A: 'fib618+0.5% (current)', B: 'fib618+1.5%', C: 'M2 structure+0.5% (per doc)' };
  for (const win of B.WINDOWS) {
    const cmap = await B.loadWindow('4h', win);
    for (const [sym, candles] of Object.entries(cmap)) {
      for (const s of B.findSetups(candles, P)) {
        for (const v of ['A', 'B', 'C']) {
          const sv = withSL(s, v);
          if (!sv) continue;
          const r = B.simRealistic(candles, sv, B.FEE_RT_PCT, { slPriority: true, exitModel: 'partial' });
          if (r) variants[v].push(r);
        }
      }
    }
  }
  console.log('═══ SL placement variants — pooled 7 windows, 4h, corrected-pess + fee ═══');
  console.log(`  ${'variant'.padEnd(30)}${pad('n', 6)}${pad('WR%', 7)}${pad('EV%/tr', 8)}${pad('PF', 6)}${pad('EV 95%CI', 18)}`);
  for (const v of ['A', 'B', 'C']) {
    const m = B.metrics(variants[v]);
    const ci = B.bootstrapCI(variants[v]);
    console.log(`  ${rows[v].padEnd(30)}${pad(m.n, 6)}${pad(r1(m.wr), 7)}${pad(r2(m.ev), 8)}${pad(r2(m.pf), 6)}${pad(`[${r2(ci[0])},${r2(ci[1])}]`, 18)}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
