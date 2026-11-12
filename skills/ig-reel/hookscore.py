#!/usr/bin/env python3
"""hookscore.py: оценка русских хуков для рилсов (0-100) с объяснением штрафов.

Использование:
  python hookscore.py "Я потерял 18 000 долларов из-за одного пункта в договоре."
  python hookscore.py --file hooks.txt        (по хуку в строке)
  python hookscore.py --json "хук 1" "хук 2"
Оценка: >=70 сильный, 50-69 средний, <50 слабый.
"""
import sys, re, json, argparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

WPS = 2.5  # слов в секунду при ~150 слов/мин

GREETINGS = ["привет", "здравствуй", "добрый день", "добрый вечер", "доброе утро", "всем привет",
             "дорогие друзья", "друзья", "ребята", "салам", "салем", "а вот и я", "хай"]
FILLER_OPENERS = ["сегодня расскажу", "сегодня поговорим", "сегодня я расскажу", "сегодня хочу рассказать",
                  "в этом видео", "в этом ролике", "в этом рилсе", "хочу рассказать", "давайте поговорим",
                  "давай поговорим", "давайте разберём", "давай разберём", "расскажу про", "расскажу о",
                  "меня зовут", "если вы смотрите"]
STOP_SCROLL = ["стоп-скролл", "стоп скролл", "не листай", "не пролистывай", "остановись", "подожди, не уходи",
               "досмотри до конца", "смотри до конца"]
WATER = ["очень", "просто", "вообще", "короче", "в общем", "как бы", "на самом деле", "в принципе", "кстати",
         "наверное", "может быть", "иногда"]
STAKES = ["потерял", "потеряла", "потеряешь", "потеряете", "потеря", "стоил", "стоила", "стоило", "обошл",
          "убил", "убьёт", "убьет", "штраф", "ошибк", "провал", "слил", "сгорел", "разорил", "дорого",
          "опасн", "никто не", "никогда не", "секрет", "скрыва", "обман", "развод", "врут", "врёт", "ловуш",
          "не делай", "не покупай", "не плати", "не запускай", "прекрати", "перестань", "хватит",
          "заработал", "сэкономил", "бесплатно", "ставлю", "против", "миф", "правда о", "признаюсь",
          "украл", "потеряно", "теряешь", "теряете"]
NOVELTY = ["только что", "уже", "впервые", "новый", "новая", "новое", "вышел", "вышла", "запретили",
           "закрыли", "заблокировали", "теперь"]
YOU = [r"\bты\b", r"\bтебе\b", r"\bтебя\b", r"\bтвой", r"\bтвоя\b", r"\bтвои\b", r"\bвы\b", r"\bвам\b", r"\bвас\b",
       r"\bваш", r"\bлюбой\b", r"\bкаждый\b", r"\bесли ты\b", r"\bесли вы\b"]
MONEY = [r"\$", r"€", r"₽", r"долл", r"евро", r"рубл", r"сом\b", r"сомов", r"тенге", r"тыс\b", r"тысяч",
         r"млн", r"миллион", r"usd", r"\bпроцент", r"%"]
INTRIGUE = [r"одн(ого|ой|а|у|о) ", r"из-за", r"вот что", r"вот как", r"вот почему", r"вот зачем"]


def words(text):
    return re.findall(r"[\w$€₽%-]+", text, flags=re.UNICODE)


