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
from PIL import Image

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL is missing")

SECRET_KEY = os.getenv("SECRET_KEY", "super-secret-key-change-me")
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_IDS = [int(x.strip()) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip()]

TBANK_TERMINAL_KEY = os.getenv("TBANK_TERMINAL_KEY", "")
TBANK_PASSWORD = os.getenv("TBANK_PASSWORD", "")

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
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost FROM orders WHERE client_id = $1 AND archived = FALSE AND status <> 'Ожидает оплаты' ORDER BY id DESC",
                client_id
            )
            archived = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost FROM orders WHERE client_id = $1 AND archived = TRUE AND status <> 'Ожидает оплаты' ORDER BY id DESC",
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
            "SELECT o.status, c.user_tg_id FROM orders o JOIN clients c ON o.client_id = c.id WHERE o.id = $1", 
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
        return {"success": True, "id": new_id}

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

        new_order_id = await db.fetchval(
            """INSERT INTO orders (client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost) 
               VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, 0, 0) RETURNING id""",
            order_data.client_id, item_title, order_price, order_data.paid_amount, "Заказ принят в обработку", first_photo_id(product["photo_id"]), order_date
        )

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
            "SELECT id, name, figure_number, price, final_price, photo_id FROM products WHERE id = ANY($1::int[])",
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
        checkout_note = f"📦 Доставка: {checkout.delivery_method or 'Не указан'}"
        if checkout.comment:
            checkout_note += f"\n💬 Комментарий: {checkout.comment}"
        try:
          order_id = await db.fetchval(
            """INSERT INTO orders
               (client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost, customer_name, customer_phone, customer_tg, payment_type, payment_status, stock_items, checkout_note)
               VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, 0, 0, $8, $9, $10, $11, 'pending', $12, $13) RETURNING id""",
            client_id, items_text, total_price, paid_amount, status_text, first_photo, order_date,
            name, phone, telegram, checkout.payment_type, dump_stock_items(reserved) if reserved else "", checkout_note
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
        order = await db.fetchrow("SELECT id, status, client_id, items, total_price, paid_amount, customer_name, customer_phone, customer_tg, payment_type, checkout_note FROM orders WHERE id = $1", oid)
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


def product_payload(row, is_admin):
    item = dict(row)
    if not is_admin:
        item.pop("link_key", None)
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

@app.post("/api/upload_photo")
async def upload_photo(file: UploadFile = File(...), admin: dict = Depends(require_admin)):
    missing = [n for n, v in (("BOT_TOKEN", BOT_TOKEN), ("ADMIN_IDS", ADMIN_IDS)) if not v]
    if missing:
        raise HTTPException(status_code=500, detail=f"Загрузка фото не настроена на сервере: не задана переменная {', '.join(missing)}")
        
    content = await file.read()
    
    # Check for transparency (PNG, WebP with alpha channel)
    has_alpha = False

    try:
        img = Image.open(io.BytesIO(content))
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            has_alpha = True

        # Cap the long edge so a 4000px phone photo doesn't become a multi-MB download
        if max(img.size) > 1600:
            img.thumbnail((1600, 1600), Image.LANCZOS)

        if has_alpha:
            if img.mode != "RGBA":
                img = img.convert("RGBA")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        out_io = io.BytesIO()
        img.save(out_io, format="WEBP", quality=92, method=6)
        content = out_io.getvalue()
    except Exception as e:
        print(f"Image processing error: {e}")

    async with httpx.AsyncClient(verify=SSL_VERIFY) as client:
        # Sent as an opaque .bin on purpose: sendPhoto recompresses to 1280px JPEG, and a
        # .webp via sendDocument comes back as a sticker (no "document" key, may be shrunk).
        files = {"document": ("photo.bin", content, "application/octet-stream")}
        data = {"chat_id": ADMIN_IDS[0], "disable_notification": "true"}
        res = await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendDocument", data=data, files=files)
        res_data = res.json()
        if not res_data.get("ok"):
            raise HTTPException(status_code=500, detail=f"Telegram upload failed: {res_data.get('description', 'unknown error')}")
        message = res_data["result"]

        # Delete before anything else can fail, so the storage message never lingers in the admin's chat
        try:
            await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/deleteMessage", json={"chat_id": ADMIN_IDS[0], "message_id": message["message_id"]})
        except Exception:
            pass

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
    return FileResponse("static/index.html")

# SPA client-side routes — serve index.html for frontend navigation
@app.get("/catalog")
async def spa_catalog():
    return FileResponse("static/index.html")

@app.get("/orders")
async def spa_orders():
    return FileResponse("static/index.html")

@app.get("/archive")
async def spa_archive():
    return FileResponse("static/index.html")

@app.get("/accounting")
async def spa_accounting():
    return FileResponse("static/index.html")

@app.get("/products")
async def spa_products():
    return FileResponse("static/index.html")

@app.get("/clients")
async def spa_clients():
    return FileResponse("static/index.html")

