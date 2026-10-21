"""Backend unit tests. They import `main` and use TestClient WITHOUT startup, so the database is never contacted."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import main
from fastapi.testclient import TestClient

CLIENT = TestClient(main.app)


def test_checkout_requires_a_valid_email():
    base = dict(items=[{"id": 1, "qty": 1}], first_name="A", phone="+79990000000", telegram="@a")
    assert main.valid_email("buyer@example.com")
    for bad in ("", "no-at-sign", "a@b", "a b@c.de", "@c.de"):
        assert not main.valid_email(bad), bad
    assert "email" in main.CheckoutRequest.model_fields
    assert main.CheckoutRequest.model_fields["email"].is_required()
    assert main.CheckoutRequest.model_fields["marketing_consent"].default is False


def test_products_carry_a_description():
    for model in (main.ProductCreate, main.ProductUpdate):
        assert model.model_fields["description"].default == ""


def test_listed_hosts_redirect_to_the_canonical_domain(monkeypatch):
    monkeypatch.setattr(main, "CANONICAL_HOST", "funkostop.org")
    monkeypatch.setattr(main, "REDIRECT_HOSTS", {"funkostop.ru", "www.funkostop.org"})
    r = CLIENT.get("/catalog?product=3", headers={"host": "funkostop.ru"}, follow_redirects=False)
    assert r.status_code == 301 and r.headers["location"] == "https://funkostop.org/catalog?product=3", (r.status_code, r.headers.get("location"))
    r = CLIENT.get("/", headers={"host": "www.funkostop.org"}, follow_redirects=False)
    assert r.status_code == 301 and r.headers["location"] == "https://funkostop.org/"


def test_other_hosts_are_never_redirected(monkeypatch):
    monkeypatch.setattr(main, "CANONICAL_HOST", "funkostop.org")
    monkeypatch.setattr(main, "REDIRECT_HOSTS", {"funkostop.ru"})
    for host in ("funkostop.org", "localhost:8000", "127.0.0.1:8000", "funko-web.onrender.com"):
        r = CLIENT.get("/robots.txt", headers={"host": host}, follow_redirects=False)
        assert r.status_code == 200, (host, r.status_code)


def _sql_arity(fn, sql_marker):
    """Max $N placeholder in the first SQL containing marker must equal the number of values passed after it."""
    import inspect, re
    src = inspect.getsource(fn)
    block = src[src.index(sql_marker):]
    sql_end = block.index('""",')
    sql = block[:sql_end]
    args_part = block[sql_end + 4:]
    args_part = args_part[:re.search(r"\n\s*\)\s*\n", args_part).start()]
    placeholders = max(int(n) for n in re.findall(r"\$(\d+)", sql))
    args = [a for a in re.split(r",\s*(?![^()]*\))", " ".join(args_part.split())) if a.strip()]
    return placeholders, len(args)


def test_product_sql_placeholders_match_their_values():
    for fn, marker in ((main.create_product, "INSERT INTO products"), (main.update_product, "UPDATE products")):
        ph, n = _sql_arity(fn, marker)
        assert ph == n, f"{fn.__name__}: {ph} placeholders but {n} values"


def test_www_redirects_even_with_no_extra_domains(monkeypatch):
    monkeypatch.setattr(main, "CANONICAL_HOST", "funkostop.org")
    monkeypatch.setattr(main, "REDIRECT_HOSTS", main.build_redirect_hosts("funkostop.org", ""))
    r = CLIENT.get("/orders", headers={"host": "www.funkostop.org"}, follow_redirects=False)
    assert r.status_code == 301 and r.headers["location"] == "https://funkostop.org/orders"
    assert main.build_redirect_hosts("funkostop.org", "") == {"www.funkostop.org"}
    assert main.build_redirect_hosts("funkostop.org", "a.ru, b.ru") == {"www.funkostop.org", "a.ru", "b.ru"}


def test_cart_lines_are_summed_per_product():
    items = [main.CartItem(id=5, name="a", qty=2), main.CartItem(id=5, name="a", qty=3), main.CartItem(id=9, name="b", qty=1), main.CartItem(id=7, name="c", qty=0)]
    assert main.aggregate_cart_qty(items) == {5: 5, 9: 1, 7: 1}   # qty < 1 counts as 1, like the price calculation


