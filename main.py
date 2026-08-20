import os
import asyncpg
import jwt
import httpx
from datetime import datetime, timedelta
from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("DATABASE_URL is missing")

SECRET_KEY = os.getenv("SECRET_KEY", "super-secret-key-change-me")
BOT_TOKEN = os.getenv("BOT_TOKEN")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 365  # 1 year (persistent login)

app = FastAPI(title="Funko Stop Admin Panel")

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
    # Add archived column if it doesn't exist yet
    async with pool.acquire() as db:
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_date TEXT")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cost_price INTEGER DEFAULT 0")
        await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_cost INTEGER DEFAULT 0")

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

# --- API Routes ---
@app.post("/api/ping")
async def ping_user(request: Request, user: dict = Depends(get_current_user)):
    update_user_session(request, user)
    return {"online_count": get_online_count()}

@app.post("/api/login")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    username = form_data.username
    password = form_data.password
    
    async with pool.acquire() as db:
        if username.isdigit():
            client_id = int(username)
            client = await db.fetchrow("SELECT id FROM clients WHERE id = $1 AND password = $2", client_id, password)
            if client:
                access_token = create_access_token(data={"sub": str(client_id), "role": "client"})
                return {"access_token": access_token, "token_type": "bearer"}
        
        user = await db.fetchrow(
            "SELECT login_id FROM users WHERE login_id = $1 AND password = $2 AND role = 'admin'",
            username, password
        )
        if user:
            access_token = create_access_token(data={"sub": user["login_id"], "role": "admin"})
            return {"access_token": access_token, "token_type": "bearer"}
            
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный логин (ID) или пароль",
        )

@app.get("/api/dashboard")
async def get_dashboard(user: dict = Depends(get_current_user)):
    online = get_online_count()
    async with pool.acquire() as db:
        if user["role"] == "admin":
            clients = await db.fetch("SELECT id, password, user_tg_id FROM clients ORDER BY id DESC")
            orders = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost FROM orders WHERE archived = FALSE ORDER BY id DESC"
            )
            archived = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost FROM orders WHERE archived = TRUE ORDER BY id DESC"
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
            orders = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost FROM orders WHERE client_id = $1 AND archived = FALSE ORDER BY id DESC",
                client_id
            )
            archived = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived, order_date, cost_price, delivery_cost FROM orders WHERE client_id = $1 AND archived = TRUE ORDER BY id DESC",
                client_id
            )
            return {
                "role": "client",
                "online_count": online,
                "orders": [dict(o) for o in orders],
                "archived": [dict(o) for o in archived]
            }

@app.post("/api/clients")
async def create_client(client: ClientCreate, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        new_id = await db.fetchval("INSERT INTO clients (password) VALUES ($1) RETURNING id", client.password)
        return {"success": True, "id": new_id}

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

# --- Telegram Photo Proxy ---
@app.get("/api/photos/{photo_id}")
async def get_telegram_photo(photo_id: str):
    if not BOT_TOKEN:
        raise HTTPException(status_code=500, detail="BOT_TOKEN not configured")
        
    async with httpx.AsyncClient() as client:
        res = await client.get(f"https://api.telegram.org/bot{BOT_TOKEN}/getFile?file_id={photo_id}")
        data = res.json()
        if not data.get("ok"):
            raise HTTPException(status_code=404, detail="Photo not found in Telegram")
            
        file_path = data["result"]["file_path"]
        
        photo_res = await client.get(f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file_path}")
        if photo_res.status_code != 200:
            raise HTTPException(status_code=404, detail="Failed to download photo")
            
        return Response(content=photo_res.content, media_type="image/jpeg")

# --- Static Files ---
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root():
    return FileResponse("static/index.html")
