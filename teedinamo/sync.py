"""
Background sync service: Firebird → SQLite every 5 minutes.
Run standalone: python sync.py
Or import and call start_sync_thread() from app.py.
"""
import threading
import time
from datetime import datetime
from db import get_conn, get_firebird_conn

SYNC_INTERVAL = 300  # seconds


FIREBIRD_QUERY = """
SELECT
    i.ITEMID,
    i.ITEMNAME,
    i.BARCODE,
    i.UNIT,
    COALESCE(c.STOCK, 0) AS STOCK,
    COALESCE(c.PRICE1, 0) AS PRICE_NORMAL,
    COALESCE(c.PRICE2, 0) AS PRICE_TECH,
    COALESCE(c.PRICE3, 0) AS PRICE_EXCHANGE
FROM ITEMS i
LEFT JOIN CALCAVG c ON c.ITEMID = i.ITEMID
"""


def run_sync():
    print(f"[sync] Starting at {datetime.now()}")
    try:
        fb = get_firebird_conn()
        cur = fb.cursor()
        cur.execute(FIREBIRD_QUERY)
        rows = cur.fetchall()
        fb.close()

        updated = 0
        with get_conn() as conn:
            for row in rows:
                itemid, itemname, barcode, unit, stock, p1, p2, p3 = row
                existing = conn.execute(
                    "SELECT id FROM items WHERE itemid=?", (itemid,)
                ).fetchone()
                if existing:
                    conn.execute(
                        """UPDATE items SET itemname=?, barcode=?, unit=?, stock=?,
                           price_normal=?, price_tech=?, price_exchange=? WHERE itemid=?""",
                        (itemname, barcode, unit, stock, p1, p2, p3, itemid),
                    )
                else:
                    conn.execute(
                        """INSERT INTO items (itemid, itemname, barcode, unit, stock,
                           price_normal, price_tech, price_exchange)
                           VALUES (?,?,?,?,?,?,?,?)""",
                        (itemid, itemname, barcode, unit, stock, p1, p2, p3),
                    )
                updated += 1

            conn.execute(
                "INSERT INTO sync_log (synced_at, items_updated, status) VALUES (?,?,?)",
                (datetime.now().isoformat(), updated, "ok"),
            )
            conn.commit()

        print(f"[sync] Done — {updated} items updated")

    except Exception as e:
        print(f"[sync] Error: {e}")
        try:
            with get_conn() as conn:
                conn.execute(
                    "INSERT INTO sync_log (synced_at, items_updated, status) VALUES (?,?,?)",
                    (datetime.now().isoformat(), 0, f"error: {e}"),
                )
                conn.commit()
        except Exception:
            pass


def sync_loop():
    while True:
        run_sync()
        time.sleep(SYNC_INTERVAL)


def start_sync_thread():
    t = threading.Thread(target=sync_loop, daemon=True)
    t.start()
    return t


if __name__ == "__main__":
    sync_loop()
