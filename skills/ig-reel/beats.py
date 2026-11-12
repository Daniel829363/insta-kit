#!/usr/bin/env python3
"""beats.py: тайминг сценария рилса по строкам (~150 слов/мин для русского) и проверки ритма.

Формат файла: одна строка = один бит (то, что произносится). Пустые строки и строки на «#» игнорируются.
Экранный текст можно дописать через « | »: «Я потерял 18 000 $ | -18 000 $». Он в тайминг не входит.
Использование: python beats.py script.txt [--target 30] [--wpm 150]
Проверки: хук <= 3 с, бит <= 4 с, нет 3 подряд строк без конкретики, есть «петля» к началу, длительность.
"""
import sys, re, argparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

PAUSE = 0.25  # пауза между битами, сек
SPECIFIC = re.compile(r"\d|\$|€|%|[A-Za-z]{3,}")


def words(t):
    return re.findall(r"[\w$€₽%-]+", t, flags=re.UNICODE)


def stems(t):
    return {w.lower().replace("ё", "е")[:5] for w in words(t) if len(w) >= 5}


def has_specific(line, first_word_skipped=True):
    if SPECIFIC.search(line):
        return True
    w = words(line)
    return any(x[:1].isupper() for x in w[1:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--target", type=float, default=0, help="целевая длительность, сек")
    ap.add_argument("--wpm", type=int, default=150)
    a = ap.parse_args()
    wps = a.wpm / 60.0
    beats = []
    for raw in open(a.file, encoding="utf-8-sig"):
        raw = raw.strip()
        if not raw or raw.startswith("#"):
            continue
        spoken, _, screen = raw.partition(" | ")
        beats.append((spoken.strip(), screen.strip()))
    if not beats:
        print("Пустой сценарий.")
        return 1

    t = 0.0
    warns = []
    streak = 0
    print(f"{'#':>2} {'старт':>6} {'длит.':>6}  строка")
    for i, (sp, sc) in enumerate(beats, 1):
        n = len(words(sp))
        d = n / wps
        flag = ""
        if i == 1 and d > 3.0:
            warns.append(f"Хук занимает {d:.1f} с (больше 3 с). Сократите до ~7 слов.")
            flag = " !хук"
        elif d > 4.0:
            warns.append(f"Бит {i} занимает {d:.1f} с (больше 4 с): разрежьте или добавьте смену кадра.")
            flag = " !длинно"
        if has_specific(sp):
            streak = 0
        else:
            streak += 1
            if streak == 3:
                warns.append(f"Биты {i - 2}-{i}: три строки подряд без конкретики (цифры, имена, суммы).")
        print(f"{i:>2} {t:>5.1f}с {d:>5.1f}с  {sp}{flag}" + (f"   [экран: {sc}]" if sc else ""))
        t += d + PAUSE
    total = t - PAUSE
    print(f"\nИтого: {len(beats)} битов, ~{total:.1f} с при {a.wpm} сл/мин.")

    first, last = beats[0][0], beats[-1][0]
    common = stems(first) & stems(last)
    if common or last.rstrip().endswith(("...", "…")):
        print("Петля: есть связь конца с началом (" + ", ".join(sorted(common)) + ").")
    else:
        warns.append("Нет петли: последняя строка не возвращает к началу. Повторите слово или мысль из хука, чтобы ролик зацикливался.")
    if a.target:
        lo, hi = a.target * 0.85, a.target * 1.15
        if not lo <= total <= hi:
            warns.append(f"Длительность {total:.0f} с вне цели {a.target:.0f} с (допуск 15%).")
        else:
            print(f"Длительность в пределах цели {a.target:.0f} с.")
    if warns:
        print("\nЗамечания:")
        for w in warns:
            print("  - " + w)
    else:
        print("\nЗамечаний нет.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
