#!/usr/bin/env python3
"""caption.py: проверка подписи к посту/рилсу по правилам ленты Instagram.

Использование:
  python caption.py caption.txt [--code СЛОВО] [--keywords "карго из китая, доставка"] [--out final.txt]
  echo "текст" | python caption.py -
Показывает первые ~125 символов «как в ленте», проверяет: первая строка, один призыв, кодовое слово,
длина, абзацы, 3-5 хештегов, ссылки. Хештеги переносит в конец и печатает итоговую подпись.
"""
import sys, re, argparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

FEED = 125
LIMIT = 2200
CTA_STEMS = {
    "написать": r"\b(напиши|пиши|напишите|пишите|отправь|отправьте)\b",
    "сохранить": r"\b(сохрани|сохраните|сохраняй)\b",
    "подписаться": r"\b(подпишись|подпишитесь|подписывайся)\b",
    "переслать": r"\b(перешли|пришли|поделись|скинь|отправь другу|перешлите)\b",
    "комментарий": r"\b(оставь|оставьте|ответь|ответьте|расскажи|расскажите) (в )?(коммент|ниже)|\bв комментариях\b|\bкомментируй\b",
    "перейти": r"\b(переходи|перейди|жми|нажми|кликай|ссылка в (шапке|профиле|био))\b",
    "забрать": r"\b(забирай|забери|получи|скачай)\b",
}
GREET = ("привет", "здравствуйте", "добрый", "доброе", "всем привет", "друзья", "дорогие")
HOOKISH = re.compile(r"\d|\?|\bпочему\b|\bкак\b|\bошибк|\bпотерял|\bсекрет|\bне делай|\bникто\b|\bсколько\b|\bстоит\b", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--code", help="кодовое слово для автоответа")
    ap.add_argument("--keywords", help="ключи поиска через запятую")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.file == "-":
        text = sys.stdin.buffer.read().decode("utf-8-sig")
    else:
        text = open(a.file, encoding="utf-8-sig").read()
    text = text.replace("\r\n", "\n").strip()
    if not text:
        print("Пустая подпись.")
        return 1

    tags = re.findall(r"#[\w]+", text, flags=re.UNICODE)
    body = re.sub(r"\s*#[\w]+", "", text, flags=re.UNICODE).strip()
    body = re.sub(r"[ \t]+\n", "\n", body)
    body = re.sub(r"\n{3,}", "\n\n", body)

    warns, oks = [], []
    first_line = body.split("\n")[0].strip()
    feed = body[:FEED].replace("\n", " ⏎ ")
    cut = len(body) > FEED
    print("Как увидят в ленте (первые ~125 символов):")
    print("┌" + "─" * (FEED + 2) + "┐")
    print("│ " + feed.ljust(FEED) + " │")
    print("└" + "─" * (FEED + 2) + "┘")
    if cut:
        print(f"   ...«ещё» после символа {FEED}. Скрыто {len(body) - FEED} симв.\n")
    else:
        print("   (подпись целиком помещается в ленте)\n")

    # первая строка
    if len(first_line) > FEED:
        warns.append(f"Первая строка {len(first_line)} симв.: в ленте обрежется на {FEED}. Сократите.")
    if first_line.lower().startswith(GREET):
        warns.append("Первая строка начинается с приветствия: потратили лучшее место. Начните с сути.")
    elif HOOKISH.search(first_line):
        oks.append("Первая строка цепляет (цифра, вопрос или ставка).")
    else:
        warns.append("Первая строка без крючка: добавьте цифру, вопрос или конкретную выгоду.")

    # ключи
    if a.keywords:
        keys = [k.strip().lower() for k in a.keywords.split(",") if k.strip()]
        head = body[:FEED].lower()
        miss = [k for k in keys if k not in head]
        if miss:
            warns.append("Ключевые слова для поиска не в первой строке: " + ", ".join(miss) + ".")
        else:
            oks.append("Ключевые слова для поиска есть в первой строке.")

    # призыв
    low = body.lower()
    found = [name for name, pat in CTA_STEMS.items() if re.search(pat, low)]
    if a.code:
        if re.search(r"\b" + re.escape(a.code.lower()) + r"\b", low):
            found = [f for f in found if f != "написать"] + ["кодовое слово"]
            if a.code not in body:
                warns.append(f"Слово «{a.code}» есть только в другом регистре: выделите кодовое слово ровно как в автоответе, например {a.code}.")
            if "напиши" not in low and "пиши" not in low and "комментар" not in low:
                warns.append("Рядом с кодовым словом нет глагола действия («напиши», «оставь в комментариях»).")
        else:
            warns.append(f"Нет кодового слова «{a.code}»: автоответ не сработает.")
    if not found:
        warns.append("Нет призыва к действию. Добавьте ОДНО действие.")
    elif len(found) >= 3:
        warns.append("Призывов слишком много (" + ", ".join(found) + "): оставьте одно действие.")
    else:
        oks.append("Призыв: " + ", ".join(found) + ".")

    # длина и абзацы
    if len(body) > LIMIT:
        warns.append(f"Длина {len(body)} > {LIMIT}: Instagram обрежет.")
    paras = [p for p in body.split("\n\n") if p.strip()]
    if len(body) > 300 and len(paras) < 2:
        warns.append("Стена текста: разбейте на абзацы с пустой строкой.")
    long_p = [i for i, p in enumerate(paras, 1) if len(p) > 400]
    if long_p:
        warns.append(f"Абзацы длиннее 400 симв.: {', '.join(map(str, long_p))}.")
    if len(body) <= LIMIT and len(paras) >= 2 or len(body) <= 300:
        oks.append(f"Длина {len(body)} симв., абзацев {len(paras)}.")

    # хештеги
    uniq = list(dict.fromkeys(tags))
    if len(uniq) == 0:
        warns.append("Нет хештегов: добавьте 3-5 по теме.")
    elif len(uniq) > 5:
        warns.append(f"{len(uniq)} хештегов: хватит 3-5 по теме, 30 не нужно.")
    elif len(uniq) < 3:
        warns.append(f"{len(uniq)} хештега: добавьте до 3-5.")
    else:
        oks.append(f"Хештегов {len(uniq)}: норма.")
    if len(uniq) != len(tags):
        warns.append("Есть повторяющиеся хештеги.")

    # ссылки
    if re.search(r"https?://|www\.|\b[\w-]+\.(com|ru|kg|kz|app|io|me|net|org)\b", text, re.I):
        warns.append("Ссылка в подписи некликабельна: уберите, пишите «ссылка в шапке профиля» или кодовое слово.")

    print("Проверки:")
    for o in oks:
        print("  OK   " + o)
    for w in warns:
        print("  !!   " + w)
    if not warns:
        print("\nЗамечаний нет.")

    final = body + ("\n\n" + " ".join(uniq[:5] if len(uniq) > 5 else uniq) if uniq else "")
    print("\nИтоговая подпись (хештеги в конце):")
    print("-" * 40)
    print(final)
    print("-" * 40)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(final + "\n")
        print(f"Сохранено: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
