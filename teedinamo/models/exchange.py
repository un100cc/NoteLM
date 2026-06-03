from db import get_conn


def exchange_log(limit=50):
    with get_conn() as conn:
        return conn.execute(
            """SELECT ti.*, i.itemname, t.trans_no, t.date, u.username
               FROM trans_items ti
               JOIN items i ON i.id=ti.item_id
               JOIN transactions t ON t.id=ti.trans_id
               JOIN users u ON u.id=t.user_id
               WHERE ti.exchange_used=1
               ORDER BY t.date DESC LIMIT ?""",
            (limit,),
        ).fetchall()


def exchange_summary_today():
    from datetime import datetime
    today = datetime.now().strftime("%Y-%m-%d")
    with get_conn() as conn:
        row = conn.execute(
            """SELECT COUNT(*) as count, SUM(ti.exchange_value) as total_deducted
               FROM trans_items ti
               JOIN transactions t ON t.id=ti.trans_id
               WHERE ti.exchange_used=1 AND t.date LIKE ?""",
            (f"{today}%",),
        ).fetchone()
        return row
