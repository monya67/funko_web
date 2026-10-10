# Light "Collectible Culture" Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the whole Funko Stop site (storefront, admin, legal pages) to the approved light mockup, responsive from 390px to 1440px, without changing behaviour or the backend.

**Architecture:** Colours become tokens on `:root`; the dark theme's hard-coded colours are inverted mechanically by a one-off converter (white → ink, near-black → card), then exceptions are fixed by hand. The left sidebar and the home page's own navbar are replaced by one sticky top bar with a profile dropdown that keeps every element ID `app.js` binds to. A Playwright script driving the installed Edge checks every page at four widths for horizontal overflow and unreadable text, and runs behaviour checks per task.

**Tech Stack:** FastAPI (untouched), vanilla JS SPA (`static/app.js`), one stylesheet (`static/styles.css`), Google Fonts (Anton, Outfit, Permanent Marker), Playwright for Python with `channel="msedge"` (dev only).

**Spec:** `docs/superpowers/specs/2026-10-10-light-redesign-design.md` — visual reference canvas https://claude.ai/artifact/6r58YeJ8DpNy8qrkgBSEk3

## Global Constraints

- No backend change: `main.py` is not edited.
- Restyle only: no new pages, no favourites, no hero slider, no change to what each role can see (clients keep Заказы + Архив as today).
- Deviation from the spec, on purpose: the top-bar search and the home "Новинки" strip are `admin-only` while guests still get the catalog's "В разработке" stub (a guest search would land on the stub). When the catalog opens to everyone, remove `admin-only hidden` from `#header-search` and `#home-new-section`.
- Keep every ID/class `app.js` binds to: `.nav-item[data-tab]`, `#sidebar-login-btn`, `#logout-btn`, `#sidebar-user-chip`, `#sidebar-user-label`, `#online-badge`, `#online-count`, `#orders-new-badge`, `#landing-cart-badge`, `.auth-only`, `.admin-only`, `.hidden`.
- Tokens: `--paper #EFECE6`, `--paper-2 #E7E3DB`, `--card #FFFFFF`, `--ink #111111`, `--ink-rgb 17, 17, 17`, `--ink-2 #3B3834`, `--muted #5E5A55`, `--ok #1E6B33` on `--ok-bg #DDEFE0`, `--pre #B00A12` on `--pre-bg #FBE0E1`, `--warn #8A5A00`, `--primary #E50914` (unchanged).
- Type: display `Anton` (uppercase), body `Outfit` (unchanged), hand-written accents `Permanent Marker` (hero only).
- Hero copy: "COLLECTIBLE CULTURE" + "Редкие фигурки, эксклюзивы и коллекционные релизы". Hero images: `static/images/hero/{dexter,doom,coraline}-box.webp`.
- Responsive: no horizontal page scroll at 390, 768, 1024, 1440px; wide tables scroll inside `.table-container`; touch targets ≥ 44px.
- Text contrast ≥ 4.5:1 for body text; `tests/ui_check.py` hard-fails anything under 3:1.
- UI checks are read-only: never submit forms, delete, pay or check out.
- Screenshots of admin pages contain real customer data: they go to the session scratchpad only, never into the repo.
- Commits: one per task **only if the user approved committing for this plan**; never push unless explicitly asked.
- Dev tool only: Playwright goes into `requirements-dev.txt`, never `requirements.txt`; it drives the installed Edge, no browser download.

## Review Focus

1. **Very long product names / series at 390px** — a 120-character name must wrap or clamp inside its card, never widen the page. Test: Task 5, `long_name_card`.
2. **A shop with many series** — 30 franchise chips on a phone must scroll inside their own row, not the page. Test: Task 5, `many_chips`.
3. **Profile dropdown at the right edge of a phone** — the open menu must stay fully inside the viewport. Test: Task 4, `profile_menu_guest` at 390.
4. **Cookie banner on a phone** — must not cover more than half the screen and its buttons must be ≥ 44px tall. Test: Task 7, `cookie_banner_phone`.
5. **Home anchors from another tab** — clicking "FAQ" in the top bar while on the catalog must open the home page scrolled to the FAQ, not do nothing. Test: Task 4, `home_anchor_from_catalog`.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `tests/ui_check.py` (create) | Overflow + contrast sweep over all pages/widths, behaviour checks, screenshots | 1, extended in 4–9 |
| `requirements-dev.txt` (create) | `playwright` for the checks | 1 |
| `static/styles.css` | Tokens, light base, all component styles; new rules appended in a `/* ===== LIGHT REDESIGN ===== */` section at the end | 2–8 |
| `static/index.html` | Top bar, hero, benefits, "Новинки" section, inline-style colours | 2–7 |
| `static/app.js` | Header behaviour, `productCard()`, `renderHomeNew()`, template colours | 3–6 |
| `static/images/grain.svg` (create) | Paper grain texture | 2 |
| `static/legal.css` (create) | Shared style for the three legal pages | 9 |
| `static/privacy.html`, `oferta.html`, `returns.html` | Header, TOC, link to `legal.css` | 9 |
| scratchpad `invert_theme.py` (not committed) | One-off colour converter | 2, 3 |

Run commands from the repo root. "Scratchpad" = `C:/Users/monya/AppData/Local/Temp/claude/c--Users-monya-Documents-funko-web/dd522797-9613-44c9-957f-9b562f84ec4a/scratchpad`, abbreviated `$SP`. The dev server must be running: `python -m uvicorn main:app --port 8000`. Admin checks need `UI_ADMIN_LOGIN=admi1ZV67` in the environment (local token signed with the local `SECRET_KEY`; it is useless against production).

---

### Task 1: UI check harness

**Files:**
- Create: `tests/ui_check.py`
- Create: `requirements-dev.txt`

**Interfaces:**
- Produces: `check(name, role="guest", widths=(1440,), path="/")` decorator registering `fn(page) -> list[str]` (error strings); `LOW_CONTRAST_JS`; `OVERFLOW_JS`; CLI `python tests/ui_check.py [--selftest] [--out DIR]`.

- [ ] **Step 1: Install the dev dependency**

`requirements-dev.txt`:
```
playwright==1.48.0
```
Run: `pip install -r requirements-dev.txt`
Expected: installs; no `playwright install` needed because `channel="msedge"` uses the system Edge.

- [ ] **Step 2: Write the harness with the self-test and stub detectors**

`tests/ui_check.py`:
```python
"""UI checks for the light redesign.

Needs the dev server on http://127.0.0.1:8000 and Microsoft Edge.
  python tests/ui_check.py --selftest
  python tests/ui_check.py --out <dir>        # UI_ADMIN_LOGIN=<login> adds admin pages
Read-only: never submits forms, deletes, pays or checks out.
"""
import argparse
import os
import sys
from datetime import datetime, timedelta

import jwt
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8000"
WIDTHS = [390, 768, 1024, 1440]
GUEST_PAGES = ["/", "/catalog", "/static/privacy.html", "/static/oferta.html", "/static/returns.html"]
ADMIN_PAGES = ["/", "/catalog", "/orders", "/archive", "/accounting", "/clients"]

OVERFLOW_JS = "() => document.documentElement.scrollWidth - window.innerWidth"
LOW_CONTRAST_JS = "() => []"

CHECKS = []


def check(name, role="guest", widths=(1440,), path="/"):
    def deco(fn):
        CHECKS.append((name, role, widths, path, fn))
        return fn
    return deco


def admin_token(login):
    load_dotenv()
    key = os.getenv("SECRET_KEY", "super-secret-key-change-me")
    exp = datetime.utcnow() + timedelta(hours=1)
    return jwt.encode({"sub": login, "role": "admin", "exp": exp}, key, algorithm="HS256")


def new_context(browser, width, token, consent=True):
    ctx = browser.new_context(viewport={"width": width, "height": 900})
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
    page.goto(BASE + path, wait_until="networkidle")
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


def run(out):
    login = os.getenv("UI_ADMIN_LOGIN")
    roles = {"guest": None}
    if login:
        roles["admin"] = admin_token(login)
    os.makedirs(out, exist_ok=True)
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge")
        for role, token in roles.items():
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
            if role not in roles:
                continue
            for width in widths:
                ctx = new_context(browser, width, roles[role], consent=(name != "cookie_banner_phone"))
                page = open_page(ctx, path)
                failures += [f"{name}@{width}: {e}" for e in fn(page)]
                ctx.close()
        browser.close()
    for f in failures:
        print("FAIL", f)
    print(f"{len(failures)} failure(s); screenshots in {out}")
    return failures


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--out", default="ui-shots")
    args = ap.parse_args()
    if args.selftest:
        selftest()
    else:
        sys.exit(1 if run(args.out) else 0)
```

