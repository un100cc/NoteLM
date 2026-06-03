from flask import Flask, redirect, url_for
from db import init_db
from routes.auth import auth_bp
from routes.pos import pos_bp
from routes.stock import stock_bp
from routes.dashboard import dashboard_bp

app = Flask(__name__)
app.secret_key = "teedinamo_secret_2024"

app.register_blueprint(auth_bp)
app.register_blueprint(pos_bp)
app.register_blueprint(stock_bp)
app.register_blueprint(dashboard_bp)


@app.route("/")
def index():
    return redirect(url_for("dashboard.dashboard"))


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=True)
