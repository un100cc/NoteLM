let cart = [];
let lastTransNo = "";
let searchTimer = null;

const searchInput  = document.getElementById("searchInput");
const searchResults= document.getElementById("searchResults");
const cartEl       = document.getElementById("cart");
const paymentInput = document.getElementById("paymentInput");

// ─── Search ───────────────────────────────────────────────
searchInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    const val = searchInput.value.trim();
    if (!val) return;
    // Try barcode first (exact, no spaces)
    if (!val.includes(" ") && val.length >= 4) {
      fetch(`/api/items/barcode/${encodeURIComponent(val)}`)
        .then(r => r.ok ? r.json() : null)
        .then(item => {
          if (item) { addToCart(item); searchInput.value = ""; searchResults.innerHTML = ""; }
          else doSearch(val);
        });
    } else {
      doSearch(val);
    }
  }
});

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.innerHTML = ""; return; }
  searchTimer = setTimeout(() => doSearch(q), 250);
});

function doSearch(q) {
  fetch(`/api/items/search?q=${encodeURIComponent(q)}`)
    .then(r => r.json())
    .then(renderSearchResults);
}

function renderSearchResults(items) {
  if (!items.length) {
    searchResults.innerHTML = `<div style="padding:12px;color:#999">ไม่พบสินค้า</div>`;
    return;
  }
  searchResults.innerHTML = items.map(it => `
    <div class="search-item" onclick="addToCart(${JSON.stringify(it).replace(/"/g,'&quot;')})">
      <div>
        <div class="item-name">${it.itemname}</div>
        <div class="item-meta">${it.itemid} | ${it.barcode || '-'} | ${it.unit}
          ${it.stock <= 5 ? `<span class="item-stock-low">⚠ สต็อก ${it.stock}</span>` : `| สต็อก ${it.stock}`}
        </div>
      </div>
      <div class="item-price">฿${Number(it.price).toLocaleString('th-TH',{minimumFractionDigits:2})}</div>
    </div>`).join("");
}

// ─── Cart ─────────────────────────────────────────────────
function addToCart(item) {
  const existing = cart.find(c => c.item_id === item.id);
  if (existing) {
    existing.qty++;
  } else {
    cart.push({
      item_id: item.id,
      itemname: item.itemname,
      unit: item.unit,
      unit_price: item.price,
      qty: 1,
      exchange_used: false,
      exchange_value: item.exchange_value || 0,
    });
  }
  renderCart();
  searchInput.focus();
}

function renderCart() {
  if (!cart.length) {
    cartEl.innerHTML = `<div style="color:#999;text-align:center;padding:20px">ตะกร้าว่าง</div>`;
    updateSummary();
    return;
  }
  cartEl.innerHTML = cart.map((it, i) => `
    <div class="cart-item">
      <div>
        <div class="cart-item-name">${it.itemname}</div>
        <div class="cart-item-sub">฿${it.unit_price.toFixed(2)} / ${it.unit}</div>
        ${it.exchange_value > 0 ? `
        <label class="exchange-check">
          <input type="checkbox" ${it.exchange_used ? 'checked' : ''}
            onchange="toggleExchange(${i}, this.checked)">
          มีแบตเตอรี่เก่า (หัก ฿${it.exchange_value.toFixed(2)})
        </label>` : ''}
      </div>
      <div class="cart-qty">
        <button onclick="changeQty(${i},-1)">−</button>
        <input type="number" value="${it.qty}" min="1"
          onchange="setQty(${i}, this.value)" style="width:44px">
        <button onclick="changeQty(${i},1)">+</button>
      </div>
      <div>
        <div class="cart-item-price">฿${lineTotal(it).toFixed(2)}</div>
        <div class="cart-item-remove" onclick="removeItem(${i})">✕</div>
      </div>
    </div>`).join("");
  updateSummary();
}

function lineTotal(it) {
  return it.unit_price * it.qty - (it.exchange_used ? it.exchange_value : 0);
}

function changeQty(i, d) {
  cart[i].qty = Math.max(1, cart[i].qty + d);
  renderCart();
}
function setQty(i, v) {
  cart[i].qty = Math.max(1, parseInt(v) || 1);
  renderCart();
}
function removeItem(i) {
  cart.splice(i, 1);
  renderCart();
}
function toggleExchange(i, v) {
  cart[i].exchange_used = v;
  renderCart();
}
function clearCart() {
  cart = [];
  renderCart();
}

function updateSummary() {
  const subtotal  = cart.reduce((s, it) => s + it.unit_price * it.qty, 0);
  const deduct    = cart.reduce((s, it) => s + (it.exchange_used ? it.exchange_value : 0), 0);
  const grand     = subtotal - deduct;
  const payment   = parseFloat(paymentInput.value) || 0;
  const change    = payment - grand;

  document.getElementById("subtotal").textContent     = `฿${subtotal.toFixed(2)}`;
  document.getElementById("exchangeDeduct").textContent = `-฿${deduct.toFixed(2)}`;
  document.getElementById("grandTotal").textContent   = `฿${grand.toFixed(2)}`;
  document.getElementById("changeAmt").textContent    = change >= 0 ? `฿${change.toFixed(2)}` : "-";
}

paymentInput.addEventListener("input", updateSummary);

function setCash(amount) {
  paymentInput.value = amount;
  updateSummary();
}

// ─── Checkout ─────────────────────────────────────────────
function checkout() {
  if (!cart.length) { alert("ไม่มีสินค้าในตะกร้า"); return; }
  const payment = parseFloat(paymentInput.value) || 0;
  const grand = cart.reduce((s, it) => s + lineTotal(it), 0);
  if (payment < grand) { alert("กรุณาใส่จำนวนเงินให้ครบ"); paymentInput.focus(); return; }

  fetch("/api/checkout", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ items: cart, payment }),
  })
  .then(r => r.json())
  .then(data => {
    if (data.error) { alert(data.error); return; }
    lastTransNo = data.trans_no;
    document.getElementById("modalTransNo").textContent = `บิลเลขที่: ${data.trans_no}`;
    document.getElementById("modalTotal").textContent   = `ยอดรวม: ฿${data.total.toFixed(2)}`;
    document.getElementById("modalChange").textContent  = `ทอน: ฿${data.change.toFixed(2)}`;
    document.getElementById("receiptModal").classList.remove("hidden");
    clearCart();
    paymentInput.value = "";
  })
  .catch(() => alert("เกิดข้อผิดพลาด"));
}

function printReceipt() {
  window.open(`/receipt/${lastTransNo}`, "_blank");
}

function closeModal() {
  document.getElementById("receiptModal").classList.add("hidden");
  searchInput.focus();
}

// ─── Keyboard shortcuts ───────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "F2") { searchInput.focus(); e.preventDefault(); }
  if (e.key === "F12") { checkout(); e.preventDefault(); }
  if (e.key === "Escape") { closeModal(); }
});

// init
renderCart();
