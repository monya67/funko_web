"""Management accounting on top of the orders the shop already keeps.

Every number here is derived from an order's state; nothing has to be typed into the accounting twice.
The rules, in one place:

* Each order sits at a stage decided by its status (the mapping is a setting):
  0 not counted (awaiting payment), 1 awaiting purchase, 2 bought, 3 shipping to Russia paid, 4 done.
* An order has two costs, purchase and shipping to Russia. Each is either a fact (``cost_price`` /
  ``delivery_cost`` filled in by the admin) or a plan (snapshot taken at checkout from the product card).
  A fact always wins; a plan makes the result approximate (shown with "~").
* "Still needed" holds only costs that have not happened yet: purchase while the stage is 1,
  shipping while the stage is 1 or 2. Once a cost has happened it moves to the operations history.
* Operations are reconciled, not appended blindly: for every order we know how much money in each
  category *should* have moved by now; the difference to what is already recorded becomes a new event.
  So editing, rolling back a status or deleting an order corrects the history instead of doubling it.
"""

from datetime import date, datetime

STAGE_SKIP, STAGE_AWAITING, STAGE_BOUGHT, STAGE_SHIPPED, STAGE_DONE = 0, 1, 2, 3, 4

DEFAULT_SETTINGS = {
    "start_date": "2026-11-01",
    "start_balance": 0,
    "fx_markup_pct": 0,
    "tax_pct": 9.5,  # УСН 6% + чеки 1.5% + эквайринг 2%, as the old accounting table counted
    "status_stages": {
        "Ожидает оплаты": STAGE_SKIP,
        "Заказ принят в обработку": STAGE_AWAITING,
        "Ожидает выхода в продажу": STAGE_AWAITING,  # a preorder is bought when it is released
        "Заказ ожидает отправки из магазина": STAGE_BOUGHT,
        "Заказ едет на склад США": STAGE_BOUGHT,
        "Заказ начал сортировку на складе США": STAGE_BOUGHT,
        "Ожидает рассылки из США": STAGE_BOUGHT,
        "Заказ отправлен из США на наш склад в Россию": STAGE_SHIPPED,
        "Заказ проходит таможенное оформление": STAGE_SHIPPED,
        "Заказ прибыл в магазин и готов к выдаче": STAGE_SHIPPED,
        "Выдано": STAGE_DONE,
    },
    "shipping_norms": {},  # product kind -> planned shipping to Russia, rubles
}

EVENT_KINDS = ("payment", "tax", "purchase", "shipping")


def merged_settings(stored):
    s = {**DEFAULT_SETTINGS, **(stored or {})}
    s["status_stages"] = {**DEFAULT_SETTINGS["status_stages"], **((stored or {}).get("status_stages") or {})}
    s["shipping_norms"] = {**((stored or {}).get("shipping_norms") or {})}
    return s


def stage_of(status, settings):
    """Stage of a status; a status the settings do not know is treated as not yet bought (the safe side)."""
    return settings["status_stages"].get(status, STAGE_AWAITING)


def _pos(v):
    return int(v) if v is not None and int(v) > 0 else None


def order_money(o, settings):
    """Everything the accounting needs about one order, from the order alone."""
    price = int(o.get("total_price") or 0)
    received = int(o.get("paid_amount") or 0)
    stage = stage_of(o.get("status"), settings)

    purchase_fact = _pos(o.get("cost_price"))
    purchase_plan = _pos(o.get("planned_purchase_cost"))
    purchase = purchase_fact or purchase_plan

    ship_fact = _pos(o.get("delivery_cost"))
    ship_plan = _pos(o.get("planned_shipping"))
    if ship_plan is None and o.get("product_kind"):
        ship_plan = _pos(settings["shipping_norms"].get(o["product_kind"]))
    shipping = ship_fact or ship_plan

    tax = round(price * float(settings["tax_pct"]) / 100)
    need_purchase = (purchase or 0) if stage == STAGE_AWAITING else 0
    need_shipping = (shipping or 0) if stage in (STAGE_AWAITING, STAGE_BOUGHT) else 0
    exact = purchase_fact is not None and ship_fact is not None
    return {
        "id": o.get("id"),
        "stage": stage,
        "price": price,
        "received": received,
        "purchase": purchase, "purchase_is_fact": purchase_fact is not None,
        "shipping": shipping, "shipping_is_fact": ship_fact is not None,
        "tax": tax,
        "need_purchase": need_purchase,
        "need_shipping": need_shipping,
        "need": need_purchase + need_shipping,
        "profit": price - (purchase or 0) - (shipping or 0) - tax,
        "exact": exact,
        "missing_purchase": purchase is None and stage != STAGE_SKIP,
        "missing_shipping": shipping is None and stage != STAGE_SKIP,
        "unknown_status": o.get("status") not in settings["status_stages"],
    }


