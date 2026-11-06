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
    text = main.paid_alert_text(order, 184, "a@b.ru", "📦 Доставка: Авито Доставка\n💬 Комментарий: позвонить")
    for part in ("ОПЛАЧЕН", "480", "184", "+77054540001", "@monya325", "a@b.ru", "Авито Доставка", "позвонить", "2536 - Vox", "50%"):
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
    assert db.executed == [(2, 5), (1,), (1,)]  # stock back, then the order's promo codes released


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
    subject, html, text = main.order_email(order, "📦 Доставка: Авито Доставка\n💬 Комментарий: x")
    assert "482" in subject
    assert html.index("2536 - Vox") < html.index("Ваши данные")
    assert "Осталось доплатить" in html and "3 000 ₽" in html
    assert "&lt;b&gt;Ален&lt;/b&gt;" in html and "<b>Ален</b>" not in html
    assert "/api/photos/" not in html
    assert "Авито Доставка" in html
    assert "Осталось доплатить" not in main.order_email({**order, "paid_amount": 6000})[1]


def test_order_email_is_skipped_without_smtp_settings(monkeypatch):
    import asyncio
    monkeypatch.setattr(main, "SMTP_USER", "")
    assert asyncio.run(main.send_order_email("a@b.ru", {"id": 1})) is False


def test_clients_never_receive_cost_numbers():
    import inspect
    src = inspect.getsource(main.get_dashboard)
    client_part = src[src.index("client_id = user[\"id\"]"):]
    assert "cost_price" not in client_part and "delivery_cost" not in client_part
    row = {"id": 1, "name": "Vox", "link_key": "k", "purchase_usd": 14.99, "planned_shipping_rub": 700, "purchase_source": "Funko.com", "product_kind": "Standard Pop"}
    public = main.product_payload(row, is_admin=False)
    assert not set(main.PRODUCT_PRIVATE_FIELDS) & set(public)
    assert main.product_payload(row, is_admin=True)["purchase_usd"] == 14.99



def test_product_finance_fields_change_only_when_the_form_sends_them():
    old_form = main.ProductUpdate(name="Vox", price=100)
    assert main.product_finance_values(old_form) == {}
    sent = main.ProductUpdate(name="Vox", price=100, purchase_usd=14.999, planned_shipping_rub=0, purchase_source=" Funko.com ", product_kind="Standard Pop")
    assert main.product_finance_values(sent) == {"purchase_usd": 15.0, "planned_shipping_rub": None, "purchase_source": "Funko.com", "product_kind": "Standard Pop"}


def test_upload_accepts_heic_and_fixes_rotation_and_size():
    import io
    from PIL import Image
    import pillow_heif
    buf = io.BytesIO()
    Image.new("RGB", (4000, 3000), (200, 30, 30)).save(buf, format="HEIF")
    out = Image.open(io.BytesIO(main.prepare_upload_image(buf.getvalue())))
    assert out.format == "WEBP" and max(out.size) == 1600
    png = io.BytesIO()
    Image.new("RGBA", (300, 200), (0, 0, 0, 0)).save(png, format="PNG")
    assert Image.open(io.BytesIO(main.prepare_upload_image(png.getvalue()))).mode == "RGBA"


def test_upload_rejects_files_that_are_not_images():
    try:
        main.prepare_upload_image(b"%PDF-1.7 not a photo")
    except ValueError as exc:
        assert "JPG" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_status_email_names_the_status_and_what_is_left_to_pay():
    order = {"id": 480, "items": "2536 - Vox\n1975 - Damon x2", "total_price": 6000, "paid_amount": 3000}
    subject, html, text = main.status_email(order, "Заказ прибыл в магазин и готов к выдаче")
    assert subject == "Заказ #480: прибыл в магазин и готов к выдаче — Funko Stop"
    assert "Напишите менеджеру" in html and "Осталось доплатить" in html and "1975 - Damon x2" in html
    _, html2, _ = main.status_email({**order, "paid_amount": 6000, "items": "<b>x</b>"}, "Выдано")
    assert "Осталось доплатить" not in html2 and "&lt;b&gt;" in html2


