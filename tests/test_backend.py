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