- [ ] **Step 3: Run the self-test, see it fail**

Run: `python tests/ui_check.py --selftest`
Expected: `AssertionError: contrast detector returned []`

- [ ] **Step 4: Implement the contrast detector**

Replace the `LOW_CONTRAST_JS = "() => []"` line with:
```python
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
```

- [ ] **Step 5: Run the self-test, see it pass**

Run: `python tests/ui_check.py --selftest`
Expected: `selftest OK`

- [ ] **Step 6: Record the baseline on the current dark site**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots-baseline"`
Expected: runs to the end and prints a failure count (any number). Note it; the light theme must end at 0.

- [ ] **Step 7: Ignore screenshot folders and commit (if approved)**

Append `ui-shots/` to `.gitignore`, then:
```bash
git add tests/ui_check.py requirements-dev.txt .gitignore
git commit -m "test: add Playwright UI checks for overflow and contrast"
```

---

### Task 2: Light tokens, fonts, paper background, stylesheet inversion

**Files:**
- Modify: `static/styles.css` (`:root` block, `.background`, then whole file via converter)
- Modify: `static/index.html:60-61` (Google Fonts link) and its `<style>` block (lines 62-185)
- Create: `static/images/grain.svg`
- Create (scratchpad, not committed): `$SP/invert_theme.py`

**Interfaces:**
- Produces: the tokens listed in Global Constraints, plus `--font-display: 'Anton', sans-serif`, consumed by every later task. Legacy tokens keep their names with light values: `--dark`, `--darker`, `--surface`, `--surface-hover`, `--light`, `--gray`, `--gray-light`, `--glass-bg`, `--glass-border`.

- [ ] **Step 1: Add the failing base check**

Append to `tests/ui_check.py` above `if __name__`:
```python
@check("light_base")
def light_base(page):
    errors = []
    bg = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
    if bg != "rgb(239, 236, 230)":
        errors.append(f"body background is {bg}, expected paper rgb(239, 236, 230)")
    if not page.evaluate("() => document.fonts.ready.then(() => document.fonts.check('40px Anton'))"):
        errors.append("Anton web font not loaded")
    return errors
```
Run: `python tests/ui_check.py --out "$SP/shots"` → Expected: `FAIL light_base@1440: body background is rgb(...)…` and `Anton web font not loaded`.

- [ ] **Step 2: Replace the `:root` block in `static/styles.css`**

```css
:root {
    --paper: #EFECE6;
    --paper-2: #E7E3DB;
    --card: #FFFFFF;
    --ink: #111111;
    --ink-rgb: 17, 17, 17;
    --ink-2: #3B3834;
    --muted: #5E5A55;
    --ok: #1E6B33;
    --ok-bg: #DDEFE0;
    --pre: #B00A12;
    --pre-bg: #FBE0E1;
    --warn: #8A5A00;
    --font-display: 'Anton', sans-serif;

    --primary: #E50914;
    --primary-hover: #C20711;
    --primary-dim: rgba(229, 9, 20, 0.08);
    --dark: var(--paper);
    --darker: var(--paper-2);
    --surface: var(--card);
    --surface-hover: #F6F4EF;
    --light: var(--ink);
    --gray: var(--muted);
    --gray-light: #6B6660;
    --glass-bg: rgba(255, 255, 255, 0.92);
    --glass-border: rgba(17, 17, 17, 0.1);
    --radius: 0px;
    --transition: 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}
```

- [ ] **Step 3: Paper background with grain**

`static/images/grain.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)" opacity="0.16"/></svg>
```
Replace the `.background { … }` rule in `static/styles.css` with:
```css
.background {
    position: fixed;
    inset: 0;
    z-index: -1;
    background: var(--paper) url('/static/images/grain.svg') repeat;
    background-size: 240px 240px;
    background-blend-mode: multiply;
}
```
and make sure `body` has `background: var(--paper); color: var(--ink);`.

- [ ] **Step 4: Fonts**

In `static/index.html` replace the Outfit-only Google Fonts `<link>` with:
```html
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Outfit:wght@300;400;500;600;700;800;900&family=Permanent+Marker&display=swap" rel="stylesheet">
```
Append to the end of `static/styles.css`:
```css
/* ===== LIGHT REDESIGN ===== */
h1, h2, .display { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; letter-spacing: 0.2px; }
```

- [ ] **Step 5: Write the converter**

`$SP/invert_theme.py`:
```python
"""One-off: invert the dark theme's hard-coded colours to light-theme tokens.
usage: python invert_theme.py css|html|js <file>"""
import re
import sys

COLOR = re.compile(r'#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)|\bwhite\b|\bblack\b')
PROPS = {'color', 'background', 'background-color', 'border', 'border-color', 'border-top', 'border-bottom',
         'border-left', 'border-right', 'border-top-color', 'border-bottom-color', 'border-left-color',
         'border-right-color', 'outline', 'outline-color', 'fill', 'stroke', 'caret-color'}
TEXT_FIX = {'#00ff88': 'var(--ok)', '#40c057': 'var(--ok)', '#4ade80': 'var(--ok)', '#10b981': 'var(--ok)',
            '#ff4d4d': 'var(--pre)', '#ff6b6b': 'var(--pre)',
            '#ffb400': 'var(--warn)', '#fbbf24': 'var(--warn)', '#facc15': 'var(--warn)', '#f59e0b': 'var(--warn)'}


def rgba(tok):
    t = tok.lower()
    if t == 'white':
        return 255, 255, 255, 1.0
    if t == 'black':
        return 0, 0, 0, 1.0
    if t.startswith('#'):
        h = t[1:]
        if len(h) in (3, 4):
            h = ''.join(c * 2 for c in h)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a
    n = [float(x) for x in re.findall(r'[\d.]+', t)]
    return int(n[0]), int(n[1]), int(n[2]), (n[3] if len(n) > 3 else 1.0)


def lum(r, g, b):
    f = lambda v: (v / 255) / 12.92 if v / 255 <= 0.03928 else ((v / 255 + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def gray(r, g, b):
    return max(r, g, b) - min(r, g, b) <= 40


def keep(decls):
    """Blocks painted on red, gradients, images or dark scrims keep their colours."""
    for prop, val in decls:
        if not prop.startswith('background'):
            continue
        v = val.lower()
        if 'gradient' in v or 'url(' in v:
            return True
        for m in COLOR.finditer(v):
            r, g, b, a = rgba(m.group(0))
            if r > 170 and g < 90 and b < 90 and a > 0.5:
                return True
            if gray(r, g, b) and lum(r, g, b) < 0.03 and 0.4 <= a < 0.9:
                return True
    return False


def convert(prop, val):
    def sub(m):
        tok = m.group(0)
        r, g, b, a = rgba(tok)
        if prop == 'color' and tok.lower() in TEXT_FIX:
            return TEXT_FIX[tok.lower()]
        if not gray(r, g, b):
            return tok
        L = lum(r, g, b)
        if L > 0.8:
            return 'var(--ink)' if a >= 0.99 else f'rgba(var(--ink-rgb), {round(a, 2)})'
        if L < 0.03:
            if a >= 0.9:
                return 'var(--card)'
            if prop.startswith('background'):
                return f'rgba(255, 255, 255, {round(min(1, a + 0.1), 2)})'
            return tok
        if prop == 'color' and L > 0.2:
            return 'var(--muted)'
        return tok
    return COLOR.sub(sub, val)


def convert_decls(text):
    parts = text.split(';')
    decls = [(p.split(':', 1)[0].strip().lower(), p.split(':', 1)[1]) for p in parts if ':' in p]
    if keep(decls):
        return text, 0
    out, n = [], 0
    for p in parts:
        if ':' not in p:
            out.append(p)
            continue
        k, v = p.split(':', 1)
        if k.strip().lower() in PROPS:
            nv = convert(k.strip().lower(), v)
            n += nv != v
            out.append(f'{k}:{nv}')
        else:
            out.append(p)
    return ';'.join(out), n


def convert_css(css):
    total = 0

    def block(m):
        nonlocal total
        sel, body = m.group(1), m.group(2)
        if sel.strip().split('\n')[-1].strip() == ':root':
            return m.group(0)
        nb, n = convert_decls(body)
        total += n
        return f'{sel}{{{nb}}}'
    return re.sub(r'([^{}]*)\{([^{}]*)\}', block, css), total


def convert_style_attrs(src):
    total = 0

    def attr(m):
        nonlocal total
        nb, n = convert_decls(m.group(2))
        total += n
        return f'{m.group(1)}{nb}{m.group(3)}'
    return re.sub(r'(style=")([^"]*)(")', attr, src), total


if __name__ == '__main__':
    mode, path = sys.argv[1], sys.argv[2]
    src = open(path, encoding='utf-8').read()
    if mode == 'css':
        src, n = convert_css(src)
    else:
        counts = [0]
        if mode == 'html':
            def style_tag(m):
                css, k = convert_css(m.group(2))
                counts[0] += k
                return m.group(1) + css + m.group(3)
            src = re.sub(r'(<style>)(.*?)(</style>)', style_tag, src, flags=re.S)
        src, k = convert_style_attrs(src)
        n = counts[0] + k
    open(path, 'w', encoding='utf-8').write(src)
    print(f'{path}: {n} declarations changed')
```