def test_mail_photo_is_a_small_jpeg_on_white():
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", (800, 600), (0, 0, 0, 0)).save(buf, format="WEBP")
    out = Image.open(io.BytesIO(main.webp_to_mail_jpeg(buf.getvalue())))
    assert out.format == "JPEG" and max(out.size) == 240 and out.getpixel((5, 5)) == (255, 255, 255)


def test_ai_description_prompt_and_cleanup():
    p = main.DescribeIn(name="Vox", figure_number="2536", category="Funko", series="Hazbin Hotel")
    assert main.describe_user_prompt(p) == "Название: Vox\nНомер: 2536\nБренд: Funko\nСерия: Hazbin Hotel"
    assert main.clean_description('**«Фигурка Vox.**\n\nИз Hazbin Hotel.»') == "Фигурка Vox. Из Hazbin Hotel."


def test_ai_description_is_off_without_a_key(monkeypatch):
    import asyncio
    monkeypatch.setattr(main, "GROQ_API_KEY", "")
    try:
        asyncio.run(main.ai_describe(main.DescribeIn(name="Vox"), admin={"role": "admin"}))
    except main.HTTPException as exc:
        assert exc.status_code == 503
    else:
        raise AssertionError("expected 503")


def test_ai_description_has_no_dashes():
    assert main.clean_description("Вокс — демон-телеведущий. Фигурка – номер 2536.") == "Вокс, демон-телеведущий. Фигурка, номер 2536."


