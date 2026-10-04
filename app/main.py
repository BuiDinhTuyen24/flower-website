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

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
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


def _sign(payload: str) -> str:
    return hmac.new(bytes.fromhex(_read(AUTH_FILE, {})["secret"]), payload.encode(), hashlib.sha256).hexdigest()


def _make_token() -> str:
    payload = f"admin.{int(time.time()) + TOKEN_TTL}"
    return f"{payload}.{_sign(payload)}"


def _valid(token: str) -> bool:
    try:
        role, exp, sig = token.split(".")
    except ValueError:
        return False
    payload = f"{role}.{exp}"
    return role == "admin" and int(exp) > time.time() and hmac.compare_digest(sig, _sign(payload))


def require_admin(authorization: Optional[str] = Header(None)) -> None:
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not _valid(token):
        raise HTTPException(401, "Admin login required")


app = FastAPI(title="Petal & Thread")


class Creds(BaseModel):
    password: str


class NewPassword(BaseModel):
    current: str
    new: str


@app.get("/api/me")
def me(authorization: Optional[str] = Header(None)):
    token = (authorization or "").removeprefix("Bearer ").strip()
    return {"admin": _valid(token), "setup_needed": "hash" not in _read(AUTH_FILE, {})}


@app.post("/api/setup")
def setup(body: Creds):
    with lock:
        auth = _read(AUTH_FILE, {})
        if "hash" in auth:
            raise HTTPException(409, "Admin password already set")
        if len(body.password) < 8:
            raise HTTPException(400, "Password must be at least 8 characters")
        auth["salt"] = secrets.token_hex(16)
        auth["hash"] = _hash(body.password, auth["salt"])
        _write(AUTH_FILE, auth)
    return {"token": _make_token()}


@app.post("/api/login")
def login(body: Creds):
    auth = _read(AUTH_FILE, {})
    if "hash" not in auth or not hmac.compare_digest(_hash(body.password, auth["salt"]), auth["hash"]):
        time.sleep(0.5)
        raise HTTPException(401, "Wrong password")
    return {"token": _make_token()}


@app.post("/api/password", dependencies=[Depends(require_admin)])
def change_password(body: NewPassword):
    with lock:
        auth = _read(AUTH_FILE, {})
        if not hmac.compare_digest(_hash(body.current, auth["salt"]), auth["hash"]):
            raise HTTPException(401, "Current password is wrong")
        if len(body.new) < 8:
            raise HTTPException(400, "Password must be at least 8 characters")
        auth["salt"] = secrets.token_hex(16)
        auth["hash"] = _hash(body.new, auth["salt"])
        auth["secret"] = secrets.token_hex(32)  # log out all other sessions
        _write(AUTH_FILE, auth)
    return {"token": _make_token()}


@app.get("/api/pins")
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


app.mount("/uploads", StaticFiles(directory=UPLOADS), name="uploads")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/", StaticFiles(directory=STATIC), name="static")
