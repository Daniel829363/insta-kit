#!/usr/bin/env node
// remotion-check: предрендерная проверка композиции Remotion (идеи — HeyGen HyperFrames `hyperframes check`, Apache-2.0).
// Запуск: node check.mjs --project <dir> --comp <Id> [опции]. Справка: node check.mjs --help
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openComposition, findEntry } from './lib/remotion.mjs';
import { aggregateLayout, aggregateGhosts, analyzeCraft, aggregateContrast, aggregateFonts, clusterFindings, T } from './lib/analyze.mjs';
import { checkVideo } from './lib/video.mjs';
import { formatReport } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';

const HELP = `remotion-check ${VERSION} — предрендерная проверка Remotion-композиции

  node check.mjs --project <папка проекта> --comp <CompositionId> [опции]

  --props file.json          input props композиции
  --samples 0.25s | N        шаг выборки (по умолчанию 0.25s) или N равномерных кадров
  --from S --to S            ограничить диапазон (секунды)
  --reels-safe[=strict]      зоны интерфейса Instagram Reels (1080x1920): верх 220, низ 380, право 140 px
  --caption-zone x0,y0,x1,y1 своя зона (доли 0..1 или px)
  --video file.mp4           проверки готового MP4 (громкость, тишина, заморозка, первый кадр)
  --json out.json            JSON-отчёт
  --sheet out.jpg            контактный лист проблемных кадров
  --report out.txt           текстовый отчёт в файл
  --entry path               entry-файл (по умолчанию src/index.ts)
  --bundle dir               готовый bundle (иначе собирается во временную папку)
  --contrast-samples N       сколько кадров проверять на контраст/шрифты (по умолчанию 16)
  --no-contrast --no-fonts   отключить проверки
  --sheet-max N              макс. кадров в листе (по умолчанию 18)
  --no-cache                 не использовать кеш сборки webpack/rspack
  --quiet                    без прогресса
Код выхода: 1 если есть ошибки, иначе 0.`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const eq = t.indexOf('=');
    let k = eq > 0 ? t.slice(2, eq) : t.slice(2);
    let v = eq > 0 ? t.slice(eq + 1) : undefined;
    const bool = ['reels-safe', 'no-contrast', 'no-fonts', 'no-cache', 'quiet', 'help'];
    if (v === undefined && !bool.includes(k)) v = argv[++i];
    if (v === undefined) v = true;
    a[k] = v;
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.project || !args.comp) { console.log(HELP); process.exit(args.help ? 0 : 2); }

const t00 = Date.now();
const quiet = !!args.quiet;
const log = (m) => { if (!quiet) console.error(`[${((Date.now() - t00) / 1000).toFixed(1)}s] ${m}`); };
const projectDir = path.resolve(args.project);
const props = args.props ? JSON.parse(fs.readFileSync(path.resolve(args.props), 'utf8')) : {};

let comp;
try {
  comp = await openComposition({ projectDir, entry: findEntry(projectDir, args.entry), compId: args.comp, props, bundleDir: args.bundle ? path.resolve(args.bundle) : null, log, noCache: !!args['no-cache'] });
} catch (e) {
  let m = String(e && e.message ? e.message : e);
  const mm = /Could not find composition with ID (\S+)\. Available compositions: (.*)$/.exec(m);
  if (mm) m = `Композиция «${mm[1]}» не найдена. Доступные: ${mm[2]}`;
  console.error('Не удалось открыть композицию: ' + m);
  process.exit(3);
}

const meta = comp.composition;
const W = meta.width, H = meta.height, fps = meta.fps, durFrames = meta.durationInFrames;
const duration = durFrames / fps;
const canvas = { width: W, height: H, fps };
log(`Композиция ${meta.id}: ${W}x${H}, ${fps} fps, ${duration.toFixed(2)} с (${durFrames} кадров)`);

// --- injected script ---
await comp.run(fs.readFileSync(path.join(HERE, 'lib', 'page-audit.js'), 'utf8'));