def test_hero_cutout_gives_equal_frames_and_removes_the_white_backdrop():
    import io
    from PIL import Image, ImageDraw
    for size, box in (((800, 800), (250, 150, 550, 700)), ((1200, 900), (100, 100, 400, 500))):
        im = Image.new("RGB", size, (255, 255, 255))
        d = ImageDraw.Draw(im)
        d.rectangle(box, fill=(200, 40, 40))
        d.rectangle((box[0] + 20, box[1] + 20, box[2] - 20, box[1] + 60), fill=(255, 255, 255))  # a white lid inside the box
        buf = io.BytesIO(); im.save(buf, format="PNG")
        out = Image.open(io.BytesIO(main.hero_cutout(buf.getvalue())))
        assert out.size == (main.HERO_W, main.HERO_H)
        assert out.getpixel((5, 5))[3] == 0                       # backdrop gone
        bb = out.getchannel("A").getbbox()
        assert bb[3] >= main.HERO_H - 12                          # every box stands on the same baseline
        assert out.getpixel(((bb[0] + bb[2]) // 2, bb[1] + 12))[3] > 200   # the white lid stays


def test_index_gets_three_catalog_figures():
    page = main.render_index([("Vox", "AAA"), ("Saul <Goodman>", "BBB"), ("Paul", "CCC")])
    assert '/api/photos/AAA/hero.webp' in page and '/api/photos/CCC/hero.webp' in page
    assert "Saul &lt;Goodman&gt;" in page and 'hero-collage from-catalog' in page
    assert 'src="/static/images/hero/dexter-box' not in page  # the default stays only as the onerror fallback
    assert "dexter-box" in main.render_index([])


def test_site_promo_discount_in_rubles_or_percent():
    assert main.promo_discount(300, "rub", 2550) == 300
    assert main.promo_discount(10, "percent", 2550) == 255
    assert main.promo_discount(15, "percent", 1999) == 300


def test_site_promo_validation():
    good = main.clean_site_promo(main.SitePromoIn(code=" funko-300 ", value=300))
    assert good["code"] == "FUNKO300" and good["value_kind"] == "rub" and good["active"] is True
    for bad in ({"code": "ab", "value": 300}, {"code": "FUNKO", "value": 0}, {"code": "FUNKO", "value": 95, "value_kind": "percent"},
                {"code": "FUNKO", "value": 5, "value_kind": "bitcoin"}, {"code": "FUNKO", "value": 5, "max_uses": -1}):
        try:
            main.clean_site_promo(main.SitePromoIn(**bad))
        except ValueError:
            continue
        raise AssertionError(bad)


class FakePromoDb:
    def __init__(self, promo, uses=0):
        self.promo, self.uses = promo, uses

    async def fetchrow(self, sql, *args):
        return self.promo

    async def fetchval(self, sql, *args):
        return self.uses


def test_site_promo_lookup_checks_activity_uses_and_order_sum():
    promo = {"value": 300, "value_kind": "rub", "max_uses": 2, "min_order": 2000, "active": True}
    run = lambda db, total=2550: main.asyncio.run(main.lookup_site_promo(db, "funko300", total))
    assert run(FakePromoDb(promo)) == (300, "")
    assert run(FakePromoDb(None))[0] is None
    assert run(FakePromoDb({**promo, "active": False}))[1] == "Промокод не найден"
    assert run(FakePromoDb(promo, uses=2))[1] == "Промокод закончился"
    assert "от 2 000" in run(FakePromoDb(promo), total=1500)[1]
    assert "дороже" in run(FakePromoDb({**promo, "value": 3000, "min_order": 0}))[1]
    assert run(FakePromoDb({**promo, "value": 10, "value_kind": "percent", "max_uses": 0}))[0] == 255


def test_promo_codes_are_normalised():
    assert main.normalize_promo(" vx3m-igmz ") == "VX3MIGMZ"


def test_hero_cutout_keeps_a_transparent_background_transparent():
    import io
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (600, 800), (0, 0, 0, 0))
    ImageDraw.Draw(im).polygon([(300, 100), (500, 700), (100, 700)], fill=(230, 60, 160, 255))  # a figure, no box
    buf = io.BytesIO(); im.save(buf, format="PNG")
    out = Image.open(io.BytesIO(main.hero_cutout(buf.getvalue()))).convert("RGBA")
    bb = out.getchannel("A").getbbox()
    corner = out.getpixel((bb[0] + 3, bb[1] + 3))   # beside the triangle's tip: was painted black before
    assert corner[3] < 40


def test_mystery_page_is_served_but_linked_from_nowhere():
    from fastapi.testclient import TestClient
    res = TestClient(main.app).get("/mystery")
    assert res.status_code == 200 and "?" in res.text and "noindex" in res.text
    for path in ("static/index.html", "static/app.js", "static/sitemap.xml"):
        assert "mystery" not in open(path, encoding="utf-8").read().lower().replace("mystery one piece", "")


def test_hero_cutout_keeps_the_corners_of_a_transparent_box():
    import io
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (869, 1122), (255, 255, 255, 0))
    ImageDraw.Draw(im).rectangle((50, 50, 818, 1071), fill=(40, 90, 200, 255))
    buf = io.BytesIO(); im.save(buf, format="PNG")
    out, is_box = main.hero_cutout_info(buf.getvalue())
    out = Image.open(io.BytesIO(out)).convert("RGBA")
    assert is_box
    x0, y0, x1, y1 = out.getchannel("A").getbbox()
    assert out.getpixel((x0 + 1, y0 + 1))[3] > 200 and out.getpixel((x1 - 2, y1 - 2))[3] > 200   # the tips stay


def test_catalog_is_open_and_packs_are_gone_from_the_page():
    page = open("static/index.html", encoding="utf-8").read()
    script = open("static/app.js", encoding="utf-8").read()
    for gone in ("catalog-guest-under-dev", "home-new-stub", "Количество паков", "product-packs", "quick-order-packs", "inquiry-packs"):
        assert gone not in page, gone
    for gone in ("catalogOpenForMe", "CATALOG_PREVIEW_CLIENT_IDS", "пак."):
        assert gone not in script, gone


def test_purchase_keeps_the_shop_order_number_and_email():
    v = main.clean_purchase(main.PurchaseIn(title="Vox", order_number=" FO-123 ", email=" buy@mail.ru "))
    assert v["order_number"] == "FO-123" and v["email"] == "buy@mail.ru"
    assert set(main.PURCHASE_COLS) == set(v)


