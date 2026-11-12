#!/usr/bin/env python3
"""Дымовые тесты скриптов insta-kit. Запуск: python tests/run_tests.py"""
import os, sys, json, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FX = os.path.join(ROOT, "tests", "fixtures")
S = os.path.join(ROOT, "skills")
env = dict(os.environ, PYTHONIOENCODING="utf-8")


def run(*args):
    p = subprocess.run([sys.executable, *args], capture_output=True, env=env)
    out = p.stdout.decode("utf-8")
    assert p.returncode == 0, (args, p.stderr.decode("utf-8"))
    return out


fails = 0


def check(name, cond):
    global fails
    print(("PASS " if cond else "FAIL ") + name)
    fails += 0 if cond else 1


hs = json.loads(run(os.path.join(S, "ig-reel", "hookscore.py"), "--json",
                    "Я потерял 18 000 долларов из-за одного пункта в договоре.",
                    "Клод только что убил Инстаграм-менеджера.",
                    "Привет всем, сегодня расскажу про карго"))
check("хук с цифрой и потерей >= 70", hs[0]["score"] >= 70)
check("хук «Клод убил...» в 50-69", 50 <= hs[1]["score"] < 70)
check("приветствие < 20", hs[2]["score"] < 20)

out = run(os.path.join(S, "ig-viral", "outliers.py"), os.path.join(FX, "apify_reels.json"), "--top", "5")
check("outliers: есть сигналы >= 3x", "сигнал" in out and "Итого: 20" in out)
out = run(os.path.join(S, "ig-audit", "audit.py"), os.path.join(FX, "audit_posts.csv"))
check("audit: три таблицы", "ТОП по охвату" in out and "досмотру" in out)
out = run(os.path.join(S, "ig-reel", "beats.py"), os.path.join(FX, "script.txt"), "--target", "30")
check("beats: тайминг и замечания", "Итого:" in out and "Замечания" in out)
out = run(os.path.join(S, "ig-caption", "caption.py"), os.path.join(FX, "caption.txt"))
check("caption: рамка и проверки", "Как увидят в ленте" in out and "хештегов" in out)
out = run(os.path.join(S, "ig-human", "clean.py"), os.path.join(FX, "slop.txt"))
check("clean: штампы удалены, нет ZWSP", "в современном мире" not in out.split("ОЧИЩЕННЫЙ ТЕКСТ")[1].lower() and "​" not in out)
for f in (".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "templates/accounts.example.json",
          "skills/ig-reel/hooks.json", "skills/ig-profile/rubric.json", "skills/ig-human/slop_ru.json"):
    try:
        json.load(open(os.path.join(ROOT, f), encoding="utf-8"))
        check("json валиден: " + f, True)
    except Exception:
        check("json валиден: " + f, False)
sys.exit(1 if fails else 0)
