#!/usr/bin/env python3
"""clean.py: чистка ИИ-штампов в русском тексте (подписи, сценарии, посты).

Что делает:
  * убирает невидимые символы (ZWSP, ZWNJ, BOM, мягкий перенос), NBSP и узкие пробелы -> обычный пробел;
  * длинные тире (U+2014/U+2013 с пробелами) в разговорном тексте заменяет по смыслу
    (двоеточие, запятая или точка), --keep-dash отключает;
  * ищет штампы из slop_ru.json: безопасные удаляет, остальные только показывает с советом;
  * считает эмодзи, восклицания, тройные перечисления, «не просто X, а Y».
Использование:
  python clean.py text.txt [--out clean.txt] [--keep-dash] [--report-only]
  echo "текст" | python clean.py -
"""
import sys, re, json, os, argparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ZWJ = "‍"
INVISIBLE = {"​": "ZWSP", "‌": "ZWNJ", "﻿": "BOM", "⁠": "word-joiner",
             "­": "мягкий перенос", "‎": "LRM", "‏": "RLM"}
SPACES = {" ": "NBSP", " ": "узкий NBSP", " ": "тонкий пробел", " ": "en-пробел",
          " ": "em-пробел", " ": "цифровой пробел", " ": "волосной пробел"}
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿\U0001F000-\U0001F2FF⭐⬆↔-↪⌚-⏿]")
DASH_RE = r"(?<=\S) [—–] (?=\S)"
SENT_END = ".!?…\n"


def load_slop():
    with open(os.path.join(HERE, "slop_ru.json"), encoding="utf-8") as f:
        return json.load(f)


def strip_invisible(text, report):
    for ch, name in {**INVISIBLE, **SPACES}.items():
        n = text.count(ch)
        if n:
            report.append(f"Невидимый символ {name} (U+{ord(ch):04X}): {n} шт. удалён/заменён")
    for ch in INVISIBLE:
        text = text.replace(ch, "")
    for ch in SPACES:
        text = text.replace(ch, " ")
    # ZWJ оставляем только внутри эмодзи-последовательностей
    out = []
    for i, ch in enumerate(text):
        if ch == ZWJ:
            prev = text[i - 1] if i else " "
            nxt = text[i + 1] if i + 1 < len(text) else " "
            if not ((EMOJI.match(prev) or prev == "️") and EMOJI.match(nxt)):
                report.append("Невидимый ZWJ (U+200D) вне эмодзи удалён")
                continue
        out.append(ch)
    return "".join(out)


def _dash(m):
    nxt = m.group(1)
    if nxt.isalpha() and nxt.isupper():
        return ". " + nxt
    before = m.string[: m.start()]
    seg = re.split(r"[.!?\n]", before)[-1]
    short = len(re.findall(r"\w+", seg)) <= 4
    if nxt.isalpha() and nxt.islower():
        return (": " if short else ", ") + nxt
    return ", " + nxt


def remove_phrase(text, phrase):
    pat = re.compile(re.escape(phrase) + r"[,:]?[ \t]*", re.I)

    def r(m):
        prev = m.string[: m.start()].rstrip(" \t")
        start = (not prev) or prev[-1] in SENT_END or not (prev[-1].isalnum() or prev[-1] in ",;:-")
        return "\x01" if start else ""

    text = pat.sub(r, text)
    text = re.sub(r"\x01(\w)", lambda m: m.group(1).upper(), text)
    return text.replace("\x01", "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--out")
    ap.add_argument("--keep-dash", action="store_true")
    ap.add_argument("--report-only", action="store_true")
    a = ap.parse_args()
    if a.file == "-":
        raw = sys.stdin.buffer.read().decode("utf-8-sig")
    else:
        raw = open(a.file, encoding="utf-8-sig").read()
    raw = raw.replace("\r\n", "\n")
    slop = load_slop()
    report, tips = [], []
    text = strip_invisible(raw, report)

    n = len(re.findall(DASH_RE, text))
    if n and not a.keep_dash:
        report.append(f"Длинные тире в тексте: {n} шт. заменены на двоеточие, запятую или точку по смыслу")
        text = re.sub(r"(?<=\S) [—–] (\S)", _dash, text)
    elif n:
        report.append(f"Длинные тире: {n} шт. (оставлены по --keep-dash)")

    for item in slop["phrases"]:
        p = item["p"]
        c = len(re.findall(re.escape(p), text, re.I))
        if not c:
            continue
        if "replace" in item and not a.report_only:
            text = remove_phrase(text, p)
            report.append(f"Штамп «{p}» x{c}: удалён")
        else:
            tips.append(f"Штамп «{p}» x{c}: {item['tip']}")
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r" +([,.!?;:])", r"\1", text)

    for item in slop["regex"]:
        found = [m.group(0) for m in re.finditer(item["r"], text, re.I)]
        if found:
            tips.append(f"Оборот «{item['name']}» x{len(found)}: {item['tip']} Пример: «{found[0][:70]}»")

    emo = EMOJI.findall(text)
    if len(emo) > 3 or len(emo) / max(1, len(text)) * 500 > 3:
        tips.append(f"Много эмодзи: {len(emo)} шт. Оставьте 1-3 по делу, не в каждой строке")
    ex = text.count("!")
    if ex > 3:
        tips.append(f"Восклицательных знаков {ex}: оставьте не больше 1-2")
    trip = re.findall(r"\b[\w-]+, [\w-]+ и [\w-]+\b", text, re.U)
    if len(trip) >= 2:
        tips.append(f"Тройные перечисления «X, Y и Z» x{len(trip)}: ИИ любит тройки, оставьте одно или назовите 2 пункта. Пример: «{trip[0]}»")
    if len(re.findall(r"(?m)^\s*[-•*]\s", text)) > 5:
        tips.append("Много маркированных списков: для разговорного текста лучше связная речь")

    print("ОТЧЁТ")
    for r in report or ["автоисправлений нет"]:
        print("  [исправлено] " + r)
    if tips:
        print("ТРЕБУЕТ РУЧНОЙ ПРАВКИ")
        for t in tips:
            print("  [!] " + t)
    else:
        print("  штампов для ручной правки нет")
    print(f"Итого: исправлено {len(report)}, на ручную правку {len(tips)}.\n")
    if not a.report_only:
        print("ОЧИЩЕННЫЙ ТЕКСТ")
        print("-" * 40)
        print(text.strip())
        print("-" * 40)
        if a.out:
            with open(a.out, "w", encoding="utf-8") as f:
                f.write(text.strip() + "\n")
            print(f"Сохранено: {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