def test_client_filter_is_for_admins_only():
    page = open("static/index.html", encoding="utf-8").read()
    for name in ("orders", "archived"):
        assert f'id="{name}-client-filter" class="filter-input xnarrow admin-only hidden"' in page


def test_delivery_needs_an_address_except_self_pickup():
    assert not main.delivery_address_ok("Авито Доставка", "")
    assert not main.delivery_address_ok("Почта России", "  ")
    assert main.delivery_address_ok("Авито Доставка", "Москва, ПВЗ на Ленина")
    assert main.delivery_address_ok("Самовывоз Новокосино", "")


def test_a_failed_order_email_warns_the_admins_once_and_never_raises(monkeypatch):
    import asyncio
    sent = []
    async def fake_notify(text):
        sent.append(text)
    def boom(*a):
        raise OSError("Network is unreachable")
    monkeypatch.setattr(main, "notify_admins", fake_notify)
    monkeypatch.setattr(main, "_smtp_send", boom)
    monkeypatch.setattr(main, "SMTP_USER", "u")
    monkeypatch.setattr(main, "SMTP_PASSWORD", "p")
    monkeypatch.setitem(main.MAIL_WARNED, "at", 0.0)
    order = {"id": 1, "items": "Vox", "total_price": 10, "paid_amount": 5, "customer_name": "A", "customer_phone": "1", "photo_id": ""}
    assert asyncio.run(main.send_order_email("a@b.ru", order)) is False
    assert asyncio.run(main.send_order_email("a@b.ru", order)) is False
    assert len(sent) == 1 and "Network is unreachable" in sent[0]


def test_phone_must_look_like_a_real_number():
    for good in ("+7 999 123-45-67", "89991234567", "79991234567", "9991234567", "8 (495) 123-45-67", "+77054540001"):
        assert main.normalize_phone(good) and main.normalize_phone(good).startswith("+7") and len(main.normalize_phone(good)) == 12, good
    assert main.normalize_phone("8 (999) 123-45-67") == "+79991234567"
    for bad in ("99999999", "9999999999", "+7 999 999-99-99", "123456", "+375291234567", "1234567890", "", None, "abc"):
        assert main.normalize_phone(bad) is None, bad


def test_mystery_counts_only_after_the_opening_and_up_to_the_goal():
    assert main.mystery_room(0, 100000, 1999, 2000) == 0
    assert main.mystery_room(0, 100000, 2000, 2000) == 100000
    assert main.mystery_room(99990, 100000, 3000, 2000) == 10
    assert main.mystery_room(100000, 100000, 3000, 2000) == 0
    assert main.MYSTERY_OPENS == __import__("datetime").datetime.fromisoformat("2026-11-03T14:00:00+00:00").timestamp()


def test_mystery_limits_clicks_per_address():
    buckets = {}
    assert main.mystery_allowed(buckets, "1.1.1.1", 50, 100.0) == 50
    assert main.mystery_allowed(buckets, "1.1.1.1", 50, 100.0) == 10   # the saved-up burst is spent
    assert main.mystery_allowed(buckets, "2.2.2.2", 50, 100.0) == 50   # another visitor is not affected
    assert main.mystery_allowed(buckets, "1.1.1.1", 50, 102.0) == 30   # 15 a second come back


class FakeMysteryDb:
    def __init__(self):
        self.cells = {}

    async def fetch(self, query, *args):
        return [{"slot": s, "photo_id": p} for s, p in sorted(self.cells.items())]

    async def execute(self, query, *args):
        if query.startswith("DELETE"):
            self.cells.pop(args[0], None)
        else:
            self.cells[args[0]] = args[1]

    async def fetchval(self, query, *args):
        return 0


class FakeMysteryPool:
    def __init__(self, db):
        self.db = db

    def acquire(self):
        pool = self

        class Ctx:
            async def __aenter__(self):
                return pool.db

            async def __aexit__(self, *exc):
                return False
        return Ctx()


