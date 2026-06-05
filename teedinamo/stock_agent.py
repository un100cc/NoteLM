"""
TeeDinamo Stock Agent — เลขาตรวจสต็อก
รัน: python stock_agent.py
หรือเรียกจาก Flask: /api/agent/stock
"""
import sys, os
sys.stdout.reconfigure(encoding='utf-8') if hasattr(sys.stdout, 'reconfigure') else None
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import get_conn
from datetime import datetime, timedelta


def get_stock_report():
    with get_conn() as conn:

        # ── 1. สต็อกหมด ──────────────────────────────────────
        out_of_stock = conn.execute("""
            SELECT itemid, itemname, unit, stock, price_normal
            FROM items WHERE stock <= 0
            ORDER BY itemname
        """).fetchall()

        # ── 2. ใกล้หมด ────────────────────────────────────────
        low_stock = conn.execute("""
            SELECT itemid, itemname, unit, stock, low_stock_threshold, price_normal
            FROM items WHERE stock > 0 AND stock <= low_stock_threshold
            ORDER BY stock ASC
        """).fetchall()

        # ── 3. สินค้าขายดี 30 วัน ────────────────────────────
        top_sellers = conn.execute("""
            SELECT i.itemid, i.itemname, i.unit, i.stock,
                   SUM(ti.qty) as sold_qty,
                   SUM(ti.qty * ti.unit_price) as revenue
            FROM trans_items ti
            JOIN items i ON i.id = ti.item_id
            JOIN transactions t ON t.id = ti.trans_id
            WHERE t.date >= DATE('now', '-30 days')
            GROUP BY ti.item_id
            ORDER BY sold_qty DESC
            LIMIT 10
        """).fetchall()

        # ── 4. สินค้าค้างสต็อก (มีสต็อกแต่ไม่เคยขายใน 30 วัน) ──
        dead_stock = conn.execute("""
            SELECT i.itemid, i.itemname, i.unit, i.stock, i.price_normal,
                   COALESCE(last_sale.last_date, 'ไม่เคยขาย') as last_sold
            FROM items i
            LEFT JOIN (
                SELECT ti.item_id, MAX(t.date) as last_date
                FROM trans_items ti
                JOIN transactions t ON t.id = ti.trans_id
                GROUP BY ti.item_id
            ) last_sale ON last_sale.item_id = i.id
            WHERE i.stock > 0
              AND (last_sale.last_date IS NULL
                   OR last_sale.last_date < DATE('now', '-30 days'))
            ORDER BY i.stock DESC
            LIMIT 15
        """).fetchall()

        # ── 5. สรุปภาพรวม ─────────────────────────────────────
        summary = conn.execute("""
            SELECT
              COUNT(*) as total_items,
              SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END) as out_count,
              SUM(CASE WHEN stock > 0 AND stock <= low_stock_threshold THEN 1 ELSE 0 END) as low_count,
              SUM(CASE WHEN stock > low_stock_threshold THEN 1 ELSE 0 END) as ok_count
            FROM items
        """).fetchone()

        # ── 6. ยอดขาย 30 วัน ──────────────────────────────────
        sales_30d = conn.execute("""
            SELECT COUNT(*) as bills, SUM(total) as revenue
            FROM transactions
            WHERE date >= DATE('now', '-30 days')
        """).fetchone()

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "summary": dict(summary),
        "sales_30d": dict(sales_30d),
        "out_of_stock": [dict(r) for r in out_of_stock],
        "low_stock": [dict(r) for r in low_stock],
        "top_sellers": [dict(r) for r in top_sellers],
        "dead_stock": [dict(r) for r in dead_stock],
    }


def print_report(report):
    s = report["summary"]
    sal = report["sales_30d"]
    print(f"\n{'='*60}")
    print(f"  📊 TeeDinamo Stock Agent Report")
    print(f"  สร้างเมื่อ: {report['generated_at']}")
    print(f"{'='*60}")

    print(f"\n📦 ภาพรวมสต็อก")
    print(f"  สินค้าทั้งหมด : {s['total_items']:,} รายการ")
    print(f"  ✅ มีพอใช้    : {s['ok_count']:,} รายการ")
    print(f"  ⚠️  ใกล้หมด   : {s['low_count']:,} รายการ")
    print(f"  🔴 หมดแล้ว   : {s['out_count']:,} รายการ")

    print(f"\n💰 ยอดขาย 30 วันที่ผ่านมา")
    print(f"  จำนวนบิล : {sal['bills'] or 0:,} บิล")
    print(f"  รายได้    : ฿{sal['revenue'] or 0:,.2f}")

    if report["out_of_stock"]:
        print(f"\n🔴 สินค้าหมดสต็อก ({len(report['out_of_stock'])} รายการ)")
        for it in report["out_of_stock"][:10]:
            print(f"  - {it['itemname'][:35]:<35} (สต็อก: {it['stock']})")
        if len(report["out_of_stock"]) > 10:
            print(f"  ... และอีก {len(report['out_of_stock'])-10} รายการ")

    if report["low_stock"]:
        print(f"\n⚠️  สินค้าใกล้หมด ({len(report['low_stock'])} รายการ)")
        for it in report["low_stock"][:10]:
            print(f"  - {it['itemname'][:30]:<30} เหลือ {it['stock']} {it['unit']} (เตือนที่ {it['low_stock_threshold']})")
        if len(report["low_stock"]) > 10:
            print(f"  ... และอีก {len(report['low_stock'])-10} รายการ")

    if report["top_sellers"]:
        print(f"\n🔥 สินค้าขายดี 30 วัน (Top 10)")
        for i, it in enumerate(report["top_sellers"], 1):
            print(f"  {i:2}. {it['itemname'][:30]:<30} ขาย {it['sold_qty']} {it['unit']}  ฿{it['revenue']:,.0f}")

    if report["dead_stock"]:
        print(f"\n🧊 สินค้าค้างสต็อก (ไม่ขายใน 30 วัน)")
        for it in report["dead_stock"]:
            print(f"  - {it['itemname'][:30]:<30} สต็อก {it['stock']} {it['unit']}  ขายล่าสุด: {it['last_sold']}")

    print(f"\n{'='*60}\n")


if __name__ == "__main__":
    report = get_stock_report()
    print_report(report)
