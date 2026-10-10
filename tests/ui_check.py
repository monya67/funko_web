"""UI checks for the light redesign.

Needs the dev server on http://127.0.0.1:8000 and Microsoft Edge.
  python tests/ui_check.py --selftest
  python tests/ui_check.py --out <dir>        # UI_ADMIN_LOGIN=<login> adds admin pages
Read-only: never submits forms, deletes, pays or checks out.
"""
import argparse
import os
import sys
import warnings
from datetime import datetime, timedelta, timezone

import jwt
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

# the local dev SECRET_KEY is short; production's is not, and this token only ever hits localhost
warnings.filterwarnings("ignore", category=jwt.warnings.InsecureKeyLengthWarning)

BASE = "http://127.0.0.1:8000"
WIDTHS = [390, 768, 1024, 1440]
GUEST_PAGES = ["/", "/catalog", "/static/privacy.html", "/static/oferta.html", "/static/returns.html"]
ADMIN_PAGES = ["/", "/catalog", "/orders", "/archive", "/accounting", "/clients"]

OVERFLOW_JS = "() => document.documentElement.scrollWidth - window.innerWidth"
LOW_CONTRAST_JS = r"""() => {
  const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { rgb: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; };
  const lum = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
                                      .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const bgLum = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage !== 'none') return null;          // text on photos/gradients: judged by eye
      const c = parse(s.backgroundColor);
      if (c.a > 0.5) return lum(c.rgb);
    }
    return 1;                                                  // canvas default is white
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!r.width || !r.height || s.visibility === 'hidden' || +s.opacity === 0) continue;
    const bg = bgLum(el); if (bg === null) continue;
    const fg = parse(s.color); if (fg.a < 0.3) continue;
    const L = lum(fg.rgb), ratio = (Math.max(L, bg) + 0.05) / (Math.min(L, bg) + 0.05);
    if (ratio < 3) out.push({ text: el.textContent.trim().slice(0, 40), ratio: +ratio.toFixed(2), color: s.color });
  }
  return out;
}"""

CHECKS = []


def check(name, role="guest", widths=(1440,), path="/"):
    def deco(fn):
        CHECKS.append((name, role, widths, path, fn))
        return fn
    return deco


def admin_token(login):
    load_dotenv()
    key = os.getenv("SECRET_KEY", "super-secret-key-change-me")
    exp = datetime.now(timezone.utc) + timedelta(hours=1)
    return jwt.encode({"sub": login, "role": "admin", "exp": exp}, key, algorithm="HS256")


BLOCKED_WRITES = []


def guard_writes(route, request):
    """The local server talks to the PRODUCTION database: the test browser may only read."""
    if request.method in ("GET", "HEAD") or request.url.split("?")[0].endswith("/api/ping"):
        route.continue_()
        return
    BLOCKED_WRITES.append(f"{request.method} {request.url}")
    route.abort()


def new_context(browser, width, token, consent=True):
    ctx = browser.new_context(viewport={"width": width, "height": 900})
    ctx.route("**/api/**", guard_writes)
    script = ""
    if token:
        script += f"localStorage.setItem('funko_token', '{token}');"
    if consent:
        script += "localStorage.setItem('funko_cookie_consent', 'essential');"
    if script:
        ctx.add_init_script(script)
    return ctx


