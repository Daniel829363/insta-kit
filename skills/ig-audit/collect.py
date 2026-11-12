#!/usr/bin/env python3
"""collect.py: собирает последние посты аккаунта через Composio CLI в CSV для audit.py. Только чтение.

Использование:
  python collect.py --account smartcargo --out posts.csv [--limit 50] [--no-duration]
--account: key из ~/.claude/insta-kit/accounts.json или сам composio-аккаунт (ca_...).
Без --account берётся единственный аккаунт из файла.
composio ищется в PATH, иначе через `wsl -d Ubuntu -u root -- bash -lc`.
Длительность рилса берётся ffprobe по media_url (если ffprobe есть); иначе колонка пустая,
и audit.py считает только среднее время просмотра в секундах.
"""
import sys, os, json, csv, shlex, shutil, subprocess, argparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,media_url"
BASE_METRICS = ["views", "reach", "saved", "shares", "likes", "comments"]
REEL_METRICS = ["views", "reach", "saved", "shares", "likes", "comments", "ig_reels_avg_watch_time"]
COLS = ["id", "url", "caption", "type", "duration", "reach", "saved", "shares", "likes", "comments",
        "avg_watch", "timestamp", "views"]


def _wsl():
    return ["wsl", "-d", "Ubuntu", "-u", "root", "--", "bash", "-lc"]


def composio(tool, args, account):
    """Вызывает инструмент, возвращает JSON-ответ (dict). Читает файл, если ответ сохранён в файл."""
    payload = json.dumps(args, ensure_ascii=False)
    native = shutil.which("composio")
    if native:
        cmd = [native, "execute", tool, "--account", account, "-d", payload]
    else:
        line = f"composio execute {tool} --account {shlex.quote(account)} -d {shlex.quote(payload)}"
        cmd = _wsl() + [line]
    r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace")
    try:
        d = json.loads(r.stdout)
    except ValueError:
        raise RuntimeError(f"{tool}: не JSON в ответе: {(r.stdout or r.stderr)[:300]}")
    if d.get("storedInFile") and d.get("outputFilePath"):
        path = d["outputFilePath"]
        if native and os.path.exists(path):
            text = open(path, encoding="utf-8").read()
        else:
            rr = subprocess.run(_wsl() + [f"cat {shlex.quote(path)}"], capture_output=True, encoding="utf-8", errors="replace")
            text = rr.stdout
        d = json.loads(text)
    return d


def load_account(arg, path=None):
    path = path or os.path.expanduser("~/.claude/insta-kit/accounts.json")
    if arg and arg.startswith("ca_"):
        return arg
    accs = json.load(open(path, encoding="utf-8"))
    if not arg:
        if len(accs) != 1:
            raise SystemExit("Укажи --account: " + ", ".join(a["key"] for a in accs))
        return accs[0]["composio_account"]
    for a in accs:
        if arg in (a.get("key"), a.get("username")):
            return a["composio_account"]
    raise SystemExit(f"Аккаунт {arg} не найден в {path}")


def metrics_for(item):
    return REEL_METRICS if item.get("media_product_type") == "REELS" else BASE_METRICS


def kind(item):
    return "REELS" if item.get("media_product_type") == "REELS" else (item.get("media_type") or "IMAGE")


def parse_insights(resp):
    if not resp.get("successful"):
        return None
    return {x["name"]: x["values"][0]["value"] for x in resp.get("data", {}).get("data", []) if x.get("values")}


def fetch_media(call, limit):
    media, after = [], None
    while len(media) < limit:
        a = {"ig_user_id": "me", "limit": min(100, limit), "fields": FIELDS}
        if after:
            a["after"] = after
        resp = call("INSTAGRAM_GET_IG_USER_MEDIA", a)
        if not resp.get("successful", True):
            raise RuntimeError(f"GET_IG_USER_MEDIA: {resp.get('error')}")
        d = resp.get("data", {})
        media += d.get("data", [])
        paging = d.get("paging", {})
        after = paging.get("cursors", {}).get("after")
        if not paging.get("next") or not after or not d.get("data"):
            break
    return media[:limit]


def fetch_insights(call, item):
    v = parse_insights(call("INSTAGRAM_GET_IG_MEDIA_INSIGHTS", {"ig_media_id": item["id"], "metric": metrics_for(item)}))
    if v is None:  # одна неподдерживаемая метрика валит весь запрос: пробуем общий набор
        v = parse_insights(call("INSTAGRAM_GET_IG_MEDIA_INSIGHTS", {"ig_media_id": item["id"], "metric": BASE_METRICS})) or {}
    return v


def probe_duration(url):
    if not url or not shutil.which("ffprobe"):
        return ""
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", url],
                           capture_output=True, encoding="utf-8", timeout=40)
        return round(float(r.stdout.strip().splitlines()[0]), 1)
    except Exception:
        return ""


def build_rows(media, call, duration=probe_duration):
    rows = []
    for m in media:
        v = fetch_insights(call, m)
        reel = m.get("media_product_type") == "REELS"
        rows.append({
            "id": m["id"], "url": m.get("permalink", ""), "caption": m.get("caption") or "", "type": kind(m),
            "duration": duration(m.get("media_url")) if reel and duration else "",
            "reach": v.get("reach", ""), "saved": v.get("saved", ""), "shares": v.get("shares", ""),
            "likes": v.get("likes", m.get("like_count", "")), "comments": v.get("comments", m.get("comments_count", "")),
            "avg_watch": v.get("ig_reels_avg_watch_time", ""), "timestamp": m.get("timestamp", ""),
            "views": v.get("views", ""),
        })
    return rows


def write_csv(rows, path):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account")
    ap.add_argument("--out", default="posts.csv")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--no-duration", action="store_true")
    a = ap.parse_args()
    acc = load_account(a.account)
    call = lambda tool, args: composio(tool, args, acc)
    media = fetch_media(call, a.limit)
    rows = build_rows(media, call, None if a.no_duration else probe_duration)
    write_csv(rows, a.out)
    print(f"Собрано постов: {len(rows)} -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
