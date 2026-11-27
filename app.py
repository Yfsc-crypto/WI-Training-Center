"""WI & Training Center. Python 3.11+, no external dependencies."""
import argparse
import base64
import csv
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
from datetime import datetime
from getpass import getpass
from pathlib import Path
from urllib.parse import parse_qs
from wsgiref.simple_server import make_server
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get("WI_DATABASE", ROOT / "data" / "wi.sqlite3"))
MAX_PDF = 12 * 1024 * 1024
SCHEMA = """
CREATE TABLE IF NOT EXISTS users(login TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, dc TEXT NOT NULL, dept TEXT NOT NULL, salt BLOB NOT NULL, hash BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS docs(code TEXT PRIMARY KEY, title TEXT NOT NULL, dc TEXT NOT NULL, dept TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS revs(id INTEGER PRIMARY KEY, code TEXT NOT NULL REFERENCES docs, rev INTEGER NOT NULL, effective TEXT NOT NULL, summary TEXT NOT NULL, retrain INTEGER NOT NULL, creator TEXT NOT NULL REFERENCES users, approved TEXT REFERENCES users, pdf BLOB NOT NULL, UNIQUE(code,rev));
CREATE TABLE IF NOT EXISTS training(id INTEGER PRIMARY KEY, employee TEXT NOT NULL REFERENCES users, revision INTEGER NOT NULL REFERENCES revs, day TEXT NOT NULL, trainer TEXT NOT NULL REFERENCES users, result TEXT NOT NULL);
"""

def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db

def password_hash(value, salt):
    return hashlib.pbkdf2_hmac("sha256", value.encode(), salt, 600000)

def today():
    return datetime.now(ZoneInfo("Asia/Bangkok")).date().isoformat()

def field(data, key, limit=300):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError("กรุณาตรวจสอบช่อง " + key)
    return value.strip()

def date_field(data, key):
    value = field(data, key)
    if datetime.strptime(value, "%Y-%m-%d").date().isoformat() != value:
        raise ValueError("วันที่ไม่ถูกต้อง")
    return value

def list_rows(db, sql, args=()):
    return [dict(r) for r in db.execute(sql, args)]

def snapshot(db, user):
    docs = list_rows(db, "SELECT * FROM docs ORDER BY code")
    revisions = list_rows(db, "SELECT id,code,rev,effective,summary,retrain,creator,approved FROM revs ORDER BY rev DESC")
    current = {}
    for r in revisions:
        if r["approved"] and r["effective"] <= today():
            current.setdefault(r["code"], r)
    for r in revisions:
        r["status"] = ("รออนุมัติ" if not r["approved"] else "รอวันที่มีผล" if r["effective"] > today() else
                       "ใช้งาน" if current[r["code"]]["id"] == r["id"] else "ยกเลิกใช้แล้ว")
    employees = list_rows(db, "SELECT login,name,dc,dept FROM users ORDER BY name")
    if user["role"] == "employee":
        employees = [e for e in employees if e["login"] == user["login"]]
    if user["role"] == "lead":
        employees = [e for e in employees if (e["dc"], e["dept"]) == (user["dc"], user["dept"])]
    allowed = {e["login"] for e in employees}
    history = [r for r in list_rows(db, """SELECT t.*,r.code,r.rev FROM training t JOIN revs r ON r.id=t.revision ORDER BY day DESC,t.id DESC""") if r["employee"] in allowed]
    passed = {}
    for r in history:
        if r["result"] == "ผ่าน":
            key = (r["employee"], r["code"])
            passed[key] = max(passed.get(key, -1), r["rev"])
    tasks = []
    for d in docs:
        active = current.get(d["code"])
        if not active:
            continue
        minimum = max((r["rev"] for r in revisions if r["code"] == d["code"] and r["approved"] and r["effective"] <= today() and r["retrain"]), default=0)
        for e in employees:
            if (d["dc"] in ("*", e["dc"]) and d["dept"] in ("*", e["dept"])):
                score = passed.get((e["login"], d["code"]), -1)
                tasks.append(dict(employee=e["login"], name=e["name"], code=d["code"], rev=active["rev"], status="ผ่านแล้ว" if score >= minimum else "รออบรม" if score < 0 else "รออบรมซ้ำ"))
    return dict(docs=docs, revs=revisions, employees=employees, history=history, tasks=tasks,
                user=dict(login=user["login"],name=user["name"],role=user["role"]),today=today())