def score(hook):
    h = hook.strip()
    low = h.lower().replace("ё", "е")
    lowy = h.lower()
    w = words(h)
    n = len(w)
    pts = 10
    notes_plus, notes_minus, breakers = [], [], []

    # конкретика
    if re.search(r"\d", h):
        pts += 20
        notes_plus.append("+20 есть цифра")
    else:
        notes_minus.append("нет цифры: добавьте число, срок или сумму")
    if any(re.search(p, low) for p in MONEY):
        pts += 10
        notes_plus.append("+10 деньги или проценты")
    caps = [x for x in w[1:] if x[:1].isupper() and not x.isdigit()]
    if caps or re.search(r"[A-Za-z]{3,}", h):
        pts += 8
        notes_plus.append("+8 есть имя, бренд или название")
    # ставки
    if any(s in low for s in (x.replace("ё", "е") for x in STAKES)):
        pts += 15
        notes_plus.append("+15 есть ставка: потеря, ошибка, спор или выгода")
    else:
        notes_minus.append("нет ставки: что теряет или получает зритель?")
    if any(s in lowy for s in NOVELTY):
        pts += 5
        notes_plus.append("+5 новизна")
    if any(re.search(p, lowy) for p in INTRIGUE):
        pts += 3
        notes_plus.append("+3 интрига «из-за одного...»")
    if any(re.search(p, lowy) for p in YOU):
        pts += 8
        notes_plus.append("+8 обращение к зрителю (ты/вы)")

    # старт и длина
    greeted = any(lowy.startswith(g) or lowy.startswith("всем " + g) for g in GREETINGS)
    if not greeted and not any(lowy.startswith(f) for f in FILLER_OPENERS):
        pts += 10
        notes_plus.append("+10 сразу по делу, без разгона")
    if n <= 8:
        pts += 15
        notes_plus.append(f"+15 коротко ({n} сл.)")
    elif n <= 12:
        pts += 12
        notes_plus.append(f"+12 в пределах 12 слов ({n})")
    elif n <= 16:
        pts += 5
        notes_minus.append(f"{n} слов: длинновато, сократите до 12")
    else:
        pts -= 10
        notes_minus.append(f"-10 {n} слов: хук не уместится в 3-4 секунды")

    # дилбрейкеры
    if greeted or any(g in lowy[:25] for g in ("привет", "здравствуйте")):
        pts -= 45
        breakers.append("-45 приветствие в начале: зритель уже пролистнул")
    if any(f in lowy for f in FILLER_OPENERS):
        pts -= 25
        breakers.append("-25 подводка («сегодня расскажу», «в этом видео»): начните с сути")
    if any(s in lowy for s in STOP_SCROLL):
        pts -= 20
        breakers.append("-20 «стоп-скролл»/просьба не листать: не работает, дайте причину остаться")
    waters = [x for x in WATER if re.search(r"\b" + re.escape(x) + r"\b", lowy)]
    if waters:
        pts -= 4 * len(waters)
        breakers.append(f"-{4 * len(waters)} вода: {', '.join(waters)}")
    if h.endswith("?") and not re.search(r"\d", h) and n <= 5:
        pts -= 8
        breakers.append("-8 короткий общий вопрос без конкретики")

    pts = max(0, min(100, pts))
    verdict = "сильный" if pts >= 70 else ("средний" if pts >= 50 else "слабый")
    return {
        "hook": h, "score": pts, "verdict": verdict, "words": n,
        "speech_sec": round(n / WPS, 1), "plus": notes_plus, "minus": notes_minus, "dealbreakers": breakers,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("hooks", nargs="*")
    ap.add_argument("--file")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    hooks = list(a.hooks)
    if a.file:
        hooks += [l.strip() for l in open(a.file, encoding="utf-8-sig") if l.strip() and not l.startswith("#")]
    if not hooks and not sys.stdin.isatty():
        hooks += [l.strip() for l in sys.stdin.buffer.read().decode("utf-8-sig").splitlines() if l.strip()]
    if not hooks:
        ap.print_help()
        return 1
    res = [score(h) for h in hooks]
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0
    for r in res:
        print(f"[{r['score']:>3}] {r['verdict'].upper()}  ({r['words']} сл., ~{r['speech_sec']} с)  {r['hook']}")
        for x in r["dealbreakers"]:
            print(f"      ШТРАФ {x}")
        for x in r["minus"]:
            print(f"      - {x}")
        for x in r["plus"]:
            print(f"      {x}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
