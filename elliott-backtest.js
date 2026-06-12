// Backtest แก่นกลยุทธ์ 3-Swings/Shock-Retest ที่หน้า elliott.html ใช้
// วิธี (walk-forward, ไม่มี lookahead):
//   1) หา M1 = impulse leg จาก zigzag (p0 -> p1)
//   2) ตั้ง limit entry ที่ retrace 50% ของ M1  (ระดับรู้ล่วงหน้าหลัง M1 ยืนยัน)
//   3) SL = จุดเริ่ม M1 (p0)  →  risk = 0.5*M1
//   4) TP = 100% ของ M1 จาก entry  →  reward = M1   (RR ≈ 1:2)
//   5) เดินแท่งจริงหลัง p1: ราคา fill ที่ entry ไหม → แล้วโดน TP หรือ SL ก่อน
// หมายเหตุ: ถ้าราคาวิ่งหนีไม่ย่อมาที่ 50% = "ไม่เข้าไม้" (no fill) ไม่นับแพ้/ชนะ

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','SUIUSDT'];
const TFS = ['1h','4h','1d'];
const LIMIT = 1000;

function autoThreshold(cs){
  let tr=0;
  for(let i=1;i<cs.length;i++){const c=cs[i],p=cs[i-1];tr+=Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close));}
  const atr=tr/(cs.length-1), price=cs[cs.length-1].close||1;
  return Math.min(8,Math.max(1.2,+((atr/price)*100*3).toFixed(1)));
}
// zigzag คืน pivot สลับ high/low + index ของแท่งที่ "ยืนยัน" pivot (confirmIdx)
function zigzag(cs,pct){
  const th=pct/100;
  if(cs.length<3) return [];
  const piv=[{index:0,price:cs[0].close,confirm:0}];
  let trend=0,extIdx=0,extPx=cs[0].close;
  for(let i=1;i<cs.length;i++){
    const hi=cs[i].high,lo=cs[i].low;
    if(trend<=0 && hi>=extPx*(1+th)){ if(trend<0)piv.push({index:extIdx,price:extPx,confirm:i}); trend=1;extIdx=i;extPx=hi; }
    else if(trend>=0 && lo<=extPx*(1-th)){ if(trend>0)piv.push({index:extIdx,price:extPx,confirm:i}); trend=-1;extIdx=i;extPx=lo; }
    else if(trend>0){ if(hi>extPx){extPx=hi;extIdx=i;} }
    else if(trend<0){ if(lo<extPx){extPx=lo;extIdx=i;} }
    else { if(hi>extPx){extPx=hi;extIdx=i;} else if(lo<extPx){extPx=lo;extIdx=i;} }
  }
  return piv; // ไม่ push pivot ค้างตัวสุดท้าย (ยังไม่ยืนยัน) เพื่อเลี่ยง lookahead
}