def mystery_picture(transparent):
    from PIL import Image as PILImage, ImageDraw
    img = PILImage.new("RGBA" if transparent else "RGB", (120, 60), (0, 0, 0, 0) if transparent else (250, 250, 250))
    ImageDraw.Draw(img).rectangle((20, 15, 100, 45), fill=(240, 170, 0))
    buf = __import__("io").BytesIO()
    img.save(buf, "WEBP" if transparent else "JPEG")
    return buf.getvalue()


def test_logo_detection_by_transparent_corners():
    assert main.has_transparent_corner(mystery_picture(transparent=True)) is True
    assert main.has_transparent_corner(mystery_picture(transparent=False)) is False


def mystery_client(monkeypatch, base, opens):
    monkeypatch.setattr(main, "pool", FakeMysteryPool(FakeMysteryDb()))
    monkeypatch.setattr(main, "MYSTERY_OPENS", opens)
    monkeypatch.setattr(main, "MYSTERY", {"loaded": True, "base": base, "pending": 0, "seen": 0.0})
    monkeypatch.setattr(main, "MYSTERY_LOGOS", {})

    async def photo(photo_id):
        return mystery_picture(transparent=photo_id.startswith("logo"))
    monkeypatch.setattr(main, "telegram_photo_bytes", photo)
    return TestClient(main.app)


def test_mystery_boxes_stay_closed_until_the_goal(monkeypatch):
    client = mystery_client(monkeypatch, 99999, 0)
    assert client.get("/api/mystery/boxes").status_code == 404
    assert "НАЖАТЬ" in client.get("/mystery").text

    main.MYSTERY["base"] = 100000
    res = client.get("/api/mystery/boxes")
    assert res.status_code == 200 and res.json()["price"] == 3650 and res.json()["total"] == 30 and res.json()["cells"] == []
    assert "MYSTERY BOXES" in client.get("/mystery").text


def test_only_admins_change_mystery_cells(monkeypatch):
    client = mystery_client(monkeypatch, 100000, 0)
    assert client.put("/api/mystery/admin/cells/1", json={"photo_id": "x"}).status_code == 401
    assert client.delete("/api/mystery/admin/cells/1").status_code == 401
    assert client.get("/api/mystery/admin/boxes").status_code == 401

    main.app.dependency_overrides[main.require_admin] = lambda: {"role": "admin"}
    try:
        assert client.put("/api/mystery/admin/cells/31", json={"photo_id": "x"}).status_code == 404
        assert client.put("/api/mystery/admin/cells/0", json={"photo_id": "x"}).status_code == 404
        assert client.put("/api/mystery/admin/cells/7", json={"photo_id": " "}).status_code == 400
        assert client.put("/api/mystery/admin/cells/7", json={"photo_id": "file1"}).status_code == 200
        assert client.put("/api/mystery/admin/cells/7", json={"photo_id": "file2"}).status_code == 200
        assert client.get("/api/mystery/boxes").json()["cells"] == [{"slot": 7, "photo": "file2", "logo": False}]
        res = client.put("/api/mystery/admin/cells/8", json={"photo_id": "logo1"})
        assert res.json()["logo"] is True
        assert client.get("/api/mystery/boxes").json()["cells"][1] == {"slot": 8, "photo": "logo1", "logo": True}
        assert client.delete("/api/mystery/admin/cells/8").status_code == 200
        assert client.delete("/api/mystery/admin/cells/7").status_code == 200
        assert client.get("/api/mystery/admin/boxes").json()["cells"] == []
    finally:
        main.app.dependency_overrides.clear()


def test_pages_have_short_addresses_and_old_links_redirect():
    client = TestClient(main.app)
    for page, target in (("privacy", "/privacy"), ("oferta", "/oferta"), ("returns", "/returns"), ("index", "/"), ("mystery_boxes", "/mystery")):
        res = client.get(f"/static/{page}.html", follow_redirects=False)
        assert res.status_code == 301 and res.headers["location"] == target
    assert client.get("/static/nothing.html", follow_redirects=False).status_code == 404
    for path in ("/privacy", "/oferta", "/returns"):
        assert client.get(path).status_code == 200
    for path in ("static/index.html", "static/oferta.html", "static/privacy.html", "static/returns.html", "static/sitemap.xml"):
        assert not __import__("re").search(r"/static/\w+\.html", open(path, encoding="utf-8").read()), path


