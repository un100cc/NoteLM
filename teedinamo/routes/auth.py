from flask import Blueprint, render_template, request, redirect, url_for, session, flash
from models.user import get_user_by_username, verify_password, list_users, create_user, update_user, delete_user

auth_bp = Blueprint("auth", __name__)


def login_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("auth.login"))
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if session.get("role") != "admin":
            flash("ต้องเป็น Admin", "error")
            return redirect(url_for("dashboard.dashboard"))
        return f(*args, **kwargs)
    return login_required(decorated)


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form["username"].strip()
        password = request.form["password"]
        user = get_user_by_username(username)
        if user and verify_password(user, password):
            session["user_id"] = user["id"]
            session["username"] = user["username"]
            session["role"] = user["role"]
            session["price_level"] = user["price_level"]
            return redirect(url_for("pos.pos"))
        flash("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง", "error")
    return render_template("login.html")


@auth_bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))


@auth_bp.route("/users")
@admin_required
def users():
    return render_template("users.html", users=list_users())


@auth_bp.route("/users/create", methods=["POST"])
@admin_required
def create_user_route():
    try:
        create_user(
            request.form["username"],
            request.form["password"],
            request.form["role"],
            request.form["price_level"],
        )
        flash("สร้างผู้ใช้สำเร็จ", "success")
    except Exception as e:
        flash(f"ผิดพลาด: {e}", "error")
    return redirect(url_for("auth.users"))


@auth_bp.route("/users/<int:uid>/update", methods=["POST"])
@admin_required
def update_user_route(uid):
    update_user(uid, request.form.get("role"), request.form.get("price_level"),
                 request.form.get("password") or None)
    flash("อัปเดตสำเร็จ", "success")
    return redirect(url_for("auth.users"))


@auth_bp.route("/users/<int:uid>/delete", methods=["POST"])
@admin_required
def delete_user_route(uid):
    delete_user(uid)
    flash("ลบผู้ใช้สำเร็จ", "success")
    return redirect(url_for("auth.users"))
