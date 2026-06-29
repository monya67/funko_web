import os
import asyncpg
import jwt
import httpx
from datetime import datetime, timedelta
from fastapi import FastAPI, Depends, HTTPException, status
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
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 1 day

app = FastAPI(title="Funko Stop Admin Panel")

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

async def get_current_user(token: str = Depends(oauth2_scheme)):
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
            return {"role": "admin", "id": user["id"], "login": sub}
        elif role == "client":
            client = await db.fetchrow("SELECT * FROM clients WHERE id = $1", int(sub))
            if not client:
                raise HTTPException(status_code=401, detail="Client not found")
            return {"role": "client", "id": client["id"]}
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

class OrderUpdate(BaseModel):
    items: str
    total_price: int
    paid_amount: int
    status: str
    photo_id: str = ""

# --- API Routes ---
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
    async with pool.acquire() as db:
        if user["role"] == "admin":
            clients = await db.fetch("SELECT id, password, user_tg_id FROM clients ORDER BY id DESC")
            orders = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived FROM orders WHERE archived = FALSE ORDER BY id DESC"
            )
            archived = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived FROM orders WHERE archived = TRUE ORDER BY id DESC"
            )
            return {
                "role": "admin",
                "clients": [dict(c) for c in clients],
                "orders": [dict(o) for o in orders],
                "archived": [dict(o) for o in archived]
            }
        else:
            client_id = user["id"]
            orders = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived FROM orders WHERE client_id = $1 AND archived = FALSE ORDER BY id DESC",
                client_id
            )
            archived = await db.fetch(
                "SELECT id, client_id, items, total_price, paid_amount, status, photo_id, archived FROM orders WHERE client_id = $1 AND archived = TRUE ORDER BY id DESC",
                client_id
            )
            return {
                "role": "client",
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
    async with pool.acquire() as db:
        client = await db.fetchrow("SELECT id FROM clients WHERE id = $1", order.client_id)
        if not client:
            raise HTTPException(status_code=404, detail="Client not found")
            
        new_id = await db.fetchval(
            "INSERT INTO orders (client_id, items, total_price, paid_amount, status, photo_id, archived) VALUES ($1, $2, $3, $4, $5, $6, FALSE) RETURNING id",
            order.client_id, order.items, order.total_price, order.paid_amount, "Заказ принят в обработку", order.photo_id
        )
        return {"success": True, "id": new_id}

@app.put("/api/orders/{order_id}")
async def update_order(order_id: int, order: OrderUpdate, admin: dict = Depends(require_admin)):
    async with pool.acquire() as db:
        # Auto-archive when status is "Выдано"
        archived = order.status == "Выдано"
        res = await db.execute(
            "UPDATE orders SET items = $1, total_price = $2, paid_amount = $3, status = $4, photo_id = $5, archived = $6 WHERE id = $7",
            order.items, order.total_price, order.paid_amount, order.status, order.photo_id, archived, order_id
        )
        if res == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Order not found")
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
async def get_telegram_photo(photo_id: str, user: dict = Depends(get_current_user)):
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
