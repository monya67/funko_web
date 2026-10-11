# Funko Stop — light "collectible culture" redesign

Date: 2026-10-10
Status: approved in chat, awaiting written-spec review

## Goal

Restyle the whole site (storefront and admin) to match the client's mockup:
warm paper background, huge condensed black headlines, sparing red accents,
white product cards with availability tags, horizontal top navigation.

This is a restyle of what already exists. No new pages, no new features.

## Decisions (from the user)

| Topic | Decision |
|---|---|
| Scope | Whole site, admin pages included |
| Admin sections (Заказы, Архив, Бухгалтерия, Клиенты) | Move into a dropdown under the profile icon in the top bar |
| Mockup features the site lacks (favourites/hearts, "Как это работает" / "Контакты" pages, hero slider "01/03") | Not built. Only existing things are restyled; no empty pages |
| Hero collage image | Torn paper, red shapes and tape in SVG/CSS, with three boxed figures on top: `static/images/hero/{doom,dexter,coraline}-box.webp` (transparent cut-outs from funko.com product pages, chosen by the user) |
| Hero copy | As in the mockup: "COLLECTIBLE CULTURE" + "Редкие фигурки, эксклюзивы и коллекционные релизы" |
| Operator / API access for GPT | Out of scope, user deferred it |

## Visual language

Defined once as CSS custom properties on `:root`:

| Token | Value | Use |
|---|---|---|
| `--paper` | `#EFECE6` | page background, with a subtle SVG noise grain |
| `--card` | `#FFFFFF` | product cards, panels, modals |
| `--ink` / `--ink-rgb` | `#111111` / `17, 17, 17` | text, lines, icons |
| `--primary` | `#E50914` (unchanged) | "STOP" in logo, "Предзаказ" tag, active tab, discount |
| `--ok` | `#1E6B33` on `#DDEFE0` | "В наличии" tag (tinted fill, dark text; white on a mid green fails contrast) |
| `--pre` | `#B00A12` on `#FBE0E1` | "Предзаказ" tag, same tinted style |

Typography: headings in **Anton** (uppercase, condensed) with **Oswald 700** as the per-glyph fallback for Cyrillic (Anton has no Cyrillic glyphs), body stays **Outfit**.

Visual reference: the design canvas
https://claude.ai/artifact/6r58YeJ8DpNy8qrkgBSEk3 (home, catalog, phone home,
profile menu, legal page + cookie banner).

Product card: white tile with a thin ink border; availability tag top-left
("В наличии" green when `in_stock`, otherwise "Предзаказ" red); brand/category
in bold, name below, price. Keeps the existing click-through to the product page
and the cart button.

## Navigation

The left sidebar (`aside.sidebar`) is removed. One top bar appears on every page:

- left: `FUNKO STOP` logo
- centre: Каталог + the home page's existing anchors (Предзаказ, Наличие (Авито),
  Оплата и доставка, FAQ, Отзывы)
- right: search, cart with count, profile icon
- profile dropdown: admin → Заказы, Архив, Бухгалтерия, Клиенты, Выйти; client →
  Мои заказы, Выйти; guest → Войти
- mobile: burger menu

Existing element IDs and classes that `app.js` binds to (`.nav-item[data-tab]`,
`#sidebar-login-btn`, `#logout-btn`, `#sidebar-user-chip`, `#online-badge`,
`.auth-only`, `.admin-only`) are kept, so tab switching, role visibility and
login/logout keep working without JS rewrites.

## Home page

1. Hero: "COLLECTIBLE CULTURE" headline + subline, CTA buttons (existing),
   SVG/CSS collage on the right with the three boxed figures from
   `static/images/hero/`.
2. The existing row of four benefits (доставка, 50% предоплата, 30–90 дней
   хранения, Р/С в Т-Банке), restyled as the mockup's divided strip.
3. "Новинки" strip with category tabs and cards from the catalog. It follows the
   catalog's dev-mode rule: while visitors see the "В разработке" stub, only the
   admin sees this strip.
4. Remaining home sections keep their text, restyled.

## Everything else

Catalog, product page, cart, checkout and all modals, orders/archive/accounting/
clients tables: restyled to the light theme. Behaviour unchanged.

Legal pages `static/privacy.html`, `static/oferta.html`, `static/returns.html` are
standalone files with the same shape (h1 + numbered h2 sections). They share one
template: the same top bar, an Anton title, a section index on the left and a
readable text column (max ~760px) on the right, then the site footer. Their text
is not changed. The cookie consent banner becomes a white bar with an ink border
and two buttons ("Только необходимые" outlined, "Принять все" filled black).

## Approach

Colours are mostly hard-coded today (≈165 `rgba(255,255,255,…)`, 70 `#fff`,
296 inline `style=` in `index.html`, 60 in `app.js` templates; only 83 `var(--…)`).
On the dark theme, white means "foreground". So the conversion is a mechanical
inversion through tokens:

- `rgba(255,255,255,a)` → `rgba(var(--ink-rgb), a)`
- foreground `#fff` → `var(--ink)`; dark surfaces → `var(--card)` / `var(--paper)`

Then a manual pass on the exceptions that must stay light: text on red buttons,
on badges and on photos.

## Verification

No browser tool is attached to the session, but headless Edge
(`msedge --headless --screenshot`) works locally and the screenshots are
inspected after every step. Each page is captured at all four widths and
compared against the mockup. Admin pages need a logged-in session: Edge is started
with `--remote-debugging-port`, a scratch script sets the auth token in
`localStorage` over the DevTools protocol, then captures the page. Nothing is
added to the repo for this.

Responsive on every device: checked at 390px (phone), 768px (tablet),
1024px (small laptop) and 1440px (desktop). No horizontal page scroll at any
width; wide admin tables scroll inside their own box; touch targets ≥44px.

Done means: every page renders light with readable text (no white-on-white),
tab switching / login / cart / checkout / admin tables still work, and the home
page matches the mockup's structure.

## Out of scope

Operator role and API for GPT, favourites, new pages or sections, a raster hero
image, any backend change.
