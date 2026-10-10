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
    sys.stdout.reconfigure(encoding="utf-8")  # page text (↕, ₽, Cyrillic) must not crash a cp1251 Windows console
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--out", default="ui-shots")
    args = ap.parse_args()
    if args.selftest:
        selftest()
    else:
        sys.exit(1 if run(args.out) else 0)
