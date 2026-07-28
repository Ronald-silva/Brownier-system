import json
import urllib.request


def get_admin_token(base: str, code: str) -> str:
    req = urllib.request.Request(
        f"{base}/api/admin/login",
        data=json.dumps({"code": code}).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req).read())["token"]


def admin_headers(base: str, code: str) -> dict:
    return {"Authorization": f"Bearer {get_admin_token(base, code)}"}
