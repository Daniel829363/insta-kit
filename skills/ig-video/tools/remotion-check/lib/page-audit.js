/*
 * Скрипт, который выполняется ВНУТРИ страницы с композицией Remotion (после seek кадра).
 * Логика и пороги перенесены из HeyGen HyperFrames (Apache-2.0, см. NOTICE):
 *   hyperframes/dist/commands/layout-audit.browser.js, contrast-audit.browser.js
 * и адаптированы под DOM Remotion (корень = #remotion-canvas, без data-атрибутов HyperFrames).
 */
(function () {
  if (window.__rc) return;
  const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TITLE']);
  const TOL = 2; // допуск в пикселях, как в HyperFrames

  const rootEl = () => document.getElementById('remotion-canvas') || document.getElementById('video-container') || document.body;
  const round = (v) => Math.round(v * 100) / 100;
  const toRect = (r) => ({ left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom), width: round(r.width), height: round(r.height) });
  const parsePx = (v) => { const p = Number.parseFloat(v); return Number.isFinite(p) ? p : 0; };

  // --- идентификаторы и селекторы -----------------------------------------
  const ids = new WeakMap();
  let nextId = 0;
  const idOf = (el) => { if (!ids.has(el)) ids.set(el, ++nextId); return ids.get(el); };
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  function selectorFor(el, depth) {
    depth = depth || 0;
    if (el.id) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent || el === rootEl() || depth > 5) return tag;
    const sibs = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    const idx = sibs.indexOf(el) + 1;
    return selectorFor(parent, depth + 1) + ' > ' + tag + ':nth-of-type(' + idx + ')';
  }
  const shortSel = (el) => {
    const s = selectorFor(el);
    const parts = s.split(' > ');
    return parts.length > 4 ? '… > ' + parts.slice(-4).join(' > ') : s;
  };

  // --- видимость ------------------------------------------------------------
  function opacityChain(el) {
    let o = 1;
    for (let c = el; c; c = c.parentElement) {
      const p = Number.parseFloat(getComputedStyle(c).opacity || '1');
      if (Number.isFinite(p)) o *= p;
    }
    return o;
  }
  function hasClipPath(el) {
    for (let c = el; c; c = c.parentElement) {
      const cp = getComputedStyle(c).clipPath;
      if (cp && cp !== 'none') return true;
    }
    return false;
  }
  function isClippedAway(el) {
    if (!hasClipPath(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0.5 || r.height <= 0.5) return false;
    for (const fx of [0.05, 0.25, 0.5, 0.75, 0.95]) for (const fy of [0.25, 0.5, 0.75]) {
      const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      if (hit === el || el.contains(hit)) return false;
    }
    return true;
  }
  function isVisible(el, opacityFloor, probeClip) {
    if (IGNORE_TAGS.has(el.tagName)) return false;
    if (el.closest('[data-rc-ignore],[data-layout-ignore]')) return false;
    if (typeof el.checkVisibility === 'function') {
      const o = opacityFloor != null ? { opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true } : {};
      if (!el.checkVisibility(o)) return false;
    }
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (opacityFloor == null ? opacityChain(el) < 0.2 : opacityChain(el) < opacityFloor) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0.5 || r.height <= 0.5) return false;
    return probeClip === false || !isClippedAway(el);
  }

  // --- текст ----------------------------------------------------------------
  const directTextNodes = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3);
  const textOf = (el, own) => {
    const t = own ? directTextNodes(el).map((n) => n.textContent || '').join('') : el.innerText || el.textContent || '';
    return t.replace(/\s+/g, ' ').trim();
  };
  const hasOwnText = (el) => textOf(el, true).length > 0;
  function textRects(el) {
    const out = [];
    for (const n of directTextNodes(el)) {
      if (!(n.textContent || '').trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      out.push(...Array.from(rg.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5));
      rg.detach();
    }
    return out;
  }
  function union(rects) {
    if (!rects.length) return null;
    const u = rects.reduce((a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    return toRect({ ...u, width: u.right - u.left, height: u.bottom - u.top });
  }
  const clipsValue = (v) => v && v !== 'visible' && v !== 'clip visible';
  const clipsOverflow = (s) => [s.overflowX, s.overflowY, s.overflow].some(clipsValue);
  function visibleTextRects(el) {
    let rects = textRects(el).map(toRect);
    for (let a = el.parentElement; a && rects.length; a = a.parentElement) {
      const s = getComputedStyle(a);
      const cx = clipsValue(s.overflowX || s.overflow), cy = clipsValue(s.overflowY || s.overflow);
      if (!cx && !cy) continue;
      const c = toRect(a.getBoundingClientRect());
      rects = rects.map((r) => {
        const l = cx ? Math.max(r.left, c.left) : r.left, rr = cx ? Math.min(r.right, c.right) : r.right;
        const t = cy ? Math.max(r.top, c.top) : r.top, b = cy ? Math.min(r.bottom, c.bottom) : r.bottom;
        if (rr - l <= 0.5 || b - t <= 0.5) return null;
        return toRect({ left: l, right: rr, top: t, bottom: b, width: rr - l, height: b - t });
      }).filter(Boolean);
    }
    return rects;
  }
  function colorAlpha(color) {
    const m = (color || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return color && color !== 'transparent' ? 1 : 0;
    const body = m[1];
    const parts = body.includes(',') ? body.split(',') : body.split('/');
    const idx = body.includes(',') ? 3 : 1;
    if (parts.length <= idx) return 1;
    const raw = parts[idx].trim();
    return raw.endsWith('%') ? parsePx(raw) / 100 : parsePx(raw);
  }
  function parseRGBA(color) {
    const m = (color || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].replace('/', ' ').split(/[ ,]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }

  // метрики глифов (ink) для точного перекрытия строк при line-height < 1
  function metricsFor(el, style) {
    if (style.writingMode && style.writingMode !== 'horizontal-tb') return null;
    const ctx = (metricsFor.cv || (metricsFor.cv = document.createElement('canvas'))).getContext('2d');
    if (!ctx) return null;
    ctx.font = style.fontStyle + ' ' + style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
    let t = textOf(el, true);
    if (style.textTransform === 'uppercase') t = t.toUpperCase();
    if (style.textTransform === 'lowercase') t = t.toLowerCase();
    const m = ctx.measureText(t);
    return m.fontBoundingBoxAscent + m.fontBoundingBoxDescent > 0 ? m : null;
  }
  function inkRect(r, m) {
    const scale = r.height / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent);
    const top = r.top + (m.fontBoundingBoxAscent - m.actualBoundingBoxAscent) * scale;
    const bottom = r.bottom - (m.fontBoundingBoxDescent - m.actualBoundingBoxDescent) * scale;
    return { ...r, top, bottom, height: bottom - top };
  }

  // --- общие геометрические функции ---------------------------------------
  function overflowFor(subj, cont, tol, vtol) {
    if (vtol == null) vtol = tol;
    const o = {};
    if (subj.left < cont.left - tol) o.left = round(cont.left - subj.left);
    if (subj.right > cont.right + tol) o.right = round(subj.right - cont.right);
    if (subj.top < cont.top - vtol) o.top = round(cont.top - subj.top);
    if (subj.bottom > cont.bottom + vtol) o.bottom = round(subj.bottom - cont.bottom);
    return Object.keys(o).length ? o : null;
  }
  const area = (r) => r.width * r.height;
  function inter(a, b) {
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return ox > 0 && oy > 0 ? ox * oy : 0;
  }
  const rectsArea = (rs) => rs.reduce((t, r) => t + area(r), 0);
  const fragInter = (A, B) => { let t = 0; for (const a of A) for (const b of B) t += inter(a, b); return t; };
  const overlapsFifth = (A, B) => fragInter(A, B) > Math.min(rectsArea(A), rectsArea(B)) * 0.2;
  function hasPaint(s) {
    const bg = s.backgroundColor || '';
    const hasBg = bg && bg !== 'transparent' && !bg.endsWith(', 0)') && bg !== 'rgba(0, 0, 0, 0)';
    const hasImg = s.backgroundImage && s.backgroundImage !== 'none';
    const bw = parsePx(s.borderTopWidth) + parsePx(s.borderRightWidth) + parsePx(s.borderBottomWidth) + parsePx(s.borderLeftWidth);
    const br = parsePx(s.borderTopLeftRadius) + parsePx(s.borderTopRightRadius) + parsePx(s.borderBottomRightRadius) + parsePx(s.borderBottomLeftRadius);
    return hasBg || hasImg || bw > 0 || br > 0;
  }
  function meaningfulBox(s) {
    return parsePx(s.paddingTop) + parsePx(s.paddingRight) + parsePx(s.paddingBottom) + parsePx(s.paddingLeft) +
      parsePx(s.borderTopWidth) + parsePx(s.borderRightWidth) + parsePx(s.borderBottomWidth) + parsePx(s.borderLeftWidth) +
      parsePx(s.borderTopLeftRadius) + parsePx(s.borderTopRightRadius) + parsePx(s.borderBottomRightRadius) + parsePx(s.borderBottomLeftRadius) > 0;
  }
  function isConstraint(el, root, rootRect) {
    if (el === root) return true;
    const s = getComputedStyle(el);
    if (clipsOverflow(s)) return true;
    if (!hasPaint(s) || !meaningfulBox(s)) return false;
    const r = el.getBoundingClientRect();
    const a = r.width * r.height;
    return a > 0 && a < rootRect.width * rootRect.height * 0.95;
  }
  function nearestConstraint(el, root, rootRect) {
    for (let c = el; c && c !== document.body; c = c.parentElement) {
      if (!isVisible(c)) continue;
      if (isConstraint(c, root, rootRect)) return c;
      if (c === root) return c;
    }
    return root;
  }
  const fpx = (v) => Math.round(v) + ' px';
  function overflowHint(textRect, contRect, ov, fontSize, target) {
    const h = (ov.left || 0) + (ov.right || 0), v = (ov.top || 0) + (ov.bottom || 0);
    const needW = contRect.width + h, needH = contRect.height + v;
    const wr = contRect.width > 0 ? contRect.width / textRect.width : 0;
    const hr = contRect.height > 0 ? contRect.height / textRect.height : 0;
    const lim = Math.min(wr > 0 ? wr : Infinity, hr > 0 ? hr : Infinity);
    const shrink = Number.isFinite(lim) && lim < 1 ? Math.ceil((1 - lim) * 100) : 0;
    return { fontSize: Math.round(fontSize), needW: Math.round(needW), needH: Math.round(needH), shrinkPct: shrink, targetFont: shrink > 0 && fontSize > 0 ? Math.round(fontSize * lim) : null, textW: Math.round(textRect.width), textH: Math.round(textRect.height), contW: Math.round(contRect.width), contH: Math.round(contRect.height), horizontal: h > 0, vertical: v > 0, target };
  }

  // --- проверка перекрытия (элемент поверх текста) ---------------------------
  function hasOpaqueBg(s) {
    const bgc = parseRGBA(s.backgroundColor);
    if (bgc && bgc[3] >= 0.85) return true;
    const bi = s.backgroundImage || 'none';
    if (bi !== 'none') {
      if (bi.includes('url(')) return true;
      const cols = bi.match(/rgba?\([^)]+\)/g) || [];
      if (cols.some((c) => { const p = parseRGBA(c); return p && p[3] >= 0.85; })) return true;
    }
    return false;
  }
  function isOpaqueOccluder(el) {
    if (opacityChain(el) < 0.6) return false;
    if (IGNORE_TAGS.has(el.tagName)) return false;
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'CANVAS') return true;
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement) && !(el instanceof SVGTextElement) && !(el instanceof SVGTSpanElement)) {
      const s = getComputedStyle(el);
      const f = parseRGBA(s.fill);
      return !!f && f[3] * Number.parseFloat(s.fillOpacity || '1') >= 0.85;
    }
    return hasOpaqueBg(getComputedStyle(el));
  }
  function occluderAt(el, x, y) {
    const stack = document.elementsFromPoint(x, y);
    for (const hit of stack) {
      const foreign = hit !== el && !el.contains(hit) && !hit.contains(el);
      if (!foreign) return null;
      if (hit.closest('[data-rc-ignore],[data-layout-ignore],[data-layout-allow-occlusion]')) continue;
      if (isOpaqueOccluder(hit)) return hit;
    }
    return null;
  }
  const PROBE_Y = [0.25, 0.5, 0.75];
  const PROBE_X = [0.03, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.97];
  const isAtomic = (t) => t.length > 0 && t.length <= 16 && !/\s/.test(t);

  // --- слой «pointer-events:auto» для elementFromPoint ---------------------
  function withHitTesting(fn) {
    const st = document.createElement('style');
    st.textContent = '*{pointer-events:auto !important}';
    document.head.appendChild(st);
    try { return fn(); } finally { st.remove(); }
  }

  // ========================================================================
  // LAYOUT: один сэмпл. opts: {zones:[{name,x0,y0,x1,y1}] в px, canvasW, canvasH}
  // ========================================================================
  window.__rc = {};
  window.__rc.layout = function (opts) {
    opts = opts || {};
    const root = rootEl();
    const rr = root.getBoundingClientRect();
    const W = opts.canvasW || rr.width, H = opts.canvasH || rr.height;
    const rootRect = toRect({ left: 0, top: 0, right: W, bottom: H, width: W, height: H });
    const issues = [];
    const ghosts = [];
    const els = Array.from(root.querySelectorAll('*'));
    const textEls = [];
    for (const el of els) {
      if (IGNORE_TAGS.has(el.tagName) || !hasOwnText(el)) continue;
      // чисто декоративные символы (♥ ✓ ↓ •) — не текст для проверок вёрстки
      if (!/[\p{L}\p{N}]/u.test(textOf(el, true))) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      const op = opacityChain(el);
      const reasonsHidden = [];
      if (op < 0.05) reasonsHidden.push('opacity');
      if (rect.width <= 0.5 || rect.height <= 0.5) reasonsHidden.push('size');
      else if (!(rect.right > 0 && rect.left < W && rect.bottom > 0 && rect.top < H)) reasonsHidden.push('offcanvas');
      if (reasonsHidden.length) {
        ghosts.push({ id: idOf(el), sel: shortSel(el), text: textOf(el, true).slice(0, 60), reason: reasonsHidden[0] });
        continue;
      }
      if (!isVisible(el)) { ghosts.push({ id: idOf(el), sel: shortSel(el), text: textOf(el, true).slice(0, 60), reason: 'clip' }); continue; }
      textEls.push(el);
    }

    withHitTesting(() => {
      // --- переполнения, обрезка, выход за холст -------------------------
      for (const el of textEls) {
        const text = textOf(el, true);
        const base = { id: idOf(el), sel: shortSel(el), text, svg: el instanceof SVGElement };
        const style = getComputedStyle(el);
        const lineRects = textRects(el).map(toRect);
        const trect = union(lineRects);
        if (!trect) continue;
        const fontSize = parsePx(style.fontSize);
        const optOut = !!el.closest('[data-layout-allow-overflow],[data-rc-allow-overflow]') || el.hasAttribute('data-layout-bleed');

        // clipped_text: собственный box режет текст
        if (clipsOverflow(style) && !optOut) {
          const ox = el.scrollWidth - el.clientWidth, oy = el.scrollHeight - el.clientHeight;
          if (ox > TOL || oy > TOL) {
            // overflow:hidden с text-overflow: ellipsis — намеренное усечение
            const ellipsis = style.textOverflow === 'ellipsis';
            if (!ellipsis) {
              const rect = toRect(el.getBoundingClientRect());
              const ov = {}; if (ox > TOL) ov.right = round(ox); if (oy > TOL) ov.bottom = round(oy);
              issues.push({ ...base, code: 'clipped_text', severity: 'error', rect, overflow: ov, hint: overflowHint(rect, rect, ov, fontSize, 'сам текстовый блок') });
            }
          }
        }
        // text_box_overflow: выход за ближайший контейнер
        const cont = nearestConstraint(el, root, rootRect);
        const contRect = cont === root ? rootRect : toRect(cont.getBoundingClientRect());
        const contClips = clipsOverflow(getComputedStyle(cont));
        let visRect = trect;
        if (contClips) {
          const m = metricsFor(el, style);
          const vis = lineRects.flatMap((r) => {
            const ink = m ? toRect(inkRect(r, m)) : r;
            const ox = Math.min(ink.right, contRect.right) - Math.max(ink.left, contRect.left);
            const oy = Math.min(ink.bottom, contRect.bottom) - Math.max(ink.top, contRect.top);
            return ox > TOL && oy > TOL ? [ink] : [];
          });
          visRect = union(vis);
        }
        const vtol = contClips ? TOL : Math.max(TOL, fontSize * 0.2);
        const contIsCanvas = cont === root || area(contRect) >= 0.98 * area(rootRect);
        const cov = visRect && !contIsCanvas ? overflowFor(visRect, contRect, TOL, vtol) : null;
        if (cov && !optOut) {
          issues.push({ ...base, code: 'text_box_overflow', severity: 'error', rect: visRect, containerRect: contRect, containerSel: shortSel(cont), containerText: textOf(cont, false).slice(0, 40), overflow: cov, hint: overflowHint(visRect, contRect, cov, fontSize, 'контейнер') });
        }
        // canvas_overflow: выход за холст
        const cvo = overflowFor(trect, rootRect, TOL);
        if (cvo && !optOut) {
          const visibleShare = inter(trect, rootRect) / Math.max(1, area(trect));
          issues.push({ ...base, code: 'canvas_overflow', severity: 'info', rect: trect, containerRect: rootRect, overflow: cvo, visibleShare: round(visibleShare), hint: { fontSize } });
        } else if (!optOut) {
          // текст «прилип» к краю кадра (в пределах допуска) — содержимое на краю холста
          const edge = [];
          if (trect.left <= TOL) edge.push('left');
          if (trect.right >= W - TOL) edge.push('right');
          if (trect.top <= TOL) edge.push('top');
          if (trect.bottom >= H - TOL) edge.push('bottom');
          if (edge.length) issues.push({ ...base, code: 'text_at_edge', severity: 'warning', rect: trect, edges: edge, hint: {} });
        }
        // безопасные зоны
        if (opts.zones && opts.zones.length && !el.closest('[data-layout-allow-caption-zone],[data-rc-allow-zone]')) {
          for (const z of opts.zones) {
            const zr = { left: z.x0, top: z.y0, right: z.x1, bottom: z.y1 };
            const share = inter(trect, zr) / Math.max(1, area(trect));
            const onCanvas = inter(trect, rootRect) / Math.max(1, area(trect));
            if (share >= 0.25 && onCanvas >= 0.5) issues.push({ ...base, code: 'safe_zone', severity: 'warning', rect: trect, zone: z.name, share: round(share), hint: { zone: z } });
          }
        }
      }

      // --- text_not_painted: прозрачная заливка ---------------------------
      for (const el of textEls) {
        const cs = getComputedStyle(el);
        const fill = cs.webkitTextFillColor || cs.color;
        if (colorAlpha(fill) > 0.05) continue;
        if (parsePx(cs.webkitTextStrokeWidth) > 0 && colorAlpha(cs.webkitTextStrokeColor) > 0.05) continue;
        const clip = cs.webkitBackgroundClip || cs.backgroundClip || '';
        if (/text/i.test(clip)) {
          const painted = (cs.backgroundImage || 'none') !== 'none' || colorAlpha(cs.backgroundColor || 'rgba(0,0,0,0)') > 0.05;
          if (painted) continue;
        }
        // text-shadow может быть единственной «краской» — это намеренный приём
        if (cs.textShadow && cs.textShadow !== 'none') continue;
        issues.push({ id: idOf(el), sel: shortSel(el), text: textOf(el, true), code: 'text_not_painted', severity: 'error', rect: union(textRects(el).map(toRect)), hint: {} });
      }

      // --- content_overlap: два сплошных текста друг на друге ----------------
      const solid = [];
      for (const el of textEls) {
        if (el.closest('[data-layout-allow-overlap],[data-rc-allow-overlap]')) continue;
        if (colorAlpha(getComputedStyle(el).color) < 0.35) continue;
        const rects = visibleTextRects(el);
        const r = union(rects);
        if (r) solid.push({ el, rects, rect: r });
      }
      const glyph = (b) => {
        if (!b.glyph) { const m = metricsFor(b.el, getComputedStyle(b.el)); b.glyph = m ? b.rects.map((r) => inkRect(r, m)) : b.rects; }
        return b.glyph;
      };
      const nearestFlexGrid = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const d = getComputedStyle(p).display; if (d.includes('flex') || d.includes('grid')) return p; } return null; };
      const inFlow = (el) => ['static', 'relative', 'sticky'].includes(getComputedStyle(el).position);
      for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
        const a = solid[i], b = solid[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (inFlow(a.el) && inFlow(b.el)) { const c = nearestFlexGrid(a.el); if (c && c === nearestFlexGrid(b.el)) continue; }
        if (!overlapsFifth(a.rects, b.rects)) continue;
        if (!overlapsFifth(glyph(a), glyph(b))) continue;
        const share = fragInter(a.rects, b.rects) / Math.max(1, Math.min(rectsArea(a.rects), rectsArea(b.rects)));
        issues.push({ id: idOf(a.el), id2: idOf(b.el), sel: shortSel(a.el), sel2: shortSel(b.el), text: textOf(a.el, true), text2: textOf(b.el, true), code: 'content_overlap', severity: 'warning', rect: a.rect, rect2: b.rect, share: round(share), svg: a.el instanceof SVGElement || b.el instanceof SVGElement, hint: {} });
      }

      // --- text_occluded: поверх текста лежит непрозрачный элемент ---------
      for (const el of textEls) {
        if (el.closest('[data-layout-allow-occlusion],[data-rc-allow-occlusion]')) continue;
        const text = textOf(el, true);
        const rects = textRects(el).map(toRect);
        if (!rects.length) continue;
        let hits = 0, total = 0, occluder = null;
        for (const r of rects) for (const fy of PROBE_Y) for (const fx of PROBE_X) {
          total++;
          const x = r.left + r.width * fx, y = r.top + r.height * fy;
          if (x < 0 || y < 0 || x >= W || y >= H) { total--; continue; }
          const hit = occluderAt(el, x, y);
          if (hit) { hits++; if (!occluder) occluder = hit; }
        }
        if (!occluder || total === 0) continue;
        const cov = hits / total;
        if (!isAtomic(text) && cov < 0.15) continue;
        issues.push({ id: idOf(el), sel: shortSel(el), text, code: 'text_occluded', severity: 'error', rect: union(rects), coveredFraction: round(cov), occluderSel: shortSel(occluder), occluderTag: occluder.tagName.toLowerCase(), occluderSvg: occluder instanceof SVGElement, svg: el instanceof SVGElement, hint: {} });
      }
    });

    // --- container_overflow: дети клиппингового контейнера выходят за него ---
    for (const c of els) {
      if (!isVisible(c) || c.closest('[data-layout-allow-overflow],[data-rc-allow-overflow]')) continue;
      const s = getComputedStyle(c);
      if (!clipsOverflow(s)) continue;
      // для контейнеров, у которых overflow используется как маска-анимация (reveal), это норма — смотрим только текстовых детей
      const cr = toRect(c.getBoundingClientRect());
      for (const ch of Array.from(c.children)) {
        if (ch instanceof SVGElement || !isVisible(ch) || !textOf(ch, false)) continue;
        const chr = toRect(ch.getBoundingClientRect());
        const ov = overflowFor(chr, cr, TOL);
        if (!ov) continue;
        issues.push({ id: idOf(ch), sel: shortSel(ch), text: textOf(ch, false).slice(0, 60), code: 'container_overflow', severity: 'warning', rect: chr, containerRect: cr, containerSel: shortSel(c), overflow: ov, hint: {} });
      }
    }
    return { issues, ghosts, textCount: textEls.length, visibleIds: textEls.map(idOf) };
  };

  // ========================================================================
  // CRAFT: текстовые «части» кадра для line_unread / text_below_floor
  // ========================================================================
  const INLINE = /^(inline|inline-block|inline-flex|inline-grid|contents|ruby)$/;
  function readingBlock(el, root) {
    let c = el;
    while (c !== root && c.parentElement && INLINE.test(getComputedStyle(c).display)) c = c.parentElement;
    return c;
  }
  function scaleProp(s) {
    const parts = (s.scale || 'none').split(/\s+/).map(Number.parseFloat).filter(Number.isFinite);
    if (!parts.length) return 1;
    return Math.sqrt(Math.abs(parts[0] * (parts.length > 1 ? parts[1] : parts[0])));
  }
  function renderedFontPx(el, s) {
    const font = parsePx(s.fontSize);
    if (el.ownerSVGElement && typeof el.getScreenCTM === 'function') {
      const m = el.getScreenCTM();
      return m ? font * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : font;
    }
    let sc = 1;
    for (let c = el; c; c = c.parentElement) {
      const cs = c === el ? s : getComputedStyle(c);
      if (cs.transform && cs.transform !== 'none') {
        try { const m = new DOMMatrixReadOnly(cs.transform); sc *= Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); } catch (e) { /* noop */ }
      }
      sc *= scaleProp(cs);
    }
    return font * sc;
  }
  window.__rc.craft = function (opts) {
    opts = opts || {};
    const root = rootEl();
    const W = opts.canvasW, H = opts.canvasH;
    const parts = [];
    let painted = false;
    for (const el of root.querySelectorAll('*')) {
      if (!hasOwnText(el) || !isVisible(el, 0.05, false)) continue;
      const rect = union(visibleTextRects(el));
      if (!rect) continue;
      if (!(rect.right > 0 && rect.left < W && rect.bottom > 0 && rect.top < H)) continue;
      if (hasClipPath(el) && isClippedAway(el)) continue;
      const s = getComputedStyle(el);
      const block = readingBlock(el, root);
      const op = round(opacityChain(el));
      if (op >= 0.2) painted = true;
      parts.push({ key: idOf(el), block: idOf(block), sel: shortSel(el), blockSel: shortSel(block), text: textOf(el, true), blockText: textOf(block, false), opacity: op, fontPx: round(renderedFontPx(el, s)), rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, weight: s.fontWeight });
    }
    if (!painted) {
      for (const el of root.querySelectorAll('img, video, canvas, svg')) {
        if (el.parentElement && el.parentElement.closest('svg')) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 4 && r.height >= 4 && opacityChain(el) >= 0.2 && getComputedStyle(el).visibility !== 'hidden') { painted = true; break; }
      }
    }
    return { parts, painted, sound: root.querySelectorAll('audio, video').length + document.querySelectorAll('audio, video').length };
  };

  // ========================================================================
  // CONTRAST: подготовка (прячем цвет текста) / восстановление
  // ========================================================================
  window.__rc.contrastPrepare = function () {
    const root = rootEl();
    const out = [];
    const restores = [];
    const pending = [];
    const st = document.createElement('style');
    st.id = '__rc_nt';
    st.textContent = '*{transition:none !important}';
    document.head.appendChild(st);
    for (const el of root.querySelectorAll('*')) {
      if (!hasOwnText(el) || !isVisible(el)) continue;
      const cs = getComputedStyle(el);
      const op = opacityChain(el);
      if (op < 0.5) continue;
      const clip = cs.webkitBackgroundClip || cs.backgroundClip || '';
      if (/text/i.test(clip)) continue;
      const svgText = el instanceof SVGElement;
      const fg = parseRGBA(svgText ? cs.fill : cs.color) || parseRGBA(cs.color);
      if (!fg || fg[3] <= 0.01) continue;
      const rect = visibleTextRects(el);
      const r = union(rect);
      if (!r || r.width < 8 || r.height < 8) continue;
      const fontSize = parsePx(cs.fontSize);
      const weight = Number(cs.fontWeight) || 400;
      const large = fontSize >= 24 || (fontSize >= 19 && weight >= 700);
      const sw = parsePx(cs.webkitTextStrokeWidth);
      const stroke = sw > 0 ? parseRGBA(cs.webkitTextStrokeColor) : null;
      const shadow = cs.textShadow && cs.textShadow !== 'none';
      let ownBg = null;
      if ((cs.backgroundImage || 'none') === 'none') { const b = parseRGBA(cs.backgroundColor); if (b && b[3] >= 0.99) ownBg = b; }
      restores.push({ el, color: el.style.getPropertyValue('color'), prio: el.style.getPropertyPriority('color'), fill: el.style.getPropertyValue('fill'), fprio: el.style.getPropertyPriority('fill'), sc: el.style.getPropertyValue('-webkit-text-stroke-color'), scp: el.style.getPropertyPriority('-webkit-text-stroke-color'), svgText, stroke: !!stroke, shadow: el.style.getPropertyValue('text-shadow'), shp: el.style.getPropertyPriority('text-shadow') });
      pending.push({ el, svgText, stroke });
      out.push({ id: idOf(el), sel: shortSel(el), text: textOf(el, true).slice(0, 50), fg: [fg[0], fg[1], fg[2], fg[3] * op], stroke, fontSize, weight, large, ownBg, shadow: !!shadow, bbox: { x: r.left, y: r.top, w: r.width, h: r.height } });
    }
    // прячем цвет только после того, как прочитаны стили ВСЕХ элементов (иначе наследуемый stroke потеряется)
    for (const p of pending) {
      p.el.style.setProperty('color', 'transparent', 'important');
      if (p.svgText) p.el.style.setProperty('fill', 'transparent', 'important');
      if (p.stroke) p.el.style.setProperty('-webkit-text-stroke-color', 'transparent', 'important');
      p.el.style.setProperty('text-shadow', 'none', 'important');
    }
    window.__rc_restores = restores;
    return out;
  };
  window.__rc.contrastRestore = function () {
    for (const r of window.__rc_restores || []) {
      const el = r.el;
      const put = (p, v, pr) => (v ? el.style.setProperty(p, v, pr) : el.style.removeProperty(p));
      put('color', r.color, r.prio);
      if (r.svgText) put('fill', r.fill, r.fprio);
      if (r.stroke) put('-webkit-text-stroke-color', r.sc, r.scp);
      put('text-shadow', r.shadow, r.shp);
    }
    window.__rc_restores = [];
    const st = document.getElementById('__rc_nt'); if (st) st.remove();
  };

  // Фон под текстом: декодируем скриншот и берём медиану по сетке внутри bbox
  window.__rc.sampleBg = async function (dataUrl, boxes) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const res = [];
    for (const b of boxes) {
      const x0 = Math.max(0, Math.round(b.x) + 1), x1 = Math.min(cv.width - 1, Math.round(b.x + b.w) - 1);
      const y0 = Math.max(0, Math.round(b.y) + 1), y1 = Math.min(cv.height - 1, Math.round(b.y + b.h) - 1);
      if (x1 <= x0 || y1 <= y0) { res.push(null); continue; }
      const data = ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const sx = Math.max(1, Math.floor((w - 1) / 12)), sy = Math.max(1, Math.floor((h - 1) / 6));
      const R = [], G = [], B = [];
      for (let y = 0; y < h; y += sy) for (let x = 0; x < w; x += sx) {
        const i = (y * w + x) * 4;
        R.push(data.data[i]); G.push(data.data[i + 1]); B.push(data.data[i + 2]);
      }
      const med = (a) => { a.sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
      res.push([med(R), med(G), med(B)]);
    }
    return res;
  };

  // Миниатюра в оттенках серого для измерения «движения» между сэмплами
  window.__rc.thumb = async function (dataUrl, tw, th) {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = tw; cv.height = th;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, tw, th);
    const d = ctx.getImageData(0, 0, tw, th).data;
    const out = new Uint8Array(tw * th);
    for (let i = 0; i < tw * th; i++) out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
    let bin = '';
    for (let i = 0; i < out.length; i += 8192) bin += String.fromCharCode.apply(null, out.subarray(i, i + 8192));
    return btoa(bin);
  };

  // ========================================================================
  // ШРИФТЫ: помечаем текстовые элементы для CSS.getPlatformFontsForNode
  // ========================================================================
  window.__rc.fontsMark = function () {
    const root = rootEl();
    const out = [];
    let n = 0;
    for (const el of root.querySelectorAll('*')) {
      if (!hasOwnText(el) || !isVisible(el, 0.05, false)) continue;
      const cs = getComputedStyle(el);
      const fams = cs.fontFamily.split(',').map((f) => f.trim().replace(/^["']|["']$/g, ''));
      el.setAttribute('data-rc-font', String(n));
      out.push({ n, id: idOf(el), sel: shortSel(el), text: textOf(el, true), family: fams[0], stack: cs.fontFamily, weight: cs.fontWeight, size: cs.fontSize, style: cs.fontStyle });
      n++;
    }
    return out;
  };
  window.__rc.fontsUnmark = function () {
    for (const el of document.querySelectorAll('[data-rc-font]')) el.removeAttribute('data-rc-font');
  };
  // Какие символы текста шрифт family НЕ содержит (сравнение ширины с запасными шрифтами).
  window.__rc.missingChars = function (text, family, weight, style) {
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    const w = (font, ch) => { ctx.font = font; return ctx.measureText(ch).width; };
    const miss = new Set();
    for (const ch of new Set(Array.from(text))) {
      if (!/[\p{L}\p{N}]/u.test(ch)) continue; // эмодзи и знаки не относятся к шрифту текста
      const mk = (fb) => (style || 'normal') + ' ' + (weight || 400) + ' 64px "' + family + '", ' + fb;
      const mkfb = (fb) => (style || 'normal') + ' ' + (weight || 400) + ' 64px ' + fb;
      const a = w(mk('serif'), ch), a0 = w(mkfb('serif'), ch);
      const b = w(mk('monospace'), ch), b0 = w(mkfb('monospace'), ch);
      if (Math.abs(a - a0) < 0.01 && Math.abs(b - b0) < 0.01) miss.add(ch);
    }
    return Array.from(miss).join('');
  };

  // ========================================================================
  // ОВЕРЛЕЙ проблемных рамок и сборка контактного листа
  // ========================================================================
  window.__rc.overlay = function (boxes) {
    const d = document.createElement('div');
    d.id = '__rc_overlay';
    d.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;';
    for (const b of boxes) {
      const e = document.createElement('div');
      e.style.cssText = 'position:absolute;box-sizing:border-box;border:5px solid #ff1744;background:rgba(255,23,68,0.12);left:' + b.x + 'px;top:' + b.y + 'px;width:' + Math.max(8, b.w) + 'px;height:' + Math.max(8, b.h) + 'px;';
      d.appendChild(e);
    }
    document.body.appendChild(d);
  };
  window.__rc.overlayClear = function () { const d = document.getElementById('__rc_overlay'); if (d) d.remove(); };
  window.__rc.sheet = async function (tiles, tw, th, cols) {
    const label = 54;
    const rows = Math.ceil(tiles.length / cols);
    const cv = document.createElement('canvas');
    cv.width = cols * tw; cv.height = rows * (th + label);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#16181d'; ctx.fillRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < tiles.length; i++) {
      const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + label);
      const img = new Image(); img.src = 'data:image/jpeg;base64,' + tiles[i].data; await img.decode();
      ctx.drawImage(img, x, y, tw, th);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeRect(x, y, tw, th);
      ctx.fillStyle = tiles[i].sev === 'error' ? '#ff5252' : '#ffd740';
      ctx.font = 'bold 16px Arial'; ctx.fillText(tiles[i].label1, x + 6, y + th + 20);
      ctx.fillStyle = '#d0d4dc'; ctx.font = '13px Arial';
      ctx.fillText(tiles[i].label2, x + 6, y + th + 38, tw - 12);
      ctx.fillText(tiles[i].label3 || '', x + 6, y + th + 52, tw - 12);
    }
    return cv.toDataURL('image/jpeg', 0.82).split(',')[1];
  };
})();
