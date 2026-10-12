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
    if "#" not in path:   # a deep link must be measured where it landed, not after scrolling back to the top
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


@check("checkout_email", widths=(390, 1440))
def checkout_email(page):
    page.evaluate("() => { funkoCart.length = 0; funkoCart.push({ id: 1, name: 'x', figure_number: '', price: 100, final_price: 100, photo_id: '', qty: 1 }); window.openCheckoutModal(); }")
    page.wait_for_timeout(400)
    errors = []
    info = page.evaluate("""() => { const e = document.getElementById('checkout-email'), m = document.getElementById('checkout-marketing');
        return e ? { type: e.type, required: e.required, mType: m && m.type, mChecked: m && m.checked, mRequired: m && m.required } : null; }""")
    if not info:
        return ["no #checkout-email field in the checkout form"]
    if info["type"] != "email" or not info["required"]:
        errors.append(f"email field must be type=email and required, got {info}")
    if info["mType"] != "checkbox" or info["mChecked"] or info["mRequired"]:
        errors.append(f"newsletter consent must be an unchecked, optional checkbox, got {info}")
    # filled except email -> blocked and flagged
    page.evaluate("""() => { const set = (id, v) => { document.getElementById(id).value = v; };
        set('checkout-first-name', 'Иван'); set('checkout-last-name', 'Петров'); set('checkout-phone', '+79990000000'); set('checkout-tg', '@ivan'); set('checkout-email', 'not-an-email'); }""")
    page.evaluate("() => window.proceedToPayment()")
    if "field-error" not in (page.get_attribute("#checkout-email", "class") or ""):
        errors.append("invalid email is not flagged")
    if page.evaluate("() => !!window.pendingCheckoutData"):
        errors.append("checkout went ahead with an invalid email")
    page.evaluate("() => { document.getElementById('checkout-email').value = 'Buyer@Example.com'; document.getElementById('checkout-marketing').checked = true; window.proceedToPayment(); }")
    data = page.evaluate("() => window.pendingCheckoutData")
    if not data or data.get("email") != "Buyer@Example.com" or data.get("marketing_consent") is not True:
        errors.append(f"payload lacks email/consent: {data and {k: data.get(k) for k in ('email', 'marketing_consent')}}")
    return errors


