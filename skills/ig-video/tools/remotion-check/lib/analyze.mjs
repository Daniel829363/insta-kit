// Агрегация сэмплов: персистентность, line_unread, dead_stretch, контраст, шрифты.
// Пороги из HyperFrames (craftAudit.ts, layoutAudit.ts, contrast-bg.ts) — Apache-2.0, см. NOTICE.

export const T = {
  readHeightAt1080: 30,
  readOpacity: 0.5,
  shortLineWords: 2,
  shortLineFloorSec: 0.4,
  holdBaseSec: 0.5,
  holdPerWordSec: 0.3,
  holdFloorFraction: 0.75,
  finalLineFloorSec: 2,
  deadStretchSec: 3,
  endCardSec: 3,
  typeFloorFraction: 0.026,
  typeFloorHoldSec: 0.5,
  silentFilmSec: 15,
  measureToleranceSec: 1 / 30,
  refineSteps: 4,
  maxRefinedLines: 24,
  heldErrorSec: 0.4, // персистентность: ≥ 0.4 с подряд => ошибка (в HF: ≥2 соседних сэмпла)
  overlapHeldSec: 0.5, // content_overlap: ≥ 500 мс (как в HF)
  contrastAA: 4.5,
  contrastLarge: 3,
};

const r2 = (v) => Math.round(v * 100) / 100;
const q = (t, n = 50) => '«' + (t.length > n ? t.slice(0, n - 1) + '…' : t) + '»';
const fmtT = (a, b) => (b - a > 0.001 ? `${a.toFixed(2)}–${b.toFixed(2)} с` : `${a.toFixed(2)} с`);