def test_one_address_cannot_click_past_the_hourly_cap():
    buckets = {}
    now = 7200.0
    total = 0
    for _ in range(40000):   # an autoclicker at the full allowed speed for almost the whole hour
        now += 0.09
        if now >= 10800:
            break
        total += main.mystery_allowed(buckets, "1.1.1.1", 50, now)
    assert total == main.MYSTERY_HOURLY_CAP
    assert main.mystery_allowed(buckets, "2.2.2.2", 50, now) == 50    # others keep clicking
    assert main.mystery_allowed(buckets, "1.1.1.1", 50, 10801.0) > 0  # the next hour is a new one


def test_menu_tab_appears_only_when_the_countdown_ends(monkeypatch):
    monkeypatch.setattr(main, "MYSTERY_OPENS", main.time.time() + 60)
    assert 'href="/mystery"' not in main.render_index([])
    monkeypatch.setattr(main, "MYSTERY_OPENS", main.time.time() - 60)
    assert 'href="/mystery"' in main.render_index([])


def test_boxes_page_is_not_sent_before_the_goal_without_a_pass(monkeypatch):
    client = mystery_client(monkeypatch, 10, 0)
    closed = client.get("/mystery/boxes", follow_redirects=False)
    assert closed.status_code == 302 and closed.headers["location"] == "/mystery" and "MYSTERY BOXES" not in closed.text
    assert client.get("/static/mystery_boxes.html", follow_redirects=False).status_code == 301

    forged = main.jwt.encode({"scope": main.MYSTERY_PASS_SCOPE}, "another-key", algorithm=main.ALGORITHM)
    client.cookies.set(main.MYSTERY_PASS_COOKIE, forged)
    assert client.get("/mystery/boxes", follow_redirects=False).status_code == 302
    # an ordinary login token is not a pass
    client.cookies.set(main.MYSTERY_PASS_COOKIE, main.create_access_token({"sub": "1", "role": "client"}))
    assert client.get("/mystery/boxes", follow_redirects=False).status_code == 302

    client.cookies.set(main.MYSTERY_PASS_COOKIE, main.create_access_token({"scope": main.MYSTERY_PASS_SCOPE}))
    opened = client.get("/mystery/boxes", follow_redirects=False)
    assert opened.status_code == 200 and "MYSTERY BOXES" in opened.text and opened.headers["cache-control"] == "no-store"


def test_admin_gets_the_pass_and_everybody_gets_the_page_at_the_goal(monkeypatch):
    client = mystery_client(monkeypatch, 10, 0)
    main.app.dependency_overrides[main.require_admin] = lambda: {"role": "admin"}
    try:
        cookie = client.get("/api/mystery/admin/boxes").headers["set-cookie"]
    finally:
        main.app.dependency_overrides.clear()
    assert cookie.startswith(main.MYSTERY_PASS_COOKIE + "=") and "HttpOnly" in cookie and "Secure" in cookie and "Path=/mystery" in cookie
    # the pass opens no API
    token = main.create_access_token({"scope": main.MYSTERY_PASS_SCOPE})
    assert client.get("/api/mystery/admin/boxes", headers={"Authorization": f"Bearer {token}"}).status_code == 401

    main.MYSTERY["base"] = 100000
    assert TestClient(main.app).get("/mystery/boxes", follow_redirects=False).status_code == 200


def test_telegram_and_groq_go_through_the_configured_addresses():
    src = open(main.__file__, encoding="utf-8").read()
    assert "https://api.telegram.org/" not in src.replace('"https://api.telegram.org")', "")
    assert "https://api.groq.com/" not in src
    assert src.count("headers=RELAY_HEADERS") >= 7


