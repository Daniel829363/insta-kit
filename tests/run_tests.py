#!/usr/bin/env python3
"""Дымовые тесты скриптов insta-kit. Запуск: python tests/run_tests.py"""
import os, sys, json, subprocess, tempfile

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
out = run(os.path.join(S, "ig-viral", "outliers.py"), os.path.join(FX, "apify_reels.json"), "--accounts", "@Cargo_Demo", "--per-account", "1", "--top", "5")
check("outliers: --accounts и --per-account", "Итого: 10" in out and "smm_demo" not in out and out.count("@cargo_demo") <= 2 and "Топ-1 " in out)
with tempfile.TemporaryDirectory() as tmp:
    rows = [{"ownerUsername": "a", "shortCode": "AbC%d" % i, "videoPlayCount": v} for i, v in enumerate([100, 100, 100, 5000])]
    src = os.path.join(tmp, "r.json")
    json.dump(rows, open(src, "w"))
    run(os.path.join(S, "ig-viral", "outliers.py"), src, "--md", os.path.join(tmp, "o.md"))
    check("outliers: без url ссылка строится из shortCode", "https://www.instagram.com/reel/AbC3/" in open(os.path.join(tmp, "o.md"), encoding="utf-8").read())
out = run(os.path.join(S, "ig-audit", "audit.py"), os.path.join(FX, "audit_posts.csv"))
check("audit: три таблицы", "ТОП по охвату" in out and "досмотру" in out)
# --- ig-audit: типы, порог, свежие посты ---
out = run(os.path.join(S, "ig-audit", "audit.py"), os.path.join(FX, "audit_typed.csv"), "--now", "2026-11-12")
rank_ss = out.split("ТОП по сохранениям")[1].split("ТОП рилсов")[0]
check("audit: порог охвата убирает мелкий пост из рейтинга сохр/перес", "Мелкий пост" not in rank_ss and "Порог охвата" in out)
check("audit: свежий пост в блоке «рано судить», не в «худших»",
      "Свежий рилс" in out.split("РАНО СУДИТЬ")[1] and "Свежий рилс" not in out.split("РАНО СУДИТЬ")[0])
check("audit: x тип считается внутри типа (рилс 1000 при медиане рилсов 900 = 1.1x)", "1.1x" in out and "3.1x" in out)
check("audit: без длительности -- секунды, не %", "8.0с" in out and "длительность неизвестна" in out)
check("audit: тип и дата в выводе", "карусель" in out and "01.10.26" in out)
# --- ig-audit/collect.py без сети (подмена composio) ---
import importlib.util
spec = importlib.util.spec_from_file_location("collect", os.path.join(S, "ig-audit", "collect.py"))
col = importlib.util.module_from_spec(spec)
spec.loader.exec_module(col)
calls = []
def fake(tool, args):
    calls.append((tool, args))
    if tool == "INSTAGRAM_GET_IG_USER_MEDIA":
        if args.get("after") is None:
            return {"successful": True, "data": {"data": [
                {"id": "r1", "media_type": "VIDEO", "media_product_type": "REELS", "permalink": "u1", "timestamp": "2026-10-01T10:00:00+0000", "caption": "c1", "media_url": "m"}],
                "paging": {"cursors": {"after": "CUR"}, "next": "x"}}}
        return {"successful": True, "data": {"data": [
            {"id": "c1", "media_type": "CAROUSEL_ALBUM", "media_product_type": "FEED", "permalink": "u2", "timestamp": "2026-09-01T10:00:00+0000", "like_count": 3}],
            "paging": {"cursors": {"after": "CUR2"}}}}
    ms = args["metric"]
    if "ig_reels_avg_watch_time" in ms and args["ig_media_id"] == "c1":
        return {"successful": False, "error": "unsupported"}
    vals = {"views": 10, "reach": 8, "saved": 1, "shares": 2, "likes": 3, "comments": 0, "ig_reels_avg_watch_time": 5000}
    return {"successful": True, "data": {"data": [{"name": m, "values": [{"value": vals[m]}]} for m in ms]}}
media = col.fetch_media(fake, 50)
check("collect: пагинация по after", len(media) == 2 and calls[1][1].get("after") == "CUR")
check("collect: явные fields", all(f in calls[0][1]["fields"] for f in ("media_product_type", "like_count", "comments_count", "permalink")))
rows = col.build_rows(media, fake, duration=lambda u: 31.5)
ins = [a["metric"] for t, a in calls if t == "INSTAGRAM_GET_IG_MEDIA_INSIGHTS"]
check("collect: рилс запрашивает avg_watch, карусель нет", "ig_reels_avg_watch_time" in ins[0] and "ig_reels_avg_watch_time" not in ins[1])
check("collect: рилс -> REELS, длительность и avg_watch", rows[0]["type"] == "REELS" and rows[0]["duration"] == 31.5 and rows[0]["avg_watch"] == 5000)
check("collect: карусель без длительности и avg_watch", rows[1]["type"] == "CAROUSEL_ALBUM" and rows[1]["duration"] == "" and rows[1]["avg_watch"] == "" and rows[1]["reach"] == 8)
with tempfile.TemporaryDirectory() as tmp:
    pth = os.path.join(tmp, "p.csv")
    col.write_csv(rows, pth)
    out = run(os.path.join(S, "ig-audit", "audit.py"), pth, "--now", "2026-11-12")
    check("collect -> audit: CSV читается, 2 поста", "Постов: 2" in out)
    accp = os.path.join(tmp, "a.json")
    json.dump([{"key": "k1", "username": "u", "composio_account": "ca_TEST1"}, {"key": "k2", "composio_account": "ca_TEST2"}], open(accp, "w"))
    check("collect: аккаунт по key и по ca_", col.load_account("k2", accp) == "ca_TEST2" and col.load_account("ca_X", accp) == "ca_X")
