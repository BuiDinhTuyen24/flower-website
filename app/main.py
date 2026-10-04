import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import Cookie, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = Path(__file__).parent
STATIC = BASE / "static"


def _data_dir() -> Path:
    if os.environ.get("DATA_DIR"):
        return Path(os.environ["DATA_DIR"])
    if Path("/data").is_dir():
        return Path("/data")
    return BASE.parent / "data"


DATA = _data_dir()
UPLOADS = DATA / "uploads"
UPLOADS.mkdir(parents=True, exist_ok=True)
PINS_FILE = DATA / "pins.json"
AUTH_FILE = DATA / "auth.json"
CATEGORIES = ["Crochet", "Paper", "Felt & Fabric", "Knitted", "Quilling", "Origami", "Other"]
MAX_BYTES = 50 * 1024 * 1024
TOKEN_TTL = 7 * 24 * 3600
lock = threading.Lock()
print(f"[petal-thread] data dir: {DATA}", flush=True)


def _read(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write(path: Path, obj) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    tmp.replace(path)


def _seed() -> list:
    src = (STATIC / "data.js").read_text()
    items = json.loads(src[src.index("[") : src.rindex("]") + 1])
    now = int(time.time() * 1000)
    return [
        {
            "id": f"seed-{i}",
            "title": it["title"],
            "category": it["category"],
            "desc": f"A handmade {it['category'].lower()} piece.",
            "type": "image",
            "src": it["src"],
            "w": it.get("w"),
            "h": it.get("h"),
            "license": it.get("license"),
            "credit": it.get("credit"),
            "created": now - i,
        }
        for i, it in enumerate(items)
    ]


with lock:
    if not PINS_FILE.exists():
        _write(PINS_FILE, _seed())
    auth = _read(AUTH_FILE, {})
    if "secret" not in auth:
        auth["secret"] = secrets.token_hex(32)
        _write(AUTH_FILE, auth)


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


def _account(role: str, env: str) -> dict:
    password = os.environ.get(env, "12345678")
    salt = secrets.token_hex(16)
    return {"role": role, "salt": salt, "hash": _hash(password, salt),
            "fp": hashlib.sha256(password.encode()).hexdigest()[:16]}


# Default passwords are 12345678; override with ADMIN_PASSWORD / USER_PASSWORD.
ACCOUNTS = {"admin": _account("admin", "ADMIN_PASSWORD"), "user": _account("user", "USER_PASSWORD")}
COOKIE = "pt_session"


def _sign(payload: str) -> str:
    return hmac.new(bytes.fromhex(_read(AUTH_FILE, {})["secret"]), payload.encode(), hashlib.sha256).hexdigest()


def _make_token(username: str) -> str:
    payload = f"{username}.{int(time.time()) + TOKEN_TTL}"
    # Including the password fingerprint logs everyone out when a password changes.
    return f"{payload}.{_sign(payload + '.' + ACCOUNTS[username]['fp'])}"


def _session(token: Optional[str]) -> Optional[dict]:
    try:
        username, exp, sig = (token or "").split(".")
        acct = ACCOUNTS[username]
        ok = int(exp) > time.time() and hmac.compare_digest(sig, _sign(f"{username}.{exp}.{acct['fp']}"))
    except (ValueError, KeyError):
        return None
    return {"username": username, "role": acct["role"]} if ok else None


def current_session(pt_session: Optional[str] = Cookie(None)) -> Optional[dict]:
    return _session(pt_session)


def require_user(sess: Optional[dict] = Depends(current_session)) -> dict:
    if not sess:
        raise HTTPException(401, "Please log in")
    return sess


def require_admin(sess: dict = Depends(require_user)) -> None:
    if sess["role"] != "admin":
        raise HTTPException(403, "Only the admin can do that")


app = FastAPI(title="Petal & Thread")


class Creds(BaseModel):
    username: str
    password: str


@app.get("/api/me")
def me(sess: Optional[dict] = Depends(current_session)):
    return sess or {"username": None, "role": None}


@app.post("/api/login")
def login(body: Creds, request: Request, response: Response):
    username = body.username.strip().lower()
    acct = ACCOUNTS.get(username)
    if not acct or not hmac.compare_digest(_hash(body.password, acct["salt"]), acct["hash"]):
        time.sleep(0.5)
        raise HTTPException(401, "Wrong username or password")
    https = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(COOKIE, _make_token(username), max_age=TOKEN_TTL, httponly=True, samesite="lax", secure=https)
    return {"username": username, "role": acct["role"]}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/pins", dependencies=[Depends(require_user)])
def list_pins():
    return sorted(_read(PINS_FILE, []), key=lambda p: p.get("created", 0), reverse=True)


def _clean(title: str, category: str, desc: str) -> dict:
    title = title.strip()[:60]
    if not title:
        raise HTTPException(400, "Title is required")
    if category not in CATEGORIES:
        raise HTTPException(400, "Unknown category")
    return {"title": title, "category": category, "desc": desc.strip()[:300]}


def _save_file(file: UploadFile) -> dict:
    ctype = file.content_type or ""
    if not re.match(r"^(image|video)/", ctype):
        raise HTTPException(400, "Only image or video files are allowed")
    ext = Path(file.filename or "").suffix.lower()[:8]
    if not re.fullmatch(r"\.[a-z0-9]+", ext or ""):
        ext = ".bin"
    name = f"{uuid.uuid4().hex}{ext}"
    dest = UPLOADS / name
    size = 0
    with dest.open("wb") as out:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                out.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(413, "File is larger than 50 MB")
            out.write(chunk)
    return {"src": f"/uploads/{name}", "type": "video" if ctype.startswith("video") else "image"}


def _remove_upload(pin: dict) -> None:
    src = pin.get("src") or ""
    if src.startswith("/uploads/"):
        (UPLOADS / Path(src).name).unlink(missing_ok=True)


@app.post("/api/pins", dependencies=[Depends(require_admin)])
def create_pin(
    file: UploadFile = File(...),
    title: str = Form(...),
    category: str = Form("Other"),
    desc: str = Form(""),
    w: int = Form(0),
    h: int = Form(0),
):
    pin = {"id": uuid.uuid4().hex[:12], **_clean(title, category, desc), **_save_file(file),
           "w": w or None, "h": h or None, "created": int(time.time() * 1000)}
    with lock:
        pins = _read(PINS_FILE, [])
        pins.append(pin)
        _write(PINS_FILE, pins)
    return pin


@app.put("/api/pins/{pin_id}", dependencies=[Depends(require_admin)])
def update_pin(
    pin_id: str,
    title: str = Form(...),
    category: str = Form("Other"),
    desc: str = Form(""),
    w: int = Form(0),
    h: int = Form(0),
    file: Optional[UploadFile] = File(None),
):
    fields = _clean(title, category, desc)
    new_media = _save_file(file) if file and file.filename else None
    with lock:
        pins = _read(PINS_FILE, [])
        pin = next((p for p in pins if p["id"] == pin_id), None)
        if not pin:
            if new_media:
                (UPLOADS / Path(new_media["src"]).name).unlink(missing_ok=True)
            raise HTTPException(404, "Not found")
        pin.update(fields)
        if new_media:
            _remove_upload(pin)
            pin.update(new_media, w=w or None, h=h or None, license=None, credit=None)
        _write(PINS_FILE, pins)
    return pin


@app.delete("/api/pins/{pin_id}", dependencies=[Depends(require_admin)])
def delete_pin(pin_id: str):
    with lock:
        pins = _read(PINS_FILE, [])
        pin = next((p for p in pins if p["id"] == pin_id), None)
        if not pin:
            raise HTTPException(404, "Not found")
        pins.remove(pin)
        _write(PINS_FILE, pins)
    _remove_upload(pin)
    return {"ok": True}


@app.get("/uploads/{name}", dependencies=[Depends(require_user)])
def get_upload(name: str):
    path = UPLOADS / Path(name).name
    if not path.is_file():
        raise HTTPException(404, "Not found")
    return FileResponse(path)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/", StaticFiles(directory=STATIC), name="static")