- [ ] **Step 6: Convert the stylesheet and the `<style>` block of index.html**

Run:
```bash
python "$SP/invert_theme.py" css static/styles.css
python "$SP/invert_theme.py" html static/index.html
```
Expected: both print a non-zero count (roughly 200+ for the stylesheet). Then brace-balance check:
```bash
python -c "import re;s=re.sub(r'/\*.*?\*/','',open('static/styles.css',encoding='utf-8').read(),flags=re.S);print(s.count('{')==s.count('}'))"
```
Expected: `True`.

- [ ] **Step 7: Run the checks, fix what the converter could not know**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots"`
Expected: `light_base` passes. For each remaining `low contrast` line, open the screenshot, find the rule with `grep -n` on the printed text's class, and fix by these rules: white text on a red fill stays `#fff`; text on a white or paper surface uses `var(--ink)` / `var(--ink-2)` / `var(--muted)`; a dark fill that should now be a light surface becomes `var(--card)`. Re-run until the guest and admin sweeps at 1440 show 0 low-contrast lines (overflow at narrow widths is handled in later tasks).

- [ ] **Step 8: Commit (if approved)**

```bash
git add static/styles.css static/index.html static/images/grain.svg tests/ui_check.py
git commit -m "style: light theme tokens, paper background, invert hard-coded colours"
```

---

### Task 3: Inline colours in index.html and app.js templates

**Files:**
- Modify: `static/index.html` (296 `style=""` attributes — already converted by Task 2 step 6, verify here)
- Modify: `static/app.js` (60 `style=""` attributes inside template strings, plus direct `.style.*` colour assignments)

**Interfaces:** none new.

- [ ] **Step 1: Add the failing check for JS-rendered admin rows**

```python
@check("admin_orders_readable", role="admin", path="/orders")
def admin_orders_readable(page):
    page.wait_for_selector("#orders-table tbody tr", timeout=8000)
    return [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
```
Run the sweep. Expected: FAIL lines from JS-rendered cells (status pills, inline-styled spans).

- [ ] **Step 2: Convert app.js inline styles**

Run: `python "$SP/invert_theme.py" js static/app.js` — Expected: a non-zero count.

- [ ] **Step 3: Find colour assignments the converter does not see**

Run: `grep -nE "\.style\.(color|background|backgroundColor|borderColor)\s*=|color:\s*'#|background:\s*'#" static/app.js`
For each hit, apply the converter's rule by hand (`#fff` → `var(--ink)`, near-black → `var(--card)`, neon green → `var(--ok)`, light red text → `var(--pre)`, yellow text → `var(--warn)`), unless it paints text on a red fill.

- [ ] **Step 4: Re-run the sweep**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots"`
Expected: `admin_orders_readable` passes; no new low-contrast lines on any page at 1440.

- [ ] **Step 5: Commit (if approved)**

```bash
git add static/app.js static/index.html tests/ui_check.py
git commit -m "style: convert inline template colours to light tokens"
```

---

### Task 4: Top bar with profile menu (replaces sidebar and home navbar)

**Files:**
- Modify: `static/index.html` — remove `<aside class="sidebar glass-panel">…</aside>` (lines ~191-213) and `<header class="landing-navbar">…</header>` (lines ~221-251); insert the new header as the first child of `<body>` after `<div class="background">`
- Modify: `static/app.js` — header behaviour, appended after the `navItems.forEach(...)` click binding (~line 456)
- Modify: `static/styles.css` — layout + header styles appended to the LIGHT REDESIGN section; delete rules made dead by the removed markup

**Interfaces:**
- Consumes: `window.switchTab(tab, pushState)`, `window.openCartModal()`, `updateRoleUI(role)` (unchanged; it toggles `.admin-only` / `.auth-only` and the kept IDs).
- Produces: `setProfileMenu(open: boolean)`, `setSiteNav(open: boolean)`; DOM ids `site-header`, `site-nav`, `site-menu-toggle`, `profile-menu-btn`, `profile-menu`, `header-search`.

- [ ] **Step 1: Write the failing behaviour checks**

```python
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
```
Run the sweep. Expected: these five FAIL (`#profile-menu-btn` not found, etc.).

- [ ] **Step 2: Header markup**

Insert after `<div class="background"></div>`:
```html
<header id="site-header" class="site-header">
    <div class="site-header-inner">
        <a href="/" class="nav-item site-logo" data-tab="home" aria-label="Funko Stop — на главную">FUNKO <span>STOP</span></a>
        <nav id="site-nav" class="site-nav" aria-label="Основное меню">
            <a href="/catalog" class="nav-item site-nav-link" data-tab="catalog">Каталог</a>
            <a href="/#preorder-section" class="site-nav-link" data-home-anchor="preorder-section">Предзаказ</a>
            <a href="/#stock-section" class="site-nav-link" data-home-anchor="stock-section">Наличие (Авито)</a>
            <a href="/#delivery-section" class="site-nav-link" data-home-anchor="delivery-section">Оплата и доставка</a>
            <a href="/#faq-section" class="site-nav-link" data-home-anchor="faq-section">FAQ</a>
            <a href="https://t.me/FunkoStopReviews" target="_blank" rel="noopener" class="site-nav-link">Отзывы</a>
        </nav>
        <div class="site-actions">
            <label class="sr-only" for="header-search">Поиск по каталогу</label>
            <input id="header-search" class="header-search admin-only hidden" type="search" placeholder="Поиск фигурок, серий, номеров…">
            <button type="button" class="icon-btn" aria-label="Корзина" onclick="window.openCartModal()">
                <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>
                <span id="landing-cart-badge" class="cart-badge-count">0</span>
            </button>
            <div class="profile-wrap">
                <button type="button" id="profile-menu-btn" class="icon-btn" aria-label="Профиль" aria-haspopup="true" aria-expanded="false" aria-controls="profile-menu">
                    <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                </button>
                <div id="profile-menu" class="profile-menu hidden">
                    <div id="sidebar-user-chip" class="profile-menu-head hidden">
                        <span id="sidebar-user-label"></span>
                        <div id="online-badge" class="online-status admin-only hidden"><span class="online-dot"></span>На сайте: <strong id="online-count">1</strong> чел.</div>
                    </div>
                    <a href="/orders" class="nav-item profile-menu-item auth-only hidden" data-tab="orders">Заказы <span id="orders-new-badge" class="orders-badge hidden"></span></a>
                    <a href="/archive" class="nav-item profile-menu-item auth-only hidden" data-tab="archived">Архив</a>
                    <a href="/accounting" class="nav-item profile-menu-item admin-only hidden" data-tab="accounting">Бухгалтерия</a>
                    <a href="/clients" class="nav-item profile-menu-item admin-only hidden" data-tab="clients">Клиенты</a>
                    <button id="sidebar-login-btn" type="button" class="btn primary profile-menu-login">Войти</button>
                    <button id="logout-btn" type="button" class="profile-menu-item profile-menu-logout hidden">Выйти</button>
                </div>
            </div>
            <button type="button" id="site-menu-toggle" class="icon-btn site-menu-toggle" aria-label="Меню" aria-expanded="false" aria-controls="site-nav">
                <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><line x1="3" y1="7" x2="21" y2="7"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="17" x2="21" y2="17"></line></svg>
            </button>
        </div>
    </div>
</header>
```
Delete the old `<aside class="sidebar glass-panel">…</aside>` and `<header class="landing-navbar">…</header>` blocks. Then confirm nothing else references removed IDs:
`grep -nE "landing-login-btn|landing-user-chip|landing-user-name|landing-btn-" static/app.js` — every hit must already be null-guarded (`if (landingLoginBtn)`); if one is not, guard it.

