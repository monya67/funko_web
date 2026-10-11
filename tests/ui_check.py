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
  const bgRgb = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage !== 'none') return null;          // text on photos/gradients: judged by eye
      const c = parse(s.backgroundColor);
      if (c.a > 0.5) return c.rgb;
    }
    return [255, 255, 255];                                    // canvas default is white
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!r.width || !r.height || s.visibility === 'hidden' || +s.opacity === 0) continue;
    const bgc = bgRgb(el); if (bgc === null) continue;
    const fg = parse(s.color); if (fg.a < 0.05) continue;
    const seen = fg.rgb.map((v, i) => fg.a * v + (1 - fg.a) * bgc[i]);  // semi-transparent text is what the eye sees after blending
    const L = lum(seen), bg = lum(bgc), ratio = (Math.max(L, bg) + 0.05) / (Math.min(L, bg) + 0.05);
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


def new_context(browser, width, token, consent=True, theme=None):
    ctx = browser.new_context(viewport={"width": width, "height": 900})
    ctx.route("**/api/**", guard_writes)
    script = ""
    if token:
        script += f"localStorage.setItem('funko_token', '{token}');"
    if consent:
        script += "localStorage.setItem('funko_cookie_consent', 'essential');"
    if theme:
        script += f"localStorage.setItem('funko_theme', '{theme}');"
    if script:
        ctx.add_init_script(script)
    return ctx


def reveal_all(page):
    """Scroll through the page so scroll-reveal sections appear; otherwise screenshots and contrast checks see opacity:0."""
    page.evaluate("""async () => { const h = document.documentElement.scrollHeight;
        for (let y = 0; y < h + 400; y += 400) { window.scrollTo({top: y, behavior: 'instant'}); await new Promise(r => setTimeout(r, 160)); }
        window.scrollTo({top: 0, behavior: 'instant'}); await new Promise(r => setTimeout(r, 900)); }""")


