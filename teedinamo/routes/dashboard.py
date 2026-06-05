from flask import Blueprint, render_template, jsonify
from routes.auth import login_required, admin_required
from models.transaction import today_transactions, sales_summary, top_items
from models.item import low_stock_items

dashboard_bp = Blueprint("dashboard", __name__)


@dashboard_bp.route("/dashboard")
@login_required
def dashboard():
    today = today_transactions()
    today_total = sum(t["total"] for t in today)
    low = low_stock_items()
    return render_template(
        "dashboard.html",
        today_count=len(today),
        today_total=today_total,
        low_stock_count=len(low),
    )


@dashboard_bp.route("/api/dashboard/chart")
@login_required
def api_chart():
    data = sales_summary(30)
    return jsonify({"labels": [r["day"] for r in data], "values": [r["total"] for r in data]})


@dashboard_bp.route("/api/dashboard/top")
@login_required
def api_top():
    items = top_items(10)
    return jsonify([dict(i) for i in items])


@dashboard_bp.route("/api/agent/stock")
@login_required
def api_stock_agent():
    import sys, os
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from stock_agent import get_stock_report
    return jsonify(get_stock_report())


@dashboard_bp.route("/api/gsheet/sync", methods=["POST"])
@login_required
def api_gsheet_sync():
    try:
        import sys, os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from gsheet_sync import run_sync
        ok = run_sync()
        if ok:
            return jsonify({"status": "ok", "message": "Sync สำเร็จ"})
        return jsonify({"status": "error", "message": "Sync ผิดพลาด"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