- [ ] **Step 3: Header behaviour**

Append after the `navItems.forEach(item => { item.addEventListener('click', …) })` block in `static/app.js`:
```js
// --- Top bar: profile dropdown, burger menu, home anchors, header search ---
const profileBtn = document.getElementById('profile-menu-btn');
const profileMenu = document.getElementById('profile-menu');
const siteMenuToggle = document.getElementById('site-menu-toggle');
const siteNav = document.getElementById('site-nav');

function setProfileMenu(open) {
    profileMenu.classList.toggle('hidden', !open);
    profileBtn.setAttribute('aria-expanded', String(open));
}
function setSiteNav(open) {
    siteNav.classList.toggle('open', open);
    siteMenuToggle.setAttribute('aria-expanded', String(open));
}
profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setProfileMenu(profileMenu.classList.contains('hidden'));
});
siteMenuToggle.addEventListener('click', () => setSiteNav(!siteNav.classList.contains('open')));
document.addEventListener('click', (e) => {
    if (!profileMenu.contains(e.target)) setProfileMenu(false);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setProfileMenu(false); setSiteNav(false); }
});
profileMenu.querySelectorAll('a, button').forEach(el => el.addEventListener('click', () => setProfileMenu(false)));
siteNav.querySelectorAll('a').forEach(el => el.addEventListener('click', () => setSiteNav(false)));
document.querySelectorAll('[data-home-anchor]').forEach(a => a.addEventListener('click', (e) => {
    e.preventDefault();
    window.switchTab('home');
    document.getElementById(a.dataset.homeAnchor)?.scrollIntoView({ behavior: 'smooth' });
}));
document.getElementById('header-search')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    window.switchTab('catalog');
    const target = document.getElementById('catalog-search');
    target.value = e.target.value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
});
```
Check the event name: `grep -n "catalogSearchInput.addEventListener" static/app.js` — if it listens to something other than `'input'`, dispatch that event instead.

- [ ] **Step 4: Layout and header CSS**

Replace the `.dashboard-layout { … }` and `.content { … }` rules with:
```css
.dashboard-layout { display: block; min-height: 100vh; }
.content { max-width: 1360px; margin: 0 auto; padding: 32px 24px 72px; overflow: visible; }
```
Append to the LIGHT REDESIGN section:
```css
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.site-header { position: sticky; top: 0; z-index: 900; background: var(--paper); border-bottom: 1px solid rgba(var(--ink-rgb), 0.14); }
.site-header-inner { max-width: 1360px; margin: 0 auto; padding: 10px 24px; display: flex; align-items: center; gap: 12px 28px; }
.site-logo, .site-logo.active, .site-logo:hover { font-family: var(--font-display); font-size: 28px; line-height: 1; letter-spacing: 0.5px; color: var(--ink); text-decoration: none; padding: 0; background: none; border: 0; }
.site-logo span { color: var(--primary); }
.site-nav { display: flex; align-items: center; gap: 0 24px; margin: 0 auto; }
.site-nav-link, .site-nav-link.active, .site-nav-link:hover { display: inline-flex; align-items: center; min-height: 44px; padding: 0; font-size: 12px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: var(--ink); text-decoration: none; background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; }
.site-nav-link:hover { color: var(--pre); }
.site-nav-link.active { border-bottom-color: var(--primary); }
.site-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.header-search { width: 240px; height: 44px; box-sizing: border-box; padding: 0 14px; border: 1px solid rgba(var(--ink-rgb), 0.2); background: var(--card); color: var(--ink); font: inherit; font-size: 14px; }
.icon-btn { position: relative; width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center; border: 0; background: transparent; color: var(--ink); cursor: pointer; }
.icon-btn:hover { color: var(--pre); }
.icon-btn .cart-badge-count { position: absolute; top: 3px; right: 1px; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box; border-radius: 9px; background: var(--primary); color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.site-menu-toggle { display: none; }
.profile-wrap { position: relative; }
.profile-menu { position: absolute; right: 0; top: calc(100% + 8px); width: 260px; max-width: calc(100vw - 24px); padding: 6px 0; background: var(--card); border: 1px solid rgba(var(--ink-rgb), 0.14); box-shadow: 0 16px 36px rgba(var(--ink-rgb), 0.14); z-index: 950; }
.profile-menu-head { padding: 10px 16px 12px; border-bottom: 1px solid rgba(var(--ink-rgb), 0.1); font-size: 11px; font-weight: 700; letter-spacing: 1.3px; text-transform: uppercase; color: var(--pre); }
.profile-menu .online-status { display: flex; align-items: center; gap: 7px; margin-top: 6px; font-size: 13px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--ok); }
.profile-menu .online-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
.profile-menu-item, .profile-menu-item.active { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 44px; padding: 0 16px; box-sizing: border-box; border: 0; border-radius: 0; background: none; color: var(--ink); font: inherit; font-size: 15px; font-weight: 500; text-align: left; text-decoration: none; cursor: pointer; }
.profile-menu-item:hover, .profile-menu-item.active { background: var(--paper); }
.profile-menu-logout { border-top: 1px solid rgba(var(--ink-rgb), 0.1); color: var(--muted); }
.profile-menu-login { display: block; width: calc(100% - 32px); margin: 10px 16px; }
@media (max-width: 1023px) {
    .site-menu-toggle { display: inline-flex; }
    .site-nav { display: none; position: absolute; left: 0; right: 0; top: 100%; flex-direction: column; align-items: stretch; gap: 0; margin: 0; padding: 8px 24px 16px; background: var(--paper); border-bottom: 1px solid rgba(var(--ink-rgb), 0.14); }
    .site-nav.open { display: flex; }
    .header-search { display: none; }
}
@media (max-width: 479px) {
    .site-header-inner { padding: 8px 8px 8px 16px; gap: 8px; }
    .site-logo { font-size: 24px; }
}
```
Delete rules made dead by the removed markup: list them with
`grep -nE "^\s*\.(sidebar|sidebar-auth-box|landing-navbar|landing-nav-[a-z-]+|landing-logo[a-z-]*|landing-btn-[a-z-]+|landing-user-[a-z-]+)\b|home-mode \.sidebar" static/styles.css`
and remove each listed rule block (keep `.sidebar-toggle-btn` / `.sidebar-filter-header` — those belong to the catalog filter, not the removed sidebar).

- [ ] **Step 5: Run the checks**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots"`
Expected: the five header checks pass; no low-contrast lines; no header-caused overflow at 390. Look at `guest_390_home.png` and `guest_1440_catalog.png`.

- [ ] **Step 6: Commit (if approved)**

```bash
git add static/index.html static/app.js static/styles.css tests/ui_check.py
git commit -m "feat: top bar with profile menu replaces sidebar and home navbar"
```

---

### Task 5: Product card, catalog page, product page

**Files:**
- Modify: `static/app.js` — extract `productCard(p)` from `renderCatalog()`; use it there
- Modify: `static/styles.css` — card, catalog and product-page rules in the LIGHT REDESIGN section (they override the earlier card block)

**Interfaces:**
- Consumes: `window.openProductDetail(id)`, `window.addToCart(id, qty)`, `window.openEditProductModal(id)`, `window.confirmDeleteProduct(id)`, global `currentRole`.
- Produces: `productCard(p) -> HTMLElement` (an `<article class="product-card">`), consumed by Task 6.

