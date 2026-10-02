#!/usr/bin/env python3
"""Deploy the agentx-browser Worker to Cloudflare.

Uses the custom.cloudflare connector (API token, Bearer placement).
ES-module upload via multipart (metadata + script in one call):
  account -> KV namespace BROWSER_BACKEND -> upload script with KV binding
  in metadata -> set RELAY_SECRET / CLIENT_TOKEN secrets.

Usage: RELAY_SECRET=... CLIENT_TOKEN=... deploy-worker.py worker/worker.js
Prints JSON: {"worker_url": ..., "kv_namespace_id": ...} — worker_url is
null until the account's workers.dev subdomain exists (created by opening
the Workers & Pages dashboard page once).
"""
import io
import json
import os
import sys
import urllib.request
import urllib.error
import uuid

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = "https://api.cloudflare.com/client/v4"
SCRIPT_NAME = "agentx-browser"
KV_TITLE = "BROWSER_BACKEND"


def api(method, path, data=None, ctype="application/json"):
    url = BASE + path
    body = data if isinstance(data, bytes) else (json.dumps(data).encode() if data is not None else None)
    req = urllib.request.Request(url, data=body, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    add_surrogate_to_request(
        req,
        "custom.cloudflare",
        entry_name="access_token",
        allowed_hosts=["api.cloudflare.com"],
    )
    try:
        out = read_json_response(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        print(json.dumps({"error": e.code, "body": e.read().decode(errors="replace")[:1000]}))
        sys.exit(1)
    if not out.get("success"):
        print(json.dumps({"error": "api", "body": out.get("errors")}))
        sys.exit(1)
    return out["result"]


def multipart_upload(account_id, script_bytes):
    """Upload the Worker as an ES module with a Durable Object binding.

    No KV is used anymore: the BrowserRelay DO (singleton "browser-main")
    tracks the runner uplink itself. The migration declares the new DO class.
    """
    boundary = "----MuseForm" + uuid.uuid4().hex
    metadata = {
        "main_module": "worker.js",
        "bindings": [
            {"type": "durable_object_namespace", "name": "RELAY",
             "class_name": "BrowserRelay"},
        ],
        "migrations": {
            # Free plan: Durable Objects require the SQLite backend, declared
            # via new_sqlite_classes (not new_classes).
            "new_sqlite_classes": ["BrowserRelay"],
        },
        "compatibility_date": "2024-11-01",
    }
    buf = io.BytesIO()
    buf.write(f"--{boundary}\r\n".encode())
    buf.write(b'Content-Disposition: form-data; name="metadata"\r\n')
    buf.write(b"Content-Type: application/json\r\n\r\n")
    buf.write(json.dumps(metadata).encode())
    buf.write(f"\r\n--{boundary}\r\n".encode())
    buf.write(b'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n')
    buf.write(b"Content-Type: application/javascript+module\r\n\r\n")
    buf.write(script_bytes)
    buf.write(f"\r\n--{boundary}--\r\n".encode())
    return api(
        "PUT",
        f"/accounts/{account_id}/workers/scripts/{SCRIPT_NAME}",
        buf.getvalue(),
        f"multipart/form-data; boundary={boundary}",
    )


def main():
    worker_js = open(sys.argv[1], "rb").read()
    relay_secret = os.environ["RELAY_SECRET"]
    client_token = os.environ["CLIENT_TOKEN"]

    accounts = api("GET", "/accounts")
    if not accounts:
        print(json.dumps({"error": "no accounts"}))
        sys.exit(1)
    account_id = accounts[0]["id"]
    print("account:", accounts[0].get("name"), account_id, file=sys.stderr)

    multipart_upload(account_id, worker_js)
    print("script uploaded (es module + durable object binding)", file=sys.stderr)

    for name, text in (("RELAY_SECRET", relay_secret), ("CLIENT_TOKEN", client_token)):
        api("PUT", f"/accounts/{account_id}/workers/scripts/{SCRIPT_NAME}/secrets",
            {"name": name, "text": text, "type": "secret_text"})
    print("secrets set", file=sys.stderr)

    sub = api("GET", f"/accounts/{account_id}/workers/subdomain")
    worker_url = None
    if isinstance(sub, dict) and sub.get("subdomain"):
        worker_url = f"https://{SCRIPT_NAME}.{sub['subdomain']}.workers.dev"
    print(json.dumps({"worker_url": worker_url, "account_id": account_id}))


if __name__ == "__main__":
    main()
