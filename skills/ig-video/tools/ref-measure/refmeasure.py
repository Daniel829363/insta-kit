"""Разбор референса (и сравнение с нашим роликом) в цифрах.

Обёртка над `hyperframes measure` (HeyGen HyperFrames, Apache-2.0; ставится локально
в node_modules этой папки, телеметрия и проверка обновлений выключены).

    python -I refmeasure.py REF.mp4 [--ours OURS.mp4] [--out DIR] [--start S --end E] [--sheet-every 1]

Пишет в DIR: RECIPE.md (рецепт по-русски), measure.json (все цифры),
sheet_ref_*.png / sheet_ours_*.png (контактные листы), events_*.png (карта событий).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics as st
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_CANDIDATES = [HERE / "node_modules", Path.home() / ".claude" / "insta-kit" / "hf" / "node_modules"]
CLI = next((c / "hyperframes" / "bin" / "hyperframes.mjs" for c in _CANDIDATES
            if (c / "hyperframes" / "bin" / "hyperframes.mjs").exists()),
           _CANDIDATES[1] / "hyperframes" / "bin" / "hyperframes.mjs")
ENV = {**os.environ, "HYPERFRAMES_NO_TELEMETRY": "1", "HYPERFRAMES_NO_UPDATE_CHECK": "1",
       "HYPERFRAMES_SKIP_SKILLS": "1", "DO_NOT_TRACK": "1"}
CENTER = {f"r{r}c{c}" for r in (1, 2) for c in (1, 2)}  # центр сетки 4x4


def hf(*args: str) -> dict:
    p = subprocess.run(["node", str(CLI), "measure", *args], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=ENV)
    out = p.stdout.strip()
    try:
        return json.loads(out[out.index("{"):])
    except (ValueError, json.JSONDecodeError):
        raise SystemExit(f"hyperframes measure {' '.join(args)} упал:\n{p.stdout}\n{p.stderr}")


def window(args) -> list[str]:
    w = []
    if args.start is not None:
        w.append(f"--start={args.start}")
    if args.end is not None:
        w.append(f"--end={args.end}")
    return w


def measure(video: str, tag: str, out: Path, args) -> dict:
    w = window(args)
    probe = hf("probe", video)
    cuts = hf("cuts", video, *w)
    evdir = out / f"_events_{tag}"
    ev = hf("events", "--map", f"--out={evdir}", video, *w)
    look = hf("look", video, *w)
    sheets_dir = out / f"_sheets_{tag}"
    fr = hf("frames", f"--every={args.sheet_every}", f"--out={sheets_dir}", video, *w)
    sheets = []
    for i, img in enumerate(fr.get("sheets", [])):
        img = Path(img)
        dst = out / f"sheet_{tag}_{i + 1}{img.suffix}"
        shutil.copy(img, dst)
        sheets.append(dst.name)
    if ev.get("strip") and Path(ev["strip"]).exists():
        shutil.copy(ev["strip"], out / f"events_{tag}.png")
    events = json.loads(Path(ev["file"]).read_text(encoding="utf-8"))["events"]
    shutil.rmtree(evdir, ignore_errors=True)
    shutil.rmtree(sheets_dir, ignore_errors=True)
    return {"probe": probe, "cuts": cuts, "events_summary": {k: ev.get(k) for k in ("counts", "shots", "holds", "sound")},
            "events": events, "look": look, "sheets": sheets, "stats": stats(probe, cuts, ev, events, args)}


def stats(probe, cuts, ev, events, args) -> dict:
    t0 = args.start or 0.0
    t1 = args.end if args.end is not None else probe["duration"]
    dur = max(0.001, t1 - t0)
    shots = [s["seconds"] for s in cuts.get("shots", [])]
    vis = sorted((e for e in events if e["type"] != "hold"), key=lambda e: e["t"])
    times = sorted({round(e["t"], 3) for e in vis})
    gaps = [(b - a, a) for a, b in zip([t0] + times, times + [t1])]
    big_gaps = sorted([(round(g, 2), round(a, 2)) for g, a in gaps if g >= 1.0], key=lambda x: -x[0])
    center = [e for e in vis if CENTER & set(e.get("cells", []))]
    ct = sorted({round(e["t"], 3) for e in center})
    cgaps = [b - a for a, b in zip([t0] + ct, ct + [t1])]
    # плотность по окнам 5 с
    bins = []
    b = t0
    while b < t1 - 0.01:
        e2 = min(t1, b + 5)
        n = sum(1 for t in times if b <= t < e2)
        bins.append({"from": round(b, 1), "to": round(e2, 1), "events": n, "per_s": round(n / (e2 - b), 2)})
        b = e2
    snd = ev.get("sound") or {}
    return {
        "duration": round(dur, 2),
        "size": f"{probe['width']}x{probe['height']}", "fps": probe["fps"], "audio": probe.get("audio"),
        "cuts": len(cuts.get("cuts", [])),
        "cuts_per_10s": round(len(cuts.get("cuts", [])) / dur * 10, 2),
        "shot_median_s": round(st.median(shots), 2) if shots else None,
        "shot_min_s": round(min(shots), 2) if shots else None,
        "shot_max_s": round(max(shots), 2) if shots else None,
        "events": len(vis), "events_per_s": round(len(vis) / dur, 2),
        "change_gap_median_s": round(st.median([g for g, _ in gaps]), 2) if gaps else None,
        "center_events_per_s": round(len(center) / dur, 2),
        "center_gap_median_s": round(st.median(cgaps), 2) if cgaps else None,
        "first_change_s": round(times[0] - t0, 2) if times else None,
        "events_first_3s": sum(1 for t in times if t < t0 + 3),
        "static_gaps_ge_1s": big_gaps[:12],
        "holds_ge_1s": [h for h in (ev.get("holds") or []) if h.get("seconds", 0) >= 1.0],
        "density_5s": bins,
        "sound_onsets_per_s": round(snd.get("onsets", 0) / dur, 2) if snd else None,
        "bpm": snd.get("bpm"),
    }


def fmt_bins(bins) -> str:
    mx = max([b["per_s"] for b in bins] + [0.01])
    return "\n".join(f"{b['from']:>5.1f}–{b['to']:<5.1f} {'█' * max(1, round(b['per_s'] / mx * 20)) if b['events'] else '·'} {b['per_s']}/с"
                     for b in bins)


ROWS = [
    ("Длительность, с", "duration"), ("Размер / fps", None), ("Склеек", "cuts"), ("Склеек на 10 с", "cuts_per_10s"),
    ("Медиана плана, с", "shot_median_s"), ("Самый длинный план, с", "shot_max_s"),
    ("Событий в кадре в секунду", "events_per_s"), ("Медиана паузы между изменениями, с", "change_gap_median_s"),
    ("Событий в ЦЕНТРЕ кадра в секунду", "center_events_per_s"), ("Медиана паузы в центре, с", "center_gap_median_s"),
    ("Первое изменение, с", "first_change_s"), ("Событий за первые 3 с", "events_first_3s"),
    ("Звуковых атак в секунду", "sound_onsets_per_s"),
]
LOOK = [("Яркость (0–255)", "luma"), ("Контраст", "contrast"), ("Насыщенность", "saturation"), ("Теплота (+тёпло/−холодно)", "warmth")]


def val(s, key, look=None):
    if key is None:
        return f"{s['size']} / {s['fps']}"
    v = (look or s).get(key)
    return "—" if v is None else v


def advice(r, o) -> list[str]:
    out = []
    def ratio(k):
        a, b = r.get(k), o.get(k)
        return (b / a) if a and b else None
    q = ratio("events_per_s")
    if q and q < 0.8:
        out.append(f"Темп ниже референса: изменений в секунду {o['events_per_s']} против {r['events_per_s']} — добавить движение (наезды, появления, смену планов).")
    elif q and q > 1.4:
        out.append(f"Темп выше референса ({o['events_per_s']} против {r['events_per_s']} событий/с) — проверить, не мельтешит ли.")
    q = ratio("center_gap_median_s")
    if q and q > 1.3:
        out.append(f"В центре кадра изменения реже: медиана паузы {o['center_gap_median_s']} с против {r['center_gap_median_s']} с — главный объект должен двигаться чаще.")
    if (o.get("first_change_s") or 0) > (r.get("first_change_s") or 0) + 0.3:
        out.append(f"Старт медленнее: первое изменение на {o['first_change_s']} с (у референса {r['first_change_s']} с).")
    if o.get("events_first_3s", 0) < 0.7 * r.get("events_first_3s", 0):
        out.append(f"Первые 3 с беднее: {o['events_first_3s']} событий против {r['events_first_3s']}.")
    if o["static_gaps_ge_1s"]:
        g = ", ".join(f"с {a} с — {d} с" for d, a in o["static_gaps_ge_1s"][:5])
        out.append(f"Застывшие куски ≥1 с у нас: {g}.")
    q = ratio("shot_median_s")
    if q and q > 1.5:
        out.append(f"Планы длиннее: медиана {o['shot_median_s']} с против {r['shot_median_s']} с — резать чаще или менять ракурс.")
    return out or ["По темпу и плотности близко к референсу."]


def recipe(res: dict, ref: str, ours: str | None) -> str:
    r = res["ref"]["stats"]
    L = [f"# Разбор референса: {Path(ref).name}", ""]
    if ours:
        L += [f"Сравнение с нашим: **{Path(ours).name}**", ""]
    L += ["## Цифры", "", "| Метрика | Референс" + (" | Наш |" if ours else " |"), "|---|---|" + ("---|" if ours else "")]
    for name, key in ROWS:
        row = f"| {name} | {val(r, key)}"
        if ours:
            row += f" | {val(res['ours']['stats'], key)}"
        L.append(row + " |")
    for name, key in LOOK:
        row = f"| {name} | {val(r, key, res['ref']['look'])}"
        if ours:
            row += f" | {val(res['ours']['stats'], key, res['ours']['look'])}"
        L.append(row + " |")
    L += ["", "## Плотность изменений по 5 с (референс)", "```", fmt_bins(r["density_5s"]), "```"]
    if ours:
        L += ["", "## Плотность изменений по 5 с (наш)", "```", fmt_bins(res["ours"]["stats"]["density_5s"]), "```"]
    L += ["", "## Планы референса", ""]
    L += [f"- {s['start']:.2f}–{s['end']:.2f} с ({s['seconds']} с)" for s in res["ref"]["cuts"].get("shots", [])]
    if r["static_gaps_ge_1s"]:
        L += ["", "Самые длинные паузы без изменений: " + ", ".join(f"с {a} с — {d} с" for d, a in r["static_gaps_ge_1s"][:8])]
    if ours:
        e = res.get("energy") or {}
        L += ["", "## Сравнение", ""]
        if e:
            L.append(f"- Количество движения: у нас ×{e.get('mean_ratio')} от референса (0.8–1.25 = столько же), пик ×{e.get('peak_ratio')}.")
        lk = res.get("look_compare") or {}
        if lk:
            L.append(f"- Свет и цвет, наш к референсу: яркость ×{lk.get('luma_ratio')}, контраст ×{lk.get('contrast_ratio')}, насыщенность ×{lk.get('saturation_ratio')}.")
        L += [f"- {a}" for a in advice(r, res["ours"]["stats"])]
    L += ["", "## Файлы", ""]
    L += [f"- {s}" for s in res["ref"]["sheets"]] + ["- events_ref.png — карта событий по сетке 4×4"]
    if ours:
        L += [f"- {s}" for s in res["ours"]["sheets"]] + ["- events_ours.png"]
    L += ["", "Как читать: «событие» — появление, исчезновение, изменение или склейка в одной из 16 клеток кадра (порог —",
          "средняя смена яркости 5). «Центр» — 4 центральные клетки: там должен двигаться главный объект.",
          "Плавные камеры внутри одного плана склейкой не считаются. Выводы по сюжету и приёмам — смотреть по листам кадров."]
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref")
    ap.add_argument("--ours")
    ap.add_argument("--out")
    ap.add_argument("--start", type=float)
    ap.add_argument("--end", type=float)
    ap.add_argument("--sheet-every", type=float, default=1.0)
    args = ap.parse_args()
    if not CLI.exists():
        sys.exit("Нет движка hyperframes. Установка: npm i --prefix ~/.claude/insta-kit/hf hyperframes@0.9.7 --ignore-scripts")
    out = Path(args.out or (Path(args.ref).with_suffix("").as_posix() + "_measure")).resolve()
    out.mkdir(parents=True, exist_ok=True)
    res = {"ref": measure(args.ref, "ref", out, args)}
    if args.ours:
        res["ours"] = measure(args.ours, "ours", out, args)
        ew = ["--seconds=" + str(min(res["ref"]["stats"]["duration"], res["ours"]["stats"]["duration"]))]
        if args.start is not None:
            ew.append(f"--start={args.start}")
        res["energy"] = hf("energy", args.ref, args.ours, *ew)
        res["look_compare"] = hf("look", args.ref, f"--compare={args.ours}", *window(args))
    (out / "measure.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "RECIPE.md").write_text(recipe(res, args.ref, args.ours), encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"Готово: {out / 'RECIPE.md'}")


if __name__ == "__main__":
    main()