- [ ] **Step 1: Write the failing checks**

```python
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
```
Run the sweep. Expected: `card_shape` FAILs (`productCard() is not defined`); `long_name_card` FAILs on the undefined function.

- [ ] **Step 2: Extract `productCard`**

Add above `function renderCatalog()` in `static/app.js`:
```js
const ICON_CART = '<svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>';
const ICON_IMAGE = '<svg aria-hidden="true" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="1"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';

function productCard(p) {
    const card = document.createElement('article');
    card.className = 'product-card';
    card.addEventListener('click', () => window.openProductDetail(p.id));

    const photoSrc = p.photo_id
        ? (p.photo_id.startsWith('http') || p.photo_id.startsWith('/static/') ? p.photo_id : `/api/photos/${p.photo_id}`)
        : '';
    const imgHtml = photoSrc
        ? `<img src="${photoSrc}" alt="${p.name}" loading="lazy">`
        : `<div class="product-image-placeholder">${ICON_IMAGE}<span>Фото скоро</span></div>`;
    const stockTag = p.in_stock ? '<span class="card-tag-stock">В наличии</span>' : '<span class="card-tag-pre">Предзаказ</span>';
    const discountTag = p.discount_percent > 0 ? `<span class="card-tag-discount">−${p.discount_percent}%</span>` : '';
    const badgeTag = p.badge ? `<span class="card-tag-badge">${p.badge}</span>` : '';
    const finalPrice = (p.final_price || p.price).toLocaleString('ru');
    const oldPrice = p.discount_percent > 0 ? `<span class="price-original">${p.price.toLocaleString('ru')} ₽</span>` : '';
    const adminButtons = currentRole === 'admin' ? `
        <div class="card-image-overlay">
            <button type="button" class="card-overlay-btn icon" aria-label="Редактировать" onclick="event.stopPropagation(); window.openEditProductModal(${p.id})">✎</button>
            <button type="button" class="card-overlay-btn icon danger" aria-label="Удалить" onclick="event.stopPropagation(); window.confirmDeleteProduct(${p.id})">✕</button>
        </div>` : '';

    card.innerHTML = `
        <div class="card-tags">${stockTag}${discountTag}${badgeTag}</div>
        <div class="product-image-box">${imgHtml}${adminButtons}</div>
        <div class="product-card-body">
            <div class="product-card-brand">${p.category || ''}</div>
            <div class="product-card-title" title="${p.name}">${p.figure_number ? `<span class="card-number">#${p.figure_number}</span> ` : ''}${p.name}</div>
            <div class="product-card-price-row">
                <div class="price-group"><span class="price-final">${finalPrice} ₽</span>${oldPrice}</div>
                <button type="button" class="card-cart-btn" aria-label="В корзину" onclick="event.stopPropagation(); window.addToCart(${p.id}, 1)">${ICON_CART}</button>
            </div>
        </div>`;
    return card;
}
```
In `renderCatalog()`, replace the whole `pageProducts.forEach((p, i) => { … catalogGrid.appendChild(card); });` body with:
```js
    pageProducts.forEach((p, i) => {
        const card = productCard(p);
        card.style.animationDelay = `${i * 0.06}s`;
        catalogGrid.appendChild(card);
    });
```
(This retires the old "Распродано / Подписаться" block: `in_stock = false` means "Предзаказ" in this shop and stays purchasable, as the filter labels already say.)

- [ ] **Step 3: Card, catalog and product-page CSS**

Append to the LIGHT REDESIGN section:
```css
.catalog-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
.product-card { background: var(--card); border: 1px solid rgba(var(--ink-rgb), 0.12); border-radius: 0; padding: 12px; gap: 12px; min-width: 0; }
.product-card:hover { border-color: rgba(var(--ink-rgb), 0.35); }
.card-tags { display: flex; flex-wrap: wrap; gap: 6px; min-height: 22px; }
.card-tag-stock, .card-tag-pre, .card-tag-discount, .card-tag-badge { padding: 4px 8px; font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; line-height: 1.2; }
.card-tag-stock { background: var(--ok-bg); color: var(--ok); }
.card-tag-pre { background: var(--pre-bg); color: var(--pre); }
.card-tag-discount, .card-tag-badge { background: var(--ink); color: var(--card); }
.product-image-box { background: #F1EEE8; border-radius: 0; }
.product-image-placeholder { color: var(--muted); }
.product-card-body { padding: 0; }
.product-card-brand { font-size: 14px; font-weight: 700; color: var(--ink); overflow-wrap: anywhere; }
.product-card-title { margin-top: 2px; font-size: 14px; font-weight: 400; text-transform: none; color: var(--ink-2); overflow-wrap: anywhere; -webkit-line-clamp: 2; }
.card-number { color: var(--muted); }
.price-final { font-size: 17px; font-weight: 700; color: var(--ink); }
.price-original { color: var(--gray-light); }
.card-cart-btn { width: 44px; height: 44px; border-radius: 0; background: transparent; border: 1px solid rgba(var(--ink-rgb), 0.22); color: var(--ink); }
.card-cart-btn:hover { background: var(--ink); border-color: var(--ink); color: var(--card); }
.franchise-chips-wrap { max-width: 100%; }
.franchise-chip { min-height: 44px; padding: 0 16px; font-size: 12px; font-weight: 600; letter-spacing: 1.2px; color: var(--ink); }
.franchise-chip.active { background: var(--primary); color: #fff; border-bottom-color: transparent; }
.catalog-header-bar h2 { font-family: var(--font-display); font-weight: 400; font-size: clamp(44px, 6vw, 76px); line-height: 0.95; }
.pp-image-box { background: #F1EEE8; border-radius: 0; }
#pp-title { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; font-size: clamp(32px, 4vw, 52px); line-height: 1; }
.pp-back-btn { border-radius: 0; background: transparent; border: 1px solid rgba(var(--ink-rgb), 0.2); color: var(--ink); min-height: 44px; }
@media (max-width: 479px) {
    .catalog-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .product-card { padding: 9px; gap: 9px; }
    .catalog-body-layout { grid-template-columns: minmax(0, 1fr); }
}
```

- [ ] **Step 4: Run the checks**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots"`
Expected: `card_shape`, `long_name_card`, `many_chips`, `product_page` pass; catalog pages at all widths show no overflow and no low-contrast lines. Compare `admin_1440_catalog.png` with the canvas "Каталог — компьютер".

- [ ] **Step 5: Commit (if approved)**

```bash
git add static/app.js static/styles.css tests/ui_check.py
git commit -m "feat: light product card shared by catalog; catalog and product page restyle"
```

---

### Task 6: Home page — hero collage, benefits strip, "Новинки"

**Files:**
- Modify: `static/index.html` — replace `<div class="home-hero glass-panel">…</div>` (the block before `<!-- Quick Hub Cards`) with the hero + benefits markup; add the "Новинки" section right after it
- Modify: `static/app.js` — `renderHomeNew()` called from `loadCatalog()` and `loadCatalogMeta()`
- Modify: `static/styles.css` — hero, benefits, home sections

**Interfaces:**
- Consumes: `productCard(p)` (Task 5), `rawCatalogProducts`, `catalogMeta.categories`, `window.switchTab`.
- Produces: `renderHomeNew()`; ids `home-new-section`, `home-new-tabs`, `home-new-grid`.

- [ ] **Step 1: Write the failing checks**

```python
@check("hero", widths=(390, 1440))
def hero(page):
    errors = []
    h1 = page.inner_text("#home-tab h1").upper()
    if "COLLECTIBLE" not in h1 or "РЕДКИЕ ФИГУРКИ" not in h1:
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
    return ["Новинки visible to guests while the catalog is closed"] if visible(page, "#home-new-section") else []
```
Run the sweep. Expected: FAIL for all three.

- [ ] **Step 2: Hero, benefits and "Новинки" markup**