out = run(os.path.join(S, "ig-reel", "beats.py"), os.path.join(FX, "script.txt"), "--target", "30")
check("beats: тайминг и замечания", "Итого:" in out and "Замечания" in out)
out = run(os.path.join(S, "ig-caption", "caption.py"), os.path.join(FX, "caption.txt"))
check("caption: рамка и проверки", "Как увидят в ленте" in out and "хештегов" in out)
out = run(os.path.join(S, "ig-human", "clean.py"), os.path.join(FX, "slop.txt"))
check("clean: штампы удалены, нет ZWSP", "в современном мире" not in out.split("ОЧИЩЕННЫЙ ТЕКСТ")[1].lower() and "​" not in out)
# --- видеоблок: tts_elevenlabs.py без сети ---
TTS = os.path.join(S, "ig-video", "tts_elevenlabs.py")
out = run(TTS, os.path.join(FX, "tts_script.txt"), "--voice-id", "TEST_VOICE", "--dry-run")
check("tts dry-run: эндпоинт with-timestamps", "/v1/text-to-speech/TEST_VOICE/with-timestamps" in out)
check("tts dry-run: eleven_v3 и ru по умолчанию", '"model_id": "eleven_v3"' in out and '"language_code": "ru"' in out)
check("tts dry-run: весь текст одним запросом", "Привет, мир!\\n\\nГотово." in out and "символов (стоимость: 1 кредит за символ): 31" in out)
check("tts dry-run: ключ не печатается", "xi-api-key: <ELEVENLABS_API_KEY" in out)
out = run(TTS, os.path.join(FX, "tts_script.txt"), "--voice-id", "X", "--model", "eleven_multilingual_v2", "--dry-run")
check("tts dry-run: multilingual_v2 с similarity/style", "similarity_boost" in out and "eleven_multilingual_v2" in out)
with tempfile.TemporaryDirectory() as tmp:
    run(TTS, "--from-alignment", os.path.join(FX, "el_alignment.json"), "--text", os.path.join(FX, "tts_script.txt"),
        "--out-dir", tmp, "--name", "t")
    doc = json.load(open(os.path.join(tmp, "t.words.json"), encoding="utf-8"))
    ws = doc["words"]
    check("words: 3 слова, тег [excited] отброшен", [w["w"] for w in ws] == ["Привет,", "мир!", "Готово."])
    check("words: тайминги не убывают", all(a["end"] <= b["start"] + 1e-9 for a, b in zip(ws, ws[1:])) and ws[0]["start"] >= 0)
    check("words: строки размечены", [l["text"] for l in doc.get("lines", [])] == ["Привет, мир!", "Готово."] and ws[2]["line"] == 1)
out = run(os.path.join(S, "ig-plan", "plan.py"), os.path.join(FX, "plan.json"))
check("plan: таблица с формулами хука и 10 аккаунтами", "13 Цифра результата" in out and "10. @a10" in out and "Только сторис" in out)
check("plan: предупреждение о повторе формата два дня подряд", "два дня подряд (2026-11-18 и 2026-11-19)" in out and out.count("## Предупреждения") == 1)
bad = {"days": [{"date": "2026-11-16", "time": "", "format": "reel", "goal": "leads", "cta": "Сохрани. Напиши. Перешли."}], "code_word": "КИТ", "engage": ["x"]}
with tempfile.TemporaryDirectory() as tmp:
    pj = os.path.join(tmp, "bad.json")
    json.dump(bad, open(pj, "w", encoding="utf-8"), ensure_ascii=False)
    out = run(os.path.join(S, "ig-plan", "plan.py"), pj, "--csv", os.path.join(tmp, "p.csv"))
    check("plan: ловит 1 день, нет hook_id, кодового слова, времени, 10 аккаунтов",
          all(x in out for x in ("нужно 7", "нет hook_id", "нет кодового слова", "нет времени", "нужно 10", "больше одного предложения")))
    check("plan: CSV записан", os.path.exists(os.path.join(tmp, "p.csv")))
for f in (".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "templates/accounts.example.json",
          "skills/ig-reel/hooks.json", "skills/ig-profile/rubric.json", "skills/ig-human/slop_ru.json"):
    try:
        json.load(open(os.path.join(ROOT, f), encoding="utf-8"))
        check("json валиден: " + f, True)
    except Exception:
        check("json валиден: " + f, False)
sys.exit(1 if fails else 0)
