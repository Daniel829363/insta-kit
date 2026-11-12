#!/usr/bin/env python3
"""outliers.py: кратность просмотров каждого рилса к медиане его аккаунта.

Вход: JSON (вывод Apify get-dataset-items: список объектов) или CSV/TSV.
Поля (допустимы синонимы): ownerUsername, shortCode, url, caption, transcript,
videoDuration, videoPlayCount, likesCount, commentsCount, timestamp.

Использование:
  python outliers.py data.json [--top 10] [--min-multiple 3] [--md out.md] [--json out.json]
  cat data.csv | python outliers.py - --top 15
Кратность >= 3x: сигнал. < 1.5x: шум.
"""
import sys, json, csv, io, argparse, statistics

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ALIASES = {
    "ownerUsername": ["ownerUsername", "username", "account", "owner", "аккаунт", "ник"],
    "shortCode": ["shortCode", "code", "id"],
    "url": ["url", "link", "ссылка"],
    "caption": ["caption", "text", "подпись"],
    "transcript": ["transcript", "транскрипт"],
    "videoDuration": ["videoDuration", "duration", "длительность"],
    "videoPlayCount": ["videoPlayCount", "videoViewCount", "playCount", "views", "plays", "просмотры"],
    "likesCount": ["likesCount", "likes", "лайки"],
    "commentsCount": ["commentsCount", "comments", "комментарии"],
    "timestamp": ["timestamp", "date", "taken_at", "дата"],
}


def num(v):
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().lower().replace(" ", "").replace(" ", "").replace(",", ".")
    mult = 1
    if s.endswith("k") or s.endswith("к"):
        mult, s = 1000, s[:-1]
    elif s.endswith("m") or s.endswith("м"):
        mult, s = 1_000_000, s[:-1]
    try:
        return float(s) * mult
    except ValueError:
        return 0.0


def pick(row, key):
    for a in ALIASES[key]:
        if a in row and row[a] not in (None, ""):
            return row[a]
    return None


def load(text):
    s = text.lstrip("﻿").lstrip()
    if s[:1] in "[{":
        data = json.loads(s)
        if isinstance(data, dict):
            data = data.get("items") or data.get("data") or [data]
        return data
    first = s.splitlines()[0]
    if "\t" in first:
        delim = "\t"
    elif first.count(";") > first.count(","):
        delim = ";"
    else:
        delim = ","
    return list(csv.DictReader(io.StringIO(s), delimiter=delim))


def normalize(rows):
    out = []
    for r in rows:
        out.append({
            "account": str(pick(r, "ownerUsername") or "?").lstrip("@"),
            "code": pick(r, "shortCode") or "",
            "url": pick(r, "url") or "",
            "caption": str(pick(r, "caption") or "").replace("\n", " "),
            "transcript": pick(r, "transcript") or "",
            "duration": num(pick(r, "videoDuration")),
            "views": num(pick(r, "videoPlayCount")),
            "likes": num(pick(r, "likesCount")),
            "comments": num(pick(r, "commentsCount")),
            "date": str(pick(r, "timestamp") or "")[:10],
        })
    return [x for x in out if x["views"] > 0]


def analyze(items):
    by = {}
    for it in items:
        by.setdefault(it["account"], []).append(it)
    med = {a: statistics.median(i["views"] for i in v) for a, v in by.items()}
    for it in items:
        m = med[it["account"]]
        it["median"] = m
        it["multiple"] = round(it["views"] / m, 2) if m else 0.0
        if it["multiple"] >= 3:
            it["verdict"] = "сигнал"
        elif it["multiple"] < 1.5:
            it["verdict"] = "шум"
        else:
            it["verdict"] = "выше нормы"
    items.sort(key=lambda x: x["multiple"], reverse=True)
    return items, med


def short(s, n=60):
    s = str(s).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--min-multiple", type=float, default=0.0)
    ap.add_argument("--md")
    ap.add_argument("--json", dest="jsonout")
    a = ap.parse_args()
    if a.file == "-":
        text = sys.stdin.buffer.read().decode("utf-8-sig")
    else:
        text = open(a.file, encoding="utf-8-sig").read()
    items = normalize(load(text))
    if not items:
        print("Нет рилсов с просмотрами. Проверьте поля входного файла.")
        return 1
    items, med = analyze(items)
    shown = [i for i in items if i["multiple"] >= a.min_multiple][: a.top]

    print("Медианы просмотров по аккаунтам:")
    for acc, m in sorted(med.items(), key=lambda kv: -kv[1]):
        n = sum(1 for i in items if i["account"] == acc)
        print(f"  @{acc}: {int(m):,} ({n} рилсов)".replace(",", " "))
    print(f"\nТоп-{len(shown)} по кратности:")
    print(f"{'#':>2} {'x':>6} {'просмотры':>10} {'аккаунт':<18} {'вердикт':<10} начало")
    for n, i in enumerate(shown, 1):
        start = short(i["transcript"] or i["caption"], 55)
        print(f"{n:>2} {i['multiple']:>5}x {int(i['views']):>10} {('@' + i['account'])[:18]:<18} {i['verdict']:<10} {start}")
    sig = [i for i in items if i["multiple"] >= 3]
    noise = [i for i in items if i["multiple"] < 1.5]
    print(f"\nИтого: {len(items)} рилсов, сигнал (>=3x): {len(sig)}, шум (<1.5x): {len(noise)}.")

    if a.md:
        lines = ["# Залетевшие рилсы (кратность к медиане аккаунта)", "",
                 "| # | Кратность | Просмотры | Аккаунт | Ссылка | Начало |", "|---|---|---|---|---|---|"]
        for n, i in enumerate(shown, 1):
            start = short(i["transcript"] or i["caption"], 80).replace("|", "/")
            lines.append(f"| {n} | {i['multiple']}x | {int(i['views'])} | @{i['account']} | {i['url']} | {start} |")
        with open(a.md, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print(f"Markdown: {a.md}")
    if a.jsonout:
        with open(a.jsonout, "w", encoding="utf-8") as f:
            json.dump(shown, f, ensure_ascii=False, indent=2)
        print(f"JSON: {a.jsonout}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