def update(db, user, path, data):
    if path in ("/api/upload", "/api/approve") and user["role"] != "admin":
        raise PermissionError
    if path == "/api/upload":
        code = field(data,"code",64).upper()
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9_.-]*",code):
            raise ValueError("รหัส WI ใช้ A–Z, 0–9, จุด ขีดกลาง หรือขีดล่าง")
        rev = int(data["rev"])
        day = date_field(data,"effective")
        pdf = base64.b64decode(data["pdf"], validate=True)
        if len(pdf)>MAX_PDF or not pdf.startswith(b"%PDF-"):
            raise ValueError("กรุณาเลือกไฟล์ PDF ขนาดไม่เกิน 12 MB")
        if not db.execute("SELECT 1 FROM docs WHERE code=?",(code,)).fetchone():
            db.execute("INSERT INTO docs VALUES (?,?,?,?)",(code,field(data,"title"),field(data,"dc"),field(data,"dept")))
        prev = db.execute("SELECT rev,effective FROM revs WHERE code=? ORDER BY rev DESC LIMIT 1",(code,)).fetchone()
        if rev < 0 or (prev and (rev <= prev["rev"] or day < prev["effective"])):
            raise ValueError("Rev. ต้องเพิ่มขึ้น และวันที่มีผลต้องไม่ก่อน Rev. ก่อนหน้า")
        db.execute("INSERT INTO revs(code,rev,effective,summary,retrain,creator,pdf) VALUES(?,?,?,?,?,?,?)",(code,rev,day,field(data,"summary",2000),bool(data.get("retrain")),user["login"],pdf))
    elif path == "/api/approve":
        if not db.execute("UPDATE revs SET approved=? WHERE id=? AND approved IS NULL",(user["login"],int(data["id"]))).rowcount:
            raise ValueError("ไม่พบฉบับที่รออนุมัติ")
    elif path == "/api/training":
        if user["role"] == "employee":
            raise PermissionError
        day = date_field(data,"day")
        rev = db.execute("SELECT * FROM revs WHERE id=?",(int(data["id"]),)).fetchone()
        employee = db.execute("SELECT * FROM users WHERE login=?",(field(data,"employee"),)).fetchone()
        if not employee or (user["role"] == "lead" and (employee["dc"],employee["dept"]) != (user["dc"],user["dept"])):
            raise PermissionError
        if not rev or not rev["approved"] or not rev["effective"] <= day <= today() or data["result"] not in ("ผ่าน","ไม่ผ่าน"):
            raise ValueError("ตรวจสอบวันที่อบรม ฉบับที่มีผล และผลการอบรม")
        active = db.execute("SELECT id FROM revs WHERE code=? AND approved IS NOT NULL AND effective<=? ORDER BY rev DESC LIMIT 1",(rev["code"],day)).fetchone()
        if active["id"] != rev["id"]:
            raise ValueError("Rev. ที่เลือกไม่ได้มีผลในวันที่อบรม")
        db.execute("INSERT INTO training(employee,revision,day,trainer,result) VALUES(?,?,?,?,?)",(employee["login"],rev["id"],day,user["login"],data["result"]))
    else:
        raise ValueError("ไม่พบรายการ")