// --- зоны ---
const zones = [];
if (args['reels-safe']) {
  const strict = args['reels-safe'] === 'strict';
  const sx = W / 1080, sy = H / 1920;
  const top = (strict ? 270 : 220) * sy, bottom = (strict ? 670 : 380) * sy, right = (strict ? 65 : 140) * sx;
  zones.push({ name: 'верхняя панель Reels', x0: 0, y0: 0, x1: W, y1: top });
  zones.push({ name: 'нижняя подпись/кнопки Reels', x0: 0, y0: H - bottom, x1: W, y1: H });
  zones.push({ name: 'правая колонка кнопок Reels', x0: W - right, y0: top, x1: W, y1: H - bottom });
}
if (args['caption-zone'] && args['caption-zone'] !== true) {
  const p = String(args['caption-zone']).split(',').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) { console.error('--caption-zone: ожидается x0,y0,x1,y1'); process.exit(2); }
  const frac = p.every((v) => v <= 1);
  zones.push({ name: 'заданная зона', x0: frac ? p[0] * W : p[0], y0: frac ? p[1] * H : p[1], x1: frac ? p[2] * W : p[2], y1: frac ? p[3] * H : p[3] });
}

// --- времена сэмплов ---
const from = args.from != null ? Number(args.from) : 0;
const to = args.to != null ? Math.min(Number(args.to), duration) : duration;
let step = 0.25;
let times = [];
const sv = args.samples != null ? String(args.samples) : '0.25s';
if (/s$/.test(sv)) {
  step = Number(sv.slice(0, -1));
  for (let t = from; t < to - 1e-6; t += step) times.push(Math.round(t * 1000) / 1000);
} else {
  const n = Math.max(1, Math.floor(Number(sv)));
  step = (to - from) / n;
  for (let i = 0; i < n; i++) times.push(Math.round((from + (i + 0.5) * step) * 1000) / 1000);
}
if (from === 0 && times[0] !== 0) times.unshift(0);
const lastT = Math.max(0, (Math.min(durFrames - 1, Math.round(to * fps) - 1)) / fps);
if (times[times.length - 1] < lastT - step / 2) times.push(lastT);
const frameOf = (t) => Math.min(durFrames - 1, Math.max(0, Math.round(t * fps)));
// уникальные кадры
const seenF = new Set();
times = times.filter((t) => { const f = frameOf(t); if (seenF.has(f)) return false; seenF.add(f); return true; });
const multi = times.length > 1;
log(`Сэмплов: ${times.length} (шаг ~${step}s), зоны: ${zones.length}`);

const TW = 135, TH = Math.round((135 * H) / W);
const decodeB64 = (b) => Uint8Array.from(Buffer.from(b, 'base64'));

async function craftAt(t) {
  await comp.seek(frameOf(t));
  return comp.run(`window.__rc.craft(${JSON.stringify({ canvasW: W, canvasH: H })})`);
}

