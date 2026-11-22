// Проверки готового MP4 через ffmpeg: громкость (ebur128), тишина, «заморозка» кадра, первый кадр.
import { spawnSync } from 'node:child_process';
import { T } from './analyze.mjs';

const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const r2 = (v) => Math.round(v * 100) / 100;

export function probeVideo(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json', file]);
  if (r.status !== 0) throw new Error('ffprobe: ' + (r.stderr || '').slice(0, 300));
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return { duration: Number(j.format.duration), width: v?.width, height: v?.height, hasAudio: !!a };
}

export function checkVideo(file, opts = {}) {
  const lufsTarget = opts.lufs ?? -14;
  const tol = opts.lufsTol ?? 1.5;
  const maxTp = opts.maxTp ?? -1;
  const out = { file, findings: [], metrics: {} };
  const info = probeVideo(file);
  out.metrics.duration = r2(info.duration);
  out.metrics.size = `${info.width}x${info.height}`;
  out.metrics.hasAudio = info.hasAudio;
  const add = (f) => out.findings.push({ source: 'video', rect: null, selector: '', text: '', timeEnd: f.time, ...f });

  // --- громкость ---
  if (info.hasAudio) {
    const r = run('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    const err = r.stderr || '';
    const sum = err.slice(err.lastIndexOf('Summary:'));
    const lufs = /I:\s+(-?[\d.]+)\s+LUFS/.exec(sum);
    const lra = /LRA:\s+(-?[\d.]+)\s+LU/.exec(sum);
    const tp = /True peak:[\s\S]*?Peak:\s+(-?[\d.]+)\s+dBFS/.exec(sum);
    if (lufs) {
      const I = Number(lufs[1]);
      out.metrics.lufs = I;
      out.metrics.lra = lra ? Number(lra[1]) : null;
      if (Math.abs(I - lufsTarget) > tol) {
        add({ code: 'loudness', severity: 'warning', time: 0,
          message: `Громкость ролика ${I.toFixed(1)} LUFS — вне целевого диапазона ${lufsTarget} ±${tol} LUFS.`,
          value: `${I.toFixed(1)} LUFS (интегральная)`, threshold: `${lufsTarget} ±${tol} LUFS`,
          fix: `Нормализуйте дорожку: ffmpeg -af loudnorm=I=${lufsTarget}:TP=-1.5:LRA=11 (или поднимите/опустите громкость на ${(lufsTarget - I).toFixed(1)} дБ).` });
      }
    }
    if (tp) {
      const P = Number(tp[1]);
      out.metrics.truePeak = P;
      if (P > maxTp) {
        add({ code: 'true_peak', severity: 'warning', time: 0,
          message: `True peak ${P.toFixed(1)} dBTP выше допустимого ${maxTp} dBTP — возможны клиппинг и искажения при перекодировании соцсетями.`,
          value: `${P.toFixed(1)} dBTP`, threshold: `≤ ${maxTp} dBTP`,
          fix: 'Добавьте лимитер перед выводом: ffmpeg -af alimiter=limit=0.89 или loudnorm с TP=-1.5.' });
      }
    }
    // --- тишина ---
    const s = run('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-vn', '-af', 'silencedetect=n=-50dB:d=2', '-f', 'null', '-']);
    const se = s.stderr || '';
    const starts = [...se.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...se.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)].map((m) => ({ end: Number(m[1]), dur: Number(m[2]) }));
    const segs = starts.map((st, i) => ({ start: Math.max(0, st), end: ends[i]?.end ?? info.duration, dur: ends[i]?.dur ?? info.duration - st }));
    out.metrics.silences = segs.map((x) => ({ start: r2(x.start), dur: r2(x.dur) }));
    for (const g of segs) {
      if (g.dur > T.silentFilmSec) {
        add({ code: 'film_silent', severity: 'warning', time: r2(g.start), timeEnd: r2(g.end),
          message: `Тишина ${g.dur.toFixed(1)} с (${g.start.toFixed(1)}–${g.end.toFixed(1)} с, ниже −50 dB).`,
          value: `${g.dur.toFixed(1)} с тишины`, threshold: '≤ 15 с',
          fix: 'Добавьте музыкальную подложку и звуки на видимые действия (если тишина не задумана).' });
      } else if (g.dur >= 4) {
        add({ code: 'silence_gap', severity: 'info', time: r2(g.start), timeEnd: r2(g.end),
          message: `Пауза в звуке ${g.dur.toFixed(1)} с (${g.start.toFixed(1)}–${g.end.toFixed(1)} с).`,
          value: `${g.dur.toFixed(1)} с`, threshold: 'информационно: пауза ≥ 4 с', fix: 'Если пауза не задумана — заполните озвучкой/музыкой/звуком.' });
      }
    }
  } else if (info.duration > T.silentFilmSec) {
    add({ code: 'film_silent', severity: 'warning', time: 0,
      message: `В ролике ${Math.round(info.duration)} с нет звуковой дорожки вообще.`,
      value: 'нет аудио-потока', threshold: 'ролик > 15 с должен иметь звук',
      fix: 'Добавьте музыку/озвучку/звуки действий, если тишина не задумана.' });
  }

  // --- заморозка кадра ---
  const fz = run('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-an', '-vf', 'scale=270:-2,freezedetect=n=-60dB:d=3', '-f', 'null', '-']);
  const fe = fz.stderr || '';
  const fs = [...fe.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const fd = [...fe.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const endCard = info.duration - T.endCardSec;
  out.metrics.freezes = fs.map((st, i) => ({ start: r2(st), dur: r2(fd[i] ?? info.duration - st) }));
  fs.forEach((st, i) => {
    const dur = fd[i] ?? info.duration - st;
    const end = Math.min(st + dur, endCard);
    if (end - st <= T.deadStretchSec) return;
    add({ code: 'dead_stretch', severity: 'warning', time: r2(st), timeEnd: r2(end),
      message: `В готовом видео картинка не меняется ${(end - st).toFixed(1)} с (${st.toFixed(1)}–${end.toFixed(1)} с).`,
      value: `${(end - st).toFixed(1)} с замороженного кадра (freezedetect, −60 dB)`, threshold: '≤ 3 с (последние 3 с не считаются)',
      fix: 'Запустите следующее движение/смену плана в пределах 3 с.' });
  });

  // --- первый кадр ---
  const ff = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-frames:v', '1', '-vf', 'scale=270:-2,signalstats,metadata=print:file=-', '-f', 'null', '-']);
  const txt = (ff.stdout || '') + (ff.stderr || '');
  const g = (k) => { const m = new RegExp('lavfi\\.signalstats\\.' + k + '=([\\d.]+)').exec(txt); return m ? Number(m[1]) : null; };
  const ymin = g('YMIN'), ymax = g('YMAX'), yavg = g('YAVG');
  if (ymin != null && ymax != null) {
    out.metrics.firstFrame = { ymin, ymax, yavg };
    if (ymax - ymin < 12) {
      add({ code: 'first_frame_empty', severity: 'warning', time: 0,
        message: 'Первый кадр готового видео однотонный (нет контента) — это превью в соцсетях.',
        value: `разброс яркости ${ymax - ymin} (YMIN ${ymin}, YMAX ${ymax})`, threshold: 'разброс ≥ 12',
        fix: 'Покажите заголовок/ключевой образ на 0-м кадре или задайте отдельную обложку.' });
    }
  }
  return out;
}