def test_mystery_traffic_shows_the_last_minute_per_address():
    traffic = {}
    main.mystery_track(traffic, "10.1.2.3", 50, 50, 100.0)
    main.mystery_track(traffic, "10.1.2.3", 50, 10, 101.0)
    main.mystery_track(traffic, "10.9.9.9", 5, 5, 101.0)
    main.mystery_track(traffic, "10.7.7.7", 9, 9, 30.0)   # more than a minute ago
    stats = main.mystery_traffic_stats(traffic, 120.0)
    assert stats["addresses"] == 2 and stats["counted"] == 65 and stats["limited"] == 1
    assert stats["top"][0] == {"address": "10.1.x.3", "sent": 100, "counted": 60}


def test_client_edits_own_details_with_the_checkout_checks():
    v = main.clean_self_update(main.ClientSelfUpdate(first_name=" Анна ", last_name="Ли", phone="8 999 123-45-67", tg_username="anna", email=" Anna@Mail.RU "))
    assert v == {"first_name": "Анна", "last_name": "Ли", "full_name": "Анна Ли", "phone": "+79991234567", "tg_username": "@anna", "email": "anna@mail.ru"}
    for bad in ({"first_name": "", "phone": "+79991234567"}, {"first_name": "Анна", "phone": "123"},
                {"first_name": "Анна", "phone": "+79991234567", "email": "not-an-email"}):
        try:
            main.clean_self_update(main.ClientSelfUpdate(**bad))
        except ValueError:
            continue
        raise AssertionError(bad)


def test_only_a_client_edits_their_details():
    client = TestClient(main.app)
    assert client.put("/api/me", json={"first_name": "A", "phone": "+79991234567"}).status_code == 401
    main.app.dependency_overrides[main.get_current_user] = lambda: {"role": "admin", "id": 1}
    try:
        assert client.put("/api/me", json={"first_name": "A", "phone": "+79991234567"}).status_code == 403
    finally:
        main.app.dependency_overrides.clear()


def test_a_discount_is_split_over_the_orders_of_a_purchase():
    assert main.split_discount([2550, 2550, 1000], 300) == [126, 125, 49]
    assert sum(main.split_discount([999, 1, 1], 100)) == 100
    assert main.split_discount([2550], 255) == [255]
    assert main.split_discount([100, 200], 0) == [0, 0]


def test_checkout_makes_one_order_per_figure():
    items = [main.CartItem(id=1, name="x"), main.CartItem(id=2, name="y", qty=2), main.CartItem(id=1, name="x")]
    products = {1: {"name": "Talia", "figure_number": "2599", "price": 2550, "final_price": 0, "photo_id": "A,B"},
                2: {"name": "Lucy", "figure_number": "2416", "price": 3000, "final_price": 2700, "photo_id": ""}}
    lines = main.checkout_lines(items, products)
    assert [(ln["pid"], ln["qty"], ln["total"], ln["text"], ln["photo"]) for ln in lines] == [
        (1, 1, 2550, "2599 - Talia", "A"), (1, 1, 2550, "2599 - Talia", "A"),
        (2, 1, 2700, "2416 - Lucy", ""), (2, 1, 2700, "2416 - Lucy", "")]


def test_one_purchase_reads_as_one_order_in_the_alert():
    rows = [{"id": 551, "items": "2599 - Talia", "total_price": 2250, "paid_amount": 1125, "client_id": 7},
            {"id": 552, "items": "2416 - Lucy", "total_price": 2700, "paid_amount": 1350, "client_id": 7}]
    p = main.combine_orders(rows)
    assert p["id"] == "551, #552" and p["items"] == "2599 - Talia\n2416 - Lucy" and p["total_price"] == 4950 and p["paid_amount"] == 2475
    assert main.paid_order_title(p["id"]) == "✅ **ОПЛАЧЕН: заказ #551, #552**"


def test_what_is_left_to_pay():
    base = {"archived": False, "status": "Заказ принят в обработку", "total_price": 2550, "paid_amount": 1275}
    assert main.rest_to_pay(base) == 1275
    assert main.rest_to_pay({**base, "paid_amount": 2550}) == 0
    assert main.rest_to_pay({**base, "archived": True}) == 0
    assert main.rest_to_pay({**base, "status": main.AWAITING_PAYMENT}) == 0