def test_stock_items_round_trip_and_garbage_is_ignored():
    assert main.parse_stock_items(main.dump_stock_items([(5, 2), (9, 1)])) == [(5, 2), (9, 1)]
    for bad in ("", None, "not json", "{}", '[["x", 1]]', "[[1]]"):
        assert main.parse_stock_items(bad) == [], bad


def test_products_have_an_optional_stock_quantity():
    for model in (main.ProductCreate, main.ProductUpdate):
        f = model.model_fields["stock_qty"]
        assert f.default is None
    assert main.ProductCreate(name="x", price=1, stock_qty=10).stock_qty == 10
    assert main.ProductCreate(name="x", price=1).stock_qty is None


def test_checkout_orders_insert_has_matching_placeholders():
    ph, n = _sql_arity(main.process_checkout, "INSERT INTO orders")
    assert ph == n, f"{ph} placeholders but {n} values"


def test_products_route_serves_the_app():
    r = CLIENT.get("/products")
    assert r.status_code == 200 and "<html" in r.text.lower()


def test_hidden_product_visibility_rules():
    shown = {"hidden": False, "link_key": "abc"}
    secret = {"hidden": True, "link_key": "s3cretKEY"}
    assert main.product_visible(shown, is_admin=False, key="")
    assert not main.product_visible(secret, is_admin=False, key="")
    assert not main.product_visible(secret, is_admin=False, key="wrong")
    assert not main.product_visible(secret, is_admin=False, key=None)
    assert main.product_visible(secret, is_admin=False, key="s3cretKEY")
    assert main.product_visible(secret, is_admin=True, key="")
    # a hidden product that somehow has no key can only be seen by admins
    assert not main.product_visible({"hidden": True, "link_key": ""}, is_admin=False, key="")
    assert not main.product_visible({"hidden": True, "link_key": None}, is_admin=False, key=None)


def test_link_keys_are_unguessable():
    keys = {main.make_link_key() for _ in range(200)}
    assert len(keys) == 200 and all(len(k) >= 10 for k in keys)


def test_products_can_be_hidden():
    for model in (main.ProductCreate, main.ProductUpdate):
        assert model.model_fields["hidden"].default is False


def test_public_listing_never_leaks_hidden_products_or_keys():
    rows = [{"id": 1, "hidden": False, "link_key": "a", "name": "x"}, {"id": 2, "hidden": True, "link_key": "b", "name": "y"}]
    guest = main.public_catalog(rows, is_admin=False)
    assert [r["id"] for r in guest] == [1] and all("link_key" not in r for r in guest)
    admin = main.public_catalog(rows, is_admin=True)
    assert [r["id"] for r in admin] == [1, 2] and admin[1]["link_key"] == "b"


def test_a_hidden_product_opened_by_key_is_returned_without_the_key():
    row = {"id": 2, "hidden": True, "link_key": "KEY123KEY1", "name": "y"}
    payload = main.product_payload(row, is_admin=False)
    assert payload["id"] == 2 and "link_key" not in payload
    assert main.product_payload(row, is_admin=True)["link_key"] == "KEY123KEY1"


DB_PRODUCTS = {
    5: {"id": 5, "name": "Real Name", "figure_number": "77", "price": 4000, "final_price": 3000, "photo_id": "PH1,PH2"},
    9: {"id": 9, "name": "No Discount", "figure_number": "", "price": 1500, "final_price": 0, "photo_id": ""},
}


def test_prices_come_from_the_database_not_from_the_browser():
    cheat = main.CartItem(id=5, name="Totally Free", figure_number="1", price=1, final_price=1, photo_id="HACK", qty=2)
    total, lines, photo = main.price_cart([cheat], DB_PRODUCTS)
    assert total == 6000, total                      # 2 x 3000, not 2 x 1
    assert lines[0] == "77 - Real Name x2", lines[0]      # same house format as older orders; the total lives in its own column
    assert "Totally Free" not in lines[0]
    assert photo == "PH1"                             # first photo of the real product


def test_price_falls_back_to_the_base_price_and_sums_lines():
    items = [main.CartItem(id=9, name="x", qty=1), main.CartItem(id=5, name="x", qty=1), main.CartItem(id=9, name="x", qty=2)]
    total, lines, _ = main.price_cart(items, DB_PRODUCTS)
    assert total == 1500 + 3000 + 3000 and len(lines) == 3