def open_page(ctx, path):
    page = ctx.new_page()
    page.set_default_timeout(5000)
    page.goto(BASE + path, wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(400)
    reveal_all(page)
    return page


SELFTEST_HTML = """<body style="margin:0;background:#ffffff">
<p style="color:#fafafa">white on white</p>
<p style="color:#111111">readable</p>
<p style="color:rgba(17,17,17,0.3)">faint ink</p>
<div style="width:2000px;height:10px"></div></body>"""


def selftest():
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        page = browser.new_page(viewport={"width": 390, "height": 800})
        page.set_content(SELFTEST_HTML)
        flagged = [i["text"] for i in page.evaluate(LOW_CONTRAST_JS)]
        overflow = page.evaluate(OVERFLOW_JS)
        browser.close()
    assert flagged == ["white on white", "faint ink"], f"contrast detector returned {flagged}"
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





@check("hero", widths=(390, 1440))
def hero(page):
    errors = []
    h1 = page.inner_text("#home-tab h1").upper()
    if "FUNKO" not in h1 or "POP!" not in h1 or "COLLECTIBLE" in h1 or "РЕДКИЕ ФИГУРКИ" not in h1:
        errors.append(f"hero h1 is {h1!r}")
    loaded = page.evaluate("() => [...document.querySelectorAll('.hero-fig')].filter(i => i.complete && i.naturalWidth > 0).length")
    if loaded != 3:
        errors.append(f"{loaded}/3 hero images loaded")
    return errors


@check("home_new_admin", role="admin")
def home_new_admin(page):
    page.wait_for_selector("#home-new-grid .product-card", timeout=8000)
    return [] if page.is_visible("#home-new-section") else ["Новинки hidden for admin"]


@check("home_new_guest")
def home_new_guest(page):
    errors = []
    if not visible(page, "#home-new-section"):
        errors.append("Новинки section missing for guests")
    elif "в разработке" not in page.inner_text("#home-new-section").lower():
        errors.append("guest Новинки has no 'в разработке' stub")
    if page.evaluate("() => document.querySelectorAll('#home-new-grid .product-card').length"):
        errors.append("guests see product cards while the catalog is closed")
    return errors


@check("display_font_cyrillic")
def display_font_cyrillic(page):
    # Anton has no Cyrillic glyphs; Russian headings must fall back to a condensed face, not the system sans.
    errors = []
    fam = page.evaluate("() => getComputedStyle(document.querySelector('h1')).fontFamily")
    if "Oswald" not in fam:
        errors.append(f"display font stack {fam!r} has no Cyrillic-capable condensed face")
    if not page.evaluate("() => document.fonts.load('700 40px Oswald', 'НОВИНКИ').then(f => f.length > 0)"):
        errors.append("Oswald (Cyrillic) web font not loaded")
    return errors


@check("hero_collage_layout", widths=(390, 768, 1440))
def hero_collage_layout(page):
    # Text drawn over the black torn paper is invisible to the contrast detector (it reads the ancestor's paper colour).
    return page.evaluate("""() => {
        const box = (e) => e.getBoundingClientRect();
        const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const shown = (e) => { const r = box(e); return r.width > 0 && r.height > 0; };
        const errors = [];
        const ink = box(document.querySelector('.paper-ink'));
        const scribble = document.querySelector('.hero-scribble');
        if (shown(scribble) && hit(box(scribble), ink)) errors.push('scribble overlaps the black paper');
        if (shown(scribble) && hit(box(scribble), box(document.querySelector('.hero-ctas')))) errors.push('scribble covers the CTA buttons');
        if (shown(scribble) && box(scribble).top < box(document.getElementById('site-header')).bottom) errors.push('scribble hidden under the sticky header');
        const calls = [...document.querySelectorAll('.hero-callout')].filter(shown);
        for (let i = 0; i < calls.length; i++) for (let j = i + 1; j < calls.length; j++)
            if (hit(box(calls[i]), box(calls[j]))) errors.push(`callouts collide: ${calls[i].textContent} / ${calls[j].textContent}`);
        return errors;
    }""")


@check("home_alignment", role="admin", widths=(1024, 1440))
def home_alignment(page):
    page.wait_for_selector("#home-new-grid .product-card", timeout=8000)
    hero, new = page.evaluate("() => ['.hero', '#home-new-section'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; })")
    return [] if abs(hero[0] - new[0]) <= 2 and abs(hero[1] - new[1]) <= 2 else [f"Новинки at left={new[0]} width={new[1]}, hero at left={hero[0]} width={hero[1]}"]


@check("login_modal", widths=(390, 1440))
def login_modal(page):
    page.evaluate("() => window.openLoginModal()")
    page.wait_for_timeout(300)
    errors = [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
    radius = page.evaluate("() => getComputedStyle(document.getElementById('login-modal')).borderRadius")
    if not (4 <= float(radius.replace("px", "") or 0) <= 14):
        errors.append(f"login modal radius {radius}, expected small rounding (4-14px)")
    return errors


@check("cart_modal", widths=(390, 1440))
def cart_modal(page):
    page.evaluate("() => window.openCartModal()")
    page.wait_for_timeout(300)
    return [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]


@check("cookie_banner_phone", widths=(390,))
def cookie_banner_phone(page):
    page.wait_for_selector("#cookie-consent-banner:not(.hidden)", timeout=5000)
    errors = []
    h = page.evaluate("() => document.getElementById('cookie-consent-banner').getBoundingClientRect().height / window.innerHeight")
    if h > 0.5:
        errors.append(f"banner covers {h:.0%} of the screen")
    small = page.evaluate("() => [...document.querySelectorAll('#cookie-consent-banner button')].filter(b => b.getBoundingClientRect().height < 44).length")
    if small:
        errors.append(f"{small} banner button(s) shorter than 44px")
    left, right, vw = page.evaluate("() => { const r = document.getElementById('cookie-consent-banner').getBoundingClientRect(); return [r.left, r.right, window.innerWidth]; }")
    if left < 0 or right > vw:
        errors.append(f"banner spans x {left:.0f}..{right:.0f} of a {vw}px screen")
    errors += [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
    return errors


@check("primary_button_ink", role="admin", path="/catalog")
def primary_button_ink(page):
    # Spec: red is an accent only; primary actions are ink buttons that turn red on hover.
    bg = page.evaluate("() => getComputedStyle(document.querySelector('#catalog-tab .btn.primary')).backgroundColor")
    return [] if bg == "rgb(17, 17, 17)" else [f"primary button background {bg}, expected ink rgb(17, 17, 17)"]


@check("admin_tables_phone", role="admin", widths=(390,), path="/orders")
def admin_tables_phone(page):
    page.wait_for_selector("#orders-table tbody tr", timeout=8000)
    errors = []
    if page.evaluate(OVERFLOW_JS) > 1:
        errors.append("orders table widens the page")
    scrolls = page.evaluate("() => { const c = document.querySelector('#orders-tab .table-container'); return c.scrollWidth > c.clientWidth; }")
    if not scrolls:
        errors.append("orders table does not scroll inside its container at 390px")
    return errors


@check("admin_table_header_style", role="admin", path="/orders")
def admin_table_header_style(page):
    page.wait_for_selector("#orders-table tbody tr", timeout=8000)
    th = page.evaluate("() => { const s = getComputedStyle(document.querySelector('#orders-table th')); return [s.textTransform, s.backgroundColor]; }")
    return [] if th == ["uppercase", "rgb(239, 236, 230)"] else [f"table header is {th}, expected uppercase on paper"]


@check("legal_layout", widths=(390, 1440), path="/static/privacy.html")
def legal_layout(page):
    errors = []
    if not visible(page, ".site-header"):
        errors.append("no top bar on legal page")
    links = page.evaluate("() => document.querySelectorAll('.legal-toc a').length")
    heads = page.evaluate("() => document.querySelectorAll('.legal-body h2[id]').length")
    if not links or links != heads:
        errors.append(f"TOC has {links} links for {heads} sections")
    font = page.evaluate("() => getComputedStyle(document.querySelector('h1')).fontFamily")
    if "Anton" not in font or "Oswald" not in font:
        errors.append(f"h1 font {font}, expected Anton + Oswald (Cyrillic)")
    pos, share = page.evaluate("() => { const h = document.querySelector('.site-header'); return [getComputedStyle(h).position, h.getBoundingClientRect().height / window.innerHeight]; }")
    if pos == "sticky" and share > 0.15:
        errors.append(f"sticky header covers {share:.0%} of the screen while reading")
    return errors


@check("no_overflow_without_webfonts", widths=(390,))
def no_overflow_without_webfonts(page):
    # Slow or blocked Google Fonts (common on some RU networks) must not push headings off-screen.
    page.route("**/fonts.gstatic.com/**", lambda route: route.abort())
    errors = []
    for path in ("/", "/catalog", "/static/privacy.html"):
        page.goto(BASE + path, wait_until="networkidle")
        over = page.evaluate(OVERFLOW_JS)
        if over > 1:
            errors.append(f"{path}: {over}px overflow with system fallback fonts")
    return errors


@check("header_no_wrap", role="admin", widths=(1024, 1280, 1440))
def header_no_wrap(page):
    # Each header item must stay on one line; the admin-only search eats width the guest header doesn't need.
    return page.evaluate("""() => [...document.querySelectorAll('.site-logo, #site-nav .site-nav-link')]
        .filter(e => e.getBoundingClientRect().width > 0)
        .map(e => { const r = document.createRange(); r.selectNodeContents(e);
                    const tops = [...r.getClientRects()].map(b => b.top).sort((a, b) => a - b);
                    const lines = 1 + tops.slice(1).filter((t, i) => t - tops[i] > 8).length;  // sub-pixel offsets between spans are not new lines
                    return [e.textContent.trim(), lines]; })
        .filter(([, lines]) => lines > 1)
        .map(([text, lines]) => `wraps onto ${lines} lines: ${text}`)""")


@check("hero_title_big", widths=(1024, 1440))
def hero_title_big(page):
    fs = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('.hero-title')).fontSize)")
    return [] if fs >= 170 else [f"hero title only {fs}px, client asked for bigger"]


@check("hero_title_unbroken", widths=(390, 768, 1024, 1280, 1440))
def hero_title_unbroken(page):
    # Each hero word must fit its column; the overflow-wrap safety net must not split a word with the real font.
    page.evaluate("() => document.fonts.ready")
    lines = page.evaluate("""() => { const node = document.querySelector('.hero-title').firstChild; const r = document.createRange(); r.selectNodeContents(node);
        const tops = [...r.getClientRects()].map(b => b.top).sort((a, b) => a - b);
        return 1 + tops.slice(1).filter((t, i) => t - tops[i] > 8).length; }""")
    return [] if lines == 1 else [f"first hero word split over {lines} lines"]


@check("scrollbar_visible", role="admin", path="/orders")
def scrollbar_visible(page):
    colors = page.evaluate("() => [document.documentElement, document.querySelector('#orders-tab .table-container')].map(e => getComputedStyle(e).scrollbarColor)")
    return [f"scrollbar thumb is {c} (invisible on paper)" for c in colors if c.startswith("rgba(255, 255, 255")]


@check("orders_badge_on_profile", role="admin")
def orders_badge_on_profile(page):
    # Make every active order "unseen" so the badge must appear; fail loudly if that precondition does not hold.
    page.evaluate("() => localStorage.setItem('funko_seen_order_ids', '[]')")
    page.reload(wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(600)
    if not visible(page, "#orders-new-badge") and not page.evaluate("() => !document.getElementById('orders-new-badge').classList.contains('hidden')"):
        return ["precondition: orders badge did not activate with nothing seen"]
    errors = []
    if not page.evaluate("() => document.getElementById('profile-menu-btn').classList.contains('has-new')"):
        errors.append("profile icon does not signal new orders while the menu is closed")
    if not visible(page, "#profile-menu-btn .profile-new-dot"):
        errors.append("no visible new-orders dot on the profile icon")
    return errors


@check("legal_anchor_deeplink", path="/#faq-section")
def legal_anchor_deeplink(page):
    page.wait_for_timeout(900)
    errors = []
    if not page.is_visible("#home-tab.active"):
        errors.append("home tab not active")
    top = page.evaluate("() => document.getElementById('faq-section').getBoundingClientRect().top")
    if not (-5 < top < 300):
        errors.append(f"/#faq-section did not scroll to FAQ (top={top:.0f})")
    return errors


@check("product_photo_below_header", role="admin", path="/catalog")
def product_photo_below_header(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.click("#catalog-grid .product-card .product-image-box")
    top, header = page.evaluate("() => [parseFloat(getComputedStyle(document.querySelector('.pp-image-col')).top), document.getElementById('site-header').getBoundingClientRect().height]")
    return [] if top >= header else [f"sticky photo top {top}px sits under the {header:.0f}px header"]


@check("logo_one_font", widths=(390, 1440))
def logo_one_font(page):
    # The global `* { font-family: Outfit }` reset must not pull nested spans (the red "STOP") out of the display face.
    fams = page.evaluate("() => { const a = document.querySelector('.site-logo'); return [getComputedStyle(a).fontFamily, getComputedStyle(a.querySelector('span')).fontFamily]; }")
    return [] if fams[0] == fams[1] else [f"logo is {fams[0]!r} but STOP is {fams[1]!r}"]


@check("benefits_copy")
def benefits_copy(page):
    text = page.inner_text(".benefits")
    errors = []
    if "30–60 ДНЕЙ ХРАНЕНИЯ" not in text.upper():  # benefit titles are uppercased by CSS
        errors.append("storage benefit is not '30–60 дней хранения'")
    if "Яндекс, Авито, Ozon, Почта, СДЭК" not in text:
        errors.append("delivery list does not end with СДЭК")
    return errors


@check("hero_motion", widths=(1440,))
def hero_motion(page):
    errors = []
    names = page.evaluate("() => [...document.querySelectorAll('.hero-fig')].map(e => getComputedStyle(e).animationName)")
    if any(n == "none" for n in names):
        errors.append(f"hero figures are not animated: {names}")
    box = page.evaluate("() => { const r = document.querySelector('.hero-collage').getBoundingClientRect(); return [r.left + r.width * 0.9, r.top + r.height * 0.2]; }")
    page.mouse.move(box[0], box[1])
    page.wait_for_timeout(500)
    tf = page.evaluate("() => getComputedStyle(document.querySelector('.hero-collage')).transform")
    if tf in ("none", "matrix(1, 0, 0, 1, 0, 0)"):
        errors.append("collage does not tilt toward the pointer")
    return errors


@check("motion_reduced", widths=(1440,))
def motion_reduced(page):
    page.emulate_media(reduced_motion="reduce")
    page.mouse.move(1300, 300)
    page.wait_for_timeout(400)
    names = page.evaluate("() => [...document.querySelectorAll('.hero-fig')].map(e => getComputedStyle(e).animationName)")
    tf = page.evaluate("() => getComputedStyle(document.querySelector('.hero-collage')).transform")
    errors = [] if all(n == "none" for n in names) else [f"animations still run with reduced motion: {names}"]
    if tf not in ("none", "matrix(1, 0, 0, 1, 0, 0)"):
        errors.append("tilt still active with reduced motion")
    return errors


@check("reveal_completes", widths=(390, 1440))
def reveal_completes(page):
    left = page.evaluate("() => document.querySelectorAll('.reveal:not(.in)').length")
    return [] if left == 0 else [f"{left} sections still hidden after scrolling the whole page"]


@check("theme_toggle", widths=(390, 1440))
def theme_toggle(page):
    errors = []
    if not visible(page, "#theme-toggle"):
        return ["no theme toggle in the header"]
    page.click("#theme-toggle")
    page.wait_for_timeout(300)
    if page.evaluate("() => document.documentElement.dataset.theme") != "dark":
        errors.append("click did not switch to dark")
    bg = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    if bg == "rgb(239, 236, 230)":
        errors.append("body is still paper-coloured in dark mode")
    page.reload(wait_until="networkidle", timeout=30000)
    if page.evaluate("() => document.documentElement.dataset.theme") != "dark":
        errors.append("dark choice not remembered after reload")
    page.click("#theme-toggle")
    if page.evaluate("() => document.documentElement.dataset.theme") != "light":
        errors.append("second click did not return to light")
    return errors


def _dark_sweep(path, role="guest"):
    def fn(page):
        reveal_all(page)
        return [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
    return fn


for _n, _p, _r in (("dark_home", "/", "guest"), ("dark_catalog_stub", "/catalog", "guest"),
                   ("dark_privacy", "/static/privacy.html", "guest"), ("dark_admin_orders", "/orders", "admin"),
                   ("dark_admin_catalog", "/catalog", "admin")):
    check(_n, role=_r, widths=(390, 1440), path=_p)(_dark_sweep(_p, _r))


@check("soft_corners", role="admin", widths=(1440,), path="/catalog")
def soft_corners(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    r = page.evaluate("""() => { const px = (s) => parseFloat(getComputedStyle(document.querySelector(s)).borderTopLeftRadius);
        return {card: px('#catalog-grid .product-card'), btn: px('#catalog-tab .btn.primary'), input: px('#catalog-search'), tag: px('.card-tag-stock'), modal: px('#login-modal')}; }""")
    errors = []
    for name, v in r.items():
        if not (4 <= v <= 14):
            errors.append(f"{name} radius {v}px, expected small rounding 4-14px")
    return errors


@check("home_marquee", widths=(390, 1440))
def home_marquee(page):
    errors = []
    if not visible(page, ".marquee"):
        return ["no ticker strip on home"]
    name = page.evaluate("() => getComputedStyle(document.querySelector('.marquee-track')).animationName")
    if name == "none":
        errors.append("ticker is not animated")
    if page.evaluate(OVERFLOW_JS) > 1:
        errors.append("ticker widens the page")
    return errors


@check("motion_extras", widths=(1440,))
def motion_extras(page):
    # nav underline grows on hover, header gains a shadow after scrolling
    errors = []
    page.evaluate("() => window.scrollTo(0, 400)")
    page.wait_for_timeout(400)
    if not page.evaluate("() => document.getElementById('site-header').classList.contains('scrolled')"):
        errors.append("header does not react to scrolling")
    return errors


@check("smooth_scroll", widths=(1440,))
def smooth_scroll(page):
    errors = []
    sb = page.evaluate("() => getComputedStyle(document.documentElement).scrollBehavior")
    if sb != "smooth":
        errors.append(f"html scroll-behavior is {sb}, expected smooth")
    page.emulate_media(reduced_motion="reduce")
    if page.evaluate("() => getComputedStyle(document.documentElement).scrollBehavior") == "smooth":
        errors.append("smooth scrolling not disabled for reduced motion")
    return errors


GALLERY_PRODUCT = """{ id: 987654, name: 'Gallery test', category: 'Funko', series: 'Test', price: 3000, final_price: 3000, discount_percent: 0,
    in_stock: true, photo_id: 'PHOTOAAA,PHOTOBBB', figure_number: '1', packs_count: 0, badge: '' }"""


@check("gallery_card", role="admin", widths=(1440,), path="/catalog")
def gallery_card(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    r = page.evaluate("""() => { const c = productCard(%s);
        return [c.querySelector('.product-image-box img:not(.alt)')?.getAttribute('src'), c.querySelector('.product-image-box img.alt')?.getAttribute('src')]; }""" % GALLERY_PRODUCT)
    errors = []
    if r[0] != "/api/photos/PHOTOAAA":
        errors.append(f"card main photo is {r[0]!r}, expected the first id only")
    if r[1] != "/api/photos/PHOTOBBB":
        errors.append(f"card has no second photo for hover (got {r[1]!r})")
    return errors


@check("gallery_product_page", role="admin", widths=(390, 1440), path="/catalog")
def gallery_product_page(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("() => { rawCatalogProducts.push(%s); window.openProductDetail(987654); }" % GALLERY_PRODUCT)
    errors = []
    if page.evaluate("() => document.querySelectorAll('#pp-thumbs button').length") != 2:
        errors.append("product page does not show 2 thumbnails")
        return errors
    page.click("#pp-thumbs button:nth-child(2)")
    if not page.evaluate("() => document.getElementById('pp-img').getAttribute('src').endsWith('PHOTOBBB')"):
        errors.append("clicking thumbnail 2 did not show photo 2")
    page.click("#pp-prev")
    if not page.evaluate("() => document.getElementById('pp-img').getAttribute('src').endsWith('PHOTOAAA')"):
        errors.append("previous arrow did not go back to photo 1")
    page.click("#pp-next")
    page.click("#pp-next")
    if not page.evaluate("() => document.getElementById('pp-img').getAttribute('src').endsWith('PHOTOAAA')"):
        errors.append("next arrow does not wrap around")
    if page.evaluate(OVERFLOW_JS) > 1:
        errors.append("gallery widens the page")
    return errors


@check("gallery_single_photo_clean", role="admin", widths=(1440,), path="/catalog")
def gallery_single_photo_clean(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("() => { rawCatalogProducts.push({ ...%s, id: 987655, photo_id: 'ONLYONE' }); window.openProductDetail(987655); }" % GALLERY_PRODUCT)
    shown = page.evaluate("() => [...document.querySelectorAll('#pp-thumbs, #pp-prev, #pp-next')].filter(e => e.getBoundingClientRect().width > 0).length")
    return [] if shown == 0 else ["thumbnails/arrows visible for a product with one photo"]


@check("gallery_cart_uses_first_photo", role="admin", widths=(1440,), path="/catalog")
def gallery_cart_uses_first_photo(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    got = page.evaluate("() => { rawCatalogProducts.push(%s); window.addToCart(987654, 1); const it = funkoCart.find(x => x.id === 987654); return it && it.photo_id; }" % GALLERY_PRODUCT)
    return [] if got == "PHOTOAAA" else [f"cart item photo_id is {got!r}, expected only the first id"]


@check("gallery_form", role="admin", widths=(1440,), path="/catalog")
def gallery_form(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("() => { rawCatalogProducts.push(%s); window.openEditProductModal(987654); }" % GALLERY_PRODUCT)
    errors = []
    n = page.evaluate("() => document.querySelectorAll('#product-photo-thumbs .photo-thumb').length")
    if n != 2:
        errors.append(f"edit form shows {n} thumbnails, expected 2")
        return errors
    page.click("#product-photo-thumbs .photo-thumb:first-child .photo-thumb-remove")
    val = page.evaluate("() => document.getElementById('product-photo-id').value")
    if val != "PHOTOBBB":
        errors.append(f"after removing photo 1 the field holds {val!r}, expected 'PHOTOBBB'")
    return errors


@check("product_fits_screen", role="admin", widths=(1440,), path="/catalog")
def product_fits_screen(page):
    page.set_viewport_size({"width": 1440, "height": 800})
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("() => { rawCatalogProducts.push(%s); window.openProductDetail(987654); }" % GALLERY_PRODUCT)
    page.wait_for_timeout(400)
    errors = []
    bottom = page.evaluate("() => Math.max(document.getElementById('pp-img').closest('.pp-image-box').getBoundingClientRect().bottom, document.getElementById('pp-thumbs').getBoundingClientRect().bottom)")
    if bottom > 800:
        errors.append(f"photo + thumbnails end at y={bottom:.0f}, below the 800px screen")
    price = page.evaluate("() => document.getElementById('pp-price-row').getBoundingClientRect().bottom")
    if price > 800:
        errors.append("price is below the fold")
    a = page.evaluate("""() => { const box = document.getElementById('pp-img').closest('.pp-image-box').getBoundingClientRect();
        return ['pp-prev', 'pp-next'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return Math.abs((r.top + r.height / 2) - (box.top + box.height / 2)); }); }""")
    if max(a) > 3:
        errors.append(f"arrows are off the vertical centre by {max(a):.0f}px")
    glyph = page.evaluate("""() => ['pp-prev', 'pp-next'].map(id => { const b = document.getElementById(id); const sv = b.querySelector('svg'); if (!sv) return 999;
        const r = b.getBoundingClientRect(), g = sv.getBoundingClientRect(); return Math.hypot((g.left + g.width / 2) - (r.left + r.width / 2), (g.top + g.height / 2) - (r.top + r.height / 2)); })""")
    if max(glyph) > 1.5:
        errors.append(f"arrow glyph is not centred in its circle (off by {max(glyph):.0f}px or no svg)")
    return errors


@check("card_photo_still_on_hover", role="admin", widths=(1440,), path="/catalog")
def card_photo_still_on_hover(page):
    page.wait_for_selector("#catalog-grid .product-card .product-image-box img", timeout=8000)
    page.hover("#catalog-grid .product-card")
    page.wait_for_timeout(700)
    tf = page.evaluate("() => getComputedStyle(document.querySelector('#catalog-grid .product-card .product-image-box img')).transform")
    return [] if tf in ("none", "matrix(1, 0, 0, 1, 0, 0)") else [f"card photo moves on hover: {tf}"]


@check("catalog_cart_badge_quiet", role="admin", widths=(1440,), path="/catalog")
def catalog_cart_badge_quiet(page):
    st = page.evaluate("() => { const s = getComputedStyle(document.getElementById('catalog-cart-badge')); return [s.boxShadow, s.backgroundColor, s.borderTopLeftRadius]; }")
    errors = []
    if st[0] != "none":
        errors.append(f"badge has a glow/shadow: {st[0][:50]}")
    if st[1] == "rgb(229, 9, 20)":
        errors.append("badge is still the red circle")
    return errors


@check("cart_refreshes_stale_photo", widths=(1440,))
def cart_refreshes_stale_photo(page):
    # A cart saved before a product got its photo must pick the photo up once the catalog loads.
    pid = page.evaluate("""async () => { const d = await (await fetch('/api/catalog')).json(); const p = d.products.find(x => x.photo_id); return p ? p.id : null; }""")
    if pid is None:
        return ["precondition: no product with a photo in the catalog"]
    page.evaluate("""(id) => localStorage.setItem('funko_cart', JSON.stringify([{ id, name: 'x', figure_number: '', price: 100, final_price: 100, photo_id: '', qty: 1 }]))""", pid)
    page.reload(wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(1500)
    page.evaluate("() => window.openCartModal()")
    page.wait_for_timeout(500)
    if page.evaluate("() => !!document.querySelector('.cart-item-placeholder')"):
        return ["cart still shows the 📦 placeholder although the product has a photo now"]
    return []


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
                ctx = new_context(browser, width, roles[role], consent=(name != "cookie_banner_phone"),
                                  theme="dark" if name.startswith("dark_") else None)
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