@check("product_description", role="admin", widths=(390, 1440), path="/catalog")
def product_description(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    errors = []
    if not page.evaluate("() => !!document.getElementById('product-description')"):
        return ["no description textarea in the product form"]
    page.evaluate("() => { rawCatalogProducts.push({ ...%s, description: 'Первая строка. Вторая <b>строка</b>.' }); window.openEditProductModal(987654); }" % GALLERY_PRODUCT)
    if page.evaluate("() => document.getElementById('product-description').value") != "Первая строка. Вторая <b>строка</b>.":
        errors.append("edit form does not load the description")
    page.evaluate("() => { closeModals(); window.openProductDetail(987654); }")
    shown = page.evaluate("() => { const e = document.getElementById('pp-description'); return e ? [e.getBoundingClientRect().height > 0, e.textContent, !!e.querySelector('b')] : null; }")
    if not shown or not shown[0]:
        errors.append("description is not shown on the product page")
    else:
        if "Вторая <b>строка</b>." not in shown[1]:
            errors.append("description must be rendered as plain text (no HTML injection)")
        if shown[2]:
            errors.append("description HTML was interpreted as markup")
    page.evaluate("() => { rawCatalogProducts.push({ ...%s, id: 987656, description: '' }); window.openProductDetail(987656); }" % GALLERY_PRODUCT)
    if page.evaluate("() => { const e = document.getElementById('pp-description'); return e && e.getBoundingClientRect().height > 0; }"):
        errors.append("empty description still takes space")
    return errors


@check("seo_basics")
def seo_basics(page):
    errors = []
    canon = page.evaluate("() => (document.querySelector('link[rel=canonical]') || {}).href")
    if canon != "https://funkostop.org/":
        errors.append(f"canonical is {canon!r}")
    ld = page.evaluate('''() => JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent)''')
    same = ld.get("sameAs") or []
    for needle in ("t.me/Funko_Stop", "t.me/FunkoStopReviews", "avito.ru/user/b48abaa746bfb44d73cc6536bb0c91f6"):
        if not any(needle in u for u in same):
            errors.append(f"JSON-LD sameAs lacks {needle}")
    if not ld.get("knowsAbout") and not ld.get("makesOffer"):
        errors.append("JSON-LD does not say what the store sells")
    return errors


@check("modal_scrolls", role="admin", widths=(1440,), path="/catalog")
def modal_scrolls(page):
    # A Macbook-sized window is short: the product form must scroll inside itself so its last button is reachable.
    page.set_viewport_size({"width": 1440, "height": 640})
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("() => window.openAddProductModal()")
    page.wait_for_timeout(400)
    info = page.evaluate("""() => { const m = document.getElementById('product-modal'); const s = getComputedStyle(m);
        m.scrollTop = m.scrollHeight; const btn = [...m.querySelectorAll('button[type=submit]')].pop(); const r = btn && btn.getBoundingClientRect();
        return { overflowY: s.overflowY, fits: m.getBoundingClientRect().height <= window.innerHeight, scrollable: m.scrollHeight > m.clientHeight, btnBottom: r && r.bottom, vh: window.innerHeight }; }""")
    errors = []
    if not info["fits"]:
        errors.append("form is taller than the window")
    if info["overflowY"] not in ("auto", "scroll"):
        errors.append(f"form does not scroll (overflow-y: {info['overflowY']})")
    if info["btnBottom"] is None or info["btnBottom"] > info["vh"]:
        errors.append("save button cannot be reached by scrolling")
    return errors


@check("phone_hero_is_flat", widths=(390,))
def phone_hero_is_flat(page):
    # iOS Safari paints 3D layers of cut-out images as translucent rectangles and fades red to pink.
    info = page.evaluate("""() => { const c = getComputedStyle(document.querySelector('.hero-collage'));
        const f = getComputedStyle(document.querySelector('.hero-fig')); const p = getComputedStyle(document.querySelector('.hero-paper'));
        return { style: c.transformStyle, persp: c.perspective, figAnim: f.animationName, figFilter: f.filter, figTf: f.transform, paperAnim: p.animationName }; }""")
    errors = []
    if info["style"] == "preserve-3d" or info["persp"] != "none":
        errors.append(f"collage still uses 3D on phones: {info['style']}, perspective {info['persp']}")
    if info["figAnim"] == "none":
        errors.append("figures do not move on phones (a flat 2D float is safe and expected)")
    else:
        css = page.evaluate("""(name) => { for (const sh of document.styleSheets) { let rs; try { rs = sh.cssRules; } catch (e) { continue; }
            for (const r of rs) { if (r.type === CSSRule.KEYFRAMES_RULE && r.name === name) return r.cssText; } } return ''; }""", info["figAnim"])
        if not css or "3d" in css.lower() or "translatez" in css.lower() or "perspective" in css.lower():
            errors.append(f"phone float keyframes {info['figAnim']!r} are missing or use 3D: {css[:80]}")
    if info["figFilter"] != "none":
        errors.append(f"figures keep a drop-shadow filter (rectangle artefacts on iOS): {info['figFilter']}")
    if info["paperAnim"] != "none":
        errors.append("paper still animates on phones")
    return errors


ADMIN_TABS = [("orders", "Заказы"), ("archived", "Архив"), ("accounting", "Бухгалтерия"), ("clients", "Клиенты"), ("products", "Товары")]


@check("admin_subnav", role="admin", widths=(390, 1440), path="/catalog")
def admin_subnav(page):
    errors = []
    if not visible(page, "#admin-subnav"):
        return ["admin section bar is not visible"]
    for tab, label in ADMIN_TABS:
        if not page.evaluate("(t) => !!document.querySelector(`#admin-subnav [data-tab=${t}]`)", tab):
            errors.append(f"no {label} link in the admin bar")
            continue
        page.evaluate("(t) => document.querySelector(`#admin-subnav [data-tab=${t}]`).scrollIntoView({inline: 'center'})", tab)
        page.click(f"#admin-subnav [data-tab='{tab}']")
        page.wait_for_timeout(250)
        if not page.is_visible(f"#{tab}-tab.active"):
            errors.append(f"one click on {label} did not open it")
        if "active" not in (page.get_attribute(f"#admin-subnav [data-tab='{tab}']", "class") or ""):
            errors.append(f"{label} is not highlighted while open")
    return errors


@check("admin_subnav_guest_hidden", widths=(1440,), path="/catalog")
def admin_subnav_guest_hidden(page):
    return ["admin bar is visible to a guest"] if visible(page, "#admin-subnav") else []


@check("products_admin", role="admin", widths=(390, 1440), path="/catalog")
def products_admin(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("() => window.switchTab('products')")
    page.wait_for_selector("#products-table tbody tr", timeout=10000)
    errors = []
    total = page.evaluate("() => document.querySelectorAll('#products-table tbody tr').length")
    for sel, what in (("#products-search", "search box"), ("#products-filter-stock", "availability filter"), ("#products-filter-category", "category filter"), ("#products-sort", "sort"), ("#products-add-btn", "add button")):
        if not page.evaluate("(s) => !!document.querySelector(s)", sel):
            errors.append(f"no {what}")
    if errors:
        return errors
    page.fill("#products-search", "zzzz-no-such-figure")
    page.wait_for_timeout(250)
    none = page.evaluate("() => document.querySelectorAll('#products-table tbody tr:not(.empty-row)').length")
    if none != 0:
        errors.append(f"search for nonsense still shows {none} rows")
    page.fill("#products-search", "")
    page.wait_for_timeout(250)
    if page.evaluate("() => document.querySelectorAll('#products-table tbody tr').length") != total:
        errors.append("clearing the search does not bring all rows back")
    if not page.evaluate("() => !!document.querySelector('#products-table tbody tr .product-edit-btn') && !!document.querySelector('#products-table tbody tr .product-delete-btn')"):
        errors.append("rows have no edit/delete buttons")
    if page.evaluate(OVERFLOW_JS) > 1:
        errors.append("products table widens the page")
    return errors


@check("products_admin_stock_filter", role="admin", widths=(1440,), path="/catalog")
def products_admin_stock_filter(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("() => window.switchTab('products')")
    page.wait_for_selector("#products-table tbody tr", timeout=10000)
    page.evaluate("""() => { rawCatalogProducts.push({ id: 987001, name: 'Sold test', category: 'Funko', price: 1, final_price: 1, discount_percent: 0, in_stock: true, photo_id: '', figure_number: '', stock_qty: 0, packs_count: 0, badge: '', description: '' },
        { id: 987002, name: 'Few test', category: 'Funko', price: 1, final_price: 1, discount_percent: 0, in_stock: true, photo_id: '', figure_number: '', stock_qty: 3, packs_count: 0, badge: '', description: '' }); renderProductsAdmin(); }""")
    page.select_option("#products-filter-stock", "sold")
    page.wait_for_timeout(250)
    names = page.evaluate("() => [...document.querySelectorAll('#products-table tbody tr .product-name-cell')].map(e => e.textContent)")
    errors = []
    if not any("Sold test" in n for n in names) or any("Few test" in n for n in names):
        errors.append(f"'Распродан' filter shows {names}")
    return errors


STOCK_PRODUCT = """{ id: 987654, name: 'Stock test', category: 'Funko', series: 'T', price: 3000, final_price: 3000, discount_percent: 0,
    in_stock: true, photo_id: '', figure_number: '1', packs_count: 0, badge: '', description: '', stock_qty: %s }"""


@check("stock_ui", role="admin", widths=(1440,), path="/catalog")
def stock_ui(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    errors = []
    if not page.evaluate("() => { const e = document.getElementById('product-stock-qty'); return !!e && e.type === 'number'; }"):
        errors.append("no number field #product-stock-qty in the product form")
    sold = page.evaluate("""() => { const c = productCard(%s); const btn = c.querySelector('.card-cart-btn');
        return { text: c.textContent, disabled: !btn || btn.disabled }; }""" % (STOCK_PRODUCT % 0))
    if "Распродан" not in sold["text"]:
        errors.append("card with stock 0 does not say 'Распродан'")
    if not sold["disabled"]:
        errors.append("cart button is still active for a sold-out product")
    few = page.evaluate("() => productCard(%s).textContent" % (STOCK_PRODUCT % 3))
    if "Осталось 3" not in few:
        errors.append("card with stock 3 does not say 'Осталось 3'")
    many = page.evaluate("() => productCard(%s).textContent" % (STOCK_PRODUCT % 50))
    if "Осталось" in many or "Распродан" in many:
        errors.append("plenty of stock must not show a scarcity label")
    plain = page.evaluate("() => productCard(%s).textContent" % (STOCK_PRODUCT % "null"))
    if "Осталось" in plain or "Распродан" in plain:
        errors.append("untracked product (stock_qty null) must look as before")
    page.evaluate("() => { funkoCart.length = 0; rawCatalogProducts.push(%s); rawCatalogProducts.push({ ...%s, id: 987655 }); }" % (STOCK_PRODUCT % 2, STOCK_PRODUCT % 0))
    page.evaluate("() => { window.addToCart(987654, 1); window.addToCart(987654, 1); window.addToCart(987654, 1); window.addToCart(987655, 1); }")
    got = page.evaluate("() => funkoCart.map(i => [i.id, i.qty])")
    if got != [[987654, 2]]:
        errors.append(f"cart must hold max 2 of 2 in stock and nothing sold out, got {got}")
    page.evaluate("() => window.openProductDetail(987655)")
    if not page.evaluate("() => { const b = document.querySelector('#pp-actions .btn.primary'); return !!b && b.disabled; }"):
        errors.append("product page 'В корзину' is not disabled for a sold-out product")
    return errors


HIDDEN_PRODUCT = """{ id: 987700, name: 'Hidden test', category: 'Funko', series: 'T', price: 3000, final_price: 3000, discount_percent: 0,
    in_stock: true, photo_id: '', figure_number: '9', packs_count: 0, badge: '', description: '', stock_qty: null, hidden: true, link_key: 'KEY987KEY' }"""


@check("hidden_product_admin_ui", role="admin", widths=(1440,), path="/catalog")
def hidden_product_admin_ui(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    errors = []
    if not page.evaluate("() => { const e = document.getElementById('product-hidden'); return !!e && e.type === 'checkbox' && !e.checked; }"):
        errors.append("product form lacks an unchecked #product-hidden checkbox")
    if "Скрыт" not in page.evaluate("() => productCard(%s).textContent" % HIDDEN_PRODUCT):
        errors.append("admin cannot tell a hidden product from a listed one in the catalog")
    page.evaluate("() => { rawCatalogProducts.push(%s); window.openEditProductModal(987700); }" % HIDDEN_PRODUCT)
    if not page.evaluate("() => document.getElementById('product-hidden').checked"):
        errors.append("edit form does not load the hidden flag")
    copied = page.evaluate("""async () => { let got = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { got = t; } }, configurable: true });
        window.copyProductLink(987700); await new Promise(r => setTimeout(r, 100)); return got; }""")
    if "product=987700" not in copied or "k=KEY987KEY" not in copied:
        errors.append(f"copied link for a hidden product lacks its key: {copied!r}")
    plain = page.evaluate("""async () => { let got = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { got = t; } }, configurable: true });
        rawCatalogProducts.push({ ...%s, id: 987701, hidden: false, link_key: '' }); window.copyProductLink(987701); await new Promise(r => setTimeout(r, 100)); return got; }""" % HIDDEN_PRODUCT)
    if "k=" in plain:
        errors.append("a listed product's link carries a key")
    return errors


@check("hidden_product_opens_by_link", widths=(1440,), path="/catalog")
def hidden_product_opens_by_link(page):
    seen = []

    def handler(route):
        url = route.request.url
        seen.append(url)
        if "k=GOODKEY" in url:
            route.fulfill(status=200, content_type="application/json", body='{"id": 987800, "name": "Secret figure", "category": "Funko", "price": 100, "final_price": 100, "discount_percent": 0, "in_stock": true, "photo_id": "", "figure_number": "", "description": "", "stock_qty": null, "hidden": true}')
        else:
            route.fulfill(status=404, content_type="application/json", body='{"detail": "Product not found"}')

    page.route("**/api/catalog/987800*", handler)
    errors = []
    page.goto(BASE + "/catalog?product=987800&k=GOODKEY", wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(1200)
    if not page.is_visible("#product-tab.active") or "Secret figure" not in page.inner_text("#product-tab"):
        errors.append("the link with the right key did not open the hidden product")
    if not any("k=GOODKEY" in u for u in seen):
        errors.append("the key from the address was not sent to the server")
    page.goto(BASE + "/catalog?product=987800&k=BAD", wait_until="networkidle", timeout=30000)
    page.wait_for_timeout(1200)
    if page.is_visible("#product-tab.active"):
        errors.append("a wrong key opened the hidden product")
    return errors


@check("phone_motion_respects_reduced", widths=(390,))
def phone_motion_respects_reduced(page):
    page.emulate_media(reduced_motion="reduce")
    page.wait_for_timeout(200)
    names = page.evaluate("() => [...document.querySelectorAll('.hero-fig')].map(e => getComputedStyle(e).animationName)")
    return [] if all(n == "none" for n in names) else [f"phone figures still move with reduced motion: {names}"]


SHADOW_JS = """(sel) => { const e = document.querySelector(sel); if (!e) return null; const sh = getComputedStyle(e).boxShadow;
    const m = sh.match(/rgba?\\(([^)]+)\\)\\s+(-?[\\d.]+)px\\s+(-?[\\d.]+)px\\s+([\\d.]+)px/); if (!m) return { raw: sh };
    const c = m[1].split(',').map(Number); return { raw: sh, rgb: c.slice(0, 3), alpha: c.length > 3 ? c[3] : 1, blur: +m[4] }; }"""


def _hover_shadow(page, sel):
    el = page.query_selector(sel)
    if not el:
        return None
    el.scroll_into_view_if_needed()
    page.hover(sel)
    page.wait_for_timeout(800)
    return page.evaluate(SHADOW_JS, sel)


@check("logo_stable", widths=(1440,))
def logo_stable(page):
    info = page.evaluate("""() => { const a = document.querySelector('.site-logo'), s = a.querySelector('span'), h = document.getElementById('site-header');
        const f = (e) => { const c = getComputedStyle(e); return [c.fontWeight, c.fontSynthesis, c.webkitFontSmoothing]; };
        return { a: f(a), s: f(s), layer: getComputedStyle(h).willChange }; }""")
    errors = []
    for part in ("a", "s"):
        w, syn, smooth = info[part]
        if w != "400":
            errors.append(f"logo {part} font-weight {w}, Anton only exists in 400 (anything else risks a fake bold)")
        if "weight" in syn:
            errors.append(f"logo {part} may synthesize bold ({syn})")
        if smooth != "antialiased":
            errors.append(f"logo {part} font smoothing is {smooth}")
    if "transform" not in info["layer"]:
        errors.append("header is not pinned to its own layer, so text rendering changes between top and scrolled")
    return errors


@check("shadows_dark_are_dark", widths=(1440,), path="/")
def shadows_dark_are_dark(page):
    page.evaluate("() => { document.documentElement.dataset.theme = 'dark'; }")
    errors = []
    for sel, hover in ((".glass-panel", False), (".hub-card", True), (".benefit", True)):
        sh = _hover_shadow(page, sel) if hover else page.evaluate(SHADOW_JS, sel)
        if not sh or "rgb" not in sh:
            continue
        if max(sh["rgb"]) > 70:
            errors.append(f"{sel}{':hover' if hover else ''} casts a LIGHT shadow in dark mode: {sh['raw'][:70]}")
    return errors


@check("shadows_light_are_soft", widths=(1440,), path="/")
def shadows_light_are_soft(page):
    errors = []
    for sel in (".hub-card", ".benefit"):
        sh = _hover_shadow(page, sel)
        if not sh:
            errors.append(f"{sel} has no hover shadow to measure")
        elif "rgb" in sh and (sh["alpha"] > 0.14 or sh["blur"] < 30):
            errors.append(f"{sel}:hover shadow is harsh (alpha {sh['alpha']}, blur {sh['blur']}px): {sh['raw'][:70]}")
    return errors


@check("faq_opens_smoothly", widths=(1440,), path="/")
def faq_opens_smoothly(page):
    info = page.evaluate("""() => { const a = getComputedStyle(document.querySelector('.faq-answer-panel')), p = getComputedStyle(document.querySelector('.faq-answer-panel p'));
        const dur = (s) => Math.max(...s.split(',').map(x => parseFloat(x))) ; return { prop: a.transitionProperty, dur: dur(a.transitionDuration), pprop: p.transitionProperty, pdur: dur(p.transitionDuration) }; }""")
    errors = []
    if info["dur"] < 0.45:
        errors.append(f"FAQ panel opens in {info['dur']}s, expected a calm >= 0.45s")
    if "max-height" in info["prop"]:
        errors.append("FAQ still animates max-height with a fixed ceiling (jerky; the answer height is not known)")
    if "opacity" not in info["pprop"] or info["pdur"] < 0.35:
        errors.append("FAQ answer text does not fade in gently")
    return errors


@check("catalog_stub_blocks_turn_transparent", widths=(1440,), path="/catalog")
def catalog_stub_blocks_turn_transparent(page):
    page.hover(".under-dev-feature")
    page.wait_for_timeout(700)
    bg = page.evaluate("() => getComputedStyle(document.querySelector('.under-dev-feature')).backgroundColor")
    return [] if bg in ("rgba(0, 0, 0, 0)", "transparent") else [f"stub block stays filled on hover: {bg}"]


@check("cart_text_and_icon", widths=(1440,), path="/")
def cart_text_and_icon(page):
    page.evaluate("() => { funkoCart.length = 0; window.openCartModal(); }")
    page.wait_for_timeout(500)
    errors = []
    stroke = page.evaluate("() => { const e = document.querySelector('#cart-empty-view svg'); return e ? e.getAttribute('stroke') : null; }")
    if stroke is None or "255, 255, 255" in stroke or "255,255,255" in stroke:
        errors.append(f"empty-cart icon stroke is {stroke!r}: invisible on the light theme")
    fam = page.evaluate("() => getComputedStyle(document.getElementById('cart-modal-count-pill')).fontFamily")
    if "Oswald" not in fam:
        errors.append(f"cart counter font is {fam.split(',')[0]}; its round zero reads as the letter o")
    tot = page.evaluate("() => getComputedStyle(document.getElementById('cart-total-display')).fontFamily")
    if "Oswald" not in tot:
        errors.append(f"cart total font is {tot.split(',')[0]}")
    return errors


@check("order_rows_react_on_hover_light", role="admin", widths=(1440,), path="/orders")
def order_rows_react_on_hover_light(page):
    page.wait_for_selector("#orders-table tbody tr", timeout=8000)
    before = page.evaluate("() => getComputedStyle(document.querySelector('#orders-table tbody tr td')).backgroundColor")
    page.hover("#orders-table tbody tr:nth-child(2)")
    page.wait_for_timeout(600)
    after = page.evaluate("() => { const td = document.querySelector('#orders-table tbody tr:nth-child(2) td'); const c = getComputedStyle(td); return [c.backgroundColor, c.boxShadow, c.transitionDuration]; }")
    errors = []
    if after[0] == before:
        errors.append("hovering an order row does not change its background in the light theme")
    if "inset" not in after[1]:
        errors.append("hovered row has no accent edge")
    if parseFloat_safe(after[2]) <= 0:
        errors.append("row hover is instant, not eased")
    return errors


def parseFloat_safe(v):
    try:
        return max(float(x.strip().rstrip("s")) for x in v.split(","))
    except ValueError:
        return 0.0


@check("sold_out_replaces_price", role="admin", widths=(1440,), path="/catalog")
def sold_out_replaces_price(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    card = page.evaluate("""() => { const c = productCard({ id: 987654, name: 'Sold', category: 'Funko', price: 3000, final_price: 2000, discount_percent: 33, in_stock: true, photo_id: '',
        figure_number: '1', packs_count: 0, badge: '', description: '', stock_qty: 0, hidden: false });
        const row = c.querySelector('.product-card-price-row'); return { row: row.textContent.replace(/\\s+/g, ' ').trim(), hasPrice: !!c.querySelector('.price-final'), tags: c.querySelector('.card-tags').textContent }; }""")
    errors = []
    if "Распродан" not in card["row"] or card["hasPrice"]:
        errors.append(f"sold-out card must show 'Распродан' INSTEAD of the price in the price row, got {card['row']!r}")
    if "Распродан" in card["tags"]:
        errors.append("'Распродан' is repeated as a corner tag; the price row says it now")
    page.evaluate("() => { rawCatalogProducts.push({ id: 987654, name: 'Sold', category: 'Funko', price: 3000, final_price: 2000, discount_percent: 33, in_stock: true, photo_id: '', figure_number: '1', packs_count: 0, badge: '', description: '', stock_qty: 0, hidden: false }); window.openProductDetail(987654); }")
    price = page.evaluate("() => document.getElementById('pp-price-row').textContent.trim()")
    if "Распродан" not in price or "₽" in price:
        errors.append(f"product page price line is {price!r}, expected 'Распродан' instead of the price")
    return errors


def _prod(extra):
    base = "id: 987900, name: 'Type test', category: 'Funko', price: 1000, final_price: 1000, discount_percent: 0, photo_id: '', figure_number: '', packs_count: 0, badge: '', description: '', hidden: false"
    return "{ " + base + ", " + extra + " }"


@check("availability_comes_from_the_type_not_the_quantity", role="admin", widths=(1440,), path="/catalog")
def availability_comes_from_the_type_not_the_quantity(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    cases = [("in_stock: false, stock_qty: 5", "Предзаказ", "В наличии"), ("in_stock: false, stock_qty: null", "Предзаказ", "В наличии"),
             ("in_stock: true, stock_qty: 5", "В наличии", "Предзаказ"), ("in_stock: true, stock_qty: null", "В наличии", "Предзаказ")]
    errors = []
    for extra, want, notwant in cases:
        tags = page.evaluate("() => productCard(%s).querySelector('.card-tags').textContent" % _prod(extra))
        if want not in tags or notwant in tags:
            errors.append(f"{extra}: card says {tags!r}, expected {want!r}")
    sold = page.evaluate("() => productCard(%s).textContent" % _prod("in_stock: false, stock_qty: 0"))
    if "Распродан" not in sold:
        errors.append("quantity 0 must still say 'Распродан' for a preorder")
    return errors


@check("availability_select_in_form", role="admin", widths=(1440,), path="/catalog")
def availability_select_in_form(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    errors = []
    info = page.evaluate("""() => { const e = document.getElementById('product-availability'); return e && e.tagName === 'SELECT' ? [...e.options].map(o => o.value + ':' + o.textContent.trim()) : null; }""")
    if not info:
        return ["no #product-availability select in the product form"]
    if info != ["preorder:Предзаказ", "instock:В наличии"]:
        errors.append(f"options are {info}, expected preorder first, then instock")
    page.evaluate("() => window.openAddProductModal()")
    if page.evaluate("() => document.getElementById('product-availability').value") != "preorder":
        errors.append("a new product must default to Предзаказ (the shop mostly sells preorders)")
    page.evaluate("() => { rawCatalogProducts.push(%s); window.openEditProductModal(987900); }" % _prod("in_stock: true, stock_qty: null"))
    if page.evaluate("() => document.getElementById('product-availability').value") != "instock":
        errors.append("edit form does not load 'В наличии' for an in-stock product")
    page.evaluate("() => { rawCatalogProducts.push({ ...%s, id: 987901 }); window.openEditProductModal(987901); }" % _prod("in_stock: false, stock_qty: 4"))
    if page.evaluate("() => document.getElementById('product-availability').value") != "preorder":
        errors.append("edit form loads the wrong type for a preorder that has a quantity")
    return errors


@check("products_list_filters_follow_the_type", role="admin", widths=(1440,), path="/catalog")
def products_list_filters_follow_the_type(page):
    page.wait_for_selector("#catalog-grid .product-card", timeout=8000)
    page.evaluate("() => window.switchTab('products')")
    page.wait_for_selector("#products-table tbody tr", timeout=10000)
    page.wait_for_load_state("networkidle")   # the section reloads the catalog; inject only after that finished
    page.wait_for_timeout(800)
    page.evaluate("""() => { rawCatalogProducts.length = 0;
        rawCatalogProducts.push({ ...%s, id: 1, name: 'PRE-with-qty', in_stock: false, stock_qty: 3 }, { ...%s, id: 2, name: 'STOCK-with-qty', in_stock: true, stock_qty: 3 },
                                { ...%s, id: 3, name: 'PRE-plain', in_stock: false, stock_qty: null }, { ...%s, id: 4, name: 'SOLD-pre', in_stock: false, stock_qty: 0 }); renderProductsAdmin(); }""" % ((_prod("stock_qty: null"),) * 4))

    def names(flt):
        page.select_option("#products-filter-stock", flt)
        page.wait_for_timeout(200)
        return sorted(page.evaluate("() => [...document.querySelectorAll('#products-table tbody tr .product-name-cell')].map(e => e.textContent.replace(/Скрыт/, '').trim())"))
    errors = []
    expect = {"instock": ["STOCK-with-qty"], "preorder": ["PRE-plain", "PRE-with-qty"], "low": ["PRE-with-qty", "STOCK-with-qty"], "sold": ["SOLD-pre"]}
    for flt, want in expect.items():
        got = names(flt)
        if got != want:
            errors.append(f"filter {flt!r} shows {got}, expected {want}")
    return errors


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