def test_unknown_products_are_rejected():
    import pytest
    with pytest.raises(ValueError):
        main.price_cart([main.CartItem(id=404, name="ghost", price=1, final_price=1)], DB_PRODUCTS)


def test_absurd_quantities_are_capped_and_never_negative():
    total, _, _ = main.price_cart([main.CartItem(id=9, name="x", qty=-5)], DB_PRODUCTS)
    assert total == 1500
    total, _, _ = main.price_cart([main.CartItem(id=9, name="x", qty=10**9)], DB_PRODUCTS)
    assert total == 1500 * main.MAX_LINE_QTY


def test_order_line_matches_the_format_of_older_orders():
    assert main.order_line_text({"name": "Vox", "figure_number": "2536"}, 1) == "2536 - Vox"
    assert main.order_line_text({"name": "Vox", "figure_number": "2536"}, 3) == "2536 - Vox x3"
    assert main.order_line_text({"name": "Vox", "figure_number": ""}, 1) == "Vox"
    assert main.order_line_text({"name": "Vox", "figure_number": None}, 2) == "Vox x2"


def test_admin_alert_says_plainly_when_the_order_is_not_paid():
    unpaid = main.new_order_title(479, payment_pending=True)
    assert "479" in unpaid and "НЕ оплачен" in unpaid
    manual = main.new_order_title(480, payment_pending=False)
    assert "НЕ оплачен" not in manual
    assert "ОПЛАЧЕН" in main.paid_order_title(479)


def test_tbank_token_signs_booleans_like_the_bank(monkeypatch):
    import hashlib
    monkeypatch.setattr(main, "TBANK_PASSWORD", "pw")
    got = main.tbank_generate_token({"Success": True, "OrderId": "480", "Status": "CONFIRMED"})
    # alphabetical by key: OrderId, Password, Status, Success
    assert got == hashlib.sha256("480pwCONFIRMEDtrue".encode()).hexdigest()


def test_paid_alert_has_everything_the_manager_needs():
    order = {"id": 480, "customer_name": "Ален", "customer_phone": "+77054540001", "customer_tg": "@monya325",
             "items": "2536 - Vox", "total_price": 2, "paid_amount": 1, "payment_type": "50%"}
    text = main.paid_alert_text(order, 184, "a@b.ru", "📦 Доставка: СДЭК\n💬 Комментарий: позвонить")
    for part in ("ОПЛАЧЕН", "480", "184", "+77054540001", "@monya325", "a@b.ru", "СДЭК", "позвонить", "2536 - Vox", "50%"):
        assert part in text
    assert "Почта: —" in main.paid_alert_text(order, 184, "", "")


def test_awaiting_payment_orders_are_kept_out_of_every_order_list():
    import inspect
    src = inspect.getsource(main.dashboard) if hasattr(main, "dashboard") else open(main.__file__, encoding="utf-8").read()
    lists = [l for l in src.splitlines() if "FROM orders WHERE" in l and "archived" in l]
    assert len(lists) >= 4
    assert all("status <> 'Ожидает оплаты'" in l for l in lists)


def test_throttle_locks_after_the_limit_and_unlocks_later():
    fails, locked, updated = 0, 0.0, 0.0
    for i in range(9):
        fails, locked = main.throttle_after_failure(fails, locked, 100.0, 100.0, 10)
        updated = 100.0
    assert locked == 0
    fails, locked = main.throttle_after_failure(fails, locked, updated, 100.0, 10)
    assert locked == 100.0 + main.THROTTLE_LOCK_SECONDS
    # after the lock ends the count starts again
    fails, locked = main.throttle_after_failure(fails, locked, updated, locked + 1, 10)
    assert (fails, locked) == (1, 0.0)


def test_throttle_forgets_old_failures():
    fails, locked = main.throttle_after_failure(9, 0.0, 0.0, main.THROTTLE_FORGET_SECONDS + 1, 10)
    assert (fails, locked) == (1, 0.0)


