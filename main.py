import os
import time
import hmac
import secrets
import json
from typing import Optional
import re
import asyncpg
import jwt
import httpx
import ssl
import hashlib
from datetime import datetime, timedelta, timezone
import asyncio
from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, RedirectResponse
from fastapi import UploadFile, File, Form
from pydantic import BaseModel
from dotenv import load_dotenv
import io
import random
from PIL import Image, ImageOps, ImageChops, ImageDraw, ImageFilter
import html as html_lib
import random as _random
try:
    # Photos from a Mac or an iPhone are HEIC; without this Pillow cannot open them
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    print("pillow-heif is not installed: HEIC photos cannot be converted")
import finance as F

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL is missing")

SECRET_KEY = os.getenv("SECRET_KEY", "super-secret-key-change-me")
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_IDS = [int(x.strip()) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip()]
# Product and order photos live in Telegram. A private channel set here keeps them out of the admins' chats;
# without it the photo goes to the first admin and is deleted right away (the file stays reachable).
PHOTO_STORAGE_CHAT_ID = os.getenv("PHOTO_STORAGE_CHAT_ID", "").strip()

# Product descriptions written by an LLM (Groq, OpenAI-compatible API). Empty key = the button says it is off.
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
# Qwen knew the characters best in our tests but has a small per-minute limit; GPT-OSS takes over when it is busy
GROQ_MODELS = [m.strip() for m in os.getenv("GROQ_MODELS", "qwen/qwen3.8-27b,openai/gpt-oss-120b").split(",") if m.strip()]

TBANK_TERMINAL_KEY = os.getenv("TBANK_TERMINAL_KEY", "")
TBANK_PASSWORD = os.getenv("TBANK_PASSWORD", "")

# Order e-mails to clients (transactional, sent without marketing consent). Set on Render; empty = e-mails off.
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
MAIL_FROM_NAME = os.getenv("MAIL_FROM_NAME", "Funko Stop")
# With a sending service (Brevo, Unisender) the login is not an address: the letters come from MAIL_FROM
# (e.g. noreply@funkostop.org, the domain verified there), and replies go to MAIL_REPLY_TO.
MAIL_FROM = os.getenv("MAIL_FROM", "").strip() or SMTP_USER
MAIL_REPLY_TO = os.getenv("MAIL_REPLY_TO", "").strip()
SITE_URL = os.getenv("SITE_URL", "https://funkostop.org").rstrip("/")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 365  # 1 year (persistent login)

app = FastAPI(title="Funko Stop Admin Panel")

# SSL context with Russian Trusted CA support (Mincifry)
# Install certs with: sudo bash install_certs.sh
# Then set SSL_CERT_FILE=/etc/ssl/russian-trusted-ca-bundle.pem in .env
def get_ssl_context():
    ca_bundle = os.getenv("SSL_CERT_FILE") or os.getenv("REQUESTS_CA_BUNDLE")
    if ca_bundle and os.path.exists(ca_bundle):
        ctx = ssl.create_default_context(cafile=ca_bundle)
        return ctx
    return True  # default: use system/certifi trust store

SSL_VERIFY = get_ssl_context()


async def notify_admins(text: str):
    """Message every admin in ADMIN_IDS. One admin failing (e.g. never pressed
    Start on the bot) must not stop the others from being notified."""
    if not BOT_TOKEN or not ADMIN_IDS:
        print("TG notify skipped: BOT_TOKEN or ADMIN_IDS not set")
        return
    async with httpx.AsyncClient(verify=SSL_VERIFY) as client:
        for admin_id in ADMIN_IDS:
            try:
                res = await client.post(
                    f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                    json={"chat_id": admin_id, "text": text, "parse_mode": "Markdown"},
                    timeout=15,
                )
                data = res.json()
                if not data.get("ok"):
                    print(f"TG notify {admin_id} rejected: {data.get('description')}")
            except Exception as e:
                print(f"TG notify {admin_id} failed: {e}")


IMAGE_CACHE = {}
CACHE_LIMIT = 500

# Active Users Tracking (Heartbeat)
active_sessions = {}

def update_user_session(request: Request, user: dict = None):
    dev_id = request.headers.get("x-device-id")
    if not dev_id:
        if user:
            dev_id = f"{user['role']}_{user['id']}"
        else:
            dev_id = request.client.host if (request and request.client) else "unknown"
    active_sessions[dev_id] = datetime.utcnow()

def get_online_count():
    now = datetime.utcnow()
    cutoff = now - timedelta(seconds=60)
    for sid, last_seen in list(active_sessions.items()):
        if last_seen < cutoff:
            del active_sessions[sid]
    return max(1, len(active_sessions))

# Security
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/login")

pool = None

