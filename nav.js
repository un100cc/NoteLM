// Shared nav + market bar for all pages
const NAV_PAGES = [
  { label:'Dashboard', href:'index.html' },
  { label:'Scanner',   href:'scanner.html' },
  { label:'Watchlist', href:'watchlist.html' },
  { label:'Elliott',   href:'elliott.html' },
  { label:'EW',        href:'ew.html' },
  { label:'⚡ Shock',  href:'shockretest.html' },
  { label:'CDC',       href:'cdc.html' },
  { label:'Stats',     href:'stats.html' },
  { label:'Log',       href:'log.html' },
  { label:'Strategy',  href:'strategy.html' },
];

function buildNav(active) {
  const nav = document.getElementById('topbar-nav');
  NAV_PAGES.forEach(p => {
    const a = document.createElement('a');
    a.href = p.href;
    a.className = 'nav-item' + (p.label === active ? ' active' : '');
    a.textContent = p.label;
    nav.appendChild(a);
  });
}

async function fetchMarketBar() {
  const syms = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','SUIUSDT','STXUSDT'];
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=[' + syms.map(s=>`"${s}"`).join(',') + ']');
    const data = await res.json();
    const bar = document.getElementById('market-bar');
    if (!bar) return;
    bar.innerHTML = data.map(d => {
      const p = parseFloat(d.lastPrice);
      const chg = parseFloat(d.priceChangePercent);
      const sym = d.symbol.replace('USDT','');
      const fmtP = p >= 1000 ? '$'+p.toLocaleString('en',{maximumFractionDigits:2}) : p >= 1 ? '$'+p.toFixed(3) : '$'+p.toFixed(5);
      return `<div class="market-ticker">
        <span class="mt-sym">${sym}</span>
        <span class="mt-price">${fmtP}</span>
        <span class="mt-chg ${chg>=0?'up':'dn'}">${chg>=0?'▲':'▼'}${Math.abs(chg).toFixed(2)}%</span>
      </div>`;
    }).join('');
  } catch(e) {}
}