def application(env, start):
    def send(status, body, mime="text/plain; charset=utf-8", extra=()):
        start(status,[("Content-Type",mime),("Cache-Control","no-store"),("X-Content-Type-Options","nosniff"),("X-Frame-Options","DENY"),*extra])
        return [body]
    path = env["PATH_INFO"]
    db = connect()
    try:
        auth = env.get("HTTP_AUTHORIZATION","")
        user = None
        if auth.startswith("Basic "):
            try:
                login, pw = base64.b64decode(auth[6:],validate=True).decode().split(":",1)
                user = db.execute("SELECT * FROM users WHERE login=?",(login,)).fetchone()
                if user and not hmac.compare_digest(password_hash(pw,user["salt"]),user["hash"]):
                    user = None
            except (ValueError,UnicodeError):
                pass
        if not user:
            return send("401 Unauthorized",b"Sign in",extra=[("WWW-Authenticate",'Basic realm="WI Center", charset="UTF-8"')])
        if env["REQUEST_METHOD"] == "POST":
            if env.get("HTTP_X_WI_REQUEST") != "1" or env.get("CONTENT_TYPE") != "application/json":
                raise PermissionError
            n = int(env.get("CONTENT_LENGTH") or 0)
            if not 0 < n < 17*1024*1024:
                raise ValueError("ขนาดข้อมูลไม่ถูกต้อง")
            with db:
                db.execute("BEGIN IMMEDIATE")
                update(db,user,path,json.loads(env["wsgi.input"].read(n)))
            return send("200 OK",b"{}","application/json")
        if env["REQUEST_METHOD"] != "GET":
            return send("405 Method Not Allowed",b"Method not allowed")
        if path == "/api/data":
            db.execute("BEGIN")
            return send("200 OK",json.dumps(snapshot(db,user),ensure_ascii=False).encode(),"application/json")
        if path.startswith("/pdf/"):
            row = db.execute("SELECT * FROM revs WHERE id=?",(int(path.split("/")[-1]),)).fetchone()
            if row and (row["approved"] or user["role"]=="admin"):
                mode = "attachment" if "download" in parse_qs(env["QUERY_STRING"]) else "inline"
                filename = f'{row["code"]}_Rev{row["rev"]:02}.pdf'
                return send("200 OK",row["pdf"],"application/pdf",[("Content-Disposition",f'{mode}; filename="{filename}"')])
        assets = {"/":("index.html","text/html; charset=utf-8"),"/app.js":("app.js","text/javascript"),"/style.css":("style.css","text/css")}
        if path in assets:
            filename, mime = assets[path]
            return send("200 OK",(ROOT/"static"/filename).read_bytes(),mime)
        return send("404 Not Found",b"Not found")
    except PermissionError:
        return send("403 Forbidden","ไม่มีสิทธิ์ทำรายการ".encode())
    except (ValueError,KeyError,TypeError,sqlite3.IntegrityError) as exc:
        return send("400 Bad Request",str(exc).encode())
    finally:
        db.close()

if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("command",choices=["user","serve"])
    for key in ["login","name","dc","dept"]:
        parser.add_argument("--"+key)
    parser.add_argument("--role",choices=["admin","lead","employee"],default="employee")
    parser.add_argument("--host",default="127.0.0.1")
    parser.add_argument("--port",type=int,default=8000)
    args=parser.parse_args()
    with connect() as db:
        db.executescript(SCHEMA)
        if args.command=="user":
            if not all([args.login,args.name,args.dc,args.dept]) or ":" in args.login:
                parser.error("ระบุ --login --name --dc --dept ให้ครบ รหัสต้องไม่มีเครื่องหมาย :")
            pw=getpass("Password (12+ characters): ")
            if len(pw)<12:
                parser.error("รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร")
            salt=secrets.token_bytes(16)
            db.execute("INSERT INTO users VALUES(?,?,?,?,?,?,?)",(args.login,args.name,args.role,args.dc,args.dept,salt,password_hash(pw,salt)))
    if args.command=="serve":
        print(f"WI Center http://{args.host}:{args.port}",flush=True)
        with make_server(args.host,args.port,application) as server:
            server.serve_forever()
