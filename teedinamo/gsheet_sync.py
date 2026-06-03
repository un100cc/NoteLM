"""
sync ข้อมูลวันนี้จาก SQLite → Google Sheets
รัน: python gsheet_sync.py
หรือกดปุ่ม "Sync วันนี้" ใน dashboard
"""
import sys, os
sys.stdout.reconfigure(encoding='utf-8') if hasattr(sys.stdout, 'reconfigure') else None

import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from db import get_conn

SHEET_ID  = "1wLrYe4m3ZW3KBbNA0GR3Hu1jazpllgmQO4dw-apXqmQ"
KEY_FILE  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gsheet_key.json")
SCOPES    = ["https://www.googleapis.com/auth/spreadsheets",
             "https://www.googleapis.com/auth/drive"]


def get_sheet():
    creds = Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
    gc    = gspread.authorize(creds)
    return gc.open_by_key(SHEET_ID)


def ensure_sheet(spreadsheet, title, headers):
    try:
        ws = spreadsheet.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = spreadsheet.add_worksheet(title=title, rows=2000, cols=len(headers))
    ws.clear()
    ws.append_row(headers, value_input_option="USER_ENTERED")
    return ws


def sync_daily_summary(spreadsheet):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT DATE(date) as day,
                   COUNT(*) as bills,
                   SUM(total) as total,
                   SUM(payment) as payment,
                   SUM(change) as change_amt
            FROM transactions
            GROUP BY DATE(date)
            ORDER BY day DESC
        """).fetchall()

    ws = ensure_sheet(spreadsheet, "ยอดขายรายวัน",
                      ["วันที่", "จำนวนบิล", "ยอดรวม", "รับเงิน", "ทอนเงิน"])
    if rows:
        ws.append_rows([[r[0], r[1], r[2], r[3], r[4]] for r in rows],
                       value_input_option="USER_ENTERED")
    print(f"  ยอดขายรายวัน: {len(rows)} วัน")


def sync_transactions(spreadsheet):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT t.trans_no, t.date, u.username, t.total, t.payment, t.change, t.status
            FROM transactions t
            JOIN users u ON u.id = t.user_id
            ORDER BY t.date DESC
        """).fetchall()

    ws = ensure_sheet(spreadsheet, "รายการขาย",
                      ["เลขบิล", "วันที่", "พนักงาน", "ยอดรวม", "รับเงิน", "ทอน", "สถานะ"])
    if rows:
        ws.append_rows([list(r) for r in rows], value_input_option="USER_ENTERED")
    print(f"  รายการขาย: {len(rows)} บิล")


def sync_items(spreadsheet):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT itemid, itemname, barcode, unit, stock,
                   price_normal, price_tech, price_exchange, exchange_value, low_stock_threshold
            FROM items ORDER BY itemname
        """).fetchall()

    ws = ensure_sheet(spreadsheet, "สินค้า",
                      ["Item ID", "ชื่อสินค้า", "บาร์โค้ด", "หน่วย", "สต็อก",
                       "ราคาปกติ", "ราคาช่าง", "ราคาแลกเปลี่ยน", "มูลค่าแบต", "เตือนเมื่อ"])
    if rows:
        ws.append_rows([list(r) for r in rows], value_input_option="USER_ENTERED")
    print(f"  สินค้า: {len(rows)} รายการ")


def sync_today_detail(spreadsheet):
    today = datetime.now().strftime("%Y-%m-%d")
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT t.trans_no, t.date, u.username,
                   i.itemname, ti.qty, i.unit, ti.unit_price,
                   ti.qty * ti.unit_price as subtotal,
                   ti.exchange_used, ti.exchange_value
            FROM trans_items ti
            JOIN transactions t ON t.id = ti.trans_id
            JOIN items i ON i.id = ti.item_id
            JOIN users u ON u.id = t.user_id
            WHERE t.date LIKE ?
            ORDER BY t.date DESC
        """, (f"{today}%",)).fetchall()

    ws = ensure_sheet(spreadsheet, "รายละเอียดวันนี้",
                      ["เลขบิล", "เวลา", "พนักงาน", "สินค้า", "จำนวน",
                       "หน่วย", "ราคา/หน่วย", "รวม", "แลกแบต", "มูลค่าแบต"])
    if rows:
        ws.append_rows([list(r) for r in rows], value_input_option="USER_ENTERED")
    print(f"  รายละเอียดวันนี้: {len(rows)} รายการ")


def run_sync():
    print(f"เริ่ม sync → Google Sheets ({datetime.now().strftime('%Y-%m-%d %H:%M')})")
    try:
        spreadsheet = get_sheet()
        sync_daily_summary(spreadsheet)
        sync_transactions(spreadsheet)
        sync_items(spreadsheet)
        sync_today_detail(spreadsheet)
        print(f"\n✓ Sync สำเร็จ")
        print(f"  ดูได้ที่: https://docs.google.com/spreadsheets/d/{SHEET_ID}")
        return True
    except Exception as e:
        print(f"✗ Sync ผิดพลาด: {e}")
        return False


if __name__ == "__main__":
    run_sync()
