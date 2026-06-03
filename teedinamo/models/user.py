from db import get_conn
from werkzeug.security import generate_password_hash, check_password_hash

PRICE_LEVELS = ["normal", "tech", "exchange"]
ROLES = ["admin", "staff"]


def get_user_by_username(username):
    with get_conn() as conn:
        return conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()


def get_user_by_id(user_id):
    with get_conn() as conn:
        return conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def verify_password(user, password):
    return check_password_hash(user["password_hash"], password)


def list_users():
    with get_conn() as conn:
        return conn.execute("SELECT id, username, role, price_level FROM users").fetchall()


def create_user(username, password, role="staff", price_level="normal"):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO users (username, password_hash, role, price_level) VALUES (?,?,?,?)",
            (username, generate_password_hash(password), role, price_level),
        )
        conn.commit()


def update_user(user_id, role=None, price_level=None, password=None):
    with get_conn() as conn:
        if role:
            conn.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
        if price_level:
            conn.execute("UPDATE users SET price_level=? WHERE id=?", (price_level, user_id))
        if password:
            conn.execute(
                "UPDATE users SET password_hash=? WHERE id=?",
                (generate_password_hash(password), user_id),
            )
        conn.commit()


def delete_user(user_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
        conn.commit()
