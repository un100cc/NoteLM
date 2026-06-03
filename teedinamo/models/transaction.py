from db import get_conn
from datetime import datetime
import uuid


def generate_trans_no():
    now = datetime.now()
    return f"T{now.strftime('%Y%m%d%H%M%S')}{uuid.uuid4().hex[:4].upper()}"


def create_transaction(user_id, items, payment):
    """
    items: list of dicts {item_id, qty, price_level, unit_price, exchange_used, exchange_value}
    returns: trans_no
    """
    total = sum(
        (i["unit_price"] * i["qty"]) - (i["exchange_value"] if i["exchange_used"] else 0)
        for i in items
    )
    change = payment - total
    trans_no = generate_trans_no()
    now = datetime.now().isoformat()

    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO transactions (trans_no, date, user_id, total, payment, change, status)
               VALUES (?,?,?,?,?,?,?)""",
            (trans_no, now, user_id, total, payment, change, "completed"),
        )
        trans_id = cur.lastrowid

        for i in items:
            conn.execute(
                """INSERT INTO trans_items
                   (trans_id, item_id, qty, price_level, unit_price, exchange_used, exchange_value)
                   VALUES (?,?,?,?,?,?,?)""",
                (
                    trans_id,
                    i["item_id"],
                    i["qty"],
                    i["price_level"],
                    i["unit_price"],
                    int(i["exchange_used"]),
                    i["exchange_value"] if i["exchange_used"] else 0,
                ),
            )
        conn.commit()

    return trans_no, total, change


def get_transaction(trans_no):
    with get_conn() as conn:
        t = conn.execute(
            "SELECT t.*, u.username FROM transactions t JOIN users u ON u.id=t.user_id WHERE t.trans_no=?",
            (trans_no,),
        ).fetchone()
        if not t:
            return None, []
        items = conn.execute(
            """SELECT ti.*, i.itemname, i.unit FROM trans_items ti
               JOIN items i ON i.id=ti.item_id WHERE ti.trans_id=?""",
            (t["id"],),
        ).fetchall()
        return t, items


def today_transactions():
    today = datetime.now().strftime("%Y-%m-%d")
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM transactions WHERE date LIKE ? ORDER BY date DESC",
            (f"{today}%",),
        ).fetchall()


def sales_summary(days=30):
    with get_conn() as conn:
        return conn.execute(
            """SELECT DATE(date) as day, SUM(total) as total, COUNT(*) as count
               FROM transactions
               WHERE date >= DATE('now', ?)
               GROUP BY DATE(date)
               ORDER BY day""",
            (f"-{days} days",),
        ).fetchall()


def top_items(limit=10, days=30):
    with get_conn() as conn:
        return conn.execute(
            """SELECT i.itemname, SUM(ti.qty) as total_qty, SUM(ti.qty * ti.unit_price) as revenue
               FROM trans_items ti
               JOIN items i ON i.id=ti.item_id
               JOIN transactions t ON t.id=ti.trans_id
               WHERE t.date >= DATE('now', ?)
               GROUP BY ti.item_id
               ORDER BY total_qty DESC LIMIT ?""",
            (f"-{days} days", limit),
        ).fetchall()