// ---------------------------------------------------------------------------
// Персистентность layout-проблем (collapseStaticLayoutIssues + applyPersistenceTier)
// ---------------------------------------------------------------------------
function runsOf(times, step) {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  const gap = Math.max(1.0, step * 2.01);
  const runs = [];
  let cur = [];
  for (const t of sorted) {
    if (cur.length && t - cur[cur.length - 1] > gap) { runs.push(cur); cur = []; }
    cur.push(t);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

export function aggregateLayout(samples, step, canvas, multi) {
  // samples: [{time, issues:[...]}]
  const groups = new Map();
  for (const s of samples) {
    for (const is of s.issues) {
      const key = [is.code, is.text ?? '', is.sel ?? '', is.text2 ?? '', is.sel2 ?? '', is.zone ?? ''].join('|');
      let g = groups.get(key);
      if (!g) { g = { first: is, occ: [] }; groups.set(key, g); }
      g.occ.push({ time: s.time, issue: is });
    }
  }
  const short = Math.min(canvas.width, canvas.height);
  const findings = [];
  for (const g of groups.values()) {
    const times = g.occ.map((o) => o.time);
    const runs = runsOf(times, step);
    const longest = runs.reduce((b, r) => (r[r.length - 1] - r[0] > b[b.length - 1] - b[0] ? r : b), runs[0]);
    const held = longest[longest.length - 1] - longest[0] + step;
    const nSamples = times.length;
    const mid = longest[Math.floor(longest.length / 2)];
    const rep = g.occ.find((o) => o.time === mid).issue;
    const f = buildLayoutFinding(g.first.code, rep, { held, nSamples, times, longest, canvas, short, multi, step });
    if (f) {
      // текст внутри SVG-иллюстрации: наложения/выезды за кадр создаёт камера и слои сцены — чаще намеренно, поэтому не выше «предупреждения»
      if (rep.svg && f.severity === 'error') {
        f.severity = 'warning';
        f.message += ' (Текст внутри SVG-иллюстрации: камера и слои сцены часто создают такие наложения намеренно, поэтому уровень снижен до «предупреждения».)';
      }
      findings.push(f);
    }
  }
  return findings;
}

function overflowText(ov) {
  const names = { left: 'слева', right: 'справа', top: 'сверху', bottom: 'снизу' };
  return Object.entries(ov).map(([k, v]) => `${names[k]} ${Math.round(v)} px`).join(', ');
}
const maxOv = (ov) => Math.max(...Object.values(ov));

function buildLayoutFinding(code, is, ctx) {
  const { held, nSamples, longest, canvas, short, multi } = ctx;
  const t0 = longest[0], t1 = longest[longest.length - 1] + (nSamples > 1 ? 0 : 0);
  const heldOk = !multi ? true : held >= T.heldErrorSec && longest.length >= 2;
  const base = {
    code, text: is.text, selector: is.sel, rect: is.rect, time: t0, timeEnd: t1, at: longest[Math.floor(longest.length / 2)],
    held: r2(held), samples: nSamples, times: ctx.times,
  };
  const tierErr = (sev) => (multi && !heldOk ? 'info' : sev);
  const singleNote = multi && !heldOk ? ' Замечено только в одном сэмпле (≈ переход/анимация), поэтому уровень снижен до «инфо».' : '';
  switch (code) {
    case 'text_box_overflow': {
      const h = is.hint;
      const fix = [];
      if (h.horizontal) fix.push(`расширьте контейнер минимум до ~${h.needW} px`);
      if (h.vertical) fix.push(`увеличьте высоту контейнера минимум до ~${h.needH} px`);
      if (h.targetFont) fix.push(`или уменьшите шрифт с ${h.fontSize} до ~${h.targetFont} px`);
      fix.push('или разрешите перенос строк (max-width, fitText)');
      return { ...base, severity: tierErr('error'),
        message: `Текст ${q(is.text)} выходит за свой контейнер (${is.containerSel}) — ${overflowText(is.overflow)}.${singleNote}`,
        value: `текст ${h.textW}×${h.textH} px в контейнере ${h.contW}×${h.contH} px, выход до ${Math.round(maxOv(is.overflow))} px`,
        threshold: 'допуск 2 px', fix: fix.join('; ') + '.' };
    }
    case 'clipped_text': {
      const h = is.hint;
      return { ...base, severity: tierErr('error'),
        message: `Текст ${q(is.text)} обрезан границами собственного блока (overflow:hidden) — ${overflowText(is.overflow)}.${singleNote}`,
        value: `scroll больше клиентского размера на ${Math.round(maxOv(is.overflow))} px`, threshold: 'допуск 2 px',
        fix: `Увеличьте блок (минимум ~${h.needW}×${h.needH} px) или уменьшите шрифт/уберите overflow:hidden.` };
    }
    case 'canvas_overflow': {
      const breach = maxOv(is.overflow);
      let sev = 'info';
      if (multi && heldOk && is.visibleShare > 0) {
        if (breach >= short * 0.05 && held >= 1) sev = 'error';
        else if (breach >= 10) sev = 'warning';
      }
      if (!multi) sev = 'warning';
      return { ...base, severity: sev,
        message: `Текст ${q(is.text)} выходит за границу кадра — ${overflowText(is.overflow)}.${sev === 'info' ? ' Кратковременно/мелко — вероятно, въезд или выезд анимации.' : ''}`,
        value: `выход ${Math.round(breach)} px (${r2((breach / short) * 100)}% короткой стороны), держится ${held.toFixed(2)} с`,
        threshold: 'допуск 2 px; предупреждение: выход ≥ 10 px и ≥ 0.4 с; ошибка: ≥ 5% короткой стороны и ≥ 1 с',
        fix: 'Сдвиньте текст внутрь кадра, уменьшите шрифт или ограничьте ширину; для намеренного выезда добавьте атрибут data-layout-allow-overflow на элемент.' };
    }
    case 'text_at_edge':
      return { ...base, severity: multi && !heldOk ? 'info' : 'warning',
        message: `Текст ${q(is.text)} вплотную прилегает к краю кадра (${is.edges.join(', ')}).`,
        value: 'отступ от края ≤ 2 px', threshold: 'отступ > 2 px (рекомендуется ≥ 5% короткой стороны)',
        fix: 'Добавьте внутренние поля (padding) или сдвиньте блок от края.' };
    case 'container_overflow':
      return { ...base, severity: multi && !heldOk ? 'info' : 'warning',
        message: `Элемент ${q(is.text, 40)} выходит за границы клипующего контейнера (${is.containerSel}) — ${overflowText(is.overflow)}.`,
        value: `выход до ${Math.round(maxOv(is.overflow))} px`, threshold: 'допуск 2 px',
        fix: 'Измените размер/позицию дочернего элемента или контейнера; для намеренной маски-анимации добавьте data-layout-allow-overflow.' };
    case 'content_overlap': {
      const held2 = held >= T.overlapHeldSec && longest.length >= 2;
      // «ошибка» только для HTML-текстов с сильным (≥ 50%) и устойчивым наложением; SVG-сцены и «кучи» — предупреждение
      const strong = held2 && is.share >= 0.5 && !is.svg;
      return { ...base, severity: multi ? (strong ? 'error' : held2 ? 'warning' : 'info') : 'warning', text2: is.text2,
        message: `Два текста накладываются друг на друга: ${q(is.text, 30)} и ${q(is.text2, 30)} (пересечение ${Math.round(is.share * 100)}% меньшего блока).${multi && !held2 ? singleNote : ''}`,
        value: `перекрытие ${Math.round(is.share * 100)}%, держится ${held.toFixed(2)} с`, threshold: 'перекрытие > 20% меньшего блока ≥ 0.5 с — предупреждение; ошибка: ≥ 50% и оба текста HTML (не SVG)',
        fix: 'Разнесите блоки по зонам, уберите один из них на время другого; для намеренного наложения (водяной знак, «куча» пузырей) добавьте data-layout-allow-overlap.' };
    }
    case 'text_occluded': {
      const cv = is.coveredFraction;
      const baseSev = cv >= 0.5 && !is.occluderSvg && !is.svg ? 'error' : cv >= 0.1 ? 'warning' : 'info';
      const sev = multi && !heldOk ? 'info' : baseSev;
      return { ...base, severity: sev,
        message: `Текст ${q(is.text)} перекрыт непрозрачным элементом <${is.occluderTag}> (${is.occluderSel}) — закрыто ${Math.round(cv * 100)}%.${sev === 'info' && cv >= 0.1 ? singleNote : ''}${cv < 0.5 ? ' Частичное перекрытие — чаще всего это намеренная «глубина» слоёв.' : ''}`,
        value: `закрыто ${Math.round(cv * 100)}% точек сетки`, threshold: 'ошибка: ≥ 50% и перекрывает HTML-элемент; предупреждение: ≥ 10% (или SVG-слой); инфо: < 10% (HyperFrames: любая точка у короткой подписи)',
        fix: 'Поднимите текст выше по z-index/порядку слоёв, дайте ему свою зону или сдвиньте перекрывающий элемент; намеренное — data-layout-allow-occlusion.' };
    }
    case 'text_not_painted':
      return { ...base, severity: 'error',
        message: `Текст ${q(is.text)} не отрисован: заливка прозрачная (color / -webkit-text-fill-color).`,
        value: 'alpha заливки ≤ 0.05', threshold: 'alpha > 0.05',
        fix: 'Задайте непрозрачный color; для градиентного текста добавьте background-clip: text.' };
    case 'safe_zone': {
      const sev = multi && !heldOk ? 'info' : 'warning';
      return { ...base, severity: sev, zone: is.zone,
        message: `Текст ${q(is.text)} попадает в зону «${is.zone}» (${Math.round(is.share * 100)}% блока внутри), которую перекроет интерфейс.`,
        value: `внутри зоны ${Math.round(is.share * 100)}% площади текста, ${held.toFixed(2)} с`, threshold: '≥ 25% площади текста',
        fix: `Поднимите/сдвиньте текст из зоны ${is.hint.zone ? `(x ${Math.round(is.hint.zone.x0)}–${Math.round(is.hint.zone.x1)}, y ${Math.round(is.hint.zone.y0)}–${Math.round(is.hint.zone.y1)} px)` : ''}; намеренные нижние титры помечайте data-layout-allow-caption-zone.` };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Призрачный текст: смонтирован, но ни разу не был виден
// ---------------------------------------------------------------------------
export function aggregateGhosts(samples, step) {
  const m = new Map();
  for (const s of samples) {
    const seenNow = new Set();
    for (const g of s.layout.ghosts) {
      const k = g.id;
      let e = m.get(k);
      if (!e) { e = { ...g, mounted: [], visible: 0 }; m.set(k, e); }
      e.mounted.push(s.time);
      seenNow.add(k);
    }
    // видимые текстовые элементы определяем по id из issues? — нет, считаем по отдельной карте visibleIds
    for (const id of s.layout.visibleIds || []) {
      const e = m.get(id);
      if (e) e.visible++;
    }
  }
  const out = [];
  for (const e of m.values()) {
    if (e.visible > 0) continue;
    const span = e.mounted[e.mounted.length - 1] - e.mounted[0] + step;
    if (e.mounted.length < 4 || span < 1) continue;
    const why = { opacity: 'opacity ≈ 0', size: 'нулевой размер', offcanvas: 'целиком за пределами кадра', clip: 'скрыт clip-path' }[e.reason] || e.reason;
    const strong = (e.reason === 'opacity' || e.reason === 'size') && span >= 3;
    out.push({ code: 'text_not_painted_ghost', severity: strong ? 'warning' : 'info', reason: e.reason, text: e.text, selector: e.sel, time: e.mounted[0], timeEnd: e.mounted[e.mounted.length - 1],
      message: `Текст ${q(e.text)} есть в DOM ${span.toFixed(1)} с, но ни разу не виден (${why}).`,
      value: `${e.mounted.length} сэмплов без видимости`, threshold: 'виден хотя бы в одном сэмпле',
      fix: 'Проверьте анимацию появления (opacity/scale/позиция): текст, видимый по CSS, но не нарисованный, обычно означает сломанный interpolate() или неверный Sequence.' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CRAFT: line_unread, text_below_floor, first_frame_empty, dead_stretch
// ---------------------------------------------------------------------------
const WORD_RUNS = /[\p{L}\p{M}\p{N}%$]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu;
const SEG = new Intl.Segmenter('ja', { granularity: 'word' });
export function readingWords(text) {
  const runs = text.toLowerCase().normalize('NFC').match(WORD_RUNS) ?? [];
  return runs.reduce((n, run) => n + Math.max(1, [...SEG.segment(run)].filter((s) => s.isWordLike).length), 0);
}
const lineTarget = (w) => T.holdBaseSec + T.holdPerWordSec * w;
const lineFloor = (w, final) => {
  const f = w <= T.shortLineWords ? T.shortLineFloorSec : T.holdFloorFraction * lineTarget(w);
  return final ? Math.max(f, T.finalLineFloorSec) : f;
};

function readableBlocks(parts, readHeight) {
  const blocks = new Map();
  for (const p of parts) {
    if (p.opacity < T.readOpacity) continue;
    const rect = { left: p.rect.left, top: p.rect.top, right: p.rect.left + p.rect.width, bottom: p.rect.top + p.rect.height };
    const b = blocks.get(p.block);
    if (!b) { blocks.set(p.block, { text: p.blockText, rect, sel: p.blockSel, fontPx: p.fontPx }); continue; }
    b.rect = { left: Math.min(b.rect.left, rect.left), top: Math.min(b.rect.top, rect.top), right: Math.max(b.rect.right, rect.right), bottom: Math.max(b.rect.bottom, rect.bottom) };
    b.fontPx = Math.max(b.fontPx, p.fontPx);
  }
  for (const [k, b] of blocks) if (b.rect.bottom - b.rect.top < readHeight) blocks.delete(k);
  return blocks;
}
function indexRuns(idx) {
  const s = [...idx].sort((a, b) => a - b);
  const runs = [];
  for (const i of s) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
  }
  return runs;
}
const winSec = (w) => (w.endIn + w.endOut) / 2 - (w.startOut + w.startIn) / 2;

export async function analyzeCraft({ frames, duration, canvas, probe, step, partialStart = false, partialEnd = false }) {
  const findings = [];
  const notes = [];
  const readHeight = T.readHeightAt1080 * (Math.min(canvas.width, canvas.height) / 1080);

  // --- дорожки блоков ---
  const tracks = new Map();
  frames.forEach((f, i) => {
    for (const [key, b] of readableBlocks(f.parts, readHeight)) {
      const tr = tracks.get(key) ?? { key, sel: b.sel, seen: new Map() };
      tr.seen.set(i, { text: b.text, rect: b.rect, fontPx: b.fontPx });
      tracks.set(key, tr);
    }
  });
  const timeAt = (i) => frames[Math.min(Math.max(i, 0), frames.length - 1)].time;
  const lastEnd = (tr) => Math.max(...tr.seen.keys());
  const latest = Math.max(-1, ...[...tracks.values()].map(lastEnd));
  const windowFor = ([first, last]) => {
    const reachesEnd = last === frames.length - 1;
    return { startOut: timeAt(first - 1), startIn: timeAt(first), endIn: reachesEnd ? duration : timeAt(last), endOut: reachesEnd ? duration : timeAt(last + 1) };
  };
  let cands = [];
  for (const tr of tracks.values()) {
    const runs = indexRuns([...tr.seen.keys()]);
    const finalLine = !partialEnd && lastEnd(tr) === latest;
    if ((partialEnd && lastEnd(tr) === frames.length - 1) || (partialStart && tr.seen.has(0))) continue;
    const wins = runs.map(windowFor);
    const chosen = finalLine ? wins.length - 1 : wins.reduce((b, w, i) => (winSec(w) > winSec(wins[b]) ? i : b), 0);
    const win = wins[chosen], run = runs[chosen];
    const texts = [...tr.seen.values()].map((s) => s.text);
    const text = texts.reduce((l, n) => (readingWords(n) > readingWords(l) ? n : l));
    const words = readingWords(text);
    if (!words) continue;
    // иконки/инициалы/счётчики — не «строки для чтения»
    if ((text.match(/[\p{L}\p{N}]/gu) || []).length < 2 || !/\p{L}{2}/u.test(text)) continue;
    const floor = lineFloor(words, finalLine);
    if (win.endIn - win.startIn >= floor) continue;
    const seenFirst = tr.seen.get(run[0]);
    cands.push({ tr, words, text, finalLine, floor, win, firstIndex: run[0], rect: seenFirst.rect, fontPx: seenFirst.fontPx });
  }

  // --- эвристика «субтитры по слову» ---
  // Кандидаты на 1 слово/короткую фразу, повторяющиеся в одной и той же позиции кадра и с одним кеглем,
  // считаются потоком субтитров: считаем по нему общую статистику, а не предупреждаем за каждое слово.
  const bucket = (c) => [Math.round(((c.rect.left + c.rect.right) / 2) / (canvas.width * 0.12)), Math.round(((c.rect.top + c.rect.bottom) / 2) / (canvas.height * 0.06)), Math.round(c.fontPx / 6)].join(':');
  const byBucket = new Map();
  for (const c of cands) { const b = bucket(c); (byBucket.get(b) ?? byBucket.set(b, []).get(b)).push(c); }
  const streamSet = new Set();
  const streams = [];
  for (const [b, list] of byBucket) {
    // поток: ≥4 коротких строк (≤3 слов), идущих в основном друг за другом
    const shorts = list.filter((c) => c.words <= 3);
    if (shorts.length >= 4) {
      shorts.forEach((c) => streamSet.add(c));
      streams.push(shorts);
    }
  }
  for (const list of streams) {
    const durs = list.map((c) => Math.max(0, winSec(c.win))).sort((a, b) => a - b);
    const med = durs[Math.floor(durs.length / 2)];
    const min = durs[0];
    const frameSec = 1 / (canvas.fps || 30);
    const tooFast = durs.filter((d) => d < 0.1).length;
    const sample = list[0];
    const t0 = Math.min(...list.map((c) => c.win.startIn)), t1 = Math.max(...list.map((c) => c.win.endIn));
    const slow = med < 0.2 || tooFast >= 2;
    findings.push({ code: 'subtitle_stream', severity: slow ? 'warning' : 'info', time: t0, timeEnd: t1, text: list.slice(0, 4).map((c) => c.text).join(' '),
      selector: sample.tr.sel, rect: sample.rect,
      message: `Субтитры по слову/короткими фразами: ${list.length} строк, медиана ${med.toFixed(2)} с на строку, минимум ${min.toFixed(2)} с.${slow ? ' Строки мелькают слишком быстро для чтения.' : ' Проверка line_unread для потока заменена статистикой (стиль «по слову» — норма).'}`,
      value: `медиана ${med.toFixed(2)} с, мин ${min.toFixed(2)} с, строк быстрее 0.1 с: ${tooFast}`, threshold: 'предупреждение: медиана < 0.2 с или ≥ 2 строк быстрее 0.1 с',
      fix: slow ? 'Показывайте слово не меньше ~0.25 с (или группируйте по 2–3 слова); отрезок аудио слишком плотный.' : '' });
    void frameSec;
  }
  cands = cands.filter((c) => !streamSet.has(c));

  // --- уточнение окон бисекцией и вывод line_unread ---
  let refined = 0;
  for (const c of cands) {
    let win = c.win;
    if (probe && refined < T.maxRefinedLines) {
      refined++;
      win = { ...win };
      const norm = (x) => x.replace(/\s+/g, ' ').trim();
      const want = norm(c.text);
      // при «перемотке» React может создать новый DOM-узел, поэтому сопоставляем не по id, а по id ИЛИ по тексту блока
      const visibleAt = async (t) => {
        const bl = readableBlocks((await probe(t)).parts, readHeight);
        if (bl.has(c.tr.key)) return true;
        for (const b of bl.values()) if (norm(b.text) === want) return true;
        return false;
      };
      for (let i = 0; i < T.refineSteps; i++) {
        if (win.startIn > win.startOut) { const mid = (win.startOut + win.startIn) / 2; if (await visibleAt(mid)) win.startIn = mid; else win.startOut = mid; }
        if (win.endOut > win.endIn) { const mid = (win.endIn + win.endOut) / 2; if (await visibleAt(mid)) win.endIn = mid; else win.endOut = mid; }
      }
    }
    const held = winSec(win);
    if (held >= c.floor - T.measureToleranceSec) continue;
    const err = Math.max(win.startIn - win.startOut, win.endOut - win.endIn) / 2;
    const target = lineTarget(c.words);
    findings.push({ code: 'line_unread', severity: 'warning', time: r2(win.startIn), timeEnd: r2(win.endIn), text: c.text, selector: c.tr.sel, rect: c.rect, words: c.words, held: r2(held),
      message: c.finalLine
        ? `Последняя строка ролика ${q(c.text, 60)} (${c.words} сл.) на экране ${held.toFixed(2)} с (±${Math.max(0.01, err).toFixed(2)}) — меньше ${c.floor.toFixed(2)} с, нужных для финальной строки.`
        : `Строка ${q(c.text, 60)} (${c.words} сл.) на экране ${held.toFixed(2)} с (±${Math.max(0.01, err).toFixed(2)}) — меньше порога ${c.floor.toFixed(2)} с.`,
      value: `${held.toFixed(2)} с на экране`, threshold: c.finalLine ? `≥ ${c.floor.toFixed(2)} с (0.5 с + 0.3 с/слово, минимум 2 с для финала)` : `≥ ${c.floor.toFixed(2)} с (${c.words <= 2 ? '1–2 слова: 0.4 с' : '¾·(0.5 с + 0.3 с/слово)'})`,
      fix: `Держите строку на экране около ${target.toFixed(1)} с (0.5 с + 0.3 с на слово)${c.finalLine ? ', финальную — не меньше 2 с до конца ролика' : ''}, прежде чем она уйдёт или сменится.` });
  }

  // --- text_below_floor ---
  const floorPx = Math.round(T.typeFloorFraction * Math.min(canvas.width, canvas.height));
  const sight = new Map();
  frames.forEach((f, i) => {
    for (const p of f.parts) {
      if (p.opacity < T.readOpacity || p.fontPx >= floorPx - 0.5 || readingWords(p.text) === 0) continue;
      const m = sight.get(p.key) ?? new Map();
      m.set(i, p);
      sight.set(p.key, m);
    }
  });
  const small = [];
  for (const m of sight.values()) {
    const runs = indexRuns([...m.keys()]);
    const [a, b] = runs.reduce((best, r) => (r[1] - r[0] > best[1] - best[0] ? r : best), [0, -1]);
    const start = frames[a].time;
    const end = b === frames.length - 1 ? duration : frames[b].time + step;
    if (end - start < T.typeFloorHoldSec) continue;
    const inRun = [...m.entries()].filter(([i]) => i >= a && i <= b).map(([, p]) => p);
    const px = inRun.map((p) => p.fontPx).sort((x, y) => x - y);
    const med = px[Math.floor(px.length / 2)];
    if (med < 8 || med >= floorPx - 0.5) continue; // <8 px — элемент фактически схлопнут (scale≈0), не «мелкий текст»
    small.push({ part: inRun[0], fontPx: med, seconds: end - start, time: start });
  }
  small.sort((x, y) => x.fontPx - y.fontPx || x.time - y.time);
  if (small.length) {
    const sm = small[0];
    const uniq = [...new Map(small.map((s) => [s.part.text, s])).values()];
    const ex = uniq.slice(0, 6).map((s) => `${q(s.part.text, 20)} ${Math.round(s.fontPx)} px`).join(', ');
    const rc = (p) => ({ left: p.rect.left, top: p.rect.top, right: p.rect.left + p.rect.width, bottom: p.rect.top + p.rect.height, width: p.rect.width, height: p.rect.height });
    findings.push({ code: 'text_below_floor', severity: 'warning', time: r2(sm.time), timeEnd: r2(sm.time + sm.seconds), text: sm.part.text, selector: sm.part.sel, rect: rc(sm.part), count: small.length,
      elements: small.slice(0, 60).map((s) => ({ text: s.part.text, fontPx: Math.round(s.fontPx), time: r2(s.time), seconds: r2(s.seconds), selector: s.part.sel })),
      message: `Мелкий текст: ${small.length} ${small.length === 1 ? 'элемент' : 'элементов'} (${uniq.length} разных) держатся ≥ 0.5 с ниже ${floorPx} px (2.6% короткой стороны ${Math.min(canvas.width, canvas.height)} px). Самый мелкий — ${q(sm.part.text, 40)}: ${Math.round(sm.fontPx)} px, ${sm.seconds.toFixed(1)} с. Примеры: ${ex}.`,
      value: `минимум ${Math.round(sm.fontPx)} px (медиана по интервалу, с учётом scale/transform)`, threshold: `≥ ${floorPx} px для читаемого текста дольше 0.5 с`,
      fix: `Увеличьте кегль до ${floorPx} px и больше; микро-подписи без смысловой нагрузки («текстуру») пометьте data-layout-ignore. Полный список — в JSON (elements).` });
  }

  // --- first_frame_empty ---
  const f0 = frames[0];
  if (f0 && f0.time < 0.001) {
    const flat = f0.thumbStd != null && f0.thumbStd < 3;
    if (!f0.painted || (flat && f0.parts.length === 0)) {
      findings.push({ code: 'first_frame_empty', severity: 'warning', time: 0, timeEnd: 0, text: '', selector: '',
        message: 'Кадр 0 пустой: виден только фон (первый кадр — превью в соцсетях).',
        value: f0.painted ? `однотонный кадр (σ яркости ${f0.thumbStd?.toFixed(1)})` : 'нет ни текста, ни медиа на кадре 0', threshold: 'на кадре 0 есть заголовок или ключевая картинка',
        fix: 'Покажите заголовок/ключевой образ уже на 0-м кадре (не въезжающим «из ничего»), либо задайте обложку отдельно.' });
    }
  }

  // --- dead_stretch (по пиксельной разнице миниатюр) ---
  const endCardStart = duration - T.endCardSec;
  let start = null, end = 0;
  const flush = () => {
    if (start !== null && end - start > T.deadStretchSec) {
      findings.push({ code: 'dead_stretch', severity: 'warning', time: r2(start), timeEnd: r2(end), text: '', selector: '', rect: null,
        message: `На экране ничего не меняется ${(end - start).toFixed(1)} с (${start.toFixed(2)}–${end.toFixed(2)} с).`,
        value: `${(end - start).toFixed(1)} с без изменений картинки`, threshold: '≤ 3 с (последние 3 с — финальная карточка — не считаются)',
        fix: 'Запустите следующее движение в пределах 3 с: зум, смена плана, появление нового элемента; намеренную паузу оставьте, если она короче.' });
    }
    start = null;
  };
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    const still = a.diffNext != null && a.diffNext.still && a.time < endCardStart;
    if (!still) { flush(); continue; }
    start ??= a.time;
    end = Math.min(b.time, endCardStart);
  }
  flush();

  return { findings, notes, step };
}

// ---------------------------------------------------------------------------
// Контраст WCAG
// ---------------------------------------------------------------------------
const lum = (c) => {
  const ch = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
};
export const contrastRatio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
export function suggestColor(fg, bg, req) {
  if (contrastRatio(fg, bg) >= req) return fg;
  const black = [0, 0, 0], white = [255, 255, 255];
  const target = contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black;
  for (let s = 1; s <= 255; s++) {
    const a = s / 255;
    const cand = fg.map((v, i) => Math.round(v + (target[i] - v) * a));
    if (contrastRatio(cand, bg) >= req) return cand;
  }
  return target;
}
const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export function aggregateContrast(entries, sampledTimes) {
  // entries: [{time, id, sel, text, ratio, required, fg, bg, large, rect, shadow}]
  const fails = new Map();
  const passKeys = new Set();
  for (const e of entries) if (e.ratio >= e.required) passKeys.add(e.sel + '|' + e.text);
  for (const e of entries) {
    if (!/[\p{L}\p{N}]/u.test(e.text)) continue; // чистая пунктуация/иконки
    if (e.ratio >= e.required) continue;
    const key = e.sel + '|' + e.text;
    const g = fails.get(key) ?? { first: e, times: [], worst: e };
    g.times.push(e.time);
    if (e.ratio / e.required < g.worst.ratio / g.worst.required) g.worst = e;
    fails.set(key, g);
  }
  // группируем по цвету текста: «неактивные» слова караоке и однотипные подписи дают десятки одинаковых находок
  const byColor = new Map();
  for (const g of fails.values()) {
    const e = g.worst;
    const k = hex(e.fgRgb) + '|' + e.required;
    (byColor.get(k) ?? byColor.set(k, []).get(k)).push(g);
  }
  const findings = [];
  for (const list of byColor.values()) {
    list.sort((a, b) => a.worst.ratio / a.worst.required - b.worst.ratio / b.worst.required);
    const g = list[0];
    const e = g.worst;
    const allTimes = list.flatMap((x) => x.times);
    const held = sampledTimes < 2 || list.some((x) => x.times.length >= 2);
    const sug = suggestColor(e.fgRgb, e.bg, e.required);
    let sev = held ? 'error' : 'warning';
    let note = '';
    const manyTimes = new Set(allTimes).size;
    if (e.shadow) { sev = 'info'; note = ' Есть text-shadow — реальная читаемость может быть выше расчётной.'; }
    else if (list.every((x) => passKeys.has(x.first.sel + '|' + x.first.text))) { sev = 'info'; note = ' В другие моменты те же элементы контрастные — похоже на «неактивное» состояние (караоке/появление).'; }
    else if (list.length >= 4 && manyTimes >= 3) note = ' Один и тот же цвет у многих текстов в разные моменты — похоже на «неактивные» слова караоке/подсказки: если так и задумано, это приём дизайна, но такие слова нечитаемы, пока не подсвечены.';
    const names = list.slice(0, 5).map((x) => q(x.worst.text, 18)).join(', ');
    findings.push({ code: 'contrast_aa', severity: sev, time: Math.min(...allTimes), timeEnd: Math.max(...allTimes), at: e.time, text: e.text, selector: e.sel, rect: e.rect, count: list.length,
      message: `Низкий контраст у текста ${q(e.text, 40)}: ${e.ratio.toFixed(2)}:1 (текст ${hex(e.fgRgb)} на фоне ${hex(e.bg)})${list.length > 1 ? `; всего ${list.length} текстов с этим цветом (${names}${list.length > 5 ? ', …' : ''})` : ''}.${note}`,
      value: `${e.ratio.toFixed(2)}:1, ${e.large ? 'крупный' : 'обычный'} текст, провал в ${g.times.length} из ${sampledTimes} проверенных кадров`,
      threshold: `WCAG AA: ≥ ${e.required}:1 (${e.large ? 'крупный текст ≥ 24 px или ≥ 19 px жирный' : 'обычный текст'})`,
      fix: `Замените цвет текста на ${hex(sug)} (проходит ${e.required}:1) либо затемните/осветлите фон под текстом.` });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Шрифты
// ---------------------------------------------------------------------------
export function aggregateFonts(entries) {
  // entries: [{time, sel, text, family, weight, usedFonts:[{familyName,isCustomFont,glyphCount}], missing: 'ңөү'}]
  const groups = new Map();
  for (const e of entries) {
    const used = e.usedFonts || [];
    const total = used.reduce((s, f) => s + f.glyphCount, 0);
    if (!total) continue;
    const want = e.family.toLowerCase();
    // у вариативных/web-шрифтов платформенное имя бывает «Nunito ExtraLight» — сравниваем по префиксу
    const isPrim = (f) => { const n = f.familyName.toLowerCase(); return n === want || n.startsWith(want + ' '); };
    const isEmoji = (f) => /emoji|symbol/i.test(f.familyName);
    const prim = used.filter(isPrim);
    const primCount = prim.reduce((s, f) => s + f.glyphCount, 0);
    const other = used.filter((f) => !isPrim(f) && !isEmoji(f));
    const otherCount = other.reduce((s, f) => s + f.glyphCount, 0);
    if (otherCount <= 0) continue;
    // generic-семейства (sans-serif и т.п.) не проверяем
    if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|emoji|math)$/i.test(e.family)) continue;
    const key = e.family + '|' + e.weight + '|' + other.map((f) => f.familyName).join(',');
    const g = groups.get(key) ?? { family: e.family, weight: e.weight, other, items: [], chars: new Set(), allFallback: primCount === 0, times: [], texts: [] };
    g.items.push(e);
    g.times.push(e.time);
    for (const ch of e.missing || '') g.chars.add(ch);
    if (primCount > 0) g.allFallback = false;
    if (g.texts.length < 4) g.texts.push(e.text);
    groups.set(key, g);
  }
  const findings = [];
  for (const g of groups.values()) {
    const ex = g.items[0];
    const chars = [...g.chars].join(' ');
    // текст целиком из символов (▌ ♥ ◔ → ✓): их штатно рисует системный шрифт — это не дефект загрузки шрифта
    const symbolOnly = g.items.every((x) => !/[\p{L}\p{N}]/u.test(x.text)) || (!chars && !g.allFallback);
    const cyr = /[ңөүҢӨҮқғһ]/.test(chars) || /[Ѐ-ӿ]/.test(chars);
    const fb = g.other.map((f) => f.familyName).join(', ');
    const ext = /[ңөүҢӨҮ]/.test(chars);
    findings.push({ code: g.allFallback ? 'font_not_loaded' : 'font_glyph_fallback', severity: symbolOnly ? 'info' : (g.allFallback || chars ? 'error' : 'warning'), time: Math.min(...g.times), timeEnd: Math.max(...g.times), text: ex.text, selector: ex.sel, rect: null,
      message: g.allFallback
        ? `Шрифт «${g.family}» (${g.weight}) не загружен: текст ${q(ex.text, 40)} отрисован запасным шрифтом «${fb}».`
        : `Шрифт «${g.family}» (${g.weight}) не содержит часть символов${chars ? ` (${chars})` : ''}: они отрисованы запасным шрифтом «${fb}» — в тексте ${q(ex.text, 40)}.`,
      value: `запасной шрифт: ${fb}${chars ? `; нет глифов: ${chars}` : ''}`, threshold: 'весь текст — глифами заявленного шрифта',
      fix: ext || cyr
        ? `Подключите нужный subset: loadFont('normal', { subsets: ['latin', 'cyrillic', 'cyrillic-ext'], weights: [...] }) из @remotion/google-fonts (символы ң ө ү есть только в cyrillic-ext), либо выберите шрифт с полной кириллицей/кыргызскими буквами.`
        : `Дождитесь загрузки шрифта (loadFont() + delayRender) и проверьте, что запрошенные начертание/weight/subset подключены.` });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Кластеризация однотипных находок, происходящих одновременно (куча перекрывающихся пузырей и т.п.)
// ---------------------------------------------------------------------------
const CLUSTER_CODES = new Set(['text_occluded', 'content_overlap', 'safe_zone', 'text_at_edge', 'container_overflow', 'text_box_overflow', 'canvas_overflow', 'text_not_painted_ghost']);
const SEV_RANK = { error: 0, warning: 1, info: 2 };
export function clusterFindings(findings) {
  const out = [];
  const byKey = new Map();
  for (const f of findings) {
    if (!CLUSTER_CODES.has(f.code)) { out.push(f); continue; }
    const key = f.code + '|' + f.severity + '|' + (f.zone ?? '');
    (byKey.get(key) ?? byKey.set(key, []).get(key)).push(f);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => a.time - b.time);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      if (cur.items.length === 1) { out.push(cur.items[0]); cur = null; return; }
      const first = [...cur.items].sort((a, b) => b.held - a.held || a.time - b.time)[0];
      const names = [...new Set(cur.items.map((x) => q(x.text, 22)))].slice(0, 6).join(', ');
      const t0 = Math.min(...cur.items.map((x) => x.time)), t1 = Math.max(...cur.items.map((x) => x.timeEnd));
      out.push({ ...first, time: t0, timeEnd: t1, count: cur.items.length, items: cur.items,
        message: `${first.message} Ещё ${cur.items.length - 1} однотипных в этот же момент (${t0.toFixed(2)}–${t1.toFixed(2)} с): ${names}${cur.items.length > 6 ? ', …' : ''}.` });
      cur = null;
    };
    for (const f of list) {
      if (cur && f.time <= cur.end + 0.5) { cur.items.push(f); cur.end = Math.max(cur.end, f.timeEnd); }
      else { flush(); cur = { items: [f], end: f.timeEnd }; }
    }
    flush();
  }
  out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.time - b.time);
  return out;
}
