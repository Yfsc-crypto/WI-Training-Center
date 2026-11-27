"""Print one INSERT suitable for the Cloudflare D1 console."""
import argparse
import hashlib
import secrets
import sqlite3
from getpass import getpass

parser = argparse.ArgumentParser()
for field in ("login", "name", "dc", "dept"):
    parser.add_argument("--" + field, required=True)
parser.add_argument("--role", choices=("admin", "lead", "employee"), required=True)
args = parser.parse_args()
password = getpass("Password (12+ characters): ")
if len(password) < 12 or ":" in args.login:
    parser.error("Use a 12+ character password and a login without :")
salt = secrets.token_bytes(16)
digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100000)
values = [args.login, args.name, args.role, args.dc, args.dept, salt.hex(), digest.hex()]
with sqlite3.connect(":memory:") as db:
    literals = [db.execute("SELECT quote(?)", (value,)).fetchone()[0] for value in values]
print("INSERT INTO users(login,name,role,dc,dept,salt,digest) VALUES (" + ",".join(literals) + ");")
