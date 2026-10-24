import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import finance as F

S = F.merged_settings({"start_date": "2026-11-01", "start_balance": 10000, "tax_pct": 10})


def order(**kw):
    base = {"id": 1, "items": "Vox", "status": "Заказ принят в обработку", "total_price": 4000, "paid_amount": 2000,
            "cost_price": 0, "delivery_cost": 0, "planned_purchase_cost": 1500, "planned_shipping": 700,
            "order_date": "02.11.2026"}
    return base | kw


def test_awaiting_purchase_reserves_purchase_and_shipping():
    m = F.order_money(order(), S)
    assert (m["need_purchase"], m["need_shipping"], m["need"]) == (1500, 700, 2200)
    assert m["profit"] == 4000 - 1500 - 700 - 400 and not m["exact"]


def test_bought_releases_the_purchase_reserve_but_keeps_shipping():
    m = F.order_money(order(status="Заказ ожидает отправки из магазина", cost_price=1430), S)
    assert (m["need_purchase"], m["need_shipping"]) == (0, 700)
    assert m["purchase"] == 1430 and m["purchase_is_fact"]


def test_shipping_paid_and_done_need_nothing():
    for status in ("Заказ отправлен из США на наш склад в Россию", "Выдано"):
        assert F.order_money(order(status=status), S)["need"] == 0


def test_unknown_status_is_treated_as_not_bought_and_flagged():
    m = F.order_money(order(status="Что-то новое"), S)
    assert m["need_purchase"] == 1500 and m["unknown_status"]


def test_fact_wins_over_plan_and_a_missing_cost_is_flagged():
    assert F.order_money(order(cost_price=1600), S)["purchase"] == 1600
    m = F.order_money(order(planned_purchase_cost=None), S)
    assert m["missing_purchase"] and m["need_purchase"] == 0


def test_shipping_norm_by_product_kind_fills_a_missing_plan():
    s = F.merged_settings({"shipping_norms": {"Deluxe": 1400}})
    assert F.order_money(order(planned_shipping=None, product_kind="Deluxe"), s)["shipping"] == 1400


def test_reconcile_records_only_the_difference():
    o = order(status="Заказ ожидает отправки из магазина")
    exp = F.expected_flows(o, S)
    assert exp == {"payment": 2000, "purchase": -1500, "shipping": 0}
    first = F.reconcile(exp, {}, 10)
    assert first == [("payment", 2000), ("tax", -200), ("purchase", -1500)]
    assert F.reconcile(exp, exp, 10) == []
    # client pays the rest: only the new money and its tax are added
    exp2 = F.expected_flows(o | {"paid_amount": 4000}, S)
    assert F.reconcile(exp2, exp, 10) == [("payment", 2000), ("tax", -200)]
    # status rolled back to awaiting purchase: the purchase is undone, not doubled
    exp3 = F.expected_flows(o | {"paid_amount": 4000, "status": "Заказ принят в обработку"}, S)
    assert F.reconcile(exp3, exp2, 10) == [("purchase", 1500)]
    # a deleted order reverses everything it recorded
    assert F.reconcile(F.expected_flows(o, S, deleted=True), exp, 10) == [("payment", -2000), ("tax", 200), ("purchase", 1500)]


def test_a_new_tax_rate_applies_to_new_payments_only():
    o = order(status="Заказ ожидает отправки из магазина")
    recorded = F.expected_flows(o, S)  # paid 2000 at 10%
    assert F.reconcile(recorded, recorded, 6) == []
    assert F.reconcile(F.expected_flows(o | {"paid_amount": 3000}, S), recorded, 6) == [("payment", 1000), ("tax", -60)]


def test_awaiting_payment_orders_move_no_money():
    assert F.expected_flows(order(status="Ожидает оплаты"), S) == {"payment": 0, "purchase": 0, "shipping": 0}