Replace `<div class="home-hero glass-panel"> … </div>` with:
```html
<section class="hero">
    <div class="hero-text">
        <h1>
            <span class="hero-title">Collectible<br>culture</span>
            <svg class="hero-zigzag" aria-hidden="true" width="64" height="28" viewBox="0 0 64 28" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 24 L12 5 L20 20 L30 4 L38 20 L48 6 L60 22"></path></svg>
            <span class="hero-sub">Редкие фигурки, эксклюзивы и коллекционные релизы</span>
        </h1>
        <div class="hero-ctas">
            <a href="/catalog" class="hero-cta hero-cta-primary" onclick="event.preventDefault(); window.switchTab('catalog')">Перейти в каталог
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
            </a>
            <a href="https://t.me/Funko_Stop" target="_blank" rel="noopener" class="hero-cta hero-cta-secondary">Написать @Funko_Stop</a>
        </div>
    </div>
    <div class="hero-collage" aria-hidden="true">
        <svg class="hero-paper" viewBox="0 0 600 540" preserveAspectRatio="none">
            <polygon class="paper-ink" points="70,40 120,26 182,48 240,18 302,40 362,16 432,46 500,24 562,54 546,122 572,192 538,262 566,330 528,402 556,470 498,502 430,484 360,514 290,490 220,518 150,494 88,512 58,450 84,380 50,312 80,240 46,170 76,102"></polygon>
            <polygon class="paper-red" points="14,118 122,100 134,170 112,240 22,254 34,188"></polygon>
            <polygon class="paper-red" points="468,356 592,336 600,440 580,522 478,532 492,452"></polygon>
        </svg>
        <span class="hero-tape hero-tape-1"></span>
        <span class="hero-tape hero-tape-2"></span>
        <img class="hero-fig hero-fig-1" src="/static/images/hero/dexter-box.webp" alt="" width="800" height="800" decoding="async">
        <img class="hero-fig hero-fig-2" src="/static/images/hero/doom-box.webp" alt="" width="800" height="800" decoding="async">
        <img class="hero-fig hero-fig-3" src="/static/images/hero/coraline-box.webp" alt="" width="800" height="800" decoding="async">
        <span class="hero-scribble">Collect<br>trade<br>repeat</span>
        <span class="hero-callout hero-callout-1">Dexter</span>
        <span class="hero-callout hero-callout-2">Doctor Doom</span>
        <span class="hero-callout hero-callout-3">Coraline</span>
    </div>
</section>

<section class="benefits" aria-label="Преимущества">
    <div class="benefits-inner">
        <div class="benefit">
            <span class="benefit-icon"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg></span>
            <div><div class="benefit-title">Доставка по всей РФ</div><div class="benefit-text">СДЭК, Яндекс, Авито, Ozon, Почта</div></div>
        </div>
        <div class="benefit">
            <span class="benefit-icon"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="19" y1="5" x2="5" y2="19"></line><circle cx="6.5" cy="6.5" r="2.5"></circle><circle cx="17.5" cy="17.5" r="2.5"></circle></svg></span>
            <div><div class="benefit-title">50% предоплата</div><div class="benefit-text">Фиксация цены до самого получения</div></div>
        </div>
        <div class="benefit">
            <span class="benefit-icon"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg></span>
            <div><div class="benefit-title">30–90 дней хранения</div><div class="benefit-text">Бесплатно на нашем складе в Москве</div></div>
        </div>
        <div class="benefit">
            <span class="benefit-icon"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="1"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg></span>
            <div><div class="benefit-title">Р/С в Т-Банке</div><div class="benefit-text">Официально ИП · 0% скрытых комиссий</div></div>
        </div>
    </div>
</section>

<section id="home-new-section" class="home-new admin-only hidden" aria-labelledby="home-new-title">
    <div class="home-new-head">
        <div>
            <h2 id="home-new-title">Новинки<br>и предзаказы</h2>
            <a href="/catalog" class="link-arrow" onclick="event.preventDefault(); window.switchTab('catalog')">Смотреть все →</a>
        </div>
        <div id="home-new-tabs" class="home-new-tabs" role="tablist" aria-label="Бренды"></div>
    </div>
    <div id="home-new-grid" class="catalog-grid"></div>
</section>
```

- [ ] **Step 3: `renderHomeNew()`**

Add after `productCard()` in `static/app.js`:
```js
let homeNewCategory = '';

function renderHomeNew() {
    const grid = document.getElementById('home-new-grid');
    const tabs = document.getElementById('home-new-tabs');
    if (!grid || !tabs) return;
    const categories = ['', ...(catalogMeta.categories || [])];
    tabs.replaceChildren(...categories.map(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'franchise-chip' + (c === homeNewCategory ? ' active' : '');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(c === homeNewCategory));
        b.textContent = c || 'Все';
        b.addEventListener('click', () => { homeNewCategory = c; renderHomeNew(); });
        return b;
    }));
    const items = rawCatalogProducts
        .filter(p => !homeNewCategory || (p.category || '').toLowerCase() === homeNewCategory.toLowerCase())
        .slice(0, 5);
    grid.replaceChildren(...items.map(productCard));
}
```
Call `renderHomeNew();` as the last statement inside the `try` of `loadCatalog()` and of `loadCatalogMeta()`.

- [ ] **Step 4: Hero, benefits and home CSS**

Append to the LIGHT REDESIGN section:
```css
.dashboard-layout.home-mode .content { padding: 0 !important; max-width: none !important; }
.hero { max-width: 1360px; margin: 0 auto; padding: 48px 24px 40px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 32px; align-items: center; }
.hero h1 { margin: 0; text-transform: none; }
.hero-title { display: block; font-family: var(--font-display); font-weight: 400; font-size: clamp(60px, 9.6vw, 148px); line-height: 0.88; letter-spacing: -0.5px; text-transform: uppercase; color: var(--ink); }
.hero-zigzag { display: block; margin: 10px 0 0 4px; color: var(--primary); }
.hero-sub { display: block; margin-top: 16px; max-width: 470px; font-family: var(--font-display); font-weight: 400; font-size: clamp(20px, 2vw, 28px); line-height: 1.15; text-transform: uppercase; color: var(--ink-2); }
.hero-ctas { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 32px; }
.hero-cta { display: inline-flex; align-items: center; justify-content: center; gap: 10px; min-height: 52px; padding: 0 24px; box-sizing: border-box; font-size: 15px; font-weight: 600; text-decoration: none; }
.hero-cta-primary { background: var(--ink); color: var(--card); }
.hero-cta-primary:hover { background: var(--primary); color: #fff; }
.hero-cta-secondary { border: 1.5px solid var(--ink); color: var(--ink); }
.hero-collage { position: relative; width: 100%; max-width: 620px; aspect-ratio: 600 / 540; justify-self: end; }
.hero-paper { position: absolute; inset: 0; width: 100%; height: 100%; }
.paper-ink { fill: var(--ink); }
.paper-red { fill: var(--primary); }
.hero-fig { position: absolute; width: 44%; height: auto; filter: drop-shadow(0 14px 18px rgba(0, 0, 0, 0.35)); }
.hero-fig-1 { left: 3%; top: 20%; transform: rotate(-7deg); }
.hero-fig-2 { left: 27%; top: 2%; width: 50%; transform: rotate(3deg); z-index: 1; }
.hero-fig-3 { left: 55%; top: 28%; transform: rotate(8deg); }
.hero-tape { position: absolute; width: 16%; height: 5%; background: rgba(239, 236, 230, 0.85); z-index: 2; }
.hero-tape-1 { left: 37%; top: 2%; transform: rotate(-9deg); }
.hero-tape-2 { left: 72%; top: 29%; transform: rotate(14deg); }
.hero-scribble { position: absolute; right: 0; top: -3%; z-index: 2; font-family: 'Permanent Marker', cursive; font-size: clamp(14px, 1.7vw, 24px); line-height: 1.05; text-transform: uppercase; color: var(--ink); transform: rotate(-7deg); }
.hero-callout { position: absolute; bottom: -4%; padding: 26px 0 0 6px; border-left: 1px solid var(--ink); font-size: 11px; font-weight: 700; letter-spacing: 1.6px; text-transform: uppercase; color: var(--ink); }
.hero-callout-1 { left: 14%; } .hero-callout-2 { left: 45%; } .hero-callout-3 { left: 74%; }
.benefits { border-top: 1px solid rgba(var(--ink-rgb), 0.14); border-bottom: 1px solid rgba(var(--ink-rgb), 0.14); }
.benefits-inner { max-width: 1360px; margin: 0 auto; padding: 0 24px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.benefit { display: flex; align-items: center; gap: 14px; padding: 24px 20px; border-left: 1px solid rgba(var(--ink-rgb), 0.14); }
.benefit:first-child { border-left: 0; padding-left: 0; }
.benefit-icon { flex: none; width: 44px; height: 44px; box-sizing: border-box; border: 1.5px solid var(--primary); border-radius: 50%; color: var(--primary); display: flex; align-items: center; justify-content: center; }
.benefit-title { font-size: 14px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; color: var(--ink); }
.benefit-text { margin-top: 3px; font-size: 13px; color: var(--muted); }
.home-new { max-width: 1360px; margin: 0 auto; padding: 64px 24px; }
.home-new-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 20px 40px; margin-bottom: 28px; }
.home-new-head h2 { margin: 0; font-size: clamp(40px, 5vw, 58px); line-height: 0.95; }
.link-arrow { display: inline-flex; align-items: center; min-height: 44px; margin-top: 10px; font-size: 14px; font-weight: 600; color: var(--ink); text-decoration: none; }
.home-new-tabs { display: flex; flex-wrap: wrap; gap: 4px 6px; max-width: 100%; }
@media (max-width: 1023px) {
    .benefits-inner { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .benefit { border-left: 0; border-top: 1px solid rgba(var(--ink-rgb), 0.14); padding-left: 0; }
    .benefit:nth-child(-n+2) { border-top: 0; }
    .benefit:nth-child(even) { border-left: 1px solid rgba(var(--ink-rgb), 0.14); padding-left: 16px; }
}
@media (max-width: 899px) {
    .hero { grid-template-columns: minmax(0, 1fr); padding-top: 28px; }
    .hero-collage { justify-self: center; max-width: 520px; }
}
@media (max-width: 479px) {
    .hero { padding: 24px 16px 32px; }
    .hero-cta { flex: 1 1 100%; }
    .benefits-inner { padding: 0 16px; }
    .benefit { flex-direction: column; align-items: flex-start; gap: 8px; padding: 16px 12px 16px 0; }
    .benefit:nth-child(even) { padding-left: 12px; }
    .home-new { padding: 40px 16px; }
}
```
Restyle the remaining home blocks (`.home-hub-grid`, `.hub-card`, how-it-works, stock, delivery, FAQ) only where the sweep flags them: section titles `h2` already get Anton from Task 2; give `.hub-card` `background: var(--card); border: 1px solid rgba(var(--ink-rgb), 0.12); border-radius: 0;`.