@app.on_event("startup")
async def startup():
    global pool
    pool = await asyncpg.create_pool(DATABASE_URL)
    app.state.cleanup_task = asyncio.create_task(unpaid_orders_loop())
    app.state.finance_baseline = asyncio.create_task(finance_baseline())
    app.state.hero_warmup = asyncio.create_task(warm_hero_cutouts())
    # Add archived column if it doesn't exist yet
    async with pool.acquire() as db:
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_date TEXT")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cost_price INTEGER DEFAULT 0")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_cost INTEGER DEFAULT 0")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT ''")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT DEFAULT ''")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_tg TEXT DEFAULT ''")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT '50%'")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS tbank_payment_id TEXT DEFAULT ''")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_note TEXT DEFAULT ''")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()")
        await db.execute("CREATE TABLE IF NOT EXISTS login_throttle (key TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until DOUBLE PRECISION NOT NULL DEFAULT 0, updated DOUBLE PRECISION NOT NULL DEFAULT 0)")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'")
        await db.execute("ALTER TABLE clients ADD COLUMN IF NOT EXISTS full_name TEXT DEFAULT ''")
        await db.execute("ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_name TEXT DEFAULT ''")
        await db.execute("ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_name TEXT DEFAULT ''")
        await db.execute("ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT ''")
        await db.execute("ALTER TABLE clients ADD COLUMN IF NOT EXISTS tg_username TEXT DEFAULT ''")
        await db.execute("ALTER TABLE clients ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''")
        await db.execute("ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_consent BOOLEAN DEFAULT FALSE")
        await db.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''")
        await db.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_qty INTEGER")
        await db.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE")
        await db.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS link_key TEXT DEFAULT ''")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_items TEXT DEFAULT ''")

        # Ledger (manual income/expense entries)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS ledger_entries (
                id SERIAL PRIMARY KEY,
                entry_date TEXT NOT NULL,
                description TEXT DEFAULT '',
                amount INTEGER NOT NULL,
                entry_type TEXT NOT NULL DEFAULT 'expense',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Accounting: planned costs copied into each order, private purchase data of products, history
        for col, typ in (("planned_purchase_cost", "INTEGER"), ("planned_shipping", "INTEGER"), ("purchase_usd", "NUMERIC(10,2)"),
                         ("fx_rate", "NUMERIC(10,4)"), ("product_kind", "TEXT DEFAULT ''"), ("completed_at", "TIMESTAMPTZ")):
            await db.execute(f"ALTER TABLE orders ADD COLUMN IF NOT EXISTS {col} {typ}")
        for col, typ in (("purchase_usd", "NUMERIC(10,2)"), ("planned_shipping_rub", "INTEGER"),
                         ("purchase_source", "TEXT DEFAULT ''"), ("product_kind", "TEXT DEFAULT ''")):
            await db.execute(f"ALTER TABLE products ADD COLUMN IF NOT EXISTS {col} {typ}")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS finance_events (
                id SERIAL PRIMARY KEY,
                created_at TIMESTAMPTZ DEFAULT now(),
                order_id INTEGER,
                kind TEXT NOT NULL,
                amount INTEGER NOT NULL,
                note TEXT DEFAULT ''
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS finance_events_order ON finance_events (order_id)")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS owner_withdrawals (
                id SERIAL PRIMARY KEY,
                wd_date TEXT NOT NULL,
                amount INTEGER NOT NULL,
                comment TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT now()
            )
        """)
        await db.execute("CREATE TABLE IF NOT EXISTS finance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")

        # Admin registers: purchases bought for clients in other shops, and promo codes for those shops
        await db.execute("""
            CREATE TABLE IF NOT EXISTS purchases (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                amount INTEGER DEFAULT 0,
                purchase_date TEXT DEFAULT '',
                track TEXT DEFAULT '',
                kind TEXT DEFAULT 'stock',
                expected_date TEXT DEFAULT '',
                shop TEXT DEFAULT '',
                delivered BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT now()
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS promo_codes (
                id SERIAL PRIMARY KEY,
                code TEXT NOT NULL,
                value INTEGER DEFAULT 0,
                value_kind TEXT DEFAULT 'percent',
                site TEXT DEFAULT '',
                conditions TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT now()
            )
        """)

        # Catalog tables
        await db.execute("""
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS series (
                id SERIAL PRIMARY KEY,
                name TEXT UNIQUE NOT NULL
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                figure_number TEXT DEFAULT '',
                price INTEGER NOT NULL DEFAULT 0,
                discount_percent INTEGER DEFAULT 0,
                final_price INTEGER NOT NULL DEFAULT 0,
                category TEXT NOT NULL DEFAULT '',
                series TEXT NOT NULL DEFAULT '',
                packs_count INTEGER DEFAULT 0,
                photo_id TEXT DEFAULT '',
                in_stock BOOLEAN DEFAULT TRUE,
                badge TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("ALTER TABLE products ADD COLUMN IF NOT EXISTS badge TEXT DEFAULT ''")

@app.on_event("shutdown")
async def shutdown():
    if pool:
        await pool.close()

# --- Auth ---
def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

async def get_current_user(request: Request, token: str = Depends(oauth2_scheme)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        role: str = payload.get("role")
        sub = payload.get("sub")
        if not sub or not role:
            raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    async with pool.acquire() as db:
        if role == "admin":
            user = await db.fetchrow("SELECT * FROM users WHERE login_id = $1 AND role = 'admin'", sub)
            if not user:
                raise HTTPException(status_code=401, detail="Admin not found")
            res_user = {"role": "admin", "id": user["id"], "login": sub}
            update_user_session(request, res_user)
            return res_user
        elif role == "client":
            client = await db.fetchrow("SELECT * FROM clients WHERE id = $1", int(sub))
            if not client:
                raise HTTPException(status_code=401, detail="Client not found")
            res_user = {"role": "client", "id": client["id"]}
            update_user_session(request, res_user)
            return res_user
        else:
            raise HTTPException(status_code=401, detail="Invalid role")

def require_admin(user: dict = Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user

# --- Models ---
class ClientCreate(BaseModel):
    password: str
    first_name: str = ""
    last_name: str = ""
    full_name: str = ""
    phone: str = ""
    tg_username: str = ""
    email: str = ""

class ClientUpdate(BaseModel):
    password: str = ""
    first_name: str = ""
    last_name: str = ""
    full_name: str = ""
    phone: str = ""
    tg_username: str = ""
    email: str = ""

class OrderCreate(BaseModel):
    client_id: int
    items: str
    total_price: int
    paid_amount: int
    photo_id: str = ""
    order_date: str = ""
    cost_price: int = 0
    delivery_cost: int = 0

class OrderUpdate(BaseModel):
    items: str
    total_price: int
    paid_amount: int
    status: str
    photo_id: str = ""
    order_date: str = ""
    cost_price: int = 0
    delivery_cost: int = 0

class ProductCreate(BaseModel):
    name: str
    figure_number: str = ""
    price: int
    discount_percent: int = 0
    final_price: int = 0
    category: str = ""
    series: str = ""
    packs_count: int = 0
    photo_id: str = ""
    in_stock: bool = True
    badge: str = ""
    description: str = ""
    stock_qty: Optional[int] = None
    hidden: bool = False
    purchase_usd: Optional[float] = None
    planned_shipping_rub: Optional[int] = None
    purchase_source: Optional[str] = None
    product_kind: Optional[str] = None

class ProductUpdate(BaseModel):
    name: str
    figure_number: str = ""
    price: int
    discount_percent: int = 0
    final_price: int = 0
    category: str = ""
    series: str = ""
    packs_count: int = 0
    photo_id: str = ""
    in_stock: bool = True
    badge: str = ""
    description: str = ""
    stock_qty: Optional[int] = None
    hidden: bool = False
    purchase_usd: Optional[float] = None
    planned_shipping_rub: Optional[int] = None
    purchase_source: Optional[str] = None
    product_kind: Optional[str] = None

ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class PurchaseIn(BaseModel):
    title: str
    description: str = ""
    amount: int = 0
    purchase_date: str = ""
    track: str = ""
    kind: str = "stock"          # 'stock' or 'preorder'
    expected_date: str = ""      # preorders only: when the shop is expected to ship
    shop: str = ""
    delivered: bool = False


class PromoCodeIn(BaseModel):
    code: str
    value: int = 0
    value_kind: str = "percent"  # 'percent' or 'rub'
    site: str = ""
    conditions: str = ""


def clean_purchase(p: PurchaseIn) -> dict:
    """Validated purchase fields, in column order. Raises ValueError with a message for the admin."""
    title = p.title.strip()
    if not title:
        raise ValueError("Укажите название")
    if p.kind not in ("stock", "preorder"):
        raise ValueError("Неверный тип")
    if p.amount < 0:
        raise ValueError("Сумма не может быть отрицательной")
    for d in (p.purchase_date, p.expected_date):
        if d and not ISO_DATE_RE.match(d):
            raise ValueError("Неверная дата")
    return {
        "title": title[:300], "description": p.description.strip()[:5000], "amount": p.amount,
        "purchase_date": p.purchase_date, "track": p.track.strip()[:200], "kind": p.kind,
        "expected_date": p.expected_date if p.kind == "preorder" else "",
        "shop": p.shop.strip()[:200], "delivered": p.delivered,
    }


def clean_promo(p: PromoCodeIn) -> dict:
    code = p.code.strip()
    if not code:
        raise ValueError("Укажите промокод")
    if p.value_kind not in ("percent", "rub"):
        raise ValueError("Неверный тип скидки")
    if p.value < 0 or (p.value_kind == "percent" and p.value > 100):
        raise ValueError("Неверный размер скидки")
    return {"code": code[:100], "value": p.value, "value_kind": p.value_kind,
            "site": p.site.strip()[:300], "conditions": p.conditions.strip()[:5000]}


class LedgerEntryCreate(BaseModel):
    entry_date: str
    description: str = ""
    amount: int
    entry_type: str = "expense"  # 'income' or 'expense'

class QuickOrderCreate(BaseModel):
    client_id: int
    paid_amount: int = 0

class CartItem(BaseModel):
    id: int
    name: str
    figure_number: str = ""
    price: int = 0
    final_price: int = 0
    photo_id: str = ""
    qty: int = 1

class CheckoutRequest(BaseModel):
    items: list[CartItem]
    customer_name: str = ""
    first_name: str = ""
    last_name: str = ""
    phone: str
    telegram: str
    email: str
    marketing_consent: bool = False
    payment_type: str = "50%"
    delivery_method: str = ""
    comment: str = ""

# --- T-Bank Payment Helpers ---
def tbank_generate_token(params: dict) -> str:
    filtered = {k: v for k, v in params.items() if k not in ("Shops", "DATA", "Receipt", "Items")}
    filtered["Password"] = TBANK_PASSWORD
    sorted_pairs = sorted(filtered.items(), key=lambda x: x[0])
    # T-Bank signs booleans as true/false; Python would write True/False and the webhook token would never match
    concat = "".join(("true" if v is True else "false" if v is False else str(v)) for _, v in sorted_pairs)
    return hashlib.sha256(concat.encode("utf-8")).hexdigest()

UNPAID_ORDER_MINUTES = 60


async def tbank_init_payment(amount_kopecks: int, order_id: int, description: str) -> dict:
    params = {
        "TerminalKey": TBANK_TERMINAL_KEY,
        "Amount": amount_kopecks,
        "OrderId": str(order_id),
        "Description": description[:250],
    }

    def signed(p):
        return {**p, "Token": tbank_generate_token(p)}

    # the payment link dies with the unpaid order, so nobody can pay for an order that is already gone
    due = (datetime.now(timezone(timedelta(hours=3))) + timedelta(minutes=UNPAID_ORDER_MINUTES)).strftime("%Y-%m-%dT%H:%M:%S+03:00")
    async with httpx.AsyncClient(verify=SSL_VERIFY) as client:
        resp = (await client.post("https://securepay.tinkoff.ru/v2/Init", json=signed({**params, "RedirectDueDate": due}), timeout=15)).json()
        if not resp.get("Success"):
            print(f"T-Bank Init with a link lifetime failed, retrying without it: {resp}")
            resp = (await client.post("https://securepay.tinkoff.ru/v2/Init", json=signed(params), timeout=15)).json()
        return resp


async def expire_unpaid_orders(db, minutes=UNPAID_ORDER_MINUTES + 15):
    """Remove checkout orders that never got paid and give their stock back. Returns how many were removed."""
    ids = await db.fetch(
        "SELECT id FROM orders WHERE status = $1 AND payment_status = 'pending' AND created_at < now() - ($2 * interval '1 minute')",
        AWAITING_PAYMENT, minutes)
    removed = 0
    for row in ids:
        # one atomic claim: a payment confirmed meanwhile changes the status, and then nothing is deleted
        stock = await db.fetchrow(
            "DELETE FROM orders WHERE id = $1 AND status = $2 AND payment_status = 'pending' RETURNING stock_items",
            row["id"], AWAITING_PAYMENT)
        if stock is None:
            continue
        removed += 1
        if stock["stock_items"]:
            await restore_stock(db, parse_stock_items(stock["stock_items"]))
    return removed


async def unpaid_orders_loop():
    while True:
        await asyncio.sleep(300)
        try:
            async with pool.acquire() as db:
                n = await expire_unpaid_orders(db)
                if n:
                    print(f"Removed {n} unpaid order(s) and returned their stock")
        except Exception as e:
            print(f"unpaid orders cleanup failed: {e}")

# --- Public Health / Ping (for cron-job keep-alive) ---
@app.get("/health")
@app.get("/ping")
async def health_check():
    return Response(content="OK", media_type="text/plain")

@app.post("/api/ping")
async def ping_user(request: Request, user: dict = Depends(get_current_user)):
    update_user_session(request, user)
    return {"online_count": get_online_count()}

THROTTLE_LIMITS = {"u": 10, "ip": 20}  # failed logins per account name / per client address
THROTTLE_LOCK_SECONDS = 900
THROTTLE_FORGET_SECONDS = 3600


def throttle_after_failure(fails, locked_until, updated, now, limit, lock_seconds=THROTTLE_LOCK_SECONDS, forget_seconds=THROTTLE_FORGET_SECONDS):
    """New (fails, locked_until) after one more failed login. Old failures fade after an hour or once a lock has ended."""
    if locked_until and locked_until <= now:
        fails, locked_until = 0, 0.0
    elif not locked_until and now - updated > forget_seconds:
        fails = 0
    fails += 1
    if fails >= limit:
        locked_until = now + lock_seconds
    return fails, locked_until


def client_ip(request):
    """The real visitor address: Cloudflare sets CF-Connecting-IP; otherwise the first X-Forwarded-For hop."""
    ip = request.headers.get("cf-connecting-ip") or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return (ip or (request.client.host if request.client else "unknown"))[:64]


async def throttle_is_blocked(db, keys, now):
    row = await db.fetchval("SELECT 1 FROM login_throttle WHERE key = ANY($1::text[]) AND locked_until > $2 LIMIT 1", keys, now)
    return bool(row)


async def throttle_register_failure(db, keys, now):
    """keys: {'u:184': 10, 'ip:1.2.3.4': 20}. Every failure is counted per name and per address."""
    async with db.transaction():
        for key, limit in keys.items():
            row = await db.fetchrow("SELECT fails, locked_until, updated FROM login_throttle WHERE key = $1 FOR UPDATE", key)
            fails, locked, updated = (row["fails"], row["locked_until"], row["updated"]) if row else (0, 0.0, 0.0)
            fails, locked = throttle_after_failure(fails, locked, updated, now, limit)
            await db.execute(
                "INSERT INTO login_throttle (key, fails, locked_until, updated) VALUES ($1, $2, $3, $4) "
                "ON CONFLICT (key) DO UPDATE SET fails = $2, locked_until = $3, updated = $4",
                key, fails, locked, now)
        await db.execute("DELETE FROM login_throttle WHERE updated < $1 AND locked_until < $2", now - 86400, now)


async def throttle_clear(db, key):
    await db.execute("DELETE FROM login_throttle WHERE key = $1", key)


@app.post("/api/login")
async def login(request: Request, form_data: OAuth2PasswordRequestForm = Depends()):
    username = (form_data.username or "")[:64]
    password = form_data.password
    wrong = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Неверный логин (ID) или пароль",
    )
    now = time.time()
    ip = client_ip(request)
    keys = {f"u:{username}": THROTTLE_LIMITS["u"], f"ip:{ip}": THROTTLE_LIMITS["ip"]}

    async with pool.acquire() as db:
        if await throttle_is_blocked(db, list(keys), now):
            raise wrong
        if username.isdigit():
            client_id = int(username)
            client = await db.fetchrow("SELECT id FROM clients WHERE id = $1 AND password = $2", client_id, password)
            if client:
                await throttle_clear(db, f"u:{username}")
                access_token = create_access_token(data={"sub": str(client_id), "role": "client"})
                return {"access_token": access_token, "token_type": "bearer"}
        
        user = await db.fetchrow(
            "SELECT login_id FROM users WHERE login_id = $1 AND password = $2 AND role = 'admin'",
            username, password
        )
        if user:
            await throttle_clear(db, f"u:{username}")
            access_token = create_access_token(data={"sub": user["login_id"], "role": "admin"})
            return {"access_token": access_token, "token_type": "bearer"}
            
        await throttle_register_failure(db, keys, now)
        raise wrong

@app.get("/api/dashboard")
async def get_dashboard(user: dict = Depends(get_current_user)):
    online = get_online_count()
    async with pool.acquire() as db:
        if user["role"] == "admin":
            clients = await db.fetch("""
                SELECT id, password, user_tg_id, 
                       COALESCE(full_name, '') as full_name,
                       COALESCE(first_name, '') as first_name,
                       COALESCE(last_name, '') as last_name,
                       COALESCE(phone, '') as phone,
                       COALESCE(tg_username, '') as tg_username,
                       COALESCE(email, '') as email
                FROM clients ORDER BY id DESC
            """)
            orders = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost FROM orders WHERE archived = FALSE AND status <> 'Ожидает оплаты' ORDER BY id DESC"
            )
            archived = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost FROM orders WHERE archived = TRUE AND status <> 'Ожидает оплаты' ORDER BY id DESC"
            )
            return {
                "role": "admin",
                "online_count": online,
                "clients": [dict(c) for c in clients],
                "orders": [dict(o) for o in orders],
                "archived": [dict(o) for o in archived]
            }
        else:
            client_id = user["id"]
            client_info = await db.fetchrow("SELECT COALESCE(full_name, '') as full_name, COALESCE(phone, '') as phone, COALESCE(tg_username, '') as tg_username, COALESCE(email, '') as email FROM clients WHERE id = $1", client_id)
            orders = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date FROM orders WHERE client_id = $1 AND archived = FALSE AND status <> 'Ожидает оплаты' ORDER BY id DESC",
                client_id
            )
            archived = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date FROM orders WHERE client_id = $1 AND archived = TRUE AND status <> 'Ожидает оплаты' ORDER BY id DESC",
                client_id
            )
            return {
                "role": "client",
                "client_id": client_id,
                "full_name": client_info["full_name"] if client_info else "",
                "phone": client_info["phone"] if client_info else "",
                "tg_username": client_info["tg_username"] if client_info else "",
                "email": client_info["email"] if client_info else "",
                "online_count": online,
                "orders": [dict(o) for o in orders],
                "archived": [dict(o) for o in archived]
            }

@app.post("/api/clients")
async def create_client(client: ClientCreate, admin: dict = Depends(require_admin)):
    pwd = (client.password or "").strip()
    first_name = (client.first_name or "").strip()
    last_name = (client.last_name or "").strip()
    full_name = (client.full_name or "").strip()
    if not full_name and (first_name or last_name):
        full_name = f"{first_name} {last_name}".strip()
    elif full_name and not (first_name or last_name):
        parts = full_name.split()
        first_name = parts[0] if parts else ""
        last_name = " ".join(parts[1:]) if len(parts) > 1 else ""
    phone = (client.phone or "").strip()
    tg_username = (client.tg_username or "").strip()
    email = (client.email or "").strip().lower()
    if email and not valid_email(email):
        raise HTTPException(status_code=400, detail="Некорректная почта")

    if not pwd:
        raise HTTPException(status_code=400, detail="Пароль обязателен")
    async with pool.acquire() as db:
        new_id = await db.fetchval(
            "INSERT INTO clients (password, full_name, first_name, last_name, phone, tg_username, email) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            pwd, full_name, first_name, last_name, phone, tg_username, email
        )
        return {"success": True, "id": new_id}

@app.put("/api/clients/{client_id}")
async def update_client(client_id: int, client: ClientUpdate, admin: dict = Depends(require_admin)):
    first_name = (client.first_name or "").strip()
    last_name = (client.last_name or "").strip()
    full_name = (client.full_name or "").strip()
    if not full_name and (first_name or last_name):
        full_name = f"{first_name} {last_name}".strip()
    elif full_name and not (first_name or last_name):
        parts = full_name.split()
        first_name = parts[0] if parts else ""
        last_name = " ".join(parts[1:]) if len(parts) > 1 else ""
    phone = (client.phone or "").strip()
    tg_username = (client.tg_username or "").strip()
    email = (client.email or "").strip().lower()
    if email and not valid_email(email):
        raise HTTPException(status_code=400, detail="Некорректная почта")
    pwd = (client.password or "").strip()

    async with pool.acquire() as db:
        if pwd:
            res = await db.execute(
                "UPDATE clients SET password = $1, full_name = $2, first_name = $3, last_name = $4, phone = $5, tg_username = $6, email = $7 WHERE id = $8",
                pwd, full_name, first_name, last_name, phone, tg_username, email, client_id
            )
        else:
            res = await db.execute(
                "UPDATE clients SET full_name = $1, first_name = $2, last_name = $3, phone = $4, tg_username = $5, email = $6 WHERE id = $7",
                full_name, first_name, last_name, phone, tg_username, email, client_id
            )
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Клиент не найден")
        return {"success": True}