def test_client_ip_prefers_the_cloudflare_header():
    class R:
        def __init__(self, headers, host="10.0.0.1"):
            self.headers = headers
            self.client = type("C", (), {"host": host})()
    assert main.client_ip(R({"cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9"})) == "1.2.3.4"
    assert main.client_ip(R({"x-forwarded-for": "5.6.7.8, 10.1.1.1"})) == "5.6.7.8"
    assert main.client_ip(R({})) == "10.0.0.1"


def test_expire_unpaid_orders_returns_stock_and_skips_orders_paid_meanwhile():
    import asyncio

    class FakeDB:
        def __init__(self):
            self.executed = []

        async def fetch(self, sql, *args):
            return [{"id": 1}, {"id": 2}]

        async def fetchrow(self, sql, *args):
            # order 1 is still unpaid and is removed; order 2 got paid between the two queries
            return {"stock_items": main.dump_stock_items([(5, 2)])} if args[0] == 1 else None

        async def execute(self, sql, *args):
            self.executed.append(args)

    db = FakeDB()
    assert asyncio.run(main.expire_unpaid_orders(db)) == 1
    assert db.executed == [(2, 5)]


def test_login_error_does_not_reveal_the_limit():
    import inspect
    src = inspect.getsource(main.login)
    assert "попыт" not in src.lower() and "заблок" not in src.lower()


def test_purchase_validation_keeps_the_expected_date_only_for_preorders():
    ok = main.clean_purchase(main.PurchaseIn(title=" Vox ", amount=100, purchase_date="2026-10-21", kind="stock", expected_date="2026-12-01"))
    assert ok["title"] == "Vox" and ok["expected_date"] == ""
    pre = main.clean_purchase(main.PurchaseIn(title="Vox", kind="preorder", expected_date="2026-12-01"))
    assert pre["expected_date"] == "2026-12-01"
    for bad in (dict(title=""), dict(title="x", kind="other"), dict(title="x", amount=-1), dict(title="x", purchase_date="21.10.2026")):
        try:
            main.clean_purchase(main.PurchaseIn(**bad))
        except ValueError:
            continue
        raise AssertionError(bad)


def test_promo_validation():
    assert main.clean_promo(main.PromoCodeIn(code=" SPOOKY ", value=20))["code"] == "SPOOKY"
    for bad in (dict(code=""), dict(code="X", value=101), dict(code="X", value_kind="usd"), dict(code="X", value=-5)):
        try:
            main.clean_promo(main.PromoCodeIn(**bad))
        except ValueError:
            continue
        raise AssertionError(bad)


def test_register_columns_match_the_sql():
    import inspect, re
    for fn, cols in ((main.create_purchase, main.PURCHASE_COLS), (main.update_purchase, main.PURCHASE_COLS),
                     (main.create_promocode, main.PROMO_COLS), (main.update_promocode, main.PROMO_COLS)):
        src = inspect.getsource(fn)
        top = max(int(n) for n in re.findall(r"\$(\d+)", src))
        extra = 1 if fn.__name__.startswith("update") else 0
        assert top == len(cols) + extra, fn.__name__


def test_admin_register_pages_are_served():
    from fastapi.testclient import TestClient
    client = TestClient(main.app)
    for path in ("/purchases", "/promocodes"):
        assert client.get(path).status_code == 200


def test_order_email_puts_the_order_first_and_escapes_client_text():
    order = {"id": 482, "items": "2536 - Vox\n1975 - Damon x2", "total_price": 6000, "paid_amount": 3000,
             "customer_name": "<b>Ален</b>", "customer_phone": "+77054540001", "photo_id": "abc,def"}
    subject, html, text = main.order_email(order, "📦 Доставка: СДЭК\n💬 Комментарий: x")
    assert "482" in subject
    assert html.index("2536 - Vox") < html.index("Ваши данные")
    assert "Осталось доплатить" in html and "3 000 ₽" in html
    assert "&lt;b&gt;Ален&lt;/b&gt;" in html and "<b>Ален</b>" not in html
    assert "/api/photos/abc" in html and "def" not in html.split("/api/photos/")[1][:10]
    assert "СДЭК" in html
    assert "Осталось доплатить" not in main.order_email({**order, "paid_amount": 6000})[1]


def test_order_email_is_skipped_without_smtp_settings(monkeypatch):
    import asyncio
    monkeypatch.setattr(main, "SMTP_USER", "")
    assert asyncio.run(main.send_order_email("a@b.ru", {"id": 1})) is False
