#!/usr/bin/env python3
"""audit.py: разбор своих постов по охвату, сохранениям+пересылкам на 1000 охвата и досмотру.

Вход: CSV/TSV/JSON со столбцами (синонимы допустимы):
  id, url, caption, type, duration (сек), reach (или views), saved, shares, likes, comments,
  avg_watch (мс, ig_reels_avg_watch_time) или avg_watch_s (сек), timestamp.
Использование: python audit.py posts.csv [--top 5] [--now YYYY-MM-DD]
Медианы считаются по постам старше 7 дней; свежие выводятся отдельно («рано судить»).
"""
import sys, json, csv, io, argparse, statistics
from datetime import datetime, timezone, timedelta

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


def kind(t):
    t = (t or "").upper()
    if "REEL" in t or t == "VIDEO":
        return "рилс"
    if "CAROUSEL" in t:
        return "карусель"
    return "фото"


def parse_ts(v):
    if not v:
        return None
    v = str(v).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%d.%m.%Y"):
        try:
            d = datetime.strptime(v.replace("Z", "+0000"), fmt)
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def analyze(rows, now=None, early_days=7, min_reach=50):
    """Возвращает (зрелые, ранние, med, порог_охвата). Поля p: mult, mult_t, ss, ret, aw, kind, date."""
    now = now or datetime.now(timezone.utc)
    posts = []
    for r in rows:
        reach = num(get(r, "reach")) or num(get(r, "views"))
        if reach <= 0:
            continue
        ts = parse_ts(get(r, "timestamp"))
        dur = num(get(r, "duration"))
        aw = num(get(r, "avg_watch_s")) or num(get(r, "avg_watch")) / 1000.0
        posts.append({
            "caption": get(r, "caption") or "", "reach": reach, "kind": kind(get(r, "type")),
            "saved": num(get(r, "saved")), "shares": num(get(r, "shares")), "dur": dur, "aw": aw,
            "date": ts.strftime("%d.%m.%y") if ts else "",
            "early": bool(ts and now - ts < timedelta(days=early_days)),
        })
    mature = [p for p in posts if not p["early"]] or posts
    early = [p for p in posts if p["early"]] if mature is not posts else []
    if not posts:
        return [], [], 0, 0
    med = statistics.median(p["reach"] for p in mature)
    tmed = {}
    for k in {p["kind"] for p in mature}:
        grp = [p["reach"] for p in mature if p["kind"] == k]
        if len(grp) >= 3:
            tmed[k] = statistics.median(grp)
    for p in mature + early:
        p["mult"] = p["reach"] / med
        p["mult_t"] = p["reach"] / tmed[p["kind"]] if p["kind"] in tmed else None
        p["ss"] = (p["saved"] + p["shares"]) / p["reach"] * 1000
        p["ret"] = (p["aw"] / p["dur"]) if p["dur"] and p["aw"] else None
    return mature, early, med, max(min_reach, 0.3 * med)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--now", help="дата отсчёта YYYY-MM-DD (для тестов)")
    a = ap.parse_args()
    rows = load(open(a.file, encoding="utf-8-sig").read())
    now = parse_ts(a.now) if a.now else None
    mature, early, med, thr = analyze(rows, now)
    if not mature:
        print("Нет постов с охватом.")
        return 1
    ss_pool = [p for p in mature if p["reach"] >= thr]
    ss_med = statistics.median(p["ss"] for p in ss_pool) if ss_pool else 0.0
    print(f"Постов: {len(mature) + len(early)} (оценивается {len(mature)}, рано судить {len(early)}). "
          f"Медианный охват: {int(med)}. Медиана (сохранения+пересылки) на 1000 охвата: {ss_med:.1f}.")
    kinds = {}
    for p in mature:
        kinds.setdefault(p["kind"], []).append(p["reach"])
    print("По типам (оценивается): " + ", ".join(f"{k} {len(v)} шт., медиана охвата {int(statistics.median(v))}" for k, v in kinds.items()))
    print(f"Порог охвата для рейтинга по сохранениям/пересылкам: {int(thr)}.\n")

    def line(i, p, extra=""):
        mt = f"{p['mult_t']:.1f}x" if p["mult_t"] is not None else "-"
        if p["ret"]:
            ret = f"{p['ret'] * 100:.0f}%"
        elif p["aw"]:
            ret = f"{p['aw']:.1f}с"
        else:
            ret = "н/д"
        print(f"{i:>2} {p['date']:>8} {p['kind']:<8} {int(p['reach']):>6} {p['mult']:>5.1f}x {mt:>6} {p['ss']:>8.1f} {ret:>7}  {short(p['caption']) or '(без подписи)'}{extra}")

    hdr = f"{'#':>2} {'дата':>8} {'тип':<8} {'охват':>6} {'x мед.':>6} {'x тип':>6} {'с+п/1000':>8} {'досм.':>7}  пост"

    def table(title, pool, key, n):
        print(title)
        print(hdr)
        for i, p in enumerate(sorted(pool, key=key, reverse=True)[:n], 1):
            line(i, p)
        print()

    table("ТОП по охвату (x мед. = ко всем, x тип = внутри рилсов/каруселей/фото):", mature, lambda p: p["mult"], a.top)
    table(f"ТОП по сохранениям и пересылкам на 1000 охвата (только охват >= {int(thr)}):", ss_pool, lambda p: p["ss"], a.top)
    withret = [p for p in mature if p["ret"]]
    withaw = [p for p in mature if p["aw"] and p["kind"] == "рилс"]
    if withret:
        table("ТОП по досмотру (среднее время просмотра / длительность):", withret, lambda p: p["ret"], a.top)
    elif withaw:
        table("ТОП рилсов по среднему времени просмотра (длительность неизвестна, % досмотра не считается):", withaw, lambda p: p["aw"], a.top)
    best = sorted(mature, key=lambda p: p["mult_t"] if p["mult_t"] is not None else p["mult"])[: a.top]
    print("ХУДШИЕ по охвату среди оцениваемых (что бросить; внутри типа, если типа достаточно):")
    print(hdr)
    for i, p in enumerate(best, 1):
        line(i, p)
    if early:
        print(f"\nРАНО СУДИТЬ (младше 7 дней, охват ещё растёт, в «бросить» не попадают):")
        print(hdr)
        for i, p in enumerate(sorted(early, key=lambda p: p["date"]), 1):
            line(i, p)
    print("\nПримечание: лайки не используются как главный показатель. Малые охваты: выводы предварительные.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