@app.delete("/api/clients/{client_id}")
async def delete_client(client_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        res = await db.execute("DELETE FROM clients WHERE id = $1", client_id)
        if res == "DELETE 0":
            raise HTTPException(status_code=404, detail="Клиент не найден")
        return {"success": True}

@app.post("/api/orders")
async def create_order(order: OrderCreate, admin: dict = Depends(require_admin)):
    order_date = (order.order_date or "").strip()
    if not order_date:
        order_date = datetime.now().strftime("%d.%m.%Y")
        
    async with pool.acquire() as db:
        client = await db.fetchrow("SELECT id, user_tg_id FROM clients WHERE id = $1", order.client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Client not found")
            
        new_id = await db.fetchval(
            "INSERT INTO orders (client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost) VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9) RETURNING id",
            order.client_id, order.items, order.total_price, order.paid_amount, "Заказ принят в обработку", order.photo_id, order_date, order.cost_price, order.delivery_cost
        )
        await reconcile_order(db, new_id)
        
        # Send Telegram notification if client is linked to TG
        if client["user_tg_id"] and BOT_TOKEN:
            try:
                msg = f"🎉 **У вас новый заказ!**\n\n🆔 Заказ #{new_id}\n🛒 Позиции:\n{order.items}\n\n💰 Стоимость: {order.total_price}\n✅ Оплачено: {order.paid_amount}"
                async with httpx.AsyncClient() as http_client:
                    if order.photo_id:
                        await http_client.post(
                            f"https://api.telegram.org/bot{BOT_TOKEN}/sendPhoto",
                            data={"chat_id": client["user_tg_id"], "photo": order.photo_id, "caption": msg, "parse_mode": "Markdown"}
                        )
                    else:
                        await http_client.post(
                            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                            json={"chat_id": client["user_tg_id"], "text": msg, "parse_mode": "Markdown"}
                        )
            except Exception as e:
                print(f"Error sending TG notification: {e}")
                
        return {"success": True, "id": new_id}

@app.put("/api/orders/{order_id}")
async def update_order(order_id: int, order: OrderUpdate, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        # Grab old status and TG ID to check if it changed
        old_data = await db.fetchrow(
            "SELECT o.status, c.user_tg_id, COALESCE(c.email, '') AS email FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = $1",
            order_id
        )
        
        # Auto-archive when status is "Выдано"
        archived = order.status == "Выдано"
        res = await db.execute(
            "UPDATE orders SET items = $1, total_price = $2, paid_amount = $3, status = $4, photo_id = $5, archived = $6, order_date = $7, cost_price = $8, delivery_cost = $9 WHERE id = $10",
            order.items, order.total_price, order.paid_amount, order.status, order.photo_id, archived, order.order_date, order.cost_price, order.delivery_cost, order_id
        )
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Order not found")
            
        # the month of the profit is the month the order was handed over
        if order.status == FINAL_STATUS and (not old_data or old_data["status"] != FINAL_STATUS):
            await db.execute("UPDATE orders SET completed_at = now() WHERE id = $1 AND completed_at IS NULL", order_id)
        elif order.status != FINAL_STATUS and old_data and old_data["status"] == FINAL_STATUS:
            await db.execute("UPDATE orders SET completed_at = NULL WHERE id = $1", order_id)
        await reconcile_order(db, order_id)

        # A status change reaches the client by e-mail too (when we know the address)
        if old_data and old_data["email"] and old_data["status"] != order.status and order.status != AWAITING_PAYMENT:
            subject, html, text = status_email(
                {"id": order_id, "items": order.items, "total_price": order.total_price, "paid_amount": order.paid_amount}, order.status)
            asyncio.create_task(send_client_email(old_data["email"], subject, html, text))

        # If status changed, send notification to client
        if old_data and old_data["user_tg_id"] and BOT_TOKEN and old_data["status"] != order.status:
            debt = order.total_price - order.paid_amount
            msg = f"📦 **Обновление по заказу #{order_id}**\n\n"
            msg += f"🛒 **Позиции:**\n{order.items}\n\n"
            msg += f"💵 **Общая стоимость:** {order.total_price}\n"
            msg += f"✅ **Оплачено:** {order.paid_amount}\n"
            msg += f"❗️ **Осталось доплатить:** {debt if debt > 0 else 0}\n\n"
            msg += f"🚚 **Текущий статус:**\n_{order.status}_"
            
            try:
                async with httpx.AsyncClient() as http_client:
                    if order.photo_id:
                        await http_client.post(
                            f"https://api.telegram.org/bot{BOT_TOKEN}/sendPhoto",
                            data={"chat_id": old_data["user_tg_id"], "photo": order.photo_id, "caption": msg, "parse_mode": "Markdown"}
                        )
                    else:
                        await http_client.post(
                            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                            json={"chat_id": old_data["user_tg_id"], "text": msg, "parse_mode": "Markdown"}
                        )
            except Exception as e:
                print(f"Error sending TG notification for status update: {e}")
                
        return {"success": True}

@app.post("/api/orders/{order_id}/archive")
async def archive_order(order_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        res = await db.execute("UPDATE orders SET archived = TRUE WHERE id = $1", order_id)
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Order not found")
        return {"success": True}

@app.post("/api/orders/{order_id}/unarchive")
async def unarchive_order(order_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        res = await db.execute("UPDATE orders SET archived = FALSE WHERE id = $1", order_id)
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Order not found")
        return {"success": True}

@app.delete("/api/orders/{order_id}")
async def delete_order(order_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        await reconcile_order(db, order_id, deleted=True, note="заказ удалён")
        res = await db.execute("DELETE FROM orders WHERE id = $1", order_id)
        if res == "DELETE 0":
            raise HTTPException(status_code=404, detail="Order not found")
        return {"success": True}

# --- Catalog API Routes (Public for all visitors) ---
@app.get("/api/catalog/meta")
async def get_catalog_meta():
    async with pool.acquire() as db:
        cats = await db.fetch("SELECT name FROM categories ORDER BY name ASC")
        sers = await db.fetch("SELECT name FROM series ORDER BY name ASC")
        return {
            "categories": [r["name"] for r in cats],
            "series": [r["name"] for r in sers]
        }

PRODUCT_COLUMNS = ("id, name, figure_number, price, discount_percent, final_price, category, series, packs_count, "
                   "photo_id, in_stock, badge, description, stock_qty, hidden, link_key, created_at")


@app.get("/api/catalog")
async def get_catalog(request: Request):
    is_admin = request_is_admin(request)
    async with pool.acquire() as db:
        products = await db.fetch(f"SELECT {PRODUCT_COLUMNS} FROM products ORDER BY id DESC")
        return {"products": public_catalog([dict(p) for p in products], is_admin)}


@app.get("/api/catalog/{product_id}")
async def get_one_product(product_id: int, request: Request, k: str = ""):
    """A single product by id; a hidden one answers 404 unless the caller is admin or holds its link key."""
    is_admin = request_is_admin(request)
    async with pool.acquire() as db:
        row = await db.fetchrow(f"SELECT {PRODUCT_COLUMNS} FROM products WHERE id = $1", product_id)
    if not row or not product_visible(dict(row), is_admin, k):
        raise HTTPException(status_code=404, detail="Product not found")
    return product_payload(dict(row), is_admin)


@app.post("/api/catalog")
async def create_product(product: ProductCreate, admin: dict = Depends(require_admin)):
    cat = product.category.strip()
    ser = product.series.strip()
    badge = (product.badge or "").strip().upper()
    
    final_price = product.final_price
    discount = product.discount_percent
    if final_price <= 0 and product.price > 0:
        final_price = max(0, round(product.price * (100 - discount) / 100))
    elif discount <= 0 and product.price > 0 and final_price > 0 and final_price < product.price:
        discount = round((product.price - final_price) * 100 / product.price)

    async with pool.acquire() as db:
        if cat:
            await db.execute("INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", cat)
        if ser:
            await db.execute("INSERT INTO series (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", ser)
            
        new_id = await db.fetchval(
            """INSERT INTO products 
               (name, figure_number, price, discount_percent, final_price, category, series, packs_count, photo_id, in_stock, badge, description, stock_qty, hidden, link_key) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id""",
            product.name.strip(), product.figure_number.strip(), product.price, discount, final_price,
            cat, ser, product.packs_count, product.photo_id.strip(), product.in_stock, badge, product.description.strip(), product.stock_qty, product.hidden, make_link_key()
        )
        await save_product_finance(db, new_id, product)
        return {"success": True, "id": new_id}

PRODUCT_FINANCE_FIELDS = ("purchase_usd", "planned_shipping_rub", "purchase_source", "product_kind")


def product_finance_values(product):
    """The private purchase fields the admin form actually sent, cleaned. Fields it did not send stay untouched."""
    sent = getattr(product, "model_fields_set", set())
    out = {}
    for f in PRODUCT_FINANCE_FIELDS:
        if f not in sent:
            continue
        v = getattr(product, f)
        if f == "purchase_usd":
            v = round(float(v), 2) if v is not None and float(v) > 0 else None
        elif f == "planned_shipping_rub":
            v = int(v) if v is not None and int(v) > 0 else None
        else:
            v = (v or "").strip()[:100]
        out[f] = v
    return out


async def save_product_finance(db, product_id, product):
    vals = product_finance_values(product)
    if not vals:
        return
    sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(vals, start=1))
    await db.execute(f"UPDATE products SET {sets} WHERE id = ${len(vals) + 1}", *vals.values(), product_id)


@app.put("/api/catalog/{product_id}")
async def update_product(product_id: int, product: ProductUpdate, admin: dict = Depends(require_admin)):
    cat = product.category.strip()
    ser = product.series.strip()
    badge = (product.badge or "").strip().upper()

    final_price = product.final_price
    discount = product.discount_percent
    if final_price <= 0 and product.price > 0:
        final_price = max(0, round(product.price * (100 - discount) / 100))
    elif discount <= 0 and product.price > 0 and final_price > 0 and final_price < product.price:
        discount = round((product.price - final_price) * 100 / product.price)

    async with pool.acquire() as db:
        if cat:
            await db.execute("INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", cat)
        if ser:
            await db.execute("INSERT INTO series (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", ser)

        res = await db.execute(
            """UPDATE products 
               SET name = $1, figure_number = $2, price = $3, discount_percent = $4, final_price = $5,
                   category = $6, series = $7, packs_count = $8, photo_id = $9, in_stock = $10, badge = $11, description = $12, stock_qty = $13, hidden = $14, link_key = COALESCE(NULLIF(link_key, ''), $15) 
               WHERE id = $16""",
            product.name.strip(), product.figure_number.strip(), product.price, discount, final_price,
            cat, ser, product.packs_count, product.photo_id.strip(), product.in_stock, badge, product.description.strip(), product.stock_qty, product.hidden, make_link_key(), product_id
        )
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Product not found")
        await save_product_finance(db, product_id, product)
        return {"success": True}

@app.delete("/api/catalog/{product_id}")
async def delete_product(product_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        res = await db.execute("DELETE FROM products WHERE id = $1", product_id)
        if res == "DELETE 0":
            raise HTTPException(status_code=404, detail="Product not found")
        return {"success": True}

@app.post("/api/catalog/categories")
async def add_category(data: dict, admin: dict = Depends(require_admin)):
    name = (data.get("name") or "").strip()
    if not name: raise HTTPException(status_code=400, detail="Name required")
    async with pool.acquire() as db:
        await db.execute("INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", name)
        return {"success": True}

@app.delete("/api/catalog/categories/{cat_name}")
async def delete_category(cat_name: str, admin: dict = Depends(require_admin)):
    clean_name = cat_name.strip()
    async with pool.acquire() as db:
        await db.execute("DELETE FROM categories WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))", clean_name)
        return {"success": True}

@app.post("/api/catalog/series")
async def add_series(data: dict, admin: dict = Depends(require_admin)):
    name = (data.get("name") or "").strip()
    if not name: raise HTTPException(status_code=400, detail="Name required")
    async with pool.acquire() as db:
        await db.execute("INSERT INTO series (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", name)
        return {"success": True}

@app.delete("/api/catalog/series/{ser_name}")
async def delete_series(ser_name: str, admin: dict = Depends(require_admin)):
    clean_name = ser_name.strip()
    async with pool.acquire() as db:
        await db.execute("DELETE FROM series WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))", clean_name)
        return {"success": True}

@app.post("/api/catalog/{product_id}/create_order")
async def create_order_from_product(product_id: int, order_data: QuickOrderCreate, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        product = await db.fetchrow("SELECT * FROM products WHERE id = $1", product_id)
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")

        client = await db.fetchrow("SELECT id, user_tg_id FROM clients WHERE id = $1", order_data.client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Client not found")

        item_title = product["name"]
        if product["figure_number"]:
            item_title = f"{product['figure_number']} - {item_title}"

        order_price = product["final_price"] if product["final_price"] > 0 else product["price"]
        order_date = datetime.now().strftime("%d.%m.%Y")

        snap = await order_snapshot(db, {product_id: 1}, {product_id: dict(product)})
        new_order_id = await db.fetchval(
            """INSERT INTO orders (client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost,
                                  planned_purchase_cost, planned_shipping, purchase_usd, fx_rate, product_kind)
               VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, 0, 0, $8, $9, $10, $11, $12) RETURNING id""",
            order_data.client_id, item_title, order_price, order_data.paid_amount, "Заказ принят в обработку", first_photo_id(product["photo_id"]), order_date,
            snap["planned_purchase_cost"], snap["planned_shipping"], snap["purchase_usd"], snap["fx_rate"], snap["product_kind"]
        )
        await reconcile_order(db, new_order_id)

        # Telegram notification
        if client["user_tg_id"] and BOT_TOKEN:
            try:
                msg = f"🎉 **У вас новый заказ!**\n\n🆔 Заказ #{new_order_id}\n🛒 Позиции:\n{item_title}\n\n💰 Стоимость: {order_price} ₽\n✅ Оплачено: {order_data.paid_amount} ₽"
                async with httpx.AsyncClient() as http_client:
                    if first_photo_id(product["photo_id"]):
                        await http_client.post(
                            f"https://api.telegram.org/bot{BOT_TOKEN}/sendPhoto",
                            data={"chat_id": client["user_tg_id"], "photo": first_photo_id(product["photo_id"]), "caption": msg, "parse_mode": "Markdown"}
                        )
                    else:
                        await http_client.post(
                            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                            json={"chat_id": client["user_tg_id"], "text": msg, "parse_mode": "Markdown"}
                        )
            except Exception as e:
                print(f"Error sending TG notification: {e}")

        return {"success": True, "id": new_order_id}

@app.post("/api/checkout")
async def process_checkout(req: Request, checkout: CheckoutRequest):
    if not checkout.items:
        raise HTTPException(status_code=400, detail="Корзина пуста")
    first_name = (checkout.first_name or "").strip()
    last_name = (checkout.last_name or "").strip()
    if first_name or last_name:
        name = f"{first_name} {last_name}".strip()
    else:
        name = (checkout.customer_name or "").strip()
        parts = name.split()
        first_name = parts[0] if parts else ""
        last_name = " ".join(parts[1:]) if len(parts) > 1 else ""

    phone = (checkout.phone or "").strip()
    telegram = (checkout.telegram or "").strip()
    email = (checkout.email or "").strip().lower()

    if (not first_name and not name) or not phone or not telegram:
        raise HTTPException(status_code=400, detail="Имя, телефон и Telegram обязательны для оформления")
    if not valid_email(email):
        raise HTTPException(status_code=400, detail="Укажите корректную электронную почту")

    # Calculate total price & item list from OUR data, never from what the browser sent
    wanted_ids = sorted({it.id for it in checkout.items})
    async with pool.acquire() as price_db:
        rows = await price_db.fetch(
            "SELECT id, name, figure_number, price, final_price, photo_id, purchase_usd, planned_shipping_rub, product_kind FROM products WHERE id = ANY($1::int[])",
            wanted_ids,
        )
    try:
        total_price, item_lines, first_photo = price_cart(checkout.items, {r["id"]: dict(r) for r in rows})
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    items_text = "\n".join(item_lines)
    paid_amount = round(total_price * 0.5) if checkout.payment_type == "50%" else total_price
    order_date = datetime.now().strftime("%d.%m.%Y")

    # Check if user is logged in
    auth_header = req.headers.get("Authorization")
    client_id = None
    generated_pwd = None
    new_token = None

    if auth_header and auth_header.startswith("Bearer "):
        raw_token = auth_header.split(" ")[1]
        try:
            payload = jwt.decode(raw_token, SECRET_KEY, algorithms=[ALGORITHM])
            if payload.get("role") == "client" and payload.get("sub"):
                client_id = int(payload["sub"])
        except Exception:
            client_id = None

    is_new_client = False
    async with pool.acquire() as db:
        if not client_id:
            existing_client = await db.fetchrow(
                "SELECT id, password FROM clients WHERE (phone != '' AND phone = $1) OR (full_name != '' AND full_name = $2) LIMIT 1",
                phone, name
            )
            if existing_client:
                # A guest who typed someone's phone or name is not proof of identity: the order joins that
                # cabinet, but neither the password nor a login token is handed out.
                client_id = existing_client["id"]
            else:
                is_new_client = True
                generated_pwd = str(100000 + secrets.randbelow(900000))
                client_id = await db.fetchval(
                    "INSERT INTO clients (password, full_name, first_name, last_name, phone, tg_username, email, marketing_consent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
                    generated_pwd, name, first_name, last_name, phone, telegram, email, checkout.marketing_consent
                )
            if is_new_client:
                new_token = create_access_token(data={"sub": str(client_id), "role": "client"})
        else:
            await db.execute(
                """UPDATE clients 
                   SET full_name = COALESCE(NULLIF(full_name, ''), $1),
                       first_name = COALESCE(NULLIF(first_name, ''), $2),
                       last_name = COALESCE(NULLIF(last_name, ''), $3),
                       phone = COALESCE(NULLIF(phone, ''), $4),
                       tg_username = COALESCE(NULLIF(tg_username, ''), $5),
                       email = COALESCE(NULLIF(email, ''), $6),
                       marketing_consent = COALESCE(marketing_consent, FALSE) OR $7
                   WHERE id = $8""",
                name, first_name, last_name, phone, telegram, email, checkout.marketing_consent, client_id
            )

        # Reserve limited stock atomically; a failed UPDATE means not enough left. The transaction rolls
        # back earlier reservations of this same request when we raise.
        reserved = []
        async with db.transaction():
            for pid, qty in aggregate_cart_qty(checkout.items).items():
                got = await db.fetchrow(
                    "UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2 AND stock_qty IS NOT NULL AND stock_qty >= $1 RETURNING name",
                    qty, pid)
                if got:
                    reserved.append((pid, qty))
                    continue
                row = await db.fetchrow("SELECT name, stock_qty FROM products WHERE id = $1", pid)
                if row and row["stock_qty"] is not None:
                    left = row["stock_qty"]
                    msg = f"«{row['name']}» распродан" if left <= 0 else f"«{row['name']}»: осталось только {left} шт."
                    raise HTTPException(status_code=409, detail=msg)

        status_text = AWAITING_PAYMENT
        snap = await order_snapshot(db, aggregate_cart_qty(checkout.items), {r["id"]: dict(r) for r in rows})
        checkout_note = f"📦 Доставка: {checkout.delivery_method or 'Не указан'}"
        if checkout.comment:
            checkout_note += f"\n💬 Комментарий: {checkout.comment}"
        try:
          order_id = await db.fetchval(
            """INSERT INTO orders
               (client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost, customer_name, customer_phone, customer_tg, payment_type, payment_status, stock_items, checkout_note,
                planned_purchase_cost, planned_shipping, purchase_usd, fx_rate, product_kind)
               VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, 0, 0, $8, $9, $10, $11, 'pending', $12, $13, $14, $15, $16, $17, $18) RETURNING id""",
            client_id, items_text, total_price, paid_amount, status_text, first_photo, order_date,
            name, phone, telegram, checkout.payment_type, dump_stock_items(reserved) if reserved else "", checkout_note,
            snap["planned_purchase_cost"], snap["planned_shipping"], snap["purchase_usd"], snap["fx_rate"], snap["product_kind"]
          )
        except Exception:
            await restore_stock(db, reserved)
            raise

        payment_url = None
        if TBANK_TERMINAL_KEY and TBANK_PASSWORD:
            try:
                amount_kopecks = paid_amount * 100
                desc = f"Заказ #{order_id} на funkostop.org"
                tbank_resp = await tbank_init_payment(amount_kopecks, order_id, desc)
                if tbank_resp.get("Success"):
                    payment_url = tbank_resp.get("PaymentURL")
                    tbank_pid = str(tbank_resp.get("PaymentId", ""))
                    await db.execute(
                        "UPDATE orders SET tbank_payment_id = $1 WHERE id = $2",
                        tbank_pid, order_id
                    )
                else:
                    print(f"T-Bank Init error: {tbank_resp}")
            except Exception as e:
                print(f"T-Bank Init exception: {e}")

        # With an online payment the admins hear about the order only when it is paid (see the T-Bank webhook);
        # without a payment link the order stands as it is and the manager must be told now.
        if BOT_TOKEN and ADMIN_IDS and not payment_url:
            try:
                pay_status = "⏳ Статус: ожидает оплаты, придёт отдельное сообщение «ОПЛАЧЕН»" if payment_url else "⚠️ Без онлайн-оплаты: свяжитесь с клиентом"
                admin_msg = (
                    f"{new_order_title(order_id, bool(payment_url))}\n\n"
                    f"👤 Клиент #{client_id}: {name}\n"
                    f"📞 Телефон: {phone}\n"
                    f"✈️ Telegram: {telegram}\n"
                    f"✉️ Почта: {email}{' (согласен на рассылку)' if checkout.marketing_consent else ''}\n"
                    f"📦 Доставка: {checkout.delivery_method or 'Не указан'}\n\n"
                    f"🛒 **Позиции:**\n{items_text}\n\n"
                    f"💰 Сумма: {total_price} ₽\n"
                    f"💳 К оплате: {paid_amount} ₽ ({checkout.payment_type})\n"
                    f"{pay_status}\n"
                )
                if checkout.comment:
                    admin_msg += f"💬 Комментарий: {checkout.comment}\n"
                await notify_admins(admin_msg)
            except Exception as e:
                print(f"Error sending TG admin order alert: {e}")

        return {
            "success": True,
            "order_id": order_id,
            "client_id": client_id,
            "password": generated_pwd,
            "token": new_token,
            "is_new_client": is_new_client,
            "total_price": total_price,
            "paid_amount": paid_amount,
            "payment_type": checkout.payment_type,
            "payment_url": payment_url
        }

# --- T-Bank Payment Notification Webhook ---
@app.post("/api/tbank/notification")
async def tbank_notification(req: Request):
    data = await req.json()
    received_token = data.get("Token", "")
    check_params = {k: v for k, v in data.items() if k != "Token"}
    expected_token = tbank_generate_token(check_params)
    if received_token != expected_token:
        return Response(content="INVALID_TOKEN", status_code=400)

    tbank_status = data.get("Status", "")
    order_id_str = data.get("OrderId", "")
    payment_id = str(data.get("PaymentId", ""))

    if not order_id_str:
        return Response(content="OK")

    try:
        oid = int(order_id_str)
    except ValueError:
        return Response(content="OK")

    async with pool.acquire() as db:
        order = await db.fetchrow("SELECT id, status, client_id, items, total_price, paid_amount, customer_name, customer_phone, customer_tg, payment_type, checkout_note, photo_id FROM orders WHERE id = $1", oid)
        if not order:
            if tbank_status == "CONFIRMED":
                await notify_admins(f"⚠️ **Пришла оплата по заказу #{oid}, но заказа нет** (удалён как неоплаченный или вручную). "
                                    f"Платёж Т-Банка {payment_id}: проверьте и верните деньги или создайте заказ вручную.")
            return Response(content="OK")

        if tbank_status == "CONFIRMED":
            # T-Bank repeats notifications: only the first CONFIRMED moves the order and alerts the admins
            first = await db.fetchval(
                "UPDATE orders SET payment_status = 'paid', status = 'Заказ принят в обработку', tbank_payment_id = $1 "
                "WHERE id = $2 AND payment_status <> 'paid' RETURNING id",
                payment_id, oid
            )
            if first:
                email = await db.fetchval("SELECT email FROM clients WHERE id = $1", order["client_id"])
                await notify_admins(paid_alert_text(order, order["client_id"], email, order["checkout_note"]))
                await send_order_email(email, order, order["checkout_note"])
                await reconcile_order(db, oid, note="оплата Т-Банк")
        elif tbank_status in ("REJECTED", "CANCELED", "DEADLINE_EXPIRED", "AUTH_FAIL"):
            await db.execute(
                "UPDATE orders SET payment_status = 'failed' WHERE id = $1", oid
            )
            given_back = await db.fetchval(
                "UPDATE orders SET stock_items = '' WHERE id = $1 AND stock_items <> '' RETURNING stock_items", oid
            )
            if given_back:
                await restore_stock(db, parse_stock_items(given_back))

    return Response(content="OK")

@app.get("/api/payment-status/{order_id}")
async def get_payment_status(order_id: int):
    async with pool.acquire() as db:
        row = await db.fetchrow("SELECT payment_status FROM orders WHERE id = $1", order_id)
        if not row:
            raise HTTPException(status_code=404, detail="Order not found")
        return {"status": row["payment_status"]}

PURCHASE_COLS = ("title", "description", "amount", "purchase_date", "track", "kind", "expected_date", "shop", "delivered")
PROMO_COLS = ("code", "value", "value_kind", "site", "conditions")


def _valid(fn, payload):
    try:
        return fn(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/purchases")
async def list_purchases(admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        rows = await db.fetch("SELECT id, " + ", ".join(PURCHASE_COLS) + " FROM purchases ORDER BY id DESC")
        return {"items": [dict(r) for r in rows]}


@app.post("/api/purchases")
async def create_purchase(p: PurchaseIn, admin: dict = Depends(require_admin)):
    v = _valid(clean_purchase, p)
    async with pool.acquire() as db:
        new_id = await db.fetchval(
            "INSERT INTO purchases (title, description, amount, purchase_date, track, kind, expected_date, shop, delivered) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
            *[v[c] for c in PURCHASE_COLS])
        return {"success": True, "id": new_id}


@app.put("/api/purchases/{item_id}")
async def update_purchase(item_id: int, p: PurchaseIn, admin: dict = Depends(require_admin)):
    v = _valid(clean_purchase, p)
    async with pool.acquire() as db:
        res = await db.execute(
            "UPDATE purchases SET title = $1, description = $2, amount = $3, purchase_date = $4, track = $5, kind = $6, "
            "expected_date = $7, shop = $8, delivered = $9 WHERE id = $10",
            *[v[c] for c in PURCHASE_COLS], item_id)
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Не найдено")
        return {"success": True}


@app.delete("/api/purchases/{item_id}")
async def delete_purchase(item_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        if await db.execute("DELETE FROM purchases WHERE id = $1", item_id) == "DELETE 0":
            raise HTTPException(status_code=404, detail="Не найдено")
        return {"success": True}


@app.get("/api/promocodes")
async def list_promocodes(admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        rows = await db.fetch("SELECT id, " + ", ".join(PROMO_COLS) + " FROM promo_codes ORDER BY id DESC")
        return {"items": [dict(r) for r in rows]}


@app.post("/api/promocodes")
async def create_promocode(p: PromoCodeIn, admin: dict = Depends(require_admin)):
    v = _valid(clean_promo, p)
    async with pool.acquire() as db:
        new_id = await db.fetchval(
            "INSERT INTO promo_codes (code, value, value_kind, site, conditions) VALUES ($1, $2, $3, $4, $5) RETURNING id",
            *[v[c] for c in PROMO_COLS])
        return {"success": True, "id": new_id}


@app.put("/api/promocodes/{item_id}")
async def update_promocode(item_id: int, p: PromoCodeIn, admin: dict = Depends(require_admin)):
    v = _valid(clean_promo, p)
    async with pool.acquire() as db:
        res = await db.execute(
            "UPDATE promo_codes SET code = $1, value = $2, value_kind = $3, site = $4, conditions = $5 WHERE id = $6",
            *[v[c] for c in PROMO_COLS], item_id)
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Не найдено")
        return {"success": True}


@app.delete("/api/promocodes/{item_id}")
async def delete_promocode(item_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        if await db.execute("DELETE FROM promo_codes WHERE id = $1", item_id) == "DELETE 0":
            raise HTTPException(status_code=404, detail="Не найдено")
        return {"success": True}


# ======================= Accounting (see finance.py for the rules) =======================
FINAL_STATUS = "Выдано"
ORDER_FIN_COLS = ("id, items, status, total_price, paid_amount, cost_price, delivery_cost, planned_purchase_cost, "
                  "planned_shipping, product_kind, completed_at, archived")


async def fin_get(db, key, default=None):
    raw = await db.fetchval("SELECT value FROM finance_settings WHERE key = $1", key)
    return json.loads(raw) if raw else default


async def fin_set(db, key, value):
    await db.execute("INSERT INTO finance_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
                     key, json.dumps(value, ensure_ascii=False))


async def fin_settings(db):
    return F.merged_settings(await fin_get(db, "settings", {}))


async def usd_rate(db, settings, force=False):
    """(rate with markup, CBR rate, day) — the CBR rate is fetched once a day and kept in the settings table."""
    cached = await fin_get(db, "fx", {}) or {}
    today = datetime.now(timezone(timedelta(hours=3))).date().isoformat()
    if force or cached.get("day") != today or not cached.get("cbr"):
        for url in ("https://www.cbr-xml-daily.ru/daily_json.js", "https://www.cbr.ru/scripts/XML_daily.asp"):
            try:
                async with httpx.AsyncClient(verify=SSL_VERIFY, timeout=10, headers={"User-Agent": "Mozilla/5.0"}) as client:
                    r = await client.get(url)
                cbr = F.parse_cbr_usd(r.content) if r.status_code == 200 else None
            except Exception as e:
                print(f"CBR rate from {url} failed: {e}")
                cbr = None
            if cbr:
                cached = {"cbr": cbr, "day": today}
                await fin_set(db, "fx", cached)
                break
    cbr = cached.get("cbr")
    return F.rate_with_markup(cbr, settings["fx_markup_pct"]), cbr, cached.get("day")


async def order_snapshot(db, qty_by_product, products):
    settings = await fin_settings(db)
    needs_rate = any((products.get(pid) or {}).get("purchase_usd") for pid in qty_by_product)
    rate = (await usd_rate(db, settings))[0] if needs_rate else None
    return F.planned_snapshot(qty_by_product, products, rate, settings)


async def recorded_flows(db, order_id):
    rows = await db.fetch("SELECT kind, SUM(amount)::int AS total FROM finance_events WHERE order_id = $1 GROUP BY kind", order_id)
    return {r["kind"]: r["total"] for r in rows}


async def reconcile_order(db, order_id, deleted=False, note=""):
    """Bring the order's money history in line with its current state (best effort: never breaks the order flow)."""
    try:
        o = await db.fetchrow(f"SELECT {ORDER_FIN_COLS} FROM orders WHERE id = $1", order_id)
        if not o:
            return
        settings = await fin_settings(db)
        events = F.reconcile(F.expected_flows(dict(o), settings, deleted), await recorded_flows(db, order_id), settings["tax_pct"])
        if events:
            await db.executemany("INSERT INTO finance_events (order_id, kind, amount, note) VALUES ($1, $2, $3, $4)",
                                 [(order_id, k, a, note) for k, a in events])
    except Exception as e:
        print(f"accounting reconcile of order {order_id} failed: {e}")


async def reconcile_all(db, note):
    settings = await fin_settings(db)
    orders = await db.fetch(f"SELECT {ORDER_FIN_COLS} FROM orders")
    sums = await db.fetch("SELECT order_id, kind, SUM(amount)::int AS total FROM finance_events WHERE order_id IS NOT NULL GROUP BY order_id, kind")
    recorded = {}
    for r in sums:
        recorded.setdefault(r["order_id"], {})[r["kind"]] = r["total"]
    rows = []
    for o in orders:
        for k, a in F.reconcile(F.expected_flows(dict(o), settings), recorded.get(o["id"], {}), settings["tax_pct"]):
            rows.append((o["id"], k, a, note))
    if rows:
        await db.executemany("INSERT INTO finance_events (order_id, kind, amount, note) VALUES ($1, $2, $3, $4)", rows)
    return len(rows)


async def finance_baseline():
    """Once: record the current state of every existing order, dated today. Those events are older than the start of
    the accounting, so they are never counted; they only make later changes show up as differences."""
    try:
        async with pool.acquire() as db:
            if await fin_get(db, "baseline_at"):
                return
            n = await reconcile_all(db, "начальный снимок")
            await fin_set(db, "baseline_at", datetime.now(timezone.utc).date().isoformat())
            print(f"accounting baseline recorded: {n} events")
    except Exception as e:
        print(f"accounting baseline failed: {e}")


class FinanceSettingsIn(BaseModel):
    start_date: str
    start_balance: int = 0
    fx_markup_pct: float = 0
    tax_pct: float = 9.5
    status_stages: dict = {}
    shipping_norms: dict = {}


class WithdrawalIn(BaseModel):
    wd_date: str
    amount: int
    comment: str = ""


class OrderCostsIn(BaseModel):
    planned_purchase_cost: Optional[int] = None
    planned_shipping: Optional[int] = None
    cost_price: Optional[int] = None
    delivery_cost: Optional[int] = None


@app.get("/api/finance")
async def finance_overview(month: str = "", show_all_ops: bool = False, admin: dict = Depends(require_admin)):
    if not re.match(r"^\d{4}-\d{2}$", month or ""):
        month = datetime.now().strftime("%Y-%m")
    async with pool.acquire() as db:
        settings = await fin_settings(db)
        start = settings["start_date"]
        orders = [dict(o) for o in await db.fetch(f"SELECT {ORDER_FIN_COLS} FROM orders")]
        events = [dict(e) for e in await db.fetch(
            "SELECT e.id, e.created_at, e.order_id, e.kind, e.amount, e.note, COALESCE(o.items, '') AS items "
            "FROM finance_events e LEFT JOIN orders o ON o.id = e.order_id ORDER BY e.id DESC")]
        ledger = [dict(l) for l in await db.fetch("SELECT id, entry_date, description, amount, entry_type FROM ledger_entries")]
        withdrawals = [dict(w) for w in await db.fetch("SELECT id, wd_date, amount, comment FROM owner_withdrawals ORDER BY wd_date DESC, id DESC")]
        rate, cbr, day = await usd_rate(db, settings)
        no_price = await db.fetchval("SELECT count(*) FROM products WHERE (purchase_usd IS NULL OR purchase_usd <= 0)")
        baseline_at = await fin_get(db, "baseline_at")
    out = F.summary(orders, events, ledger, withdrawals, settings, month)
    if no_price:
        out["attention"].append({"count": no_price, "text": "товаров каталога без закупочной цены в $ (новые заказы на них будут без плана)"})
    start_day = F.parse_day(start)
    ops = [e for e in events if show_all_ops or (F.parse_day(e["created_at"]) or start_day) >= start_day]
    out.update({
        "settings": settings, "fx": {"rate": rate, "cbr": cbr, "day": day}, "baseline_at": baseline_at,
        "withdrawals": withdrawals,
        "operations": [{**e, "created_at": e["created_at"].isoformat()} for e in ops[:500]],
    })
    return out


@app.put("/api/finance/settings")
async def finance_save_settings(body: FinanceSettingsIn, admin: dict = Depends(require_admin)):
    start = F.parse_day(body.start_date)
    if not start:
        raise HTTPException(status_code=400, detail="Неверная дата начала учёта")
    if not (0 <= body.tax_pct < 50) or not (-50 < body.fx_markup_pct < 100):
        raise HTTPException(status_code=400, detail="Неверный процент")
    stages = {str(k): int(v) for k, v in body.status_stages.items() if int(v) in range(0, 5)}
    norms = {str(k).strip(): int(v) for k, v in body.shipping_norms.items() if str(k).strip() and str(v).strip() and int(v) > 0}
    async with pool.acquire() as db:
        baseline = F.parse_day(await fin_get(db, "baseline_at"))
        if baseline and start < baseline:
            raise HTTPException(status_code=400, detail=f"Начало учёта не может быть раньше {baseline.strftime('%d.%m.%Y')} — до этой даты у сайта нет истории операций")
        old = await fin_get(db, "settings", {})
        await fin_set(db, "settings", {"start_date": start.isoformat(), "start_balance": body.start_balance,
                                       "fx_markup_pct": body.fx_markup_pct, "tax_pct": body.tax_pct,
                                       "status_stages": stages, "shipping_norms": norms})
        corrected = 0
        if (old or {}).get("status_stages", {}) != stages or (old or {}).get("shipping_norms", {}) != norms:
            corrected = await reconcile_all(db, "пересчёт после изменения настроек")
    return {"success": True, "corrected": corrected}


@app.post("/api/finance/fx/refresh")
async def finance_refresh_fx(admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        rate, cbr, day = await usd_rate(db, await fin_settings(db), force=True)
    if not cbr:
        raise HTTPException(status_code=502, detail="Не удалось получить курс ЦБ")
    return {"rate": rate, "cbr": cbr, "day": day}


@app.post("/api/finance/withdrawals")
async def finance_add_withdrawal(body: WithdrawalIn, admin: dict = Depends(require_admin)):
    day = F.parse_day(body.wd_date)
    if not day or body.amount <= 0:
        raise HTTPException(status_code=400, detail="Укажите дату и сумму")
    async with pool.acquire() as db:
        new_id = await db.fetchval("INSERT INTO owner_withdrawals (wd_date, amount, comment) VALUES ($1, $2, $3) RETURNING id",
                                   day.isoformat(), body.amount, body.comment.strip()[:500])
    return {"success": True, "id": new_id}


@app.delete("/api/finance/withdrawals/{wd_id}")
async def finance_delete_withdrawal(wd_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        if await db.execute("DELETE FROM owner_withdrawals WHERE id = $1", wd_id) == "DELETE 0":
            raise HTTPException(status_code=404, detail="Не найдено")
    return {"success": True}


@app.patch("/api/orders/{order_id}/costs")
async def update_order_costs(order_id: int, body: OrderCostsIn, admin: dict = Depends(require_admin)):
    """Planned and actual costs of one order, edited from the accounting table. Only the sent fields change."""
    vals = {k: (max(0, int(v)) if v is not None else None) for k, v in body.model_dump(exclude_unset=True).items()}
    for k in ("cost_price", "delivery_cost"):
        if k in vals and vals[k] is None:
            vals[k] = 0
    if not vals:
        return {"success": True}
    sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(vals, start=1))
    async with pool.acquire() as db:
        res = await db.execute(f"UPDATE orders SET {sets} WHERE id = ${len(vals) + 1}", *vals.values(), order_id)
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Order not found")
        await reconcile_order(db, order_id, note="изменение себестоимости/доставки")
    return {"success": True}


class DescribeIn(BaseModel):
    name: str
    figure_number: str = ""
    category: str = ""
    series: str = ""
    badge: str = ""


# Style taken from descriptions the shop wrote itself: search-friendly, gift angle, names in both languages.
# Their false bits (an "exclusive" series, "bobblehead") are left out of the examples on purpose.
DESCRIBE_SYSTEM_PROMPT = (
    "Ты пишешь описания товаров для интернет-магазина коллекционных фигурок, чтобы их находили в поиске. Пиши по-русски, 3–4 предложения.\n"
    "Естественно вплетай ключевые слова: название бренда и линейки (например Funko Pop), «коллекционная виниловая фигурка», "
    "имя персонажа по-английски и по-русски, название фильма, сериала или игры по-английски и по-русски, номер фигурки, "
    "«оригинальная», «фирменная коробка», «подарок для фанатов». Одно предложение о персонаже: кто он и чем известен.\n"
    "Строго: не выдумывай эксклюзивность, тираж, даты выхода, размер, комплектацию, позу и аксессуары фигурки; "
    "эксклюзив или стикер называй только если он есть во входных данных. Бренд называй только если он дан или очевиден из линейки.\n"
    "Не используй тире (— и –), строй предложения через запятые и точки. Без эмодзи, без кавычек вокруг текста, без восклицаний.\n\n"
    "Пример 1. Вход: Название: Paul Atreides; Номер: 2152; Бренд: Funko; Серия: Dune.\n"
    "Ответ: Оригинальная коллекционная виниловая фигурка Funko Pop Paul Atreides (Пол Атрейдес) из вселенной Dune (Дюна). "
    "Пол, наследник дома Атрейдес, которому предстоит стать лидером фрименов на Арракисе. Фигурка под номером 2152 поставляется "
    "в фирменной коробке и станет отличным подарком для фанатов фильма и книг Фрэнка Герберта.\n\n"
    "Пример 2. Вход: Название: Saul Goodman; Номер: 1938; Бренд: Funko; Серия: Better Call Saul.\n"
    "Ответ: Коллекционная виниловая фигурка Funko Pop Saul Goodman (Сол Гудман) из сериалов Better Call Saul (Лучше звоните Солу) "
    "и Breaking Bad (Во все тяжкие). Сол, изворотливый адвокат из Альбукерке, которого невозможно забыть благодаря кричащим костюмам "
    "и умению выкрутиться из любой ситуации. Оригинальная фигурка под номером 1938 в фирменной коробке станет украшением полки "
    "и отличным подарком для фанатов сериала."
)


def describe_user_prompt(p):
    """The product facts the model may use, one per line; empty fields are left out."""
    rows = [("Название", p.name), ("Номер", p.figure_number), ("Бренд", p.category), ("Серия", p.series), ("Стикер", p.badge)]
    return "\n".join(f"{k}: {v.strip()[:200]}" for k, v in rows if (v or "").strip())


def clean_description(text):
    """Model output -> one tidy paragraph without wrapping quotes or markdown."""
    t = re.sub(r"[*_#`]+", "", (text or "").strip()).strip().strip('"«»').strip()
    t = re.sub(r"\s*[—–]\s*", ", ", t)  # the shop asked for no dashes; a comma reads naturally in their place
    t = re.sub(r",\s*,", ",", t)
    return re.sub(r"\s*\n\s*", " ", t)[:2000]


@app.post("/api/ai/describe")
async def ai_describe(body: DescribeIn, admin: dict = Depends(require_admin)):
    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="Генерация описаний выключена: на сервере не задан GROQ_API_KEY")
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Сначала укажите название товара")
    text = ""
    async with httpx.AsyncClient(verify=SSL_VERIFY, timeout=httpx.Timeout(45.0, connect=10.0)) as client:
        for model in GROQ_MODELS:
            try:
                r = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                    json={"model": model, "temperature": 0.2, "max_tokens": 2500, "reasoning_effort": "medium",
                          "messages": [{"role": "system", "content": DESCRIBE_SYSTEM_PROMPT},
                                       {"role": "user", "content": describe_user_prompt(body)}]})
                data = r.json()
                if r.status_code == 200:
                    text = clean_description(data["choices"][0]["message"]["content"])
                    if text:
                        break
                else:
                    print(f"Groq {model} error {r.status_code}: {str(data)[:300]}")
            except Exception as exc:
                print(f"Groq {model} request failed: {exc!r}")
    if not text:
        raise HTTPException(status_code=502, detail="Сервис генерации не ответил, попробуйте ещё раз через минуту")
    return {"description": text}


@app.get("/api/ledger")
async def get_ledger(admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        entries = await db.fetch("SELECT id, entry_date, description, amount, entry_type FROM ledger_entries ORDER BY id DESC")
        return {"entries": [dict(e) for e in entries]}

@app.post("/api/ledger")
async def create_ledger_entry(entry: LedgerEntryCreate, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        new_id = await db.fetchval(
            "INSERT INTO ledger_entries (entry_date, description, amount, entry_type) VALUES ($1, $2, $3, $4) RETURNING id",
            entry.entry_date, entry.description, entry.amount, entry.entry_type
        )
        return {"success": True, "id": new_id}

@app.put("/api/ledger/{entry_id}")
async def update_ledger_entry(entry_id: int, entry: LedgerEntryCreate, admin: dict = Depends(require_admin)):
    if entry.entry_type not in ("income", "expense") or entry.amount <= 0:
        raise HTTPException(status_code=400, detail="Неверная сумма или тип")
    async with pool.acquire() as db:
        res = await db.execute(
            "UPDATE ledger_entries SET entry_date = $1, description = $2, amount = $3, entry_type = $4 WHERE id = $5",
            entry.entry_date, entry.description, entry.amount, entry.entry_type, entry_id
        )
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Entry not found")
        return {"success": True}

@app.delete("/api/ledger/{entry_id}")
async def delete_ledger_entry(entry_id: int, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        res = await db.execute("DELETE FROM ledger_entries WHERE id = $1", entry_id)
        if res == "DELETE 0":
            raise HTTPException(status_code=404, detail="Entry not found")
        return {"success": True}

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]{2,}$")


def valid_email(value):
    return bool(EMAIL_RE.match((value or "").strip()))


# Extra domains that should 301 to the main one. Opt-in via env so a typo can never lock the site out.
CANONICAL_HOST = os.getenv("CANONICAL_HOST", "funkostop.org").strip().lower()
def build_redirect_hosts(canonical, extra_csv):
    hosts = {h.strip().lower() for h in (extra_csv or "").split(",") if h.strip()}
    hosts.add("www." + canonical)
    return hosts


REDIRECT_HOSTS = build_redirect_hosts(CANONICAL_HOST, os.getenv("REDIRECT_HOSTS", ""))


@app.middleware("http")
async def redirect_to_canonical_host(request: Request, call_next):
    host = (request.headers.get("host") or "").split(":")[0].lower()
    if host in REDIRECT_HOSTS and host != CANONICAL_HOST:
        target = f"https://{CANONICAL_HOST}{request.url.path}"
        if request.url.query:
            target += f"?{request.url.query}"
        return RedirectResponse(target, status_code=301)
    return await call_next(request)


def make_link_key():
    return secrets.token_urlsafe(9)


def product_visible(row, is_admin, key):
    """A hidden product is reachable only by admins or with its own random link key."""
    if not row.get("hidden"):
        return True
    if is_admin:
        return True
    stored = row.get("link_key") or ""
    return bool(stored) and bool(key) and hmac.compare_digest(str(stored), str(key))


# Purchase prices and shipping plans of a product are the shop's private numbers: only admins ever receive them
PRODUCT_PRIVATE_FIELDS = ("link_key", "purchase_usd", "planned_shipping_rub", "purchase_source", "product_kind")


def product_payload(row, is_admin):
    item = dict(row)
    if not is_admin:
        for f in PRODUCT_PRIVATE_FIELDS:
            item.pop(f, None)
    return item


def public_catalog(rows, is_admin):
    """What the catalog list may show: hidden products and link keys are for admins only."""
    return [product_payload(r, is_admin) for r in rows if is_admin or not r.get("hidden")]


def request_is_admin(request):
    """Signature check only (cheap): the catalog list must not hit the users table on every page view."""
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return False
    try:
        payload = jwt.decode(auth.split(" ", 1)[1], SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return False
    return payload.get("role") == "admin"


MAX_LINE_QTY = 99


def line_qty(item):
    """qty as the server trusts it: at least 1, at most MAX_LINE_QTY."""
    return min(MAX_LINE_QTY, max(1, item.qty))


def aggregate_cart_qty(items):
    """{product_id: total qty}; a line with qty < 1 counts as 1, the same rule the price calculation uses."""
    totals = {}
    for it in items:
        totals[it.id] = totals.get(it.id, 0) + line_qty(it)
    return totals


def order_line_text(product, qty):
    """One order line in the house format of older orders: '<number> - <name>' plus ' xN' for several pieces."""
    number = (product.get("figure_number") or "").strip()
    text = f"{number} - {product['name']}" if number else product["name"]
    return f"{text} x{qty}" if qty > 1 else text


AWAITING_PAYMENT = "Ожидает оплаты"


def _h(text):
    import html as _html
    return _html.escape(str(text if text is not None else ""))


def order_email(order, note=""):
    """(subject, html, plain text) of the 'order placed' e-mail. Order facts first, the client's details at the end."""
    oid = order["id"]
    total = int(order["total_price"] or 0)
    paid = int(order["paid_amount"] or 0)
    left = max(0, total - paid)
    lines = [l.strip() for l in str(order["items"] or "").split("\n") if l.strip()]
    photo = first_photo_id(order.get("photo_id") if hasattr(order, "get") else order["photo_id"])
    delivery = ""
    for part in str(note or "").split("\n"):
        if part.startswith("📦 Доставка:"):
            delivery = part.split(":", 1)[1].strip()
    red, ink, muted, line = "#B3121B", "#141414", "#6B6B6B", "#E8E4DE"
    rows = "".join(
        f'<tr><td style="padding:8px 0;border-bottom:1px solid {line};font:15px/1.4 Arial,sans-serif;color:{ink};">{_h(l)}</td></tr>'
        for l in lines)
    img = (f'<td width="96" valign="top" style="padding-right:16px;"><img src="{SITE_URL}/api/photos/{_h(photo)}/mail.jpg" width="96" height="96" alt="" '
           f'style="display:block;width:96px;height:96px;object-fit:cover;border-radius:10px;background:#F2EFEA;"></td>') if photo else ""
    money = [("Сумма заказа", f"{total:,} ₽".replace(",", " "), ink), ("Оплачено", f"{paid:,} ₽".replace(",", " "), "#1E8E3E")]
    if left:
        money.append(("Осталось доплатить", f"{left:,} ₽".replace(",", " "), red))
    money_rows = "".join(
        f'<tr><td style="padding:4px 0;font:14px Arial,sans-serif;color:{muted};">{k}</td>'
        f'<td align="right" style="padding:4px 0;font:bold 15px Arial,sans-serif;color:{c};">{v}</td></tr>' for k, v, c in money)
    details = [("Получатель", order["customer_name"]), ("Телефон", order["customer_phone"])]
    if delivery:
        details.append(("Доставка", delivery))
    details_rows = "".join(
        f'<tr><td style="padding:3px 0;font:13px Arial,sans-serif;color:{muted};width:110px;">{k}</td>'
        f'<td style="padding:3px 0;font:13px Arial,sans-serif;color:{ink};">{_h(v) or "—"}</td></tr>' for k, v in details)
    html = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Заказ #{oid}</title></head>
<body style="margin:0;padding:0;background:#EFEBE5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEBE5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;">
  <tr><td style="background:{red};padding:28px 28px 26px;">
    <div style="font:normal 24px/1 Impact,'Arial Narrow',Arial,sans-serif;letter-spacing:1px;color:#FFFFFF;">FUNKO STOP</div>
    <div style="margin-top:22px;font:normal 32px/1.05 Impact,'Arial Narrow',Arial,sans-serif;text-transform:uppercase;color:#FFFFFF;">Заказ #{oid} оформлен</div>
    <div style="margin-top:10px;font:15px/1.5 Arial,sans-serif;color:#FFE3E3;">Спасибо! Оплата получена, заказ ушёл в работу. Статус — в личном кабинете и в боте @funkostop_bot.</div>
  </td></tr>
  <tr><td style="padding:24px 28px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{img}
      <td valign="top"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{rows}</table></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:8px 28px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid {ink};padding-top:8px;">{money_rows}</table></td></tr>
  <tr><td align="center" style="padding:22px 28px 6px;">
    <a href="{SITE_URL}/orders" style="display:inline-block;padding:14px 30px;background:{ink};color:#FFFFFF;border-radius:999px;font:bold 15px Arial,sans-serif;text-decoration:none;">Открыть личный кабинет</a>
  </td></tr>
  <tr><td style="padding:22px 28px 6px;"><div style="font:bold 12px Arial,sans-serif;letter-spacing:1px;text-transform:uppercase;color:{muted};margin-bottom:6px;">Ваши данные</div>
    <table role="presentation" cellpadding="0" cellspacing="0">{details_rows}</table></td></tr>
  <tr><td style="padding:20px 28px 26px;font:12px/1.5 Arial,sans-serif;color:{muted};border-top:1px solid {line};">
    Вопросы по заказу — менеджеру в Telegram <a href="https://t.me/Funko_Stop" style="color:{red};">@Funko_Stop</a>.<br>
    Письмо отправлено, потому что вы оформили заказ на <a href="{SITE_URL}" style="color:{muted};">funkostop.org</a>.
  </td></tr>
</table></td></tr></table></body></html>"""
    text = "\n".join([
        f"Заказ #{oid} оформлен. Спасибо! Оплата получена, заказ ушёл в работу.", "",
        *lines, "",
        f"Сумма заказа: {total} ₽", f"Оплачено: {paid} ₽", *([f"Осталось доплатить: {left} ₽"] if left else []), "",
        f"Личный кабинет: {SITE_URL}/orders", "Вопросы: Telegram @Funko_Stop",
    ])
    return f"Заказ #{oid} оформлен — Funko Stop", html, text


def _smtp_send(to_addr, subject, html, text):
    import smtplib
    from email.message import EmailMessage
    from email.utils import formataddr, make_msgid
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((MAIL_FROM_NAME, MAIL_FROM))
    if MAIL_REPLY_TO:
        msg["Reply-To"] = MAIL_REPLY_TO
    msg["To"] = to_addr
    msg["Message-ID"] = make_msgid(domain=MAIL_FROM.split("@")[-1] or None)
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20) as s:
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.send_message(msg)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
            s.starttls()
            s.login(SMTP_USER, SMTP_PASSWORD)
            s.send_message(msg)


# What the client reads under the new status: one plain sentence per stage of the order
STATUS_MAIL_HINTS = {
    "Заказ принят в обработку": "Мы получили заказ и готовим выкуп.",
    "Заказ ожидает отправки из магазина": "Фигурка выкуплена, ждём, когда магазин её отправит.",
    "Заказ едет на склад США": "Посылка едет на наш склад в США.",
    "Заказ начал сортировку на складе США": "Посылка на складе в США, её готовят к отправке в Россию.",
    "Ожидает рассылки из США": "Ждём отправки со склада в США.",
    "Ожидает выхода в продажу": "Это предзаказ: ждём официального выхода фигурки.",
    "Заказ отправлен из США на наш склад в Россию": "Посылка летит в Россию.",
    "Заказ проходит таможенное оформление": "Посылка проходит таможню.",
    "Заказ прибыл в магазин и готов к выдаче": "Заказ в Москве и готов к выдаче или отправке. Напишите менеджеру, как удобнее получить.",
    "Выдано": "Заказ выдан. Спасибо, что выбрали Funko Stop!",
}


def status_email(order, status):
    """(subject, html, text) of the 'your order changed status' e-mail."""
    oid = order["id"]
    total = int(order["total_price"] or 0)
    paid = int(order["paid_amount"] or 0)
    left = max(0, total - paid)
    hint = STATUS_MAIL_HINTS.get(status, "")
    red, ink, muted, line = "#B3121B", "#141414", "#6B6B6B", "#E8E4DE"
    items = "".join(
        f'<tr><td style="padding:6px 0;border-bottom:1px solid {line};font:15px/1.4 Arial,sans-serif;color:{ink};">{_h(l.strip())}</td></tr>'
        for l in str(order["items"] or "").split("\n") if l.strip())
    rub = lambda v: f"{v:,} ₽".replace(",", " ")
    left_row = (f'<tr><td style="padding:4px 0;font:14px Arial,sans-serif;color:{muted};">Осталось доплатить</td>'
                f'<td align="right" style="padding:4px 0;font:bold 15px Arial,sans-serif;color:{red};">{rub(left)}</td></tr>') if left else ""
    html = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Заказ #{oid}</title></head>
<body style="margin:0;padding:0;background:#EFEBE5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEBE5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;">
  <tr><td style="background:{ink};padding:24px 28px;">
    <div style="font:normal 22px/1 Impact,'Arial Narrow',Arial,sans-serif;letter-spacing:1px;color:#FFFFFF;">FUNKO <span style="color:#E5484D;">STOP</span></div>
    <div style="margin-top:18px;font:14px Arial,sans-serif;color:#BDBDBD;">Заказ #{oid}: новый статус</div>
    <div style="margin-top:6px;font:normal 26px/1.1 Impact,'Arial Narrow',Arial,sans-serif;text-transform:uppercase;color:#FFFFFF;">{_h(status)}</div>
    {f'<div style="margin-top:10px;font:15px/1.5 Arial,sans-serif;color:#E8E8E8;">{_h(hint)}</div>' if hint else ''}
  </td></tr>
  <tr><td style="padding:20px 28px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{items}</table></td></tr>
  <tr><td style="padding:6px 28px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="padding:4px 0;font:14px Arial,sans-serif;color:{muted};">Оплачено</td><td align="right" style="padding:4px 0;font:bold 15px Arial,sans-serif;color:{ink};">{rub(paid)} из {rub(total)}</td></tr>{left_row}
  </table></td></tr>
  <tr><td align="center" style="padding:20px 28px 8px;">
    <a href="{SITE_URL}/orders" style="display:inline-block;padding:13px 28px;background:{red};color:#FFFFFF;border-radius:999px;font:bold 15px Arial,sans-serif;text-decoration:none;">Открыть личный кабинет</a>
  </td></tr>
  <tr><td style="padding:18px 28px 24px;font:12px/1.5 Arial,sans-serif;color:{muted};border-top:1px solid {line};">
    Вопросы по заказу — менеджеру в Telegram <a href="https://t.me/Funko_Stop" style="color:{red};">@Funko_Stop</a>.<br>
    Письмо отправлено, потому что у вас есть заказ на <a href="{SITE_URL}" style="color:{muted};">funkostop.org</a>.
  </td></tr>
</table></td></tr></table></body></html>"""
    text = "\n".join([f"Заказ #{oid}: новый статус — {status}.", *([hint] if hint else []), "",
                      str(order["items"] or ""), "", f"Оплачено: {paid} из {total} ₽",
                      *([f"Осталось доплатить: {left} ₽"] if left else []), "", f"Личный кабинет: {SITE_URL}/orders"])
    short = status[len("Заказ "):] if status.startswith("Заказ ") else status
    return f"Заказ #{oid}: {short[:1].lower()}{short[1:]} — Funko Stop", html, text


async def send_client_email(to_addr, subject, html, text):
    """Best effort: a failed e-mail is logged and never breaks the order flow."""
    if not (SMTP_USER and SMTP_PASSWORD):
        print("client e-mail skipped: SMTP_USER / SMTP_PASSWORD not set")
        return False
    if not to_addr or not valid_email(to_addr):
        return False
    try:
        await asyncio.to_thread(_smtp_send, to_addr, subject, html, text)
        return True
    except Exception as e:
        print(f"client e-mail failed: {e}")
        return False


async def send_order_email(to_addr, order, note=""):
    """Best effort: a failed e-mail is logged and never breaks the payment flow."""
    if not (SMTP_USER and SMTP_PASSWORD):
        print("order e-mail skipped: SMTP_USER / SMTP_PASSWORD not set")
        return False
    if not to_addr or not valid_email(to_addr):
        return False
    subject, html, text = order_email(order, note)
    try:
        await asyncio.to_thread(_smtp_send, to_addr, subject, html, text)
        return True
    except Exception as e:
        print(f"order e-mail to client failed: {e}")
        return False


def paid_alert_text(order, client_id, email, note):
    """The admin message sent once the bank confirms the payment: everything the manager needs to start work."""
    lines = [
        paid_order_title(order["id"]),
        "",
        f"👤 Клиент #{client_id}: {order['customer_name']}",
        f"📞 Телефон: {order['customer_phone'] or '—'}",
        f"✈️ Telegram: {order['customer_tg'] or '—'}",
        f"✉️ Почта: {email or '—'}",
    ]
    if note:
        lines.append(note)
    lines += [
        "",
        f"🛒 **Позиции:**\n{order['items']}",
        "",
        f"💰 Сумма: {order['total_price']} ₽",
        f"💳 Оплачено: {order['paid_amount']} ₽ ({order['payment_type']})",
    ]
    return "\n".join(lines)


def new_order_title(order_id, payment_pending):
    if payment_pending:
        return f"🕓 **Заказ #{order_id} создан, но НЕ оплачен** (клиент ещё на странице оплаты)"
    return f"🔥 **Новый заказ #{order_id}**"


def paid_order_title(order_id):
    return f"✅ **ОПЛАЧЕН: заказ #{order_id}**"


def price_cart(items, products_by_id):
    """Total, order lines and first photo computed ONLY from database rows.
    Names, prices and photos sent by the browser are ignored: they are editable by any visitor."""
    total = 0
    lines = []
    first_photo = ""
    for it in items:
        product = products_by_id.get(it.id)
        if product is None:
            raise ValueError("Один из товаров в корзине больше недоступен. Обновите страницу.")
        unit = product["final_price"] if (product["final_price"] or 0) > 0 else product["price"]
        qty = line_qty(it)
        subtotal = unit * qty
        total += subtotal
        lines.append(order_line_text(product, qty))
        if not first_photo:
            first_photo = first_photo_id(product.get("photo_id"))
    return total, lines, first_photo


def dump_stock_items(pairs):
    return json.dumps([[int(pid), int(qty)] for pid, qty in pairs])


def parse_stock_items(value):
    """Read orders.stock_items back; anything malformed means 'nothing was reserved'."""
    try:
        data = json.loads(value or "")
        return [(int(pid), int(qty)) for pid, qty in data]
    except (ValueError, TypeError):
        return []


async def restore_stock(db, pairs):
    for pid, qty in pairs:
        await db.execute("UPDATE products SET stock_qty = stock_qty + $1 WHERE id = $2 AND stock_qty IS NOT NULL", qty, pid)


def first_photo_id(value):
    """Products may hold several photos as 'id1,id2'; orders and Telegram messages need just the first."""
    return (value or "").split(",")[0].strip()

def trim_transparent_margin(img, pad_ratio=0.03):
    """Crop fully transparent borders (cut-out photos arrive on a big empty square) and keep a little air."""
    if img.mode not in ("RGBA", "LA", "P"):
        return img
    rgba = img.convert("RGBA")
    box = rgba.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if not box or box == (0, 0, rgba.width, rgba.height):
        return img
    pad = int(max(box[2] - box[0], box[3] - box[1]) * pad_ratio)
    box = (max(0, box[0] - pad), max(0, box[1] - pad), min(rgba.width, box[2] + pad), min(rgba.height, box[3] + pad))
    return rgba.crop(box)

def convert_to_webp(content):
    is_webp = len(content) > 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP"
    img = Image.open(io.BytesIO(content))
    trimmed = trim_transparent_margin(img)
    if is_webp and trimmed is img:
        return content
    img = trimmed
    out_io = io.BytesIO()
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        img.save(out_io, format="WEBP", quality=92)
    else:
        img.save(out_io, format="WEBP", quality=85)
    return out_io.getvalue()

# --- Telegram Photo Proxy ---
def webp_to_mail_jpeg(webp_bytes, size=240):
    """Many mail clients (Outlook, Mail.ru, older Apple Mail) show no WebP: e-mails get a small JPEG on white."""
    img = Image.open(io.BytesIO(webp_bytes))
    img.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGB", img.size, (255, 255, 255))
    canvas.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
    out = io.BytesIO()
    canvas.save(out, format="JPEG", quality=88)
    return out.getvalue()


HERO_W, HERO_H = 640, 800


def hero_cutout(content):
    """A catalog packshot -> a 640x800 WebP for the home collage: the white studio backdrop removed, the box cropped to
    its outline and scaled to the same height, bottom-centred. Every box comes out the same size whatever the photo's
    margins. A photo whose edges are not a plain white backdrop is put on a rounded white card instead."""
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(content))).convert("RGBA")
    img.thumbnail((900, 900), Image.LANCZOS)
    w, h = img.size
    rgb = img.convert("RGB")
    r, g, b = rgb.split()
    lo = ImageChops.darker(ImageChops.darker(r, g), b)
    hi = ImageChops.lighter(ImageChops.lighter(r, g), b)
    # near-pure white with no colour cast; light-grey box panels stay
    white = ImageChops.multiply(lo.point(lambda v: 255 if v > 246 else 0), ImageChops.subtract(hi, lo).point(lambda v: 255 if v < 8 else 0))
    transparent = img.getchannel("A").point(lambda v: 255 if v < 30 else 0)
    white = ImageChops.lighter(white, transparent)

    edge = [(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] + [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)]
    wp = white.load()
    if sum(1 for p in edge if wp[p] == 255) / len(edge) < 0.85:
        card = Image.new("RGBA", (HERO_W, HERO_H), (0, 0, 0, 0))
        mask = Image.new("L", (HERO_W, HERO_H), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 40, HERO_W - 1, HERO_H - 1), radius=36, fill=255)
        card.paste(Image.new("RGBA", (HERO_W, HERO_H), (255, 255, 255, 255)), (0, 0), mask)
        inner = img.copy()
        inner.thumbnail((HERO_W - 60, HERO_H - 100), Image.LANCZOS)
        card.alpha_composite(inner, ((HERO_W - inner.width) // 2, 40 + (HERO_H - 40 - inner.height) // 2))
        out = io.BytesIO()
        card.save(out, format="WEBP", quality=90)
        return out.getvalue()

    for p in edge:  # flood the backdrop from every white edge pixel (128 = reached from outside)
        if wp[p] == 255:
            ImageDraw.floodfill(white, p, 128, thresh=0)
    alpha = white.point(lambda v: 0 if v == 128 else 255)
    # a box is convex: white lids and windows inside its outline touch the backdrop and were flooded too.
    # Keep every pixel inside the object's span on both its row and its column.
    rows = Image.new("L", (w, h), 0)
    cols = Image.new("L", (w, h), 0)
    dr, dc = ImageDraw.Draw(rows), ImageDraw.Draw(cols)
    for y in range(h):
        bb = alpha.crop((0, y, w, y + 1)).getbbox()
        if bb:
            dr.line((bb[0], y, bb[2] - 1, y), fill=255)
    for x in range(w):
        bb = alpha.crop((x, 0, x + 1, h)).getbbox()
        if bb:
            dc.line((x, bb[1], x, bb[3] - 1), fill=255)
    alpha = ImageChops.multiply(rows, cols).filter(ImageFilter.GaussianBlur(0.8))
    img.putalpha(alpha)
    box = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
    if box:
        img = img.crop(box)
    # scale up as well as down: every box fills the same frame whatever the source photo's size
    k = min((HERO_W - 20) / img.width, (HERO_H - 20) / img.height)
    img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
    canvas = Image.new("RGBA", (HERO_W, HERO_H), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((HERO_W - img.width) // 2, HERO_H - img.height - 10))
    out = io.BytesIO()
    canvas.save(out, format="WEBP", quality=90)
    return out.getvalue()


HERO_CACHE = {}


async def hero_image_bytes(photo_id):
    photo_id = first_photo_id(photo_id)
    if photo_id not in HERO_CACHE:
        src = await get_telegram_photo(photo_id)
        HERO_CACHE[photo_id] = await asyncio.to_thread(hero_cutout, src.body)
    return HERO_CACHE[photo_id]


@app.get("/api/photos/{photo_id}/hero.webp")
async def get_hero_photo(photo_id: str):
    try:
        data = await hero_image_bytes(photo_id)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"hero cutout failed for {photo_id[:12]}: {exc!r}")
        raise HTTPException(status_code=404, detail="Photo not available")
    return Response(content=data, media_type="image/webp", headers={"Cache-Control": "public, max-age=2592000"})


HERO_PRODUCTS = {"at": 0.0, "items": []}


async def hero_products():
    """Visible products with a photo, re-read at most once a minute."""
    if time.time() - HERO_PRODUCTS["at"] > 60:
        try:
            async with pool.acquire() as db:
                rows = await db.fetch("SELECT name, photo_id FROM products WHERE NOT COALESCE(hidden, FALSE) AND COALESCE(photo_id, '') <> ''")
            HERO_PRODUCTS["items"] = [(r["name"], first_photo_id(r["photo_id"])) for r in rows if first_photo_id(r["photo_id"])]
            HERO_PRODUCTS["at"] = time.time()
        except Exception as exc:
            print(f"hero products query failed: {exc!r}")
    return HERO_PRODUCTS["items"]


async def warm_hero_cutouts():
    """Cut out every catalog figure once after start, so the first visitors do not wait for it."""
    await asyncio.sleep(5)
    for _, photo in await hero_products():
        try:
            await hero_image_bytes(photo)
        except Exception as exc:
            print(f"hero warm-up skipped {photo[:12]}: {exc!r}")


INDEX_HTML = {"mtime": 0.0, "text": ""}
HERO_IMG_RE = re.compile(r'<img class="hero-fig hero-fig-(\d)"[^>]*>')
HERO_CALLOUT_RE = re.compile(r'<span class="hero-callout hero-callout-(\d)">[^<]*</span>')


def render_index(picks):
    """index.html with three catalog figures already in the hero, so they show up with the page, not after it."""
    path = "static/index.html"
    mtime = os.path.getmtime(path)
    if mtime != INDEX_HTML["mtime"]:
        INDEX_HTML["text"] = open(path, encoding="utf-8").read()
        INDEX_HTML["mtime"] = mtime
    page = INDEX_HTML["text"]
    if len(picks) < 3:
        return page
    def img(mt):
        name, photo = picks[int(mt.group(1)) - 1]
        return (f'<img class="hero-fig hero-fig-{mt.group(1)}" src="/api/photos/{html_lib.escape(photo, quote=True)}/hero.webp" '
                f'alt="{html_lib.escape(name, quote=True)}" width="{HERO_W}" height="{HERO_H}" fetchpriority="high">')
    def callout(mt):
        return f'<span class="hero-callout hero-callout-{mt.group(1)}">{html_lib.escape(picks[int(mt.group(1)) - 1][0])}</span>'
    page = HERO_IMG_RE.sub(img, page)
    page = HERO_CALLOUT_RE.sub(callout, page)
    return page.replace('<div class="hero-collage" aria-hidden="true">', '<div class="hero-collage from-catalog" aria-hidden="true">', 1)


async def spa_index():
    items = await hero_products()
    picks = _random.sample(items, 3) if len(items) >= 3 else []
    return Response(content=render_index(picks), media_type="text/html; charset=utf-8", headers={"Cache-Control": "no-cache"})


@app.get("/api/photos/{photo_id}/mail.jpg")
async def get_mail_photo(photo_id: str):
    res = await get_telegram_photo(photo_id)
    try:
        jpeg = await asyncio.to_thread(webp_to_mail_jpeg, res.body)
    except Exception:
        return res
    return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/photos/{photo_id}")
async def get_telegram_photo(photo_id: str):
    photo_id = first_photo_id(photo_id)
    if photo_id in IMAGE_CACHE:
        return Response(content=IMAGE_CACHE[photo_id], media_type="image/webp", headers={"Content-Disposition": f'inline; filename="{photo_id}.webp"'})

    if not BOT_TOKEN:
        raise HTTPException(status_code=500, detail="BOT_TOKEN not configured")
        
    async with httpx.AsyncClient(verify=SSL_VERIFY) as client:
        res = await client.get(f"https://api.telegram.org/bot{BOT_TOKEN}/getFile?file_id={photo_id}")
        data = res.json()
        if not data.get("ok"):
            raise HTTPException(status_code=404, detail="Photo not found in Telegram")
            
        file_path = data["result"]["file_path"]
        
        photo_res = await client.get(f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}")
        if photo_res.status_code != 200:
            raise HTTPException(status_code=404, detail="Failed to download photo")
            
        try:
            import asyncio
            webp_bytes = await asyncio.to_thread(convert_to_webp, photo_res.content)
            
            if len(IMAGE_CACHE) >= CACHE_LIMIT:
                IMAGE_CACHE.clear()
            IMAGE_CACHE[photo_id] = webp_bytes
            
            return Response(content=webp_bytes, media_type="image/webp", headers={"Content-Disposition": f'inline; filename="{photo_id}.webp"'})
        except Exception as e:
            return Response(content=photo_res.content, media_type="image/jpeg", headers={"Content-Disposition": f'inline; filename="{photo_id}.jpg"'})

MAX_UPLOAD_BYTES = 30 * 1024 * 1024


def prepare_upload_image(content):
    """Any photo the admin picks (JPEG, PNG, WebP, HEIC from a Mac or iPhone) -> WebP, long edge <= 1600 px.
    Raises ValueError with a message for the admin when the file is not an image we can read."""
    try:
        img = Image.open(io.BytesIO(content))
        img.load()
    except Exception:
        raise ValueError("Не удалось прочитать фото. Подойдут JPG, PNG, WebP или HEIC; другой формат сохраните как JPG.")
    img = ImageOps.exif_transpose(img)  # phone photos keep their rotation in EXIF
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    if max(img.size) > 1600:
        img.thumbnail((1600, 1600), Image.LANCZOS)
    img = img.convert("RGBA" if has_alpha else "RGB")
    out_io = io.BytesIO()
    img.save(out_io, format="WEBP", quality=92, method=6)
    return out_io.getvalue()


@app.post("/api/upload_photo")
async def upload_photo(file: UploadFile = File(...), admin: dict = Depends(require_admin)):
    missing = [n for n, v in (("BOT_TOKEN", BOT_TOKEN), ("ADMIN_IDS", PHOTO_STORAGE_CHAT_ID or ADMIN_IDS)) if not v]
    if missing:
        raise HTTPException(status_code=500, detail=f"Загрузка фото не настроена на сервере: не задана переменная {', '.join(missing)}")

    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Фото больше 30 МБ, уменьшите его и попробуйте снова")
    try:
        content = await asyncio.to_thread(prepare_upload_image, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        # a few MB to Telegram can take longer than httpx's default 5 s
        async with httpx.AsyncClient(verify=SSL_VERIFY, timeout=httpx.Timeout(60.0, connect=15.0)) as client:
            # Sent as an opaque .bin on purpose: sendPhoto recompresses to 1280px JPEG, and a
            # .webp via sendDocument comes back as a sticker (no "document" key, may be shrunk).
            files = {"document": ("photo.bin", content, "application/octet-stream")}
            storage_chat = PHOTO_STORAGE_CHAT_ID or ADMIN_IDS[0]
            data = {"chat_id": storage_chat, "disable_notification": "true"}
            res = await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendDocument", data=data, files=files)
            res_data = res.json()
            if not res_data.get("ok"):
                raise HTTPException(status_code=502, detail=f"Telegram не принял фото: {res_data.get('description', 'неизвестная ошибка')}")
            message = res_data["result"]

            # In an admin's personal chat the storage message is deleted at once; a storage channel keeps it
            if not PHOTO_STORAGE_CHAT_ID:
                try:
                    await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/deleteMessage", json={"chat_id": storage_chat, "message_id": message["message_id"]})
                except Exception:
                    pass
    except HTTPException:
        raise
    except Exception as exc:
        print(f"photo upload to Telegram failed: {exc!r}")
        raise HTTPException(status_code=502, detail="Не удалось сохранить фото: хранилище не ответило. Попробуйте ещё раз через минуту.")

    if "document" not in message:
        raise HTTPException(status_code=500, detail="Telegram сохранил файл не как документ")
    return {"photo_id": message["document"]["file_id"]}


# --- Static Files ---
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/favicon.ico")
async def get_favicon_ico():
    return FileResponse("static/favicon.ico")

@app.get("/favicon.png")
async def get_favicon_png():
    return FileResponse("static/favicon.png")

@app.get("/apple-touch-icon.png")
async def get_apple_touch_icon():
    return FileResponse("static/apple-touch-icon.png")

@app.get("/robots.txt")
async def get_robots_txt():
    return FileResponse("static/robots.txt", media_type="text/plain")

@app.get("/sitemap.xml")
async def get_sitemap_xml():
    return FileResponse("static/sitemap.xml", media_type="application/xml")

@app.get("/privacy")
async def get_privacy():
    return FileResponse("static/privacy.html")

@app.get("/oferta")
async def get_oferta():
    return FileResponse("static/oferta.html")

@app.get("/returns")
async def get_returns():
    return FileResponse("static/returns.html")

@app.get("/")
async def root():
    return await spa_index()

# SPA client-side routes — serve index.html for frontend navigation
@app.get("/catalog")
async def spa_catalog():
    return await spa_index()

@app.get("/orders")
async def spa_orders():
    return await spa_index()

@app.get("/archive")
async def spa_archive():
    return await spa_index()

@app.get("/accounting")
async def spa_accounting():
    return await spa_index()

@app.get("/products")
async def spa_products():
    return await spa_index()


@app.get("/purchases")
@app.get("/promocodes")
async def spa_admin_registers():
    return await spa_index()

@app.get("/clients")
async def spa_clients():
    return await spa_index()

