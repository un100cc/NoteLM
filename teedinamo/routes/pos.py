from flask import Blueprint, render_template, request, jsonify, session
from routes.auth import login_required
from models.item import search_items, get_item_by_barcode, get_item_by_id, get_price
from models.transaction import create_transaction, get_transaction

pos_bp = Blueprint("pos", __name__)


@pos_bp.route("/pos")
@login_required
def pos():
    return render_template("pos.html",
                           username=session["username"],
                           price_level=session["price_level"])


@pos_bp.route("/api/items/search")
@login_required
def api_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    items = search_items(q)
    price_level = session["price_level"]
    result = []
    for it in items:
        result.append({
            "id": it["id"],
            "itemid": it["itemid"],
            "itemname": it["itemname"],
            "barcode": it["barcode"],
            "unit": it["unit"],
            "stock": it["stock"],
            "price": get_price(it, price_level),
            "exchange_value": it["exchange_value"],
        })
    return jsonify(result)


@pos_bp.route("/api/items/barcode/<barcode>")
@login_required
def api_barcode(barcode):
    item = get_item_by_barcode(barcode)
    if not item:
        return jsonify({"error": "ไม่พบสินค้า"}), 404
    price_level = session["price_level"]
    return jsonify({
        "id": item["id"],
        "itemid": item["itemid"],
        "itemname": item["itemname"],
        "barcode": item["barcode"],
        "unit": item["unit"],
        "stock": item["stock"],
        "price": get_price(item, price_level),
        "exchange_value": item["exchange_value"],
    })


@pos_bp.route("/api/checkout", methods=["POST"])
@login_required
def api_checkout():
    data = request.json
    items = data.get("items", [])
    payment = float(data.get("payment", 0))
    if not items:
        return jsonify({"error": "ไม่มีสินค้าในตะกร้า"}), 400

    cart = []
    for it in items:
        item = get_item_by_id(it["item_id"])
        if not item:
            return jsonify({"error": f"ไม่พบสินค้า id={it['item_id']}"}), 400
        cart.append({
            "item_id": it["item_id"],
            "qty": float(it["qty"]),
            "price_level": session["price_level"],
            "unit_price": float(it["unit_price"]),
            "exchange_used": bool(it.get("exchange_used", False)),
            "exchange_value": float(it.get("exchange_value", 0)),
        })

    total = sum(
        (i["unit_price"] * i["qty"]) - (i["exchange_value"] if i["exchange_used"] else 0)
        for i in cart
    )
    if payment < total:
        return jsonify({"error": "รับเงินน้อยกว่ายอดรวม"}), 400

    trans_no, total, change = create_transaction(session["user_id"], cart, payment)
    return jsonify({"trans_no": trans_no, "total": total, "change": change})


@pos_bp.route("/receipt/<trans_no>")
@login_required
def receipt(trans_no):
    t, items = get_transaction(trans_no)
    if not t:
        return "ไม่พบใบเสร็จ", 404
    return render_template("receipt.html", t=t, items=items)
