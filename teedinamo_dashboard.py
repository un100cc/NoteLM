import firebirdsql
import json
import re
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
import webbrowser
import threading

LOG_PATH = r'C:\SeniorSoft ProMaxx\logfile.txt'

def get_logs(limit=200):
    try:
        with open(LOG_PATH, encoding='utf-8-sig', errors='replace') as f:
            lines = f.readlines()
        entries = []
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            m = re.search(
                r'Commit SYSTRANNO\s*=\s*(\d+).*?TRANNO\s*=\s*(\S+).*?EMPID\s*=\s*(\d+).*?TIME\s*=\s*([^\s]+ [^\s]+)',
                line
            )
            if m:
                entries.append({
                    'type': 'commit',
                    'systranno': m.group(1),
                    'tranno': m.group(2),
                    'empid': m.group(3),
                    'time': m.group(4),
                    'raw': line,
                })
            else:
                entries.append({'type': 'raw', 'raw': line})
            if len(entries) >= limit:
                break
        return entries
    except Exception as e:
        return [{'type': 'error', 'raw': str(e)}]

DB_HOST = 'localhost'
DB_PORT = 3050
DB_PATH = r'C:\SeniorSoft ProMaxx\FBMAXX.FDB'
DB_USER = 'SYSDBA'
DB_PASSWORD = 'masterkey'