def expected_flows(o, settings, deleted=False):
    """How much money in each category this order should have moved so far (income +, spending -).
    Taxes are not here: they follow each payment at the rate of that moment (see reconcile)."""
    zero = {"payment": 0, "purchase": 0, "shipping": 0}
    if deleted:
        return zero
    m = order_money(o, settings)
    if m["stage"] == STAGE_SKIP:
        return zero
    return {
        "payment": m["received"],
        "purchase": -(m["purchase"] or 0) if m["stage"] >= STAGE_BOUGHT else 0,
        "shipping": -(m["shipping"] or 0) if m["stage"] >= STAGE_SHIPPED else 0,
    }


def reconcile(expected, recorded, tax_pct):
    """Events that bring the recorded totals to the expected ones: [(kind, amount)] without zeros.
    Every change of the received money carries its tax, so a later change of the tax rate never rewrites the past."""
    out = []
    for k in ("payment", "purchase", "shipping"):
        diff = expected[k] - recorded.get(k, 0)
        if diff:
            out.append((k, diff))
            if k == "payment":
                tax = -round(diff * float(tax_pct) / 100)
                if tax:
                    out.append(("tax", tax))
    return out


def parse_day(value):
    """'2026-11-01', '01.11.2026', a date or a datetime -> date; anything else -> None."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    v = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            pass
    return None


def month_key(day):
    return f"{day.year:04d}-{day.month:02d}"


def summary(orders, events, ledger, withdrawals, settings, month):
    """The three cards, the attention list, the per-order table and the profit by month.

    orders: order dicts (with completed_at); events: dicts {created_at, kind, amount, order_id};
    ledger: {entry_date, amount, entry_type}; withdrawals: {wd_date, amount}; month: 'YYYY-MM'.
    """
    start = parse_day(settings["start_date"]) or date(2026, 11, 1)
    counted = lambda d: (parse_day(d) or date.min) >= start

    # the accounting starts on start_date: orders placed before it are left out entirely, with all their money
    def placed(o):
        return parse_day(o.get("order_date")) or parse_day(o.get("created_at"))
    old_ids = {o.get("id") for o in orders if (placed(o) or date.min) < start}
    orders = [o for o in orders if o.get("id") not in old_ids]
    events = [e for e in events if e.get("order_id") not in old_ids]
    rows = [order_money(o, settings) | {"order": o} for o in orders]
    active = [r for r in rows if r["stage"] in (STAGE_AWAITING, STAGE_BOUGHT, STAGE_SHIPPED)]

    need_purchase = sum(r["need_purchase"] for r in active)
    need_shipping = sum(r["need_shipping"] for r in active)
    need_approx = any(
        (r["stage"] == STAGE_AWAITING and (r["missing_purchase"] or not r["purchase_is_fact"]))
        or (r["stage"] in (STAGE_AWAITING, STAGE_BOUGHT) and (r["missing_shipping"] or not r["shipping_is_fact"]))
        for r in active)

    cash = int(settings["start_balance"] or 0)
    cash += sum(int(e["amount"]) for e in events if counted(e["created_at"]))
    cash += sum(int(l["amount"]) * (1 if l["entry_type"] == "income" else -1) for l in ledger if counted(l["entry_date"]))
    withdrawn_total = sum(int(w["amount"]) for w in withdrawals if counted(w["wd_date"]))
    cash -= withdrawn_total
    available = cash - need_purchase - need_shipping

    months = {}

    def bucket(key):
        return months.setdefault(key, {"month": key, "done": 0, "profit": 0, "approx": False, "other": 0, "withdrawn": 0})

    for r in rows:
        done_day = parse_day(r["order"].get("completed_at"))
        if r["stage"] == STAGE_DONE and done_day and done_day >= start and r["received"] >= r["price"]:
            b = bucket(month_key(done_day))
            b["done"] += 1
            b["profit"] += r["profit"]
            b["approx"] = b["approx"] or not r["exact"]
    for l in ledger:
        d = parse_day(l["entry_date"])
        if d and d >= start:
            bucket(month_key(d))["other"] += int(l["amount"]) * (1 if l["entry_type"] == "income" else -1)
    for w in withdrawals:
        d = parse_day(w["wd_date"])
        if d and d >= start:
            bucket(month_key(d))["withdrawn"] += int(w["amount"])
    for b in months.values():
        b["total"] = b["profit"] + b["other"]
    current = months.get(month) or {"month": month, "done": 0, "profit": 0, "approx": False, "other": 0, "withdrawn": 0, "total": 0}

    attention = []
    def flag(n, text):
        if n:
            attention.append({"count": n, "text": text})
    flag(sum(1 for r in active if r["missing_purchase"] and r["stage"] == STAGE_AWAITING), "ждут выкупа, но не известна стоимость закупки")
    flag(sum(1 for r in active if r["missing_shipping"] and r["stage"] in (STAGE_AWAITING, STAGE_BOUGHT)), "не известна стоимость доставки до РФ")
    flag(sum(1 for r in rows if r["unknown_status"] and r["stage"] != STAGE_SKIP), "со статусом, который не размечен в настройках")
    flag(sum(1 for r in rows if r["stage"] == STAGE_DONE and counted(r["order"].get("completed_at")) and r["received"] < r["price"]),
         "выданы, но оплачены не полностью")

    return {
        "start_date": start.isoformat(),
        "need": {"total": need_purchase + need_shipping, "purchase": need_purchase, "shipping": need_shipping, "approx": need_approx},
        "available": {"value": available, "cash": cash, "withdrawn_total": withdrawn_total},
        "month": current,
        "months": sorted(months.values(), key=lambda b: b["month"], reverse=True),
        "attention": attention,
        "orders": [
            {k: v for k, v in r.items() if k != "order"} | {
                "items": r["order"].get("items", ""), "status": r["order"].get("status", ""),
                "archived": bool(r["order"].get("archived")),
            }
            for r in sorted(active, key=lambda r: -(r["id"] or 0))
        ],
    }


def planned_snapshot(qty_by_product, products, usd_rate, settings):
    """Planned purchase and shipping of a new order, copied from the product cards at the moment of the order.

    Returns the columns to store in the order. A cost stays None when any product lacks the number,
    so the accounting flags it instead of silently counting zero."""
    purchase, shipping, usd_total, kind = 0, 0, 0.0, ""
    purchase_known = shipping_known = bool(qty_by_product)
    for pid, qty in qty_by_product.items():
        p = products.get(pid) or {}
        kind = kind or (p.get("product_kind") or "")
        usd = p.get("purchase_usd")
        if usd is not None and float(usd) > 0 and usd_rate:
            usd_total += float(usd) * qty
            purchase += round(float(usd) * qty * usd_rate)
        else:
            purchase_known = False
        ship = p.get("planned_shipping_rub")
        if ship is None and p.get("product_kind"):
            ship = settings["shipping_norms"].get(p["product_kind"])
        if ship is not None and int(ship) > 0:
            shipping += int(ship) * qty
        else:
            shipping_known = False
    return {
        "planned_purchase_cost": purchase if purchase_known else None,
        "planned_shipping": shipping if shipping_known else None,
        "purchase_usd": round(usd_total, 2) if purchase_known else None,
        "fx_rate": round(usd_rate, 4) if purchase_known and usd_rate else None,
        "product_kind": kind,
    }


def parse_cbr_usd(payload):
    """USD rate from the CBR daily feed: the official XML (Value 81,2345) or the cbr-xml-daily JSON mirror."""
    import json as _json
    import re as _re
    text = payload.decode("windows-1251", "replace") if isinstance(payload, (bytes, bytearray)) else str(payload)
    m = _re.search(r"<CharCode>USD</CharCode>.*?<Nominal>(\d+)</Nominal>.*?<Value>([\d,\.]+)</Value>", text, _re.S)
    if m:
        return float(m.group(2).replace(",", ".")) / int(m.group(1))
    try:
        usd = _json.loads(text)["Valute"]["USD"]
        return float(usd["Value"]) / int(usd.get("Nominal", 1))
    except (ValueError, KeyError, TypeError):
        return None


def rate_with_markup(cbr_rate, markup_pct):
    return round(cbr_rate * (1 + float(markup_pct or 0) / 100), 4) if cbr_rate else None
