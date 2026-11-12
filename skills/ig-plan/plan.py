#!/usr/bin/env python3
"""plan.py: проверяет недельный контент-план и выводит его таблицей и CSV.

План составляет модель (по SKILL.md), скрипт нужен, чтобы правила не нарушались
молча: доли форматов, повтор формата два дня подряд, существование формулы хука,
один призыв, 10 аккаунтов для комментирования.

Вход: JSON
{
  "account": "ник", "timezone": "Asia/Bishkek", "start": "2026-11-16",
  "code_word": "КИТ",                       (необязательно)
  "repeat_ok": ["reel"],                    (форматы, которые аудит признал рабочими)
  "days": [ {"date": "2026-11-16", "time": "19:00", "format": "reel",
             "topic": "...", "hook_id": 11, "goal": "reach",
             "cta": "Напиши КИТ в комментарии", "skill": "ig-reel", "stories": "опрос"}, ... 7 штук ],
  "engage": ["ник1", ... 10 штук]
}
format: reel | carousel | photo | stories (день только со сторис). goal: reach | saves | leads.

Использование:
  python plan.py plan.json [--md plan.md] [--csv plan.csv]
Код возврата 0 (предупреждения печатаются в конце), 2 при ошибке чтения плана.
"""
import sys, os, json, csv, argparse
from datetime import date

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

FORMATS = {"reel": "Reels", "carousel": "Карусель", "photo": "Фото", "stories": "Только сторис"}
GOALS = {"reach": "охват", "saves": "сохранения", "leads": "заявки в директ"}
WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
HERE = os.path.dirname(os.path.abspath(__file__))
COLS = ("date", "time", "format", "topic", "hook_id", "goal", "cta", "skill", "stories")


def load_hooks():
    for p in (os.path.join(HERE, "..", "ig-reel", "hooks.json"),
              os.path.expanduser("~/.claude/skills/ig-reel/hooks.json")):
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return {h["id"]: h["name"] for h in json.load(f)["hooks"]}
    return {}


def check(plan, hooks):
    warns = []
    days = plan.get("days", [])
    if len(days) != 7:
        warns.append("В плане %d дней, нужно 7." % len(days))
    posts = [d for d in days if d.get("format") != "stories"]
    n = len(posts) or 1

    def share(fmt):
        return sum(1 for d in posts if d.get("format") == fmt) / n

    if not 0.55 <= share("reel") <= 0.75:
        warns.append("Рилсов %.0f%% от постов, ориентир 60-70%%." % (share("reel") * 100))
    if not 0.15 <= share("carousel") <= 0.35:
        warns.append("Каруселей %.0f%% от постов, ориентир 20-30%%." % (share("carousel") * 100))
    ok = set(plan.get("repeat_ok", []))
    for a, b in zip(days, days[1:]):
        f = a.get("format")
        if f == b.get("format") and f not in ok and f != "stories":
            warns.append("Формат «%s» два дня подряд (%s и %s); допустимо, только если аудит показал, "
                         "что он работает (repeat_ok)." % (FORMATS.get(f, f), a.get("date"), b.get("date")))
    cw = plan.get("code_word")
    for d in days:
        where = d.get("date", "?")
        if d.get("format") not in FORMATS:
            warns.append("%s: неизвестный формат «%s»." % (where, d.get("format")))
        if d.get("goal") not in GOALS:
            warns.append("%s: цель «%s» не из %s." % (where, d.get("goal"), sorted(GOALS)))
        if d.get("format") == "reel" and not d.get("hook_id"):
            warns.append("%s: у рилса нет hook_id (формула из ig-reel/hooks.json)." % where)
        if d.get("hook_id") and hooks and d["hook_id"] not in hooks:
            warns.append("%s: hook_id %s нет в hooks.json." % (where, d["hook_id"]))
        cta = (d.get("cta") or "").strip()
        if not cta:
            warns.append("%s: нет призыва." % where)
        elif cta.count(".") + cta.count("!") + cta.count("?") > 1:
            warns.append("%s: в призыве больше одного предложения, оставьте одно действие: «%s»." % (where, cta))
        if cw and d.get("goal") == "leads" and cw.lower() not in cta.lower():
            warns.append("%s: цель «заявки», но в призыве нет кодового слова «%s»." % (where, cw))
        if not d.get("time"):
            warns.append("%s: нет времени." % where)
    eng = [str(x).lower().lstrip("@") for x in plan.get("engage", [])]
    if len(eng) != 10:
        warns.append("Аккаунтов для комментирования %d, нужно 10." % len(eng))
    if len(set(eng)) != len(eng):
        warns.append("В списке для комментирования есть повторы.")
    return warns


def weekday(s):
    try:
        y, m, d = (int(x) for x in s.split("-"))
        return WEEKDAYS[date(y, m, d).weekday()]
    except Exception:
        return ""


def render_md(plan, hooks, warns):
    tz = plan.get("timezone", "местное время")
    acc = str(plan.get("account", "?")).lstrip("@")
    out = ["# Контент-план на неделю: @%s" % acc, "",
           "Старт: %s. Часовой пояс: %s. Сторис каждый день." % (plan.get("start", "?"), tz), "",
           "| День | Время | Формат | Тема | Хук (формула) | Цель | Призыв | Делает скилл | Сторис |",
           "|---|---|---|---|---|---|---|---|---|"]
    for d in plan.get("days", []):
        hid = d.get("hook_id")
        hook = ("%s %s" % (hid, hooks.get(hid, ""))).strip() if hid else "-"
        dt = d.get("date", "")
        row = [("%s %s" % (weekday(dt), dt[5:])).strip(), d.get("time", ""),
               FORMATS.get(d.get("format"), d.get("format", "")), d.get("topic", ""), hook,
               GOALS.get(d.get("goal"), d.get("goal", "")), d.get("cta", ""), d.get("skill", "-"), d.get("stories", "")]
        out.append("| " + " | ".join(str(x).replace("|", "/") for x in row) + " |")
    out += ["", "## 10 аккаунтов для комментирования (5 минут в день, содержательные комментарии)"]
    out += ["%d. @%s" % (i, str(a).lstrip("@")) for i, a in enumerate(plan.get("engage", []), 1)]
    if warns:
        out += ["", "## Предупреждения"] + ["- " + w for w in warns]
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--md")
    ap.add_argument("--csv")
    a = ap.parse_args()
    try:
        with open(a.file, encoding="utf-8-sig") as f:
            plan = json.load(f)
        assert isinstance(plan.get("days"), list)
    except Exception as e:
        print("Не удалось прочитать план: %s" % e)
        return 2
    hooks = load_hooks()
    warns = check(plan, hooks)
    md = render_md(plan, hooks, warns)
    print(md)
    if a.md:
        with open(a.md, "w", encoding="utf-8") as f:
            f.write(md)
        print("Markdown: " + a.md)
    if a.csv:
        with open(a.csv, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f, delimiter=";")
            w.writerow(COLS)
            for d in plan["days"]:
                w.writerow([d.get(k, "") for k in COLS])
        print("CSV: " + a.csv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
