#!/usr/bin/env python3
"""audit.py: разбор своих постов по охвату, сохранениям+пересылкам на 1000 охвата и досмотру.

Вход: CSV/TSV/JSON со столбцами (синонимы допустимы):
  id, url, caption, type, duration (сек), reach (или views), saved, shares, likes, comments,
  avg_watch (мс, ig_reels_avg_watch_time) или avg_watch_s (сек), timestamp.
Использование: python audit.py posts.csv [--top 5]
"""
import sys, json, csv, io, argparse, statistics

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

AL = {
    "id": ["id", "media_id", "shortCode"], "url": ["url", "permalink", "link"],
    "caption": ["caption", "text", "подпись"], "type": ["type", "media_type", "тип"],
    "duration": ["duration", "videoDuration", "длительность"],
    "reach": ["reach", "охват"], "views": ["views", "plays", "просмотры"],
    "saved": ["saved", "saves", "сохранения"], "shares": ["shares", "пересылки"],
    "likes": ["likes", "лайки"], "comments": ["comments", "комментарии"],
    "avg_watch": ["avg_watch", "ig_reels_avg_watch_time"], "avg_watch_s": ["avg_watch_s"],
    "timestamp": ["timestamp", "date", "дата"],
}


def num(v):
    if v in (None, ""):
        return 0.0
    try:
        return float(str(v).replace(" ", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return 0.0


def get(r, k):
    for a in AL[k]:
        if a in r and r[a] not in (None, ""):
            return r[a]
    return None


def load(text):
    s = text.lstrip("﻿").lstrip()
    if s[:1] in "[{":
        d = json.loads(s)
        return d if isinstance(d, list) else d.get("data") or [d]
    first = s.splitlines()[0]
    if "\t" in first:
        delim = "\t"
    elif first.count(";") > first.count(","):
        delim = ";"
    else:
        delim = ","
    return list(csv.DictReader(io.StringIO(s), delimiter=delim))


def short(s, n=45):
    s = (s or "").replace("\n", " ").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--top", type=int, default=5)
    a = ap.parse_args()
    rows = load(open(a.file, encoding="utf-8-sig").read())
    posts = []
    for r in rows:
        reach = num(get(r, "reach")) or num(get(r, "views"))
        if reach <= 0:
            continue
        dur = num(get(r, "duration"))
        aw = num(get(r, "avg_watch_s")) or num(get(r, "avg_watch")) / 1000.0
        posts.append({
            "caption": get(r, "caption") or "", "reach": reach,
            "saved": num(get(r, "saved")), "shares": num(get(r, "shares")),
            "dur": dur, "aw": aw,
        })
    if not posts:
        print("Нет постов с охватом.")
        return 1
    med = statistics.median(p["reach"] for p in posts)
    for p in posts:
        p["mult"] = p["reach"] / med
        p["ss"] = (p["saved"] + p["shares"]) / p["reach"] * 1000
        p["ret"] = (p["aw"] / p["dur"]) if p["dur"] and p["aw"] else None
    ss_med = statistics.median(p["ss"] for p in posts)
    print(f"Постов: {len(posts)}. Медианный охват: {int(med)}. Медиана (сохранения+пересылки) на 1000 охвата: {ss_med:.1f}.\n")

    def table(title, key, n):
        print(title)
        print(f"{'#':>2} {'охват':>7} {'x мед.':>6} {'сохр+перес/1000':>15} {'досмотр':>8}  пост")
        for i, p in enumerate(sorted(posts, key=key, reverse=True)[:n], 1):
            ret = f"{p['ret'] * 100:.0f}%" if p["ret"] else "н/д"
            print(f"{i:>2} {int(p['reach']):>7} {p['mult']:>5.1f}x {p['ss']:>15.1f} {ret:>8}  {short(p['caption'])}")
        print()

    table("ТОП по охвату (кратность к медиане):", lambda p: p["mult"], a.top)
    table("ТОП по сохранениям и пересылкам на 1000 охвата:", lambda p: p["ss"], a.top)
    withret = [p for p in posts if p["ret"]]
    if withret:
        print("ТОП по досмотру (среднее время просмотра / длительность):")
        for i, p in enumerate(sorted(withret, key=lambda p: p["ret"], reverse=True)[: a.top], 1):
            print(f"{i:>2} {p['ret'] * 100:>4.0f}%  охват {int(p['reach'])}  {short(p['caption'])}")
        print()
    print("ХУДШИЕ по охвату (что бросить):")
    for i, p in enumerate(sorted(posts, key=lambda p: p["mult"])[: a.top], 1):
        print(f"{i:>2} {int(p['reach']):>7} {p['mult']:>5.1f}x  {short(p['caption'])}")
    print("\nПримечание: лайки не используются как главный показатель.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
