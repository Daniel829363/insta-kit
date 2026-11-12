#!/usr/bin/env python3
"""tts_elevenlabs.py: озвучка сценария через ElevenLabs ОДНИМ запросом + тайминги слов.

Весь текст уходит одним запросом (по фразам получаются резкие склейки интонации), эндпоинт
POST /v1/text-to-speech/{voice_id}/with-timestamps. Результат: <name>.mp3 и <name>.words.json
(слова с началом/концом в секундах, строки, длительность), из которых делаются субтитры с подсветкой слов.

Ключ берётся из переменной окружения ELEVENLABS_API_KEY и нигде не печатается.

Использование:
  python tts_elevenlabs.py script.txt --voice-id <voice_id> --out-dir out/ [--model eleven_v3]
  python tts_elevenlabs.py script.txt --voice-id <voice_id> --dry-run          # запрос без вызова API
  python tts_elevenlabs.py --from-alignment alignment.json --text script.txt   # только пересобрать words.json
Формат script.txt: одна строка = одна фраза (пустые строки и строки на «#» игнорируются).
Для eleven_v3 в строке можно ставить теги эмоций: [excited], [confident], [curious].
Опция --split-lines режет готовую дорожку на <name>_NN.wav по строкам файла (нужен ffmpeg).
"""
import argparse, base64, json, os, re, shutil, subprocess, sys, urllib.error, urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

API = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"
OUTPUT_FORMAT = "mp3_44100_128"
TAG = re.compile(r"\[[^\]]*\]")
MODELS = ("eleven_v3", "eleven_multilingual_v2")


def read_lines(path):
    """Строки сценария без пустых и без комментариев."""
    with open(path, encoding="utf-8-sig") as f:
        return [ln.strip() for ln in f if ln.strip() and not ln.strip().startswith("#")]


def join_lines(lines):
    return "\n\n".join(lines)


def plain(line):
    """Строка без тегов эмоций: то, что реально произносится."""
    return re.sub(r"\s+", " ", TAG.sub(" ", line)).strip()


def voice_settings(model, stability, similarity, style):
    if model == "eleven_v3":
        # v3 принимает только 0.0 (Creative), 0.5 (Natural), 1.0 (Robust)
        return {"stability": 0.0 if stability is None else stability}
    return {"stability": 0.45 if stability is None else stability,
            "similarity_boost": 0.8 if similarity is None else similarity,
            "style": 0.3 if style is None else style}


def build_request(args, lines):
    body = {"text": join_lines(lines), "model_id": args.model, "language_code": args.language,
            "voice_settings": voice_settings(args.model, args.stability, args.similarity, args.style)}
    if args.seed is not None:
        body["seed"] = args.seed
    url = API.format(voice_id=args.voice_id) + "?output_format=" + OUTPUT_FORMAT
    return url, body


def build_words(alignment):
    """Слова с таймингами из посимвольного выравнивания {characters, character_start_times_seconds,
    character_end_times_seconds}. Слово = последовательность непробельных символов; теги [..] отбрасываются."""
    chars = alignment["characters"]
    st = alignment["character_start_times_seconds"]
    en = alignment["character_end_times_seconds"]
    if not (len(chars) == len(st) == len(en)):
        raise ValueError("выравнивание: длины characters/start/end не совпадают")
    words, cur, depth = [], None, 0

    def flush():
        nonlocal cur
        if cur and cur["w"].strip():
            words.append(cur)
        cur = None

    for ch, s, e in zip(chars, st, en):
        if ch == "[":
            flush()
            depth += 1
            continue
        if ch == "]" and depth:
            depth -= 1
            continue
        if depth:
            continue
        if ch.isspace():
            flush()
            continue
        if cur is None:
            cur = {"w": "", "start": s, "end": e}
        cur["w"] += ch
        cur["end"] = e
    flush()
    for w in words:
        w["start"], w["end"] = round(w["start"], 3), round(w["end"], 3)
    return words


def assign_lines(words, lines):
    """Раскладывает слова по строкам сценария по числу слов в строке. Возвращает список строк
    {i, text, start, end, first, last} или None, если число слов не сошлось."""
    counts = [len(plain(ln).split()) for ln in lines]
    if sum(counts) != len(words):
        return None
    out, pos = [], 0
    for i, (ln, n) in enumerate(zip(lines, counts)):
        if n == 0:
            continue
        chunk = words[pos:pos + n]
        for w in chunk:
            w["line"] = i
        out.append({"i": i, "text": plain(ln), "start": chunk[0]["start"], "end": chunk[-1]["end"],
                    "first": pos, "last": pos + n - 1})
        pos += n
    return out


def make_words_doc(alignment, lines):
    words = build_words(alignment)
    line_info = assign_lines(words, lines) if lines else None
    doc = {"duration": round(max([w["end"] for w in words] + [0]), 3), "words": words}
    if line_info is not None:
        doc["lines"] = line_info
    elif lines:
        doc["warning"] = "число слов в сценарии и в выравнивании разное: строки не размечены"
    return doc


