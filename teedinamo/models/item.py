from db import get_conn

PRICE_COLUMN = {
    "normal": "price_normal",
    "tech": "price_tech",
    "exchange": "price_exchange",
}


def search_items(query, limit=20):
    q = f"%{query}%"
    with get_conn() as conn:
        return conn.execute(
            """SELECT * FROM items
               WHERE itemname LIKE ? OR barcode LIKE ? OR itemid LIKE ?
               ORDER BY itemname LIMIT ?""",
            (q, q, q, limit),
        ).fetchall()


def get_item_by_barcode(barcode):
    with get_conn() as conn:
        return conn.execute("SELECT * FROM items WHERE barcode=?", (barcode,)).fetchone()


def get_item_by_id(item_id):
    with get_conn() as conn:
        return conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()


def get_price(item, price_level):
    col = PRICE_COLUMN.get(price_level, "price_normal")
    return item[col]


def low_stock_items():
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM items WHERE stock <= low_stock_threshold ORDER BY stock ASC"
        ).fetchall()


def update_threshold(item_id, threshold):
    with get_conn() as conn:
        conn.execute(
            "UPDATE items SET low_stock_threshold=? WHERE id=?", (threshold, item_id)
        )
        conn.commit()


def update_exchange_value(item_id, exchange_value):
    with get_conn() as conn:
        conn.execute(
            "UPDATE items SET exchange_value=? WHERE id=?", (exchange_value, item_id)
        )
        conn.commit()
