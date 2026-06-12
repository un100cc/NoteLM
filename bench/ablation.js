/**
 * Ablation study — decompose why corrected EV collapses vs the original
 * backtest, and locate the strategy's structural failure points.
 *
 * Chain (pooled over all 7 windows, 4h):
 *   S0 original sim, all setups            (= claimed numbers)
 *   S1 original sim, filled setups only    (removes phantom-fill wins)
 *   S2 corrected-opt, fee 0                (real fill timing + partial exits)
 *   S3 corrected-pess, fee 0               (SL priority on ambiguous bars)
 *   S4 corrected-pess, fee 0.1%            (costs)
 *
 * Plus mechanism stats: phantom-trade quality, stop-touch rate,
 * shaken-out rate (SL hit then price reaches TP1 anyway), win/loss
 * asymmetry, EV by direction.
 *
 * Run: node bench/ablation.js   (uses bench/cache — run benchmark.js first)
 */

const B = require('./benchmark.js');
const P = B.BASE_PARAMS;

function findFill(candles, s) {
  const bull = s.dir === 'bull';
  for (let i = s.retestIdx; i < Math.min(s.retestIdx + 40, candles.length); i++) {
    const c = candles[i];
    const structureBroken = bull
      ? c.low < s.m2Low * (1 - P.SL_BUFFER)
      : c.high > s.m2High * (1 + P.SL_BUFFER);
    const touched = bull ? c.low <= s.entryPrice : c.high >= s.entryPrice;
    if (touched) return i;
    if (structureBroken) return null;
  }
  return null;
}

const r2 = v => (Math.round(v * 100) / 100).toFixed(2);
const r1 = v => (Math.round(v * 10) / 10).toFixed(1);
const pad = (s, n) => String(s).padStart(n);

async function main() {
  const S = {
    s0: [], s1: [], s2: [], s3: [], s4: [],
    phantom: [],          // original-sim results of never-filled setups
    byDir: { bull: [], bear: [] },
  };
  let stopTouched = 0, filledN = 0, shakenOut = 0, slHitN = 0;
  const winSizes = [], lossSizes = [];

  for (const win of B.WINDOWS) {
    const cmap = await B.loadWindow('4h', win);
    for (const [sym, candles] of Object.entries(cmap)) {
      for (const s of B.findSetups(candles, P)) {
        const orig = B.simOriginal(candles, s);
        S.s0.push(orig);

        const fillIdx = findFill(candles, s);
        if (fillIdx === null) { S.phantom.push(orig); continue; }
        filledN++;
        S.s1.push(orig);

        const opt0 = B.simRealistic(candles, s, 0, { slPriority: false, exitModel: 'partial' });
        const pes0 = B.simRealistic(candles, s, 0, { slPriority: true, exitModel: 'partial' });
        const pes1 = B.simRealistic(candles, s, B.FEE_RT_PCT, { slPriority: true, exitModel: 'partial' });
        if (opt0) S.s2.push(opt0);
        if (pes0) S.s3.push(pes0);
        if (pes1) {
          S.s4.push(pes1);
          S.byDir[s.dir].push(pes1);
          if (pes1.pct > 0) winSizes.push(pes1.pct); else lossSizes.push(pes1.pct);
        }

        // mechanism stats from raw candles
        const bull = s.dir === 'bull';
        const end = Math.min(fillIdx + 60, candles.length);
        let slBar = null;
        for (let i = fillIdx; i < end; i++) {
          const c = candles[i];
          if (bull ? c.low <= s.sl : c.high >= s.sl) { slBar = i; break; }
        }
        if (slBar !== null) {
          stopTouched++;
          slHitN++;
          for (let i = slBar + 1; i < end; i++) {
            const c = candles[i];
            if (bull ? c.high >= s.tp1 : c.low <= s.tp1) { shakenOut++; break; }
          }
        }
      }
    }
  }

  const m = arr => B.metrics(arr);
  const steps = [
    ['S0 original (claimed)', m(S.s0)],
    ['S1 drop phantom fills', m(S.s1)],
    ['S2 + real fill/partial exits', m(S.s2)],
    ['S3 + SL priority (ambiguous)', m(S.s3)],
    ['S4 + fee 0.1%', m(S.s4)],
  ];
  console.log('═══ EV decomposition — pooled 7 windows, 4h ═══');
  console.log(`  ${'step'.padEnd(32)}${pad('n', 6)}${pad('WR%', 7)}${pad('EV%/tr', 8)}${pad('ΔEV', 7)}`);
  let prev = null;
  for (const [name, mm] of steps) {
    const d = prev === null ? '' : r2(mm.ev - prev);
    console.log(`  ${name.padEnd(32)}${pad(mm.n, 6)}${pad(r1(mm.wr), 7)}${pad(r2(mm.ev), 8)}${pad(d, 7)}`);
    prev = mm.ev;
  }

  const mp = m(S.phantom);
  console.log('\n═══ Mechanism stats ═══');
  console.log(`  Phantom setups (never fill @Fib50): ${mp.n} / ${S.s0.length} (${r1(mp.n / S.s0.length * 100)}%)`);
  console.log(`    their ORIGINAL-sim result       : WR ${r1(mp.wr)}%  EV ${r2(mp.ev)}%/trade  <- free wins removed`);
  console.log(`  Filled setups                     : ${filledN}`);
  console.log(`    stop-touch rate (SL hit ≤60bars): ${r1(stopTouched / filledN * 100)}%`);
  console.log(`    shaken out (SL hit, then TP1)   : ${shakenOut} / ${slHitN} = ${r1(shakenOut / slHitN * 100)}% of stop-outs`);
  const aw = winSizes.reduce((s, v) => s + v, 0) / (winSizes.length || 1);
  const al = lossSizes.reduce((s, v) => s + v, 0) / (lossSizes.length || 1);
  console.log(`  Corrected model win/loss sizes    : avg win +${r2(aw)}%  avg loss ${r2(al)}%  (ratio ${r2(aw / -al)})`);
  const mb = m(S.byDir.bull), ms = m(S.byDir.bear);
  console.log(`  By direction (S4): bull n=${mb.n} WR ${r1(mb.wr)}% EV ${r2(mb.ev)}%  |  bear n=${ms.n} WR ${r1(ms.wr)}% EV ${r2(ms.ev)}%`);

  // SL distance vs typical bar range — is the stop inside the noise band?
  let slDistSum = 0, atrSum = 0, cnt = 0;
  for (const win of B.WINDOWS) {
    const cmap = await B.loadWindow('4h', win);
    for (const [sym, candles] of Object.entries(cmap)) {
      for (const s of B.findSetups(candles, P)) {
        const fillIdx = findFill(candles, s);
        if (fillIdx === null) continue;
        const slDist = Math.abs(s.entryPrice - s.sl) / s.entryPrice * 100;
        const a = candles.slice(Math.max(0, fillIdx - 14), fillIdx)
          .reduce((sum, c) => sum + (c.high - c.low) / c.close * 100, 0) / 14;
        slDistSum += slDist; atrSum += a; cnt++;
      }
    }
  }
  console.log(`  Avg SL distance vs avg 4h bar range: ${r2(slDistSum / cnt)}% vs ${r2(atrSum / cnt)}%  (stop ≈ ${r2(slDistSum / atrSum)} bars of noise)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