// --- основной проход ---
let domReady = false;
const fontSeen = new Set();
const toolErrors = [];
const samples = [];
const contrastIdx = new Set();
const nC = Math.min(times.length, Number(args['contrast-samples'] ?? 16));
for (let i = 0; i < nC; i++) contrastIdx.add(Math.round((i * (times.length - 1)) / Math.max(1, nC - 1)));
const contrastEntries = [];
const fontEntries = [];
let soundSources = 0;
let prevThumb = null;
const tPass = Date.now();
for (let i = 0; i < times.length; i++) {
  const t = times[i];
  const frame = frameOf(t);
  await comp.seek(frame);
  const layout = await comp.run(`window.__rc.layout(${JSON.stringify({ zones, canvasW: W, canvasH: H })})`);
  const craft = await comp.run(`window.__rc.craft(${JSON.stringify({ canvasW: W, canvasH: H })})`);
  soundSources = Math.max(soundSources, craft.sound || 0);
  // миниатюра для измерения движения
  const jpg = await comp.screenshot({ format: 'jpeg', quality: 40, scale: TW / W });
  const thumb64 = await comp.run(`window.__rc.thumb('data:image/jpeg;base64,${jpg}', ${TW}, ${TH})`);
  const thumb = decodeB64(thumb64);
  let sum = 0, sum2 = 0;
  for (const v of thumb) { sum += v; sum2 += v * v; }
  const mean = sum / thumb.length;
  const thumbStd = Math.sqrt(Math.max(0, sum2 / thumb.length - mean * mean));
  const s = { time: t, frame, layout, parts: craft.parts, painted: craft.painted, thumbStd, diffNext: null };
  if (prevThumb) {
    let changed = 0, dsum = 0;
    for (let k = 0; k < thumb.length; k++) { const d = Math.abs(thumb[k] - prevThumb.thumb[k]); dsum += d; if (d > 12) changed++; }
    const frac = changed / thumb.length, md = dsum / thumb.length;
    prevThumb.s.diffNext = { frac, md, still: frac < 0.0015 && md < 0.35 };
  }
  prevThumb = { thumb, s };
  samples.push(s);

  // контраст
  if (!args['no-contrast'] && contrastIdx.has(i)) {
    try {
      const cand = await comp.run('window.__rc.contrastPrepare()');
      const shot = await comp.screenshot({ format: 'png' });
      await comp.run('window.__rc.contrastRestore()');
      if (cand.length) {
        const bgs = await comp.run(`window.__rc.sampleBg('data:image/png;base64,${shot}', ${JSON.stringify(cand.map((c) => c.bbox))})`);
        cand.forEach((c, k) => {
          const bg = bgs[k] || (c.ownBg ? c.ownBg.slice(0, 3) : null);
          if (!bg) return;
          const ownBg = c.ownBg && c.ownBg[3] >= 0.99 ? c.ownBg.slice(0, 3) : bg;
          const a = c.fg[3];
          const comp3 = [0, 1, 2].map((ch) => Math.round(c.fg[ch] * a + ownBg[ch] * (1 - a)));
          let ratio = ratioOf(comp3, ownBg);
          let usedStroke = false;
          if (c.stroke) { const sa = c.stroke[3]; const sc = [0, 1, 2].map((ch) => Math.round(c.stroke[ch] * sa + ownBg[ch] * (1 - sa))); const r2s = ratioOf(sc, ownBg); if (r2s > ratio) { ratio = r2s; usedStroke = true; } }
          const required = c.large ? T.contrastLarge : T.contrastAA;
          contrastEntries.push({ time: t, sel: c.sel, text: c.text, ratio, required, fgRgb: comp3, bg: ownBg, large: c.large, shadow: c.shadow, rect: { left: c.bbox.x, top: c.bbox.y, right: c.bbox.x + c.bbox.w, bottom: c.bbox.y + c.bbox.h, width: c.bbox.w, height: c.bbox.h } });
        });
      }
    } catch (e) {
      try { await comp.run('window.__rc.contrastRestore()'); } catch { /* ignore */ }
      log('контраст: ' + e.message); toolErrors.push('Проверка контраста: ' + e.message);
    }
  }
  // шрифты
  if (!args['no-fonts']) {
    try { await fontsAt(t, fontEntries); } catch (e) { log('шрифты: ' + e.message); if (!toolErrors.some((x) => x.startsWith('Проверка шрифтов'))) toolErrors.push('Проверка шрифтов: ' + e.message); }
  }
  if (!quiet && (i % 20 === 0 || i === times.length - 1)) log(`кадр ${i + 1}/${times.length} (t=${t.toFixed(2)} с)`);
}
const passSec = (Date.now() - tPass) / 1000;

