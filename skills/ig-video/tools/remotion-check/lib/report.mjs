// Текстовый отчёт на русском.
const SEV = { error: 'ОШИБКИ', warning: 'ПРЕДУПРЕЖДЕНИЯ', info: 'ИНФО' };
const plural = (n, a, b, c) => { const m = n % 100; const k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k >= 2 && k <= 4 ? b : c; };

const tm = (f) => (f.timeEnd != null && f.timeEnd - f.time > 0.001 ? `${f.time.toFixed(2)}–${f.timeEnd.toFixed(2)} с` : `${f.time.toFixed(2)} с`);

export function formatReport({ meta, findings, args }) {
  const L = [];
  const c = meta.counts;
  L.push(`remotion-check ${meta.version} — ${meta.composition} (${meta.canvas.width}×${meta.canvas.height}, ${meta.canvas.fps} fps, ${meta.canvas.durationSec} с)`);
  L.push(`Проект: ${meta.project}`);
  L.push(`Сэмплов: ${meta.samples.count} (шаг ~${meta.samples.stepSec} с, диапазон ${meta.samples.from}–${meta.samples.to} с), проход ${meta.samples.passSeconds} с, всего ${meta.samples.totalSeconds} с`);
  if (meta.zones.length) L.push(`Зоны: ${meta.zones.map((z) => `${z.name} [${Math.round(z.x0)},${Math.round(z.y0)}–${Math.round(z.x1)},${Math.round(z.y1)}]`).join('; ')}`);
  if (meta.video) {
    const m = meta.video.metrics;
    L.push(`MP4: ${m.size}, ${m.duration} с${m.lufs != null ? `, ${m.lufs} LUFS` : ''}${m.truePeak != null ? `, true peak ${m.truePeak} dBTP` : ''}${m.hasAudio === false ? ', без звука' : ''}`);
  }
  L.push('');
  L.push(`ИТОГ: ${c.error} ${plural(c.error, 'ошибка', 'ошибки', 'ошибок')}, ${c.warning} ${plural(c.warning, 'предупреждение', 'предупреждения', 'предупреждений')}, ${c.info} инфо — ${c.error ? 'НЕ ПРОЙДЕНО' : 'ошибок нет'}`);
  L.push('');
  for (const sev of ['error', 'warning', 'info']) {
    const list = findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    L.push(`=== ${SEV[sev]} (${list.length}) ===`);
    if (sev === 'info') {
      // Инфо схлопываем по коду
      const by = new Map();
      for (const f of list) (by.get(f.code) ?? by.set(f.code, []).get(f.code)).push(f);
      for (const [code, arr] of by) {
        const ex = arr.slice(0, 3).map((f) => `${f.text ? '«' + f.text.slice(0, 28) + '» ' : ''}${tm(f)}`).join('; ');
        L.push(`• ${code} ×${arr.length}: ${arr[0].message.split('.')[0]}.`);
        L.push(`    примеры: ${ex}${arr.length > 3 ? '; …' : ''}`);
      }
      L.push('');
      continue;
    }
    const cap = sev === 'error' ? 12 : 6;
    const shown = new Map();
    const hidden = new Map();
    for (const f of list) {
      const n = (shown.get(f.code) ?? 0) + 1;
      shown.set(f.code, n);
      if (n > cap) { hidden.set(f.code, (hidden.get(f.code) ?? 0) + 1); continue; }
      L.push(`[${tm(f)}] ${f.code}${f.source === 'video' ? ' (MP4)' : ''} — ${f.message}`);
      if (f.selector) L.push(`    элемент: ${f.selector}`);
      if (f.value) L.push(`    значение: ${f.value}`);
      if (f.threshold) L.push(`    порог: ${f.threshold}`);
      if (f.fix) L.push(`    исправить: ${f.fix}`);
    }
    for (const [code, n] of hidden) L.push(`… и ещё ${n} находок ${code} (полный список — в JSON)`);
    L.push('');
  }
  if (!findings.length) L.push('Проблем не найдено.');
  for (const e of meta.toolErrors || []) L.push(`ВНИМАНИЕ: ${e} — проверка не выполнена полностью.`);
  if (meta.sheet) L.push(`Контактный лист (${meta.sheet.tiles} кадров): ${meta.sheet.file}`);
  return L.join('\n');
}
