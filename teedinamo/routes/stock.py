from flask import Blueprint, render_template, request, jsonify, flash, redirect, url_for
from routes.auth import login_required, admin_required
from models.item import low_stock_items, update_threshold, update_exchange_value
from db import get_conn

stock_bp = Blueprint("stock", __name__)


@stock_bp.route("/stock")
@login_required
def stock():
    with get_conn() as conn:
        items = conn.execute("SELECT * FROM items ORDER BY itemname").fetchall()
    low = low_stock_items()
    low_ids = {i["id"] for i in low}
    return render_template("stock.html", items=items, low_ids=low_ids)


@stock_bp.route("/api/stock/low")
@login_required
def api_low_stock():
    items = low_stock_items()
    return jsonify([dict(i) for i in items])


@stock_bp.route("/api/stock/item/<int:item_id>", methods=["POST"])
@admin_required
def api_update_item(item_id):
    threshold = request.form.get("threshold")
    exval = request.form.get("exchange_value")
    if threshold is not None:
        update_threshold(item_id, float(threshold))
    if exval is not None:
        update_exchange_value(item_id, float(exval))
    flash("อัปเดตสำเร็จ", "success")
    return redirect(url_for("stock.stock"))


@stock_bp.route("/api/sync/status")
@login_required
def api_sync_status():
    with get_conn() as conn:
        logs = conn.execute(
            "SELECT * FROM sync_log ORDER BY id DESC LIMIT 10"
        ).fetchall()
    return jsonify([dict(l) for l in logs])