def test_available_is_cash_minus_what_is_still_needed_and_ignores_history_before_the_start():
    orders = [order(id=1), order(id=2, status="Заказ ожидает отправки из магазина")]
    events = [
        {"created_at": "2026-10-21", "kind": "payment", "amount": 99999, "order_id": 9},  # baseline, before the start
        {"created_at": "2026-11-03", "kind": "payment", "amount": 2000, "order_id": 1},
        {"created_at": "2026-11-03", "kind": "tax", "amount": -200, "order_id": 1},
    ]
    ledger = [{"entry_date": "05.11.2026", "amount": 500, "entry_type": "expense"}]
    withdrawals = [{"wd_date": "2026-11-10", "amount": 3000}]
    out = F.summary(orders, events, ledger, withdrawals, S, "2026-11")
    assert out["need"]["total"] == 2200 + 700
    assert out["available"]["cash"] == 10000 + 2000 - 200 - 500 - 3000
    assert out["available"]["value"] == out["available"]["cash"] - 2900
    assert out["need"]["approx"]


def test_profit_goes_to_the_month_the_order_was_completed_and_withdrawals_do_not_reduce_it():
    done = order(id=5, status="Выдано", paid_amount=4000, cost_price=1450, delivery_cost=700, completed_at="2026-11-20")
    half = order(id=6, status="Выдано", paid_amount=2000, completed_at="2026-11-21")
    old = order(id=7, status="Выдано", paid_amount=4000, completed_at="2026-10-01")
    out = F.summary([done, half, old], [], [], [{"wd_date": "2026-11-12", "amount": 25000}], S, "2026-11")
    nov = out["month"]
    assert nov["done"] == 1 and nov["profit"] == 4000 - 1450 - 700 - 400 and not nov["approx"]
    assert nov["withdrawn"] == 25000 and nov["total"] == nov["profit"]
    assert any("оплачены не полностью" in a["text"] for a in out["attention"])
    assert all(m["month"] >= "2026-11" for m in out["months"])


def test_parse_day_reads_both_formats():
    assert F.parse_day("01.11.2026") == F.parse_day("2026-11-01")
    assert F.parse_day("") is None and F.parse_day("bad") is None


def test_snapshot_copies_purchase_and_shipping_from_the_product_card():
    products = {1: {"purchase_usd": 24.99, "planned_shipping_rub": 700, "product_kind": "Standard Pop"},
                2: {"purchase_usd": 75, "planned_shipping_rub": None, "product_kind": "Deluxe"}}
    s = F.merged_settings({"shipping_norms": {"Deluxe": 1400}})
    snap = F.planned_snapshot({1: 2, 2: 1}, products, 82.0, s)
    assert snap["planned_purchase_cost"] == round(24.99 * 2 * 82) + round(75 * 82)
    assert snap["planned_shipping"] == 700 * 2 + 1400
    assert snap["fx_rate"] == 82.0 and snap["product_kind"] == "Standard Pop"


def test_snapshot_leaves_unknown_costs_empty():
    snap = F.planned_snapshot({1: 1}, {1: {"purchase_usd": None, "planned_shipping_rub": 0}}, 82.0, S)
    assert snap["planned_purchase_cost"] is None and snap["planned_shipping"] is None
    assert F.planned_snapshot({1: 1}, {1: {"purchase_usd": 10}}, None, S)["planned_purchase_cost"] is None


def test_cbr_rate_parsing_and_markup():
    xml = '<ValCurs><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>81,2345</Value></Valute></ValCurs>'
    assert F.parse_cbr_usd(xml.encode("windows-1251")) == 81.2345
    assert F.parse_cbr_usd('{"Valute": {"USD": {"Nominal": 1, "Value": 80.5}}}') == 80.5
    assert F.parse_cbr_usd("garbage") is None
    assert F.rate_with_markup(80.0, 3) == 82.4 and F.rate_with_markup(None, 3) is None


def test_orders_placed_before_the_start_are_left_out():
    old = order(id=1, order_date="20.10.2026")
    new = order(id=2, order_date="03.11.2026")
    events = [{"created_at": "2026-11-05", "kind": "payment", "amount": 500, "order_id": 1},
              {"created_at": "2026-11-05", "kind": "payment", "amount": 700, "order_id": 2}]
    out = F.summary([old, new], events, [], [], S, "2026-11")
    assert [o["id"] for o in out["orders"]] == [2]
    assert out["need"]["total"] == 2200
    assert out["available"]["cash"] == 10000 + 700


def test_waiting_for_release_is_not_bought_yet():
    assert F.order_money(order(status="Ожидает выхода в продажу"), S)["need_purchase"] == 1500