def split_lines(mp3, doc, out_dir, name, lead=0.06, tail=0.06):
    """Режет дорожку на <name>_NN.wav по строкам. Границы: середина паузы между последним словом строки
    и первым словом следующей, но не дальше lead/tail от слов. Фейды 15 мс на входе и 60 мс на выходе."""
    lines = doc.get("lines")
    if not lines:
        print("--split-lines: строки не размечены, нечего резать", file=sys.stderr)
        return []
    if shutil.which("ffmpeg") is None:
        print("--split-lines: ffmpeg не найден в PATH, нарезка пропущена", file=sys.stderr)
        return []
    made = []
    for k, ln in enumerate(lines):
        prev_end = lines[k - 1]["end"] if k else None
        next_start = lines[k + 1]["start"] if k + 1 < len(lines) else None
        t0 = ln["start"] - lead
        if prev_end is not None:
            t0 = max(t0, (prev_end + ln["start"]) / 2)
        t0 = max(t0, 0.0)
        t1 = ln["end"] + tail
        if next_start is not None:
            t1 = min(t1, (ln["end"] + next_start) / 2)
        dur = max(t1 - t0, 0.05)
        fo = min(0.06, dur / 2)
        path = os.path.join(out_dir, "%s_%02d.wav" % (name, ln["i"]))
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", "%.3f" % t0, "-t", "%.3f" % dur, "-i", mp3,
               "-af", "afade=t=in:d=0.015,afade=t=out:st=%.3f:d=%.3f" % (dur - fo, fo),
               "-ar", "48000", "-ac", "1", path]
        subprocess.run(cmd, check=True)
        made.append({"i": ln["i"], "file": os.path.basename(path), "duration": round(dur, 3)})
    return made


def call_api(url, body, key):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                 headers={"xi-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        sys.exit("ElevenLabs вернул HTTP %s: %s" % (e.code, detail))
    except urllib.error.URLError as e:
        sys.exit("нет связи с ElevenLabs: %s" % e.reason)


def main():
    ap = argparse.ArgumentParser(description="Озвучка одним запросом ElevenLabs + words.json")
    ap.add_argument("script", nargs="?", help="текстовый файл: одна строка = одна фраза")
    ap.add_argument("--text", help="(с --from-alignment) файл сценария для разметки строк")
    ap.add_argument("--voice-id", help="ID голоса ElevenLabs")
    ap.add_argument("--model", default="eleven_v3", help="eleven_v3 (по умолчанию) или eleven_multilingual_v2")
    ap.add_argument("--language", default="ru", help="код языка (по умолчанию ru)")
    ap.add_argument("--seed", type=int, default=None, help="seed для повторяемости")
    ap.add_argument("--stability", type=float, default=None)
    ap.add_argument("--similarity", type=float, default=None, help="только multilingual_v2")
    ap.add_argument("--style", type=float, default=None, help="только multilingual_v2")
    ap.add_argument("--out-dir", default=".", help="папка результата")
    ap.add_argument("--name", default="voice", help="имя файлов без расширения")
    ap.add_argument("--split-lines", action="store_true", help="нарезать на <name>_NN.wav по строкам (нужен ffmpeg)")
    ap.add_argument("--dry-run", action="store_true", help="показать запрос и число символов, API не вызывать")
    ap.add_argument("--from-alignment", metavar="FILE", help="не звать API: собрать words.json из JSON выравнивания")
    a = ap.parse_args()

    if a.from_alignment:
        alignment = json.load(open(a.from_alignment, encoding="utf-8"))
        alignment = alignment.get("alignment", alignment)
        lines = read_lines(a.text) if a.text else []
        doc = make_words_doc(alignment, lines)
        os.makedirs(a.out_dir, exist_ok=True)
        p = os.path.join(a.out_dir, a.name + ".words.json")
        json.dump(doc, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("слов: %d, длительность: %.2f с -> %s" % (len(doc["words"]), doc["duration"], p))
        return

    if not a.script:
        ap.error("нужен файл сценария")
    if a.model not in MODELS:
        print("предупреждение: модель %s не из списка %s" % (a.model, ", ".join(MODELS)), file=sys.stderr)
    lines = read_lines(a.script)
    if not lines:
        sys.exit("в файле нет текста")
    if not a.voice_id:
        ap.error("нужен --voice-id")
    url, body = build_request(a, lines)
    chars = len(body["text"])
    if a.dry_run:
        print("POST " + url)
        print("заголовок: xi-api-key: <ELEVENLABS_API_KEY из окружения>")
        print(json.dumps(body, ensure_ascii=False, indent=1))
        print("символов (стоимость: 1 кредит за символ): %d" % chars)
        print("строк: %d; слов без тегов: %d" % (len(lines), sum(len(plain(l).split()) for l in lines)))
        return

    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("нет ELEVENLABS_API_KEY в окружении (ключ: elevenlabs.io/app/settings/api-keys)")
    os.makedirs(a.out_dir, exist_ok=True)
    resp = call_api(url, body, key)
    mp3 = os.path.join(a.out_dir, a.name + ".mp3")
    with open(mp3, "wb") as f:
        f.write(base64.b64decode(resp["audio_base64"]))
    alignment = resp.get("alignment") or resp.get("normalized_alignment")
    if not alignment:
        sys.exit("в ответе нет выравнивания (alignment): тайминги слов недоступны")
    json.dump(alignment, open(os.path.join(a.out_dir, a.name + ".alignment.json"), "w", encoding="utf-8"),
              ensure_ascii=False)
    doc = make_words_doc(alignment, lines)
    if a.split_lines:
        doc["split"] = split_lines(mp3, doc, a.out_dir, a.name)
    p = os.path.join(a.out_dir, a.name + ".words.json")
    json.dump(doc, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("символов: %d; слов: %d; длительность: %.2f с" % (chars, len(doc["words"]), doc["duration"]))
    print("mp3: " + mp3)
    print("words: " + p)
    if doc.get("warning"):
        print("!! " + doc["warning"])


if __name__ == "__main__":
    main()
