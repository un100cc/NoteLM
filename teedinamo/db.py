import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "teedinamo.db")

# Firebird connection settings — adjust to your environment
FIREBIRD_CONFIG = {
    "host": "localhost",
    "database": "/path/to/your.fdb",
    "user": "SYSDBA",
    "password": "masterkey",
    "charset": "UTF8",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    price_level TEXT NOT NULL DEFAULT 'normal'
);

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemid TEXT UNIQUE NOT NULL,
    itemname TEXT NOT NULL,
    barcode TEXT,
    stock REAL DEFAULT 0,
    price_normal REAL DEFAULT 0,
    price_tech REAL DEFAULT 0,
    price_exchange REAL DEFAULT 0,
    exchange_value REAL DEFAULT 0,
    unit TEXT DEFAULT 'ชิ้น',
    low_stock_threshold REAL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trans_no TEXT UNIQUE NOT NULL,
    date TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    total REAL NOT NULL,
    payment REAL NOT NULL,
    change REAL NOT NULL,
    status TEXT DEFAULT 'completed',
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS trans_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trans_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty REAL NOT NULL,
    price_level TEXT NOT NULL,
    unit_price REAL NOT NULL,
    exchange_used INTEGER DEFAULT 0,
    exchange_value REAL DEFAULT 0,
    FOREIGN KEY (trans_id) REFERENCES transactions(id),
    FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    synced_at TEXT NOT NULL,
    items_updated INTEGER DEFAULT 0,
    status TEXT DEFAULT 'ok'
);
"""


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        # Create default admin if not exists
        from werkzeug.security import generate_password_hash
        existing = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO users (username, password_hash, role, price_level) VALUES (?,?,?,?)",
                ("admin", generate_password_hash("admin1234"), "admin", "normal"),
            )
            conn.commit()


def get_firebird_conn():
    try:
        import fdb
        return fdb.connect(**FIREBIRD_CONFIG)
    except ImportError:
        raise RuntimeError("fdb package not installed. Run: pip install fdb")
    except Exception as e:
        raise RuntimeError(f"Firebird connection failed: {e}")