async function fetchCandles(sym,tf){
  const url=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${LIMIT}`;
  const r=await fetch(url); const d=await r.json();
  if(!Array.isArray(d)) throw new Error(d.msg||'no data');
  return d.map(k=>({time:k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4]}));
}
function ema(cs,period){
  const k=2/(period+1); const out=new Array(cs.length); let e=cs[0].close;
  for(let i=0;i<cs.length;i++){ e=cs[i].close*k+e*(1-k); out[i]=e; } return out;
}
// avg single-candle range % → ใช้ตั้ง threshold ให้ใหญ่กว่า noise แท่งเดียว
function avgRangePct(cs){
  let s=0; for(const c of cs) s+=(c.high-c.low)/c.close; return s/cs.length*100;
}

// เดินแท่งหลัง confirm หา fill แล้วตัดสิน TP/SL
function simulate(cs, startIdx, dir, entry, stop, target){
  let filled=false;
  for(let i=startIdx;i<cs.length;i++){
    const c=cs[i];
    if(!filled){
      // ราคาวิ่งหนีถึง target ก่อน fill = พลาดไม้ (no trade)
      if(dir>0 && c.high>=target) return null;
      if(dir<0 && c.low<=target)  return null;
      if(dir>0 && c.low<=entry) filled=true;
      else if(dir<0 && c.high>=entry) filled=true;
      if(!filled) continue;
    }
    // หลัง fill: เช็ค SL ก่อน (อนุรักษ์นิยม) แล้ว TP
    if(dir>0){
      if(c.low<=stop)  return 'loss';
      if(c.high>=target) return 'win';
    }else{
      if(c.high>=stop) return 'loss';
      if(c.low<=target) return 'win';
    }
  }
  return filled ? 'open' : null; // open = เข้าไม้แล้วยังไม่จบ
}

function backtestSeries(cs, opts={}){
  // threshold: กัน noise → อย่างน้อย 2.5 เท่าของ range แท่งเดียว (เฉพาะโหมด filtered)
  let pct=autoThreshold(cs);
  if(opts.filter) pct=Math.max(pct, avgRangePct(cs)*2.5, 4);
  const piv=zigzag(cs, pct);
  const emaArr = opts.filter ? ema(cs,100) : null;
  const res={trades:0,wins:0,losses:0,open:0,nofill:0,rSum:0};
  for(let i=0;i+1<piv.length;i++){
    const p0=piv[i], p1=piv[i+1];
    const dir=Math.sign(p1.price-p0.price)||1;
    const M1=Math.abs(p1.price-p0.price);
    if(M1<=0) continue;

    if(opts.filter){
      // (1) M1 ต้องเป็น swing หลายแท่ง ไม่ใช่ spike แท่งเดียว
      if(p1.index - p0.index < 3) continue;
      // (2) เทรดตามเทรนด์ EMA100 ที่จุดยืนยัน M1
      const e=emaArr[p1.confirm];
      if(dir>0 && cs[p1.confirm].close < e) continue;   // long เฉพาะเหนือ EMA
      if(dir<0 && cs[p1.confirm].close > e) continue;   // short เฉพาะใต้ EMA
    }

    const entry  = p1.price - dir*M1*0.5;   // limit ที่ 50% retrace
    const stop   = p0.price;                 // invalidation
    const target = entry + dir*M1;           // 100% ของ M1 จาก entry
    const out=simulate(cs,p1.confirm,dir,entry,stop,target);
    if(out===null){res.nofill++;continue;}
    if(out==='open'){res.open++;continue;}
    res.trades++;
    if(out==='win'){res.wins++;res.rSum+=2;} else {res.losses++;res.rSum-=1;}
  }
  return res;
}

function summarize(label, a){
  const wr=a.trades?100*a.wins/a.trades:0, exp=a.trades?a.rSum/a.trades:0;
  console.log(`\n${label}`);
  console.log(`  ไม้จริง ${a.trades} (ชนะ ${a.wins}/แพ้ ${a.losses}) · ไม่ fill ${a.nofill} · ค้าง ${a.open}`);
  console.log(`  ✅ Win rate ${wr.toFixed(1)}%   📈 Expectancy ${exp.toFixed(3)}R/ไม้   💰 รวม ${a.rSum.toFixed(0)}R`);
}

(async()=>{
  console.log('Backtest 3-Swings (entry 50% retrace · SL=origin · TP=100% M1 · RR 1:2 · breakeven 33.3%)');
  console.log(`เหรียญ ${SYMBOLS.length} · TF ${TFS.join('/')} · ${LIMIT} แท่ง/ชุด · ข้อมูล Binance จริง`);
  const raw={trades:0,wins:0,losses:0,open:0,nofill:0,rSum:0};
  const flt={trades:0,wins:0,losses:0,open:0,nofill:0,rSum:0};
  const fltByTf={};
  for(const tf of TFS){
    fltByTf[tf]={trades:0,wins:0,rSum:0};
    for(const sym of SYMBOLS){
      try{
        const cs=await fetchCandles(sym,tf);
        const r0=backtestSeries(cs,{filter:false});
        const r1=backtestSeries(cs,{filter:true});
        for(const k in raw) raw[k]+=r0[k];
        for(const k in flt) flt[k]+=r1[k];
        fltByTf[tf].trades+=r1.trades; fltByTf[tf].wins+=r1.wins; fltByTf[tf].rSum+=r1.rSum;
        await new Promise(x=>setTimeout(x,120));
      }catch(e){ console.log('  skip',sym,tf,e.message); }
    }
  }
  console.log('\n════════ A) กลไกล้วน — เทรดทุก swing (ไม่กรอง) ════════');
  summarize('รวมทั้งหมด:', raw);
  console.log('\n════════ B) กรองตาม KB — ตามเทรนด์ EMA100 + swing สะอาด + กัน noise ════════');
  for(const tf of TFS){ const t=fltByTf[tf]; console.log(`  [${tf}] trades ${t.trades} · win ${t.trades?(100*t.wins/t.trades).toFixed(1):0}% · exp ${t.trades?(t.rSum/t.trades).toFixed(3):0}R`); }
  summarize('รวมทั้งหมด:', flt);
})();
