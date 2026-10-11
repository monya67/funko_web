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
    args_part = args_part[:args_part.index("\n        )")]
    placeholders = max(int(n) for n in re.findall(r"\$(\d+)", sql))
    args = [a for a in re.split(r",\s*(?![^()]*\))", " ".join(args_part.split())) if a.strip()]
    return placeholders, len(args)


def test_product_sql_placeholders_match_their_values():
    for fn, marker in ((main.create_product, "INSERT INTO products"), (main.update_product, "UPDATE products")):
        ph, n = _sql_arity(fn, marker)
        assert ph == n, f"{fn.__name__}: {ph} placeholders but {n} values"