def get_data():
    con = firebirdsql.connect(
        host=DB_HOST, port=DB_PORT,
        database=DB_PATH,
        user=DB_USER, password=DB_PASSWORD
    )
    cur = con.cursor()

    # ยอดขายวันนี้
    cur.execute("""
        SELECT COALESCE(SUM(GRANDTOTAL), 0), COUNT(*)
        FROM TRANS
        WHERE CAST(TRANDATE AS DATE) = CAST(CURRENT_DATE AS DATE)
        AND FCANCEL = 0
    """)
    row = cur.fetchone()
    today_sales = float(row[0] or 0)
    today_bills = int(row[1] or 0)

    # ยอดขาย 30 วันย้อนหลัง
    cur.execute("""
        SELECT CAST(TRANDATE AS DATE) as D, COALESCE(SUM(GRANDTOTAL), 0)
        FROM TRANS
        WHERE TRANDATE >= CURRENT_DATE - 30
        AND FCANCEL = 0
        GROUP BY CAST(TRANDATE AS DATE)
        ORDER BY D
    """)
    sales_30d = [{'date': str(r[0]), 'total': float(r[1] or 0)} for r in cur.fetchall()]

    # ยอดขายเดือนนี้
    cur.execute("""
        SELECT COALESCE(SUM(GRANDTOTAL), 0)
        FROM TRANS
        WHERE EXTRACT(MONTH FROM TRANDATE) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(YEAR FROM TRANDATE) = EXTRACT(YEAR FROM CURRENT_DATE)
        AND FCANCEL = 0
    """)
    month_sales = float(cur.fetchone()[0] or 0)

    # stock ทั้งหมด
    cur.execute("""
        SELECT I.ITEMID, I.ITEMNAME,
               COALESCE(
                   (SELECT FIRST 1 C.BALANCEQUANTITY
                    FROM CALCAVG C
                    WHERE C.SYSITEMID = I.SYSITEMID
                    ORDER BY C.SEGMENTS DESC),
                   (SELECT SUM(CASE T.TRANSOURCE
                                   WHEN 'U' THEN D.BASEQUANTITY
                                   WHEN 'P' THEN -D.BASEQUANTITY
                                   ELSE 0
                               END)
                    FROM TRANDETAILITEM D
                    JOIN TRANS T ON T.SYSTRANNO = D.SYSTRANNO
                    WHERE D.SYSITEMID = I.SYSITEMID AND T.FCANCEL = 0),
                   0
               ) AS STOCK,
               COALESCE(I.ESTIMATECOST, 0) AS COST
        FROM ITEMS I
        WHERE I.FUSED = 1 AND I.FEFFECTSTOCK = 1
        ORDER BY STOCK ASC
    """)
    all_stock = []
    for r in cur.fetchall():
        all_stock.append({
            'itemid': str(r[0] or '').strip(),
            'itemname': str(r[1] or '').strip(),
            'stock': float(r[2] or 0),
            'cost': float(r[3] or 0)
        })

    # สินค้าขายดี 7 วันล่าสุด
    cur.execute("""
        SELECT I.ITEMNAME, COALESCE(SUM(D.QUANTITY), 0) AS QTY, COALESCE(SUM(D.AMOUNT), 0) AS AMT
        FROM TRANDETAILITEM D
        JOIN ITEMS I ON I.SYSITEMID = D.SYSITEMID
        JOIN TRANS T ON T.SYSTRANNO = D.SYSTRANNO
        WHERE T.TRANDATE >= CURRENT_DATE - 7
        AND T.FCANCEL = 0
        GROUP BY I.ITEMNAME
        ORDER BY QTY DESC
        ROWS 10
    """)
    top_items = []
    for r in cur.fetchall():
        top_items.append({
            'name': str(r[0] or '').strip(),
            'qty': float(r[1] or 0),
            'amt': float(r[2] or 0)
        })

    # บิลวันนี้ทั้งหมด
    cur.execute("""
        SELECT T.SYSTRANNO, T.TRANNO,
               CAST(T.TRANDATE AS TIME) AS TRANTIME,
               T.GRANDTOTAL,
               T.TOTALPAYBYCASH, T.TOTALPAYBYTRANFER,
               T.TOTALPAYBYCREDITCARD, T.TOTALPAYBYCASHCARD,
               T.TOTALWITHHOLDINGTAX
        FROM TRANS T
        WHERE CAST(T.TRANDATE AS DATE) = CAST(CURRENT_DATE AS DATE)
        AND T.FCANCEL = 0
        ORDER BY T.TRANDATE ASC
    """)
    today_bills_list = []
    for r in cur.fetchall():
        pay_methods = []
        if float(r[4] or 0) > 0: pay_methods.append('เงินสด')
        if float(r[5] or 0) > 0: pay_methods.append('โอน')
        if float(r[6] or 0) > 0: pay_methods.append('บัตรเครดิต')
        if float(r[7] or 0) > 0: pay_methods.append('บัตรเงินสด')
        if not pay_methods: pay_methods.append('เงินสด')
        today_bills_list.append({
            'systranno': int(r[0]),
            'tranno': str(r[1] or '').strip(),
            'time': str(r[2])[:5] if r[2] else '',
            'grandtotal': float(r[3] or 0),
            'payment': ', '.join(pay_methods),
        })

    # รายการสินค้าในแต่ละบิลวันนี้
    if today_bills_list:
        systranno_list = ','.join(str(b['systranno']) for b in today_bills_list)
        cur.execute(f"""
            SELECT D.SYSTRANNO, D.ITEMNAME, D.QUANTITY, D.PRICE, D.DISCOUNT, D.AMOUNT
            FROM TRANDETAILITEM D
            WHERE D.SYSTRANNO IN ({systranno_list})
            ORDER BY D.SYSTRANNO, D.DETAILNO
        """)
        bill_items = {}
        for r in cur.fetchall():
            sno = int(r[0])
            if sno not in bill_items:
                bill_items[sno] = []
            bill_items[sno].append({
                'name': str(r[1] or '').strip(),
                'qty': float(r[2] or 0),
                'price': float(r[3] or 0),
                'discount': float(r[4] or 0),
                'amount': float(r[5] or 0),
            })
        for b in today_bills_list:
            b['items'] = bill_items.get(b['systranno'], [])

    con.close()
    return {
        'today_sales': today_sales,
        'today_bills': today_bills,
        'month_sales': month_sales,
        'sales_30d': sales_30d,
        'all_stock': all_stock,
        'top_items': top_items,
        'today_bills_list': today_bills_list,
        'updated': datetime.now().strftime('%d/%m/%Y %H:%M:%S')
    }