function ratioOf(a, b) {
  const l = (c) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const x = l(a), y = l(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

async function fontsAt(t, sink) {
  const marks = await comp.run('window.__rc.fontsMark()');
  try {
    if (!domReady) { await comp.cdp('DOM.enable'); await comp.cdp('CSS.enable'); domReady = true; }
    const doc = await comp.cdp('DOM.getDocument', { depth: 0 });
    const rootId = doc.root.nodeId;
    // кеш по (family|weight|style|text) чтобы не гонять одно и то же
    for (const m of marks) {
      const key = [m.family, m.weight, m.style, m.text].join('|');
      if (fontSeen.has(key)) continue;
      fontSeen.add(key);
      const q = await comp.cdp('DOM.querySelector', { nodeId: rootId, selector: `[data-rc-font="${m.n}"]` });
      if (!q.nodeId) continue;
      const pf = await comp.cdp('CSS.getPlatformFontsForNode', { nodeId: q.nodeId });
      const fonts = (pf.fonts || []).map((f) => ({ familyName: f.familyName, isCustomFont: f.isCustomFont, glyphCount: f.glyphCount }));
      const entry = { time: t, sel: m.sel, text: m.text, family: m.family, weight: m.weight, usedFonts: fonts, missing: '' };
      const wantF = m.family.toLowerCase();
      const prim = fonts.filter((f) => { const n = f.familyName.toLowerCase(); return n === wantF || n.startsWith(wantF + ' '); }).reduce((s, f) => s + f.glyphCount, 0);
      const total = fonts.filter((f) => !/emoji|symbol/i.test(f.familyName)).reduce((s, f) => s + f.glyphCount, 0);
      if (total && prim < total) entry.missing = await comp.run(`window.__rc.missingChars(${JSON.stringify(m.text)}, ${JSON.stringify(m.family)}, ${JSON.stringify(m.weight)}, ${JSON.stringify(m.style)})`);
      sink.push(entry);
    }
  } finally {
    await comp.run('window.__rc.fontsUnmark()');
  }
}

// --- анализ ---
log('Анализ...');
const findings = [];
findings.push(...aggregateLayout(samples.map((s) => ({ time: s.time, issues: s.layout.issues })), step, canvas, multi));
findings.push(...aggregateGhosts(samples.map((s) => ({ time: s.time, layout: s.layout })), step));

const craftFrames = samples.map((s) => ({ time: s.time, parts: s.parts, painted: s.painted, thumbStd: s.thumbStd, diffNext: s.diffNext }));
const craft = await analyzeCraft({
  frames: craftFrames, duration: Math.min(duration, to), canvas, step, partialStart: from > 0.001, partialEnd: to < duration - 0.001,
  probe: async (t) => craftAt(t),
});
findings.push(...craft.findings);
findings.push(...aggregateContrast(contrastEntries, new Set(contrastEntries.map((e) => e.time)).size || nC));
findings.push(...aggregateFonts(fontEntries));

// Ресурсы / ошибки консоли
const netSeen = new Set();
for (const n of comp.netErrors) {
  const k = n.url + n.error;
  if (netSeen.has(k)) continue;
  netSeen.add(k);
  if (/favicon/i.test(n.url) || n.url === '?' || /ERR_CACHE_MISS|ERR_ABORTED/.test(n.error)) continue;
  findings.push({ code: 'missing_asset', severity: 'error', time: 0, timeEnd: 0, text: '', selector: '', rect: null,
    message: `Не загрузился ресурс: ${decodeURIComponent(n.url).replace(/^https?:\/\/[^/]+/, '')} (${n.error}).`,
    value: n.error, threshold: 'все ресурсы загружаются без ошибок',
    fix: 'Проверьте путь в staticFile()/import и что файл лежит в public/; имена чувствительны к регистру и кириллице.' });
}
const consoleSeen = new Set();
for (const c of comp.consoleEvents) {
  if (c.type !== 'error' && c.type !== 'assert') continue;
  const k = c.text.slice(0, 160);
  if (consoleSeen.has(k)) continue;
  consoleSeen.add(k);
  if (/Failed to load resource/.test(c.text) && comp.netErrors.length) continue; // уже учтено как missing_asset
  findings.push({ code: 'console_error', severity: 'error', time: 0, timeEnd: 0, text: '', selector: '', rect: null,
    message: `Ошибка в консоли браузера: ${c.text.slice(0, 220)}`, value: c.text.slice(0, 120), threshold: 'нет ошибок в консоли',
    fix: 'Откройте композицию в Remotion Studio и посмотрите стек ошибки (console).' });
}
for (const e of comp.pageErrors) {
  findings.push({ code: 'console_error', severity: 'error', time: 0, timeEnd: 0, text: '', selector: '', rect: null,
    message: `Необработанное исключение на странице: ${String(e).slice(0, 220)}`, value: String(e).slice(0, 120), threshold: 'нет исключений',
    fix: 'Исправьте исключение: оно может ломать рендер части кадров.' });
}

// DOM-звук (информативно, если нет --video)
let video = null;
if (args.video && args.video !== true) {
  log('Проверка MP4 (ffmpeg)...');
  try {
    video = checkVideo(path.resolve(args.video));
    findings.push(...video.findings);
  } catch (e) { findings.push({ code: 'video_check_failed', severity: 'warning', time: 0, timeEnd: 0, text: '', selector: '', rect: null, message: 'Не удалось проверить MP4: ' + e.message, value: '', threshold: '', fix: '' }); }
} else if (soundSources === 0 && duration > T.silentFilmSec) {
  findings.push({ code: 'film_silent', severity: 'info', time: 0, timeEnd: 0, text: '', selector: '', rect: null,
    message: `В композиции (${Math.round(duration)} с) не найдено <audio>/<video> в DOM. Если звук подмешивается снаружи (ffmpeg) — всё в порядке.`,
    value: 'нет аудио-элементов', threshold: 'ролик > 15 с должен иметь звук',
    fix: 'Передайте --video готовый.mp4 — тишина будет проверена по настоящей дорожке.' });
}

// --- кластеризация ---
const rawCount = findings.length;
const clustered = clusterFindings(findings);
findings.length = 0;
findings.push(...clustered);
// --- сортировка ---
const rank = { error: 0, warning: 1, info: 2 };
findings.sort((a, b) => rank[a.severity] - rank[b.severity] || a.time - b.time);
const counts = { error: 0, warning: 0, info: 0 };
for (const f of findings) counts[f.severity]++;

// --- контактный лист ---
let sheetInfo = null;
if (args.sheet && args.sheet !== true) {
  log('Контактный лист...');
  try { sheetInfo = await buildSheet(path.resolve(args.sheet)); } catch (e) { log('лист: ' + e.message); }
}

async function buildSheet(outFile) {
  const max = Number(args['sheet-max'] ?? 18);
  const flat = findings.flatMap((f) => (f.items ? f.items : [f]));
  const withTime = flat.filter((f) => f.severity !== 'info' && f.source !== 'video' && (f.rect || f.code === 'first_frame_empty' || f.code === 'dead_stretch'));
  // группируем по ближайшему сэмплу
  const tiles = new Map();
  for (const f of withTime) {
    const tt = f.at ?? f.time;
    const sm = samples.reduce((b, s) => (Math.abs(s.time - tt) < Math.abs(b.time - tt) ? s : b), samples[0]);
    const k = sm.frame;
    const tile = tiles.get(k) ?? { frame: k, time: sm.time, items: [], sev: 'warning' };
    tile.items.push(f);
    if (f.severity === 'error') tile.sev = 'error';
    tiles.set(k, tile);
  }
  // выбираем кадры по кругу между типами находок, чтобы лист не забивался одним кодом (например, line_unread)
  const tl = [...tiles.values()];
  const byCode = new Map();
  for (const t of tl.sort((x, y) => (x.sev === y.sev ? x.time - y.time : x.sev === 'error' ? -1 : 1))) {
    for (const c of new Set(t.items.map((f) => f.code))) (byCode.get(c) ?? byCode.set(c, []).get(c)).push(t);
  }
  const order = [...byCode.entries()].sort((a, b) => (a[1].some((t) => t.sev === 'error') ? 0 : 1) - (b[1].some((t) => t.sev === 'error') ? 0 : 1));
  const chosen = new Set();
  for (let round = 0; chosen.size < max && round < 50; round++) {
    for (const [, arr] of order) { const t = arr[round]; if (t && chosen.size < max) chosen.add(t); }
  }
  let list = [...chosen].sort((a, b) => a.time - b.time);
  if (!list.length) return null;
  const out = [];
  const SC = 0.3;
  for (const tl of list) {
    await comp.seek(tl.frame);
    const boxes = tl.items.filter((f) => f.rect).map((f) => ({ x: f.rect.left, y: f.rect.top, w: f.rect.width, h: f.rect.height }));
    // для text_box_overflow рисуем и контейнер? — только сам текст
    if (boxes.length) await comp.run(`window.__rc.overlay(${JSON.stringify(boxes)})`);
    const data = await comp.screenshot({ format: 'jpeg', quality: 70, scale: SC });
    await comp.run('window.__rc.overlayClear()');
    const codes = [...new Set(tl.items.map((f) => f.code))];
    out.push({ data, sev: tl.sev, label1: `t=${tl.time.toFixed(2)} с · кадр ${tl.frame}`, label2: codes.join(', ').slice(0, 60), label3: (tl.items[0].text || '').slice(0, 44) });
  }
  const tw = Math.round(W * SC), th = Math.round(H * SC);
  const cols = Math.min(out.length, W >= H ? 3 : 6);
  const b64 = await comp.run(`window.__rc.sheet(${JSON.stringify(out)}, ${tw}, ${th}, ${cols})`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
  return { file: outFile, tiles: out.length, frames: list.map((l) => l.frame) };
}

await comp.close();

const meta2 = {
  tool: 'remotion-check', version: VERSION, project: projectDir, composition: meta.id,
  canvas: { width: W, height: H, fps, durationSec: r(duration), durationFrames: durFrames },
  remotion: comp.version,
  samples: { count: times.length, stepSec: step, from, to: r(to), passSeconds: r(passSec), totalSeconds: r((Date.now() - t00) / 1000) },
  zones, reelsSafe: !!args['reels-safe'],
  counts, video: video ? { file: video.file, metrics: video.metrics } : null,
  sheet: sheetInfo,
  toolErrors,
};
function r(v) { return Math.round(v * 100) / 100; }

const report = formatReport({ meta: meta2, findings, args });
if (!quiet || true) console.log(report);
if (args.report && args.report !== true) { fs.mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true }); fs.writeFileSync(path.resolve(args.report), report, 'utf8'); }
if (args.json && args.json !== true) {
  fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
  fs.writeFileSync(path.resolve(args.json), JSON.stringify({ ...meta2, findings: findings.map(({ times, ...f }) => ({ ...f, times: times?.slice(0, 40) })) }, null, 2), 'utf8');
}
process.exit(counts.error > 0 ? 1 : 0);