- [ ] **Step 5: Run the checks**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots"`
Expected: `hero`, `home_new_admin`, `home_new_guest` pass; home pages at all four widths show no overflow and no low-contrast lines. Compare `guest_1440_home.png` / `guest_390_home.png` with the canvas artboards "Главная — компьютер" / "Главная — телефон".

- [ ] **Step 6: Commit (if approved)**

```bash
git add static/index.html static/app.js static/styles.css tests/ui_check.py static/images/hero
git commit -m "feat: light home page with hero collage, benefits strip and Новинки"
```

---

### Task 7: Buttons, forms, modals, cookie banner, footer, floating cart

**Files:**
- Modify: `static/styles.css` (LIGHT REDESIGN section)

**Interfaces:** consumes `window.openLoginModal()`, `window.openCartModal()`.

- [ ] **Step 1: Write the failing checks**

```python
@check("login_modal", widths=(390, 1440))
def login_modal(page):
    page.evaluate("() => window.openLoginModal()")
    page.wait_for_timeout(300)
    errors = [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
    radius = page.evaluate("() => getComputedStyle(document.getElementById('login-modal')).borderRadius")
    if radius not in ("0px", ""):
        errors.append(f"login modal radius {radius}, expected square corners")
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
    errors += [f"low contrast {i}" for i in page.evaluate(LOW_CONTRAST_JS)]
    return errors
```
Run. Expected: `login_modal` FAILs on the radius; `cookie_banner_phone` FAILs on button height (current buttons are smaller).

- [ ] **Step 2: Components CSS**

Append to the LIGHT REDESIGN section:
```css
.btn { border-radius: 0; min-height: 44px; font-weight: 600; }
.btn.primary { background: var(--ink); color: var(--card); border: 1.5px solid var(--ink); box-shadow: none; }
.btn.primary:hover { background: var(--primary); border-color: var(--primary); color: #fff; }
.btn.secondary, .btn.outline { background: transparent; color: var(--ink); border: 1.5px solid var(--ink); }
.btn.secondary:hover, .btn.outline:hover { background: var(--ink); color: var(--card); }
.btn.danger { background: var(--primary); color: #fff; border-color: var(--primary); }
input, select, textarea { border-radius: 0; background: var(--card); color: var(--ink); border: 1px solid rgba(var(--ink-rgb), 0.22); }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--ink); outline-offset: 1px; border-color: var(--ink); }
.modal-overlay { background: rgba(var(--ink-rgb), 0.45); }
.glass-panel, .modal { border-radius: 0; background: var(--card); border: 1px solid rgba(var(--ink-rgb), 0.14); box-shadow: 0 24px 60px rgba(var(--ink-rgb), 0.18); }
.modal h3 { font-family: var(--font-display); font-weight: 400; text-transform: uppercase; font-size: 28px; }
.cookie-banner { border-radius: 0; background: var(--card); border: 1px solid var(--ink); box-shadow: 0 18px 40px rgba(var(--ink-rgb), 0.18); color: var(--ink-2); }
.cookie-banner .btn { min-height: 48px; }
.floating-cart-btn { border-radius: 0; background: var(--ink); color: var(--card); }
.site-footer { background: transparent; border-top: 1px solid rgba(var(--ink-rgb), 0.14); color: var(--muted); }
.site-footer a { color: var(--ink); }
@media (max-width: 479px) {
    .modal { width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow-y: auto; padding: 1.2rem; }
    .cookie-banner { left: 8px; right: 8px; bottom: 8px; }
    .cookie-banner-content { flex-direction: column; align-items: stretch; gap: 12px; }
    .cookie-banner-actions { display: flex; flex-direction: column; gap: 8px; }
    .cookie-banner-icon { display: none; }
}
```

- [ ] **Step 3: Run the checks**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots"`
Expected: `login_modal`, `cart_modal`, `cookie_banner_phone` pass; no regressions elsewhere.

- [ ] **Step 4: Commit (if approved)**

```bash
git add static/styles.css tests/ui_check.py
git commit -m "style: light buttons, forms, modals, cookie banner and footer"
```

---

### Task 8: Admin pages (orders, archive, accounting, clients)

**Files:**
- Modify: `static/styles.css` (LIGHT REDESIGN section)

**Interfaces:** none new.

- [ ] **Step 1: Write the failing check**

```python
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
```
Run. Expected: FAIL (the page itself overflows, or the container does not scroll).

- [ ] **Step 2: Table and admin CSS**

```css
.table-container { max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; background: var(--card); }
table { border-collapse: collapse; }
th { font-size: 11px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--muted); background: var(--paper); border-bottom: 1px solid rgba(var(--ink-rgb), 0.14); }
td { color: var(--ink); border-bottom: 1px solid rgba(var(--ink-rgb), 0.08); }
tbody tr:hover { background: var(--surface-hover); }
.header-flex h2 { font-size: clamp(32px, 4vw, 48px); line-height: 1; }
@media (max-width: 767px) {
    .header-flex { flex-wrap: wrap; gap: 12px; }
    .content { padding: 20px 12px 56px; }
}
```

- [ ] **Step 3: Run the checks, fix flagged status pills**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots"`
Expected: `admin_tables_phone` passes. For any `low contrast` line on `/orders`, `/archive`, `/accounting`, `/clients`, restyle that status/pill class with a tinted pair from the tokens (`--ok`/`--ok-bg`, `--pre`/`--pre-bg`, `--warn` on `#F6E9C9`, `--ink` on `--paper-2`). Re-run until 0.

- [ ] **Step 4: Commit (if approved)**

```bash
git add static/styles.css tests/ui_check.py
git commit -m "style: light, phone-friendly admin tables"
```

---