def open_page(ctx, path):
    page = ctx.new_page()
    page.set_default_timeout(5000)
    page.goto(BASE + path, wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(400)
    return page


SELFTEST_HTML = """<body style="margin:0;background:#ffffff">
<p style="color:#fafafa">white on white</p>
<p style="color:#111111">readable</p>
<div style="width:2000px;height:10px"></div></body>"""


def selftest():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width": 390, "height": 800})
        page.set_content(SELFTEST_HTML)
        flagged = [i["text"] for i in page.evaluate(LOW_CONTRAST_JS)]
        overflow = page.evaluate(OVERFLOW_JS)
        browser.close()
    assert flagged == ["white on white"], f"contrast detector returned {flagged}"
    assert overflow > 1000, f"overflow detector returned {overflow}"
    print("selftest OK")


@check("light_base")
def light_base(page):
    errors = []
    bg = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    if bg != "rgb(239, 236, 230)":
        errors.append(f"body background is {bg}, expected paper rgb(239, 236, 230)")
    # fonts.check() is true when no "Anton" face exists at all; load() returns [] in that case
    if not page.evaluate("() => document.fonts.load('40px Anton').then(faces => faces.length > 0)"):
        errors.append("Anton web font not loaded")
    return errors


def _table_readable(table_id):
    def fn(page):
        page.wait_for_selector(f"#{table_id} tbody tr", timeout=8000)
        return [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
    return fn


for _name, _path, _table in (("admin_orders_readable", "/orders", "orders-table"),
                             ("admin_archive_readable", "/archive", "archived-table"),
                             ("admin_accounting_readable", "/accounting", "accounting-table"),
                             ("admin_clients_readable", "/clients", "clients-table")):
    check(_name, role="admin", path=_path)(_table_readable(_table))


def visible(page, sel):
    return page.evaluate(f"() => {{ const e = document.querySelector({sel!r}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }}")


def in_viewport(page, sel):
    return page.evaluate(f"() => {{ const r = document.querySelector({sel!r}).getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }}")


@check("header_nav_catalog")
def header_nav_catalog(page):
    page.click("#site-nav a[data-tab='catalog']")
    return [] if page.is_visible("#catalog-tab.active") else ["catalog tab not active after clicking Каталог"]


@check("profile_menu_guest", widths=(390, 1440))
def profile_menu_guest(page):
    page.click("#profile-menu-btn")
    errors = []
    if not visible(page, "#sidebar-login-btn"):
        errors.append("Войти not visible for guest")
    if visible(page, "#profile-menu [data-tab='accounting']"):
        errors.append("admin item visible for guest")
    if not in_viewport(page, "#profile-menu"):
        errors.append("profile menu leaves the viewport")
    return errors


@check("profile_menu_admin", role="admin", widths=(390, 1440))
def profile_menu_admin(page):
    page.click("#profile-menu-btn")
    errors = [f"{t} not visible" for t in ("orders", "archived", "accounting", "clients")
              if not visible(page, f"#profile-menu [data-tab='{t}']")]
    page.click("#profile-menu [data-tab='accounting']")
    if not page.is_visible("#accounting-tab.active"):
        errors.append("accounting tab not active after menu click")
    if visible(page, "#profile-menu"):
        errors.append("menu still open after navigation")
    return errors


@check("mobile_nav", widths=(390,))
def mobile_nav(page):
    errors = []
    if visible(page, "#site-nav a[data-tab='catalog']"):
        errors.append("nav links visible before opening the burger")
    page.click("#site-menu-toggle")
    if not visible(page, "#site-nav a[data-tab='catalog']"):
        errors.append("nav links hidden after opening the burger")
    page.keyboard.press("Escape")
    if visible(page, "#site-nav a[data-tab='catalog']"):
        errors.append("Escape did not close the burger menu")
    return errors


@check("home_anchor_from_catalog", path="/catalog")
def home_anchor_from_catalog(page):
    page.click("#site-nav a[data-home-anchor='faq-section']")
    page.wait_for_timeout(900)
    errors = []
    if not page.is_visible("#home-tab.active"):
        errors.append("home tab not active")
    top = page.evaluate("() => document.getElementById('faq-section').getBoundingClientRect().top")
    if not (-5 < top < 300):
        errors.append(f"FAQ section not scrolled into view (top={top})")
    return errors


@check("card_shape", role="admin", path="/catalog")
def card_shape(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    errors = []
    if page.evaluate("() => typeof productCard") != "function":
        errors.append("productCard() is not defined")
    tag = page.evaluate("() => (document.querySelector('#catalog-grid .product-card .card-tags span') || {}).textContent || ''")
    if tag.strip() not in ("В наличии", "Предзаказ"):
        errors.append(f"first card has no availability tag (got {tag!r})")
    return errors


@check("long_name_card", role="admin", widths=(390,), path="/catalog")
def long_name_card(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("""() => {
        const p = { id: 999999, name: 'Очень длинное название фигурки '.repeat(4), category: 'Funko', price: 1990,
                    final_price: 1990, discount_percent: 0, in_stock: false, photo_id: '', figure_number: '1234567' };
        document.getElementById('catalog-grid').prepend(productCard(p));
    }""")
    over = page.evaluate(OVERFLOW_JS)
    return [f"long name widens page by {over}px"] if over > 1 else []


@check("many_chips", role="admin", widths=(390,), path="/catalog")
def many_chips(page):
    page.evaluate("""() => {
        const bar = document.getElementById('franchise-chips-bar');
        for (let i = 0; i < 30; i++) { const b = document.createElement('button'); b.className = 'franchise-chip'; b.textContent = 'Серия номер ' + i; bar.appendChild(b); }
    }""")
    over = page.evaluate(OVERFLOW_JS)
    return [f"30 chips widen page by {over}px"] if over > 1 else []


@check("product_page", role="admin", widths=(390, 1440), path="/catalog")
def product_page(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.click("#catalog-grid .product-card .product-image-box")
    errors = []
    if not page.is_visible("#product-tab.active"):
        errors.append("product page did not open")
    errors += [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
    page.click(".pp-back-btn")
    if not page.is_visible("#catalog-tab.active"):
        errors.append("back button did not return to catalog")
    return errors


@check("guest_catalog_stub", widths=(390, 1440), path="/catalog")
def guest_catalog_stub(page):
    # The contrast detector skips text over gradients, so assert the stub card itself is a flat light surface first.
    errors = []
    bg = page.evaluate("() => { const s = getComputedStyle(document.querySelector('.under-dev-card')); return [s.backgroundImage, s.backgroundColor]; }")
    if bg[0] != "none":
        errors.append(f"stub card still paints a background image: {bg[0][:60]}")
    errors += [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
    return errors


@check("write_guard", role="admin")
def write_guard(page):
    # Probe a route that does not exist: without the guard it 404s, so even a failing run cannot touch the DB.
    before = len(BLOCKED_WRITES)
    outcome = page.evaluate("""() => fetch('/api/__write_guard_probe', { method: 'POST', body: '{}' })
        .then(r => 'reached server: HTTP ' + r.status, () => 'blocked')""")
    errors = [] if outcome == "blocked" else [f"POST was not blocked ({outcome})"]
    if len(BLOCKED_WRITES) == before + 1:
        BLOCKED_WRITES.pop()  # expected probe, not a real write attempt
    else:
        errors.append("guard did not record the probe")
    return errors


CATALOG_CHECKS =["card_shape", "long_name_card", "many_chips", "product_page", "guest_catalog_stub"]

HEADER_CHECKS =["header_nav_catalog", "profile_menu_guest", "profile_menu_admin", "mobile_nav", "home_anchor_from_catalog"]


def run(out, only=None):
    login = os.getenv("UI_ADMIN_LOGIN")
    roles = {"guest": None}
    if login:
        roles["admin"] = admin_token(login)
    os.makedirs(out, exist_ok=True)
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        for role, token in ({} if only else roles).items():
            for width in WIDTHS:
                ctx = new_context(browser, width, token)
                for path in (GUEST_PAGES if role == "guest" else ADMIN_PAGES):
                    page = open_page(ctx, path)
                    name = f"{role}_{width}_{path.strip('/').replace('/', '_').replace('.html', '') or 'home'}"
                    page.screenshot(path=os.path.join(out, name + ".png"), full_page=True)
                    over = page.evaluate(OVERFLOW_JS)
                    if over > 1:
                        failures.append(f"{name}: horizontal overflow {over}px")
                    failures += [f"{name}: low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
                    page.close()
                ctx.close()
        for name, role, widths, path, fn in CHECKS:
            if role not in roles or (only and name not in only):
                continue
            for width in widths:
                ctx = new_context(browser, width, roles[role], consent=(name != "cookie_banner_phone"))
                page = open_page(ctx, path)
                try:
                    errors = fn(page)
                except Exception as exc:  # a missing element must report, not abort the run
                    errors = [f"{type(exc).__name__}: {str(exc).splitlines()[0]}"]
                failures += [f"{name}@{width}: {e}" for e in errors]
                ctx.close()
        browser.close()
    failures += [f"blocked write attempt: {w}" for w in BLOCKED_WRITES]
    for f in failures:
        print("FAIL", f)
    print(f"{len(failures)} failure(s); screenshots in {out}")
    return failures


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # page text (↕, ₽, Cyrillic) must not crash a cp1251 Windows console
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--out", default="ui-shots")
    ap.add_argument("--only", nargs="+", help="run just these named checks, skip the page sweep")
    args = ap.parse_args()
    if args.selftest:
        selftest()
    else:
        sys.exit(1 if run(args.out, args.only) else 0)