HTML = """<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TeeDinamo Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700&family=Prompt:wght@400;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0f1117; --card: #1a1d27; --card2: #222536;
    --accent: #f59e0b; --accent2: #10b981; --accent3: #3b82f6;
    --danger: #ef4444; --text: #f1f5f9; --muted: #94a3b8; --border: #2d3148;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:var(--bg); color:var(--text); font-family:'Sarabun',sans-serif; min-height:100vh; }

  /* NAV TABS */
  .header { background:#1a1d27; border-bottom:1px solid var(--border); padding:16px 32px; display:flex; align-items:center; justify-content:space-between; }
  .logo { font-family:'Prompt',sans-serif; font-weight:800; font-size:22px; color:var(--accent); }
  .logo span { color:var(--text); }
  .updated { font-size:12px; color:var(--muted); margin-top:2px; }
  .nav { display:flex; gap:4px; background:#0f1117; border-bottom:1px solid var(--border); padding:0 32px; }
  .nav-btn { padding:12px 20px; font-family:'Sarabun',sans-serif; font-size:14px; font-weight:600; color:var(--muted); background:none; border:none; border-bottom:2px solid transparent; cursor:pointer; transition:all 0.2s; }
  .nav-btn:hover { color:var(--text); }
  .nav-btn.active { color:var(--accent); border-bottom-color:var(--accent); }
  .refresh-btn { background:var(--accent); color:#000; border:none; padding:7px 16px; border-radius:8px; font-family:'Sarabun',sans-serif; font-weight:600; font-size:13px; cursor:pointer; }
  .refresh-btn:hover { opacity:0.85; }

  /* PAGES */
  .page { display:none; padding:24px 32px; max-width:1400px; margin:0 auto; }
  .page.active { display:block; }

  /* CARDS */
  .grid-3 { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin-bottom:20px; }
  .grid-12 { display:grid; grid-template-columns:2fr 1fr; gap:16px; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:20px; }
  .stat-card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:20px; position:relative; overflow:hidden; }
  .stat-card::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; }
  .stat-card.gold::before { background:var(--accent); }
  .stat-card.green::before { background:var(--accent2); }
  .stat-card.blue::before { background:var(--accent3); }
  .stat-label { font-size:12px; color:var(--muted); margin-bottom:8px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; }
  .stat-value { font-family:'Prompt',sans-serif; font-size:28px; font-weight:700; line-height:1; margin-bottom:4px; }
  .stat-value.gold { color:var(--accent); }
  .stat-value.green { color:var(--accent2); }
  .stat-value.blue { color:var(--accent3); }
  .stat-sub { font-size:12px; color:var(--muted); }
  .card-title { font-family:'Prompt',sans-serif; font-size:14px; font-weight:600; margin-bottom:16px; display:flex; align-items:center; gap:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--accent); display:inline-block; }
  .dot.green { background:var(--accent2); }
  .dot.red { background:var(--danger); }
  .dot.blue { background:var(--accent3); }
  .chart-wrap { position:relative; height:220px; }

  /* TABLE */
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; padding:0 0 10px; border-bottom:1px solid var(--border); }
  td { padding:9px 0; font-size:13px; border-bottom:1px solid #1e2133; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  .stock-badge { display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:600; }
  .stock-ok { background:#064e3b; color:#34d399; }
  .stock-low { background:#7c2d12; color:#fb923c; }
  .stock-out { background:#450a0a; color:#f87171; }
  .rank { width:22px; height:22px; background:var(--card2); border-radius:5px; display:inline-flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; color:var(--muted); }
  .rank.top { background:#451a03; color:var(--accent); }
  .bar-wrap { display:flex; align-items:center; gap:6px; }
  .bar-bg { flex:1; height:5px; background:var(--border); border-radius:3px; overflow:hidden; }
  .bar-fill { height:100%; border-radius:3px; background:var(--accent2); }

  /* PAGINATION */
  .pagination { display:flex; align-items:center; justify-content:space-between; margin-top:16px; }
  .page-info { font-size:13px; color:var(--muted); }
  .page-btns { display:flex; gap:6px; }
  .page-btn { padding:6px 14px; border-radius:8px; border:1px solid var(--border); background:var(--card2); color:var(--text); font-family:'Sarabun',sans-serif; font-size:13px; cursor:pointer; }
  .page-btn:hover { border-color:var(--accent); color:var(--accent); }
  .page-btn:disabled { opacity:0.3; cursor:default; }
  .page-btn.active { background:var(--accent); color:#000; border-color:var(--accent); }

  /* FILTER */
  .filter-bar { display:flex; gap:10px; margin-bottom:16px; align-items:center; flex-wrap:wrap; }
  .filter-btn { padding:6px 14px; border-radius:20px; border:1px solid var(--border); background:var(--card2); color:var(--muted); font-family:'Sarabun',sans-serif; font-size:13px; cursor:pointer; transition:all 0.2s; }
  .filter-btn:hover, .filter-btn.active { border-color:var(--accent); color:var(--accent); background:#1a1200; }
  .search-box { padding:7px 14px; border-radius:8px; border:1px solid var(--border); background:var(--card2); color:var(--text); font-family:'Sarabun',sans-serif; font-size:13px; outline:none; flex:1; min-width:200px; }
  .search-box:focus { border-color:var(--accent); }

  /* BILL EXPAND */
  .bill-row { cursor:pointer; transition:background 0.15s; }
  .bill-row:hover td { background:#1e2133; }
  .bill-detail-row { display:none; }
  .bill-detail-row.open { display:table-row; }
  .bill-detail-inner { background:#111421; padding:12px 16px; border-radius:8px; margin:4px 0; }
  .bill-detail-inner table { margin:0; }
  .bill-detail-inner th { font-size:10px; padding-bottom:6px; }
  .bill-detail-inner td { font-size:12px; padding:5px 0; border-bottom:1px solid #1a1d27; }
  .expand-icon { color:var(--muted); font-size:16px; transition:transform 0.2s; display:inline-block; }
  .expand-icon.open { transform:rotate(90deg); color:var(--accent); }
  .pay-tag { display:inline-block; padding:1px 7px; border-radius:5px; font-size:11px; font-weight:600; background:#1e3a5f; color:#60a5fa; margin-right:3px; }
  .pay-tag.cash { background:#064e3b; color:#34d399; }
  .pay-tag.transfer { background:#2d1a5f; color:#a78bfa; }
  .pay-tag.card { background:#3b1f00; color:#fb923c; }
  .today-summary { display:flex; gap:16px; margin-bottom:16px; flex-wrap:wrap; }
  .today-stat { background:var(--card2); border-radius:10px; padding:12px 20px; flex:1; min-width:140px; }
  .today-stat-label { font-size:11px; color:var(--muted); margin-bottom:4px; }
  .today-stat-value { font-family:'Prompt',sans-serif; font-size:20px; font-weight:700; color:var(--accent); }

  @media (max-width:900px) {
    .grid-3 { grid-template-columns:1fr; }
    .grid-12 { grid-template-columns:1fr; }
    .page { padding:16px; }
    .nav { padding:0 16px; overflow-x:auto; }
  }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="logo">TeeDinamo <span>Dashboard</span></div>
    <div class="updated" id="updated">กำลังโหลด...</div>
  </div>
  <button class="refresh-btn" onclick="loadData()">🔄 รีเฟรช</button>
</div>

<div class="nav">
  <button class="nav-btn active" onclick="showPage('dashboard',this)">📊 ภาพรวม</button>
  <button class="nav-btn" onclick="showPage('today',this)">🧾 ยอดขายวันนี้</button>
  <button class="nav-btn" onclick="showPage('stock',this)">📦 Stock ทั้งหมด</button>
  <button class="nav-btn" onclick="showPage('low',this)">⚠️ ใกล้หมด / หมดแล้ว</button>
  <button class="nav-btn" onclick="showPage('log',this);loadLog()">📋 Log ระบบ</button>
</div>

<!-- PAGE: DASHBOARD -->
<div id="page-dashboard" class="page active">
  <div class="grid-3">
    <div class="stat-card gold">
      <div class="stat-label">ยอดขายวันนี้</div>
      <div class="stat-value gold" id="today-sales">-</div>
      <div class="stat-sub" id="today-bills">-</div>
    </div>
    <div class="stat-card green">
      <div class="stat-label">ยอดขายเดือนนี้</div>
      <div class="stat-value green" id="month-sales">-</div>
      <div class="stat-sub">รวมทุกบิล</div>
    </div>
    <div class="stat-card blue">
      <div class="stat-label">สินค้าใกล้หมด</div>
      <div class="stat-value blue" id="low-count">-</div>
      <div class="stat-sub">stock ≤ 5</div>
    </div>
  </div>
  <div class="grid-12">
    <div class="card">
      <div class="card-title"><span class="dot"></span>ยอดขาย 30 วันย้อนหลัง</div>
      <div class="chart-wrap"><canvas id="salesChart"></canvas></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="dot green"></span>สินค้าขายดี 7 วัน</div>
      <table><thead><tr><th>#</th><th>สินค้า</th><th style="text-align:right">จำนวน</th></tr></thead>
      <tbody id="top-items"></tbody></table>
    </div>
  </div>
</div>

<!-- PAGE: TODAY SALES -->
<div id="page-today" class="page">
  <div class="card">
    <div class="card-title"><span class="dot"></span>บิลขายวันนี้ <span id="today-bill-count" style="color:var(--muted);font-size:12px;font-weight:400"></span></div>
    <table>
      <thead><tr>
        <th style="width:50px">#</th>
        <th>เลขที่บิล</th>
        <th>เวลา</th>
        <th>ชำระด้วย</th>
        <th style="text-align:right">ยอดรวม</th>
        <th style="width:40px"></th>
      </tr></thead>
      <tbody id="today-bill-table"></tbody>
    </table>
  </div>
</div>

<!-- PAGE: STOCK ALL -->
<div id="page-stock" class="page">
  <div class="card">
    <div class="card-title"><span class="dot blue"></span>Stock สินค้าทั้งหมด <span id="stock-total-count" style="color:var(--muted);font-size:12px;font-weight:400"></span></div>
    <div class="filter-bar">
      <input class="search-box" type="text" placeholder="🔍 ค้นหาสินค้า..." oninput="filterStock()" id="stock-search">
      <button class="filter-btn active" onclick="setStockFilter('all',this)">ทั้งหมด</button>
      <button class="filter-btn" onclick="setStockFilter('out',this)">หมดแล้ว</button>
      <button class="filter-btn" onclick="setStockFilter('low',this)">ใกล้หมด (≤5)</button>
      <button class="filter-btn" onclick="setStockFilter('ok',this)">พอ (>5)</button>
    </div>
    <table>
      <thead><tr>
        <th>รหัส</th><th>ชื่อสินค้า</th>
        <th style="text-align:right">Stock คงเหลือ</th>
        <th style="text-align:right">สถานะ</th>
      </tr></thead>
      <tbody id="stock-table"></tbody>
    </table>
    <div class="pagination">
      <div class="page-info" id="stock-page-info"></div>
      <div class="page-btns" id="stock-page-btns"></div>
    </div>
  </div>
</div>

<!-- PAGE: LOG -->
<div id="page-log" class="page">
  <div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
      <span><span class="dot blue"></span>Log ระบบ <span id="log-count" style="color:var(--muted);font-size:12px;font-weight:400"></span></span>
      <button class="refresh-btn" onclick="reloadLog()" style="font-size:12px;padding:4px 12px">🔄 รีโหลด</button>
    </div>
    <input class="search-box" type="text" placeholder="🔍 ค้นหา เลขที่บิล / รหัสพนักงาน..." id="log-search" oninput="reloadLog()">
    <table>
      <thead><tr>
        <th>SYSTRANNO</th>
        <th>เลขที่บิล</th>
        <th>รหัสพนักงาน</th>
        <th>เวลา</th>
      </tr></thead>
      <tbody id="log-table"><tr><td colspan="4" style="color:var(--muted);text-align:center">คลิกแท็บ Log ระบบ เพื่อโหลด</td></tr></tbody>
    </table>
  </div>
</div>

<!-- PAGE: LOW STOCK -->
<div id="page-low" class="page">
  <div class="card">
    <div class="card-title"><span class="dot red"></span>สินค้าใกล้หมด / หมดแล้ว</div>
    <table>
      <thead><tr>
        <th>รหัส</th><th>ชื่อสินค้า</th>
        <th style="text-align:right">Stock คงเหลือ</th>
        <th style="text-align:right">สถานะ</th>
      </tr></thead>
      <tbody id="low-table"></tbody>
    </table>
  </div>
</div>

<script>
let salesChart = null;
let allStockData = [];
let filteredStock = [];
let stockFilter = 'all';
let stockPage = 1;
const PAGE_SIZE = 50;

function fmt(n) {
  return Number(n).toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2});
}

function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  btn.classList.add('active');
}

function badge(stock) {
  if (stock <= 0) return '<span class="stock-badge stock-out">หมดแล้ว</span>';
  if (stock <= 5) return '<span class="stock-badge stock-low">ใกล้หมด</span>';
  return '<span class="stock-badge stock-ok">พอ</span>';
}

function setStockFilter(f, btn) {
  stockFilter = f;
  stockPage = 1;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyStockFilter();
}

function filterStock() {
  stockPage = 1;
  applyStockFilter();
}

function applyStockFilter() {
  const q = (document.getElementById('stock-search').value || '').toLowerCase();
  filteredStock = allStockData.filter(item => {
    const matchQ = !q || item.itemname.toLowerCase().includes(q) || item.itemid.toLowerCase().includes(q);
    const matchF = stockFilter === 'all' ? true :
                   stockFilter === 'out' ? item.stock <= 0 :
                   stockFilter === 'low' ? item.stock > 0 && item.stock <= 5 :
                   item.stock > 5;
    return matchQ && matchF;
  });
  renderStockTable();
}

function renderStockTable() {
  const total = filteredStock.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (stockPage > totalPages) stockPage = Math.max(1, totalPages);
  const start = (stockPage - 1) * PAGE_SIZE;
  const items = filteredStock.slice(start, start + PAGE_SIZE);

  document.getElementById('stock-total-count').textContent = `(${total} รายการ)`;
  document.getElementById('stock-page-info').textContent = `หน้า ${stockPage} / ${totalPages} (${start+1}-${Math.min(start+PAGE_SIZE, total)} จาก ${total})`;

  document.getElementById('stock-table').innerHTML = items.map(item => `
    <tr>
      <td style="color:var(--muted);font-size:12px">${item.itemid}</td>
      <td>${item.itemname}</td>
      <td style="text-align:right;font-family:'Prompt',sans-serif;font-weight:600;color:${item.stock<=0?'#f87171':item.stock<=5?'#fb923c':'var(--text)'}">${fmt(item.stock)}</td>
      <td style="text-align:right">${badge(item.stock)}</td>
    </tr>
  `).join('');

  // pagination buttons
  let btns = '';
  btns += `<button class="page-btn" onclick="goPage(${stockPage-1})" ${stockPage<=1?'disabled':''}>◀ ก่อนหน้า</button>`;
  const start_p = Math.max(1, stockPage-2);
  const end_p = Math.min(totalPages, stockPage+2);
  for (let i = start_p; i <= end_p; i++) {
    btns += `<button class="page-btn ${i===stockPage?'active':''}" onclick="goPage(${i})">${i}</button>`;
  }
  btns += `<button class="page-btn" onclick="goPage(${stockPage+1})" ${stockPage>=totalPages?'disabled':''}>ถัดไป ▶</button>`;
  document.getElementById('stock-page-btns').innerHTML = btns;
}

function goPage(p) {
  stockPage = p;
  renderStockTable();
  document.getElementById('page-stock').scrollTop = 0;
}

function loadData() {
  document.getElementById('updated').textContent = 'กำลังโหลด...';
  fetch('/data')
    .then(r => r.json())
    .then(d => {
      document.getElementById('updated').textContent = 'อัพเดทล่าสุด: ' + d.updated;
      document.getElementById('today-sales').textContent = '฿' + fmt(d.today_sales);
      document.getElementById('today-bills').textContent = d.today_bills + ' บิล';
      document.getElementById('month-sales').textContent = '฿' + fmt(d.month_sales);

      const lowCount = d.all_stock.filter(i => i.stock <= 5).length;
      document.getElementById('low-count').textContent = lowCount + ' รายการ';

      // chart
      const labels = d.sales_30d.map(x => { const dt = new Date(x.date); return dt.getDate()+'/'+(dt.getMonth()+1); });
      const values = d.sales_30d.map(x => x.total);
      if (salesChart) salesChart.destroy();
      const ctx = document.getElementById('salesChart').getContext('2d');
      salesChart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ data: values, backgroundColor: 'rgba(245,158,11,0.7)', borderColor:'#f59e0b', borderWidth:1, borderRadius:4 }] },
        options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
          scales: { x:{grid:{color:'#2d3148'},ticks:{color:'#94a3b8',font:{size:10}}},
                    y:{grid:{color:'#2d3148'},ticks:{color:'#94a3b8',font:{size:10},callback:v=>'฿'+Number(v).toLocaleString('th-TH')}} } }
      });

      // top items
      const maxQty = Math.max(...d.top_items.map(i => i.qty), 1);
      document.getElementById('top-items').innerHTML = d.top_items.map((item,i) => `
        <tr>
          <td><span class="rank ${i<3?'top':''}">${i+1}</span></td>
          <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.name}">${item.name}</td>
          <td style="text-align:right">
            <div class="bar-wrap">
              <div class="bar-bg"><div class="bar-fill" style="width:${(item.qty/maxQty*100).toFixed(0)}%"></div></div>
              <span style="min-width:32px;text-align:right;font-weight:600">${item.qty}</span>
            </div>
          </td>
        </tr>
      `).join('');

      // today bills
      renderTodayBills(d.today_bills_list || []);

      // stock all
      allStockData = d.all_stock;
      applyStockFilter();

      // low stock page
      const lowItems = d.all_stock.filter(i => i.stock <= 5);
      document.getElementById('low-table').innerHTML = lowItems.map(item => `
        <tr>
          <td style="color:var(--muted);font-size:12px">${item.itemid}</td>
          <td>${item.itemname}</td>
          <td style="text-align:right;font-family:'Prompt',sans-serif;font-weight:600;color:${item.stock<=0?'#f87171':'#fb923c'}">${fmt(item.stock)}</td>
          <td style="text-align:right">${badge(item.stock)}</td>
        </tr>
      `).join('');
    })
    .catch(e => {
      document.getElementById('updated').textContent = 'Error: ' + e.message;
    });
}

function payTag(pay) {
  return pay.split(', ').map(p => {
    const cls = p === 'เงินสด' ? 'cash' : p === 'โอน' ? 'transfer' : 'card';
    return `<span class="pay-tag ${cls}">${p}</span>`;
  }).join('');
}

function renderTodayBills(bills) {
  document.getElementById('today-bill-count').textContent = `(${bills.length} บิล)`;

  const totalCash = bills.reduce((s,b) => s + (b.payment.includes('เงินสด') ? b.grandtotal : 0), 0);
  const totalTransfer = bills.reduce((s,b) => s + (b.payment.includes('โอน') ? b.grandtotal : 0), 0);
  const totalCard = bills.reduce((s,b) => s + (b.payment.includes('บัตร') ? b.grandtotal : 0), 0);

  // inject summary above table if not exists
  let summaryEl = document.getElementById('today-summary');
  if (!summaryEl) {
    summaryEl = document.createElement('div');
    summaryEl.id = 'today-summary';
    summaryEl.className = 'today-summary';
    const card = document.querySelector('#page-today .card');
    card.insertBefore(summaryEl, card.querySelector('table'));
  }
  summaryEl.innerHTML = `
    <div class="today-stat"><div class="today-stat-label">บิลทั้งหมด</div><div class="today-stat-value">${bills.length} บิล</div></div>
    <div class="today-stat"><div class="today-stat-label">เงินสด</div><div class="today-stat-value" style="color:#34d399">฿${fmt(totalCash)}</div></div>
    <div class="today-stat"><div class="today-stat-label">โอน</div><div class="today-stat-value" style="color:#a78bfa">฿${fmt(totalTransfer)}</div></div>
    <div class="today-stat"><div class="today-stat-label">บัตร</div><div class="today-stat-value" style="color:#fb923c">฿${fmt(totalCard)}</div></div>
  `;

  const tbody = document.getElementById('today-bill-table');
  if (!bills.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">ยังไม่มีรายการขายวันนี้</td></tr>';
    return;
  }
  tbody.innerHTML = bills.map((b, i) => {
    const itemRows = (b.items || []).map(it => `
      <tr>
        <td style="color:var(--muted);padding-left:8px">${it.name}</td>
        <td style="text-align:right">${it.qty % 1 === 0 ? it.qty.toFixed(0) : it.qty}</td>
        <td style="text-align:right">฿${fmt(it.price)}</td>
        <td style="text-align:right;color:#fb923c">${it.discount > 0 ? '-฿'+fmt(it.discount) : '-'}</td>
        <td style="text-align:right;font-weight:600">฿${fmt(it.amount)}</td>
      </tr>
    `).join('');
    const detailHtml = `<td colspan="6" style="padding:0 8px 8px">
      <div class="bill-detail-inner">
        <table>
          <thead><tr><th>สินค้า</th><th style="text-align:right">จำนวน</th><th style="text-align:right">ราคา/หน่วย</th><th style="text-align:right">ส่วนลด</th><th style="text-align:right">รวม</th></tr></thead>
          <tbody>${itemRows || '<tr><td colspan="5" style="color:var(--muted)">ไม่มีรายการ</td></tr>'}</tbody>
        </table>
      </div>
    </td>`;
    return `
      <tr class="bill-row" onclick="toggleBill(${i})">
        <td style="color:var(--muted)">${i+1}</td>
        <td style="font-family:'Prompt',sans-serif;font-size:13px;font-weight:600">${b.tranno}</td>
        <td style="color:var(--muted)">${b.time}</td>
        <td>${payTag(b.payment)}</td>
        <td style="text-align:right;font-family:'Prompt',sans-serif;font-weight:700;color:var(--accent)">฿${fmt(b.grandtotal)}</td>
        <td style="text-align:center"><span class="expand-icon" id="icon-${i}">▶</span></td>
      </tr>
      <tr class="bill-detail-row" id="detail-${i}"><td colspan="6" style="padding:0"><div style="padding:0 0 4px"><table style="width:100%"><tr>${detailHtml}</tr></table></div></td></tr>
    `;
  }).join('');
}

function toggleBill(i) {
  const row = document.getElementById('detail-' + i);
  const icon = document.getElementById('icon-' + i);
  const isOpen = row.classList.contains('open');
  // close all
  document.querySelectorAll('.bill-detail-row').forEach(r => r.classList.remove('open'));
  document.querySelectorAll('.expand-icon').forEach(ic => ic.classList.remove('open'));
  if (!isOpen) {
    row.classList.add('open');
    icon.classList.add('open');
  }
}

loadData();
setInterval(loadData, 60000);

// ===== LOG PAGE =====
let logLoaded = false;
function loadLog() {
  if (logLoaded) return;
  logLoaded = true;
  document.getElementById('log-table').innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center">กำลังโหลด...</td></tr>';
  fetch('/logs').then(r=>r.json()).then(data=>{
    renderLog(data);
  }).catch(e=>{
    document.getElementById('log-table').innerHTML = '<tr><td colspan="4" style="color:#f87171">โหลด log ไม่ได้: '+e+'</td></tr>';
  });
}
function reloadLog() {
  logLoaded = false;
  loadLog();
}
function renderLog(entries) {
  const commits = entries.filter(e=>e.type==='commit');
  document.getElementById('log-count').textContent = `(${commits.length} รายการ)`;
  const q = (document.getElementById('log-search').value||'').toLowerCase();
  const filtered = commits.filter(e=>
    !q || e.tranno.toLowerCase().includes(q) || e.empid.includes(q) || e.time.includes(q)
  );
  if (!filtered.length) {
    document.getElementById('log-table').innerHTML = '<tr><td colspan="4" style="color:var(--muted);text-align:center">ไม่พบรายการ</td></tr>';
    return;
  }
  document.getElementById('log-table').innerHTML = filtered.map(e=>`
    <tr>
      <td style="color:var(--muted);font-size:12px">${e.systranno}</td>
      <td style="font-family:'Prompt',sans-serif;font-weight:600;font-size:13px">${e.tranno}</td>
      <td style="color:var(--muted)">${e.empid}</td>
      <td style="color:var(--muted);font-size:12px">${e.time}</td>
    </tr>
  `).join('');
}
document.getElementById('log-search') && document.getElementById('log-search').addEventListener('input', ()=>{
  fetch('/logs').then(r=>r.json()).then(renderLog);
});
</script>
</body>
</html>
"""

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(HTML.encode('utf-8'))
        elif self.path == '/data':
            try:
                data = get_data()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps(data, ensure_ascii=False, default=str).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
        elif self.path.startswith('/logs'):
            try:
                logs = get_logs(300)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps(logs, ensure_ascii=False).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass

if __name__ == '__main__':
    PORT = 5050
    server = HTTPServer(('localhost', PORT), Handler)
    print(f'TeeDinamo Dashboard กำลังรันที่ http://localhost:{PORT}')
    print('กด Ctrl+C เพื่อหยุด')
    threading.Timer(1.0, lambda: webbrowser.open(f'http://localhost:{PORT}')).start()
    server.serve_forever()