### Task 9: Legal pages

**Files:**
- Create: `static/legal.css`
- Create (scratchpad, not committed): `$SP/legal_layout.py`
- Modify: `static/privacy.html`, `static/oferta.html`, `static/returns.html`

**Interfaces:** none (standalone pages; no `app.js`).

- [ ] **Step 1: Write the failing check**

```python
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
    if "Anton" not in font:
        errors.append(f"h1 font {font}")
    return errors
```
Run. Expected: FAIL (`no top bar on legal page`).

- [ ] **Step 2: `static/legal.css`**

```css
:root { --paper: #EFECE6; --card: #FFFFFF; --ink: #111111; --ink-rgb: 17, 17, 17; --ink-2: #2A2724; --muted: #5E5A55; --primary: #E50914; --pre: #B00A12; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper) url('/static/images/grain.svg') repeat; background-size: 240px 240px; color: var(--ink); font-family: 'Outfit', system-ui, sans-serif; }
a { color: var(--ink); } a:hover { color: var(--pre); }
.site-header { position: sticky; top: 0; z-index: 10; background: var(--paper); border-bottom: 1px solid rgba(var(--ink-rgb), 0.14); }
.site-header-inner { max-width: 1360px; margin: 0 auto; padding: 10px 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 28px; }
.site-logo { font-family: 'Anton', sans-serif; font-size: 28px; line-height: 1; letter-spacing: 0.5px; color: var(--ink); text-decoration: none; }
.site-logo span { color: var(--primary); }
.site-nav { display: flex; flex-wrap: wrap; gap: 0 22px; margin-left: auto; }
.site-nav a { display: inline-flex; align-items: center; min-height: 44px; font-size: 12px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; text-decoration: none; }
.container { max-width: 1360px; margin: 0 auto; padding: 36px 24px 72px; }
.back-btn { display: none; }
h1 { margin: 0; font-family: 'Anton', sans-serif; font-weight: 400; font-size: clamp(40px, 6vw, 72px); line-height: 0.95; text-transform: uppercase; }
.subtitle { margin-top: 12px; color: var(--muted); font-size: 14px; }
.info-card, .highlight-box { margin: 24px 0; padding: 18px 20px; background: var(--card); border: 1px solid rgba(var(--ink-rgb), 0.14); border-radius: 0; color: var(--ink-2); }
.legal-layout { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 32px 72px; margin-top: 36px; padding-top: 28px; border-top: 1px solid rgba(var(--ink-rgb), 0.14); }
.legal-toc { flex: 1 1 240px; max-width: 320px; position: sticky; top: 84px; }
.legal-toc-title { font-size: 11px; font-weight: 700; letter-spacing: 1.3px; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.legal-toc ol { margin: 0; padding: 0; list-style: none; border-left: 1px solid rgba(var(--ink-rgb), 0.14); }
.legal-toc a { display: block; padding: 8px 0 8px 16px; font-size: 14px; color: var(--ink-2); text-decoration: none; }
.legal-toc a:hover { color: var(--pre); }
.legal-body { flex: 999 1 560px; min-width: 0; max-width: 760px; font-size: 16px; line-height: 1.7; color: var(--ink-2); overflow-wrap: anywhere; }
.legal-body h2 { margin: 44px 0 0; padding-top: 32px; border-top: 1px solid rgba(var(--ink-rgb), 0.12); font-family: 'Anton', sans-serif; font-weight: 400; font-size: 28px; line-height: 1.1; text-transform: uppercase; color: var(--ink); scroll-margin-top: 80px; }
.legal-body h2:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.nav-links { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: 48px; padding-top: 20px; border-top: 1px solid rgba(var(--ink-rgb), 0.14); }
.nav-links a { min-height: 44px; display: inline-flex; align-items: center; }
footer { margin-top: 24px; font-size: 13px; color: var(--muted); }
@media (max-width: 1023px) { .site-nav { margin-left: 0; width: 100%; } .legal-toc { position: static; max-width: none; } }
@media (max-width: 479px) { .site-header-inner, .container { padding-left: 16px; padding-right: 16px; } .site-nav { gap: 0 16px; } }
```

- [ ] **Step 3: Transform script**

`$SP/legal_layout.py`:
```python
"""One-off: give the three legal pages the shared header, TOC and legal.css."""
import re

HEADER = """<header class="site-header"><div class="site-header-inner">
<a href="/" class="site-logo" aria-label="Funko Stop — на главную">FUNKO <span>STOP</span></a>
<nav class="site-nav" aria-label="Основное меню">
<a href="/catalog">Каталог</a><a href="/#preorder-section">Предзаказ</a><a href="/#stock-section">Наличие (Авито)</a>
<a href="/#delivery-section">Оплата и доставка</a><a href="/#faq-section">FAQ</a>
<a href="https://t.me/FunkoStopReviews" target="_blank" rel="noopener">Отзывы</a><a href="/">Личный кабинет</a>
</nav></div></header>"""
HEAD = """<link href="https://fonts.googleapis.com/css2?family=Anton&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/legal.css?v=1">"""

for name in ("privacy", "oferta", "returns"):
    path = f"static/{name}.html"
    s = open(path, encoding="utf-8").read()
    s = re.sub(r"<style>.*?</style>", HEAD, s, count=1, flags=re.S)
    s = s.replace("<body>", "<body>\n" + HEADER, 1)
    first_h2 = s.index("<h2")
    nav_links = s.index('<div class="nav-links">')
    body = s[first_h2:nav_links]
    titles = []

    def number(m, counter=[0]):
        counter[0] += 1
        titles.append((f"s{counter[0]}", re.sub(r"<[^>]+>", "", m.group(2)).strip()))
        return f'<h2{m.group(1)} id="s{counter[0]}">{m.group(2)}</h2>'
    body = re.sub(r"<h2([^>]*)>(.*?)</h2>", number, body, flags=re.S)
    toc = '<nav class="legal-toc" aria-label="Разделы документа"><div class="legal-toc-title">Разделы</div><ol>' + \
          "".join(f'<li><a href="#{i}">{t}</a></li>' for i, t in titles) + "</ol></nav>"
    s = s[:first_h2] + f'<div class="legal-layout">{toc}<article class="legal-body">{body}</article></div>\n' + s[nav_links:]
    open(path, "w", encoding="utf-8").write(s)
    print(path, len(titles), "sections")
```
Run: `python "$SP/legal_layout.py"`
Expected: `static/privacy.html 11 sections`, `static/oferta.html 8 sections`, `static/returns.html 6 sections`.

- [ ] **Step 4: Run the checks**

Run: `python tests/ui_check.py --out "$SP/shots"`
Expected: `legal_layout` passes; the three legal pages show no overflow and no low-contrast lines at all widths. Compare `guest_1440_static_privacy.png` with the canvas artboard "Документы".

- [ ] **Step 5: Commit (if approved)**

```bash
git add static/legal.css static/privacy.html static/oferta.html static/returns.html tests/ui_check.py
git commit -m "style: light legal pages with shared header and section index"
```

---

### Task 10: Full responsive sweep and release prep

**Files:**
- Modify: `static/index.html` (cache-buster `?v=` on `styles.css` and `app.js`)

- [ ] **Step 1: Full sweep**

Run: `UI_ADMIN_LOGIN=admi1ZV67 python tests/ui_check.py --out "$SP/shots-final"`
Expected: `0 failure(s)`.

- [ ] **Step 2: Eyeball every page at every width**

Open each PNG in `$SP/shots-final` (guest: home, catalog stub, 3 legal pages; admin: home, catalog, orders, archive, accounting, clients — each at 390/768/1024/1440). For each, confirm: light paper background, Anton headings, no element cut off or overlapping, header usable, red only as accent. Fix anything found and re-run Step 1.

- [ ] **Step 3: Bump the cache-buster**

Replace the current `?v=<number>` on both `/static/styles.css` and `/static/app.js` in `static/index.html` with a new value (e.g. `?v=1791700000000`). Run: `grep -n "?v=" static/index.html` — Expected: both lines show the new value.

- [ ] **Step 4: Final commit (if approved)**

```bash
git add static/index.html
git commit -m "chore: bump asset version for light redesign"
```
Do not push; report to the user and wait for an explicit "push".
