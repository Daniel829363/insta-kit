// Открытие Remotion-проекта в браузере так же, как это делает рендерер:
// bundle() -> статический сервер -> Chrome от Remotion -> makePage() -> seekToFrame().
// Все @remotion/* берутся из node_modules проекта (createRequire), своих зависимостей нет.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export function loadRemotion(projectDir) {
  const req = createRequire(path.join(projectDir, 'package.json'));
  const resolveDir = (pkg) => path.dirname(req.resolve(pkg + '/package.json'));
  const rendererDir = resolveDir('@remotion/renderer');
  const renderer = req('@remotion/renderer');
  const bundler = req('@remotion/bundler');
  const noReact = req('remotion/no-react');
  // Внутренние модули рендерера (exports в package.json закрыты — берём по абсолютному пути).
  const makePage = req(path.join(rendererDir, 'dist', 'make-page.js')).makePage;
  const seek = req(path.join(rendererDir, 'dist', 'seek-to-frame.js'));
  const version = req('remotion/package.json').version;
  return { req, renderer, bundler, noReact, makePage, seek, version, rendererDir };
}

export function findEntry(projectDir, explicit) {
  if (explicit) return path.resolve(projectDir, explicit);
  for (const c of ['src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.jsx', 'src/entry.ts', 'index.ts', 'index.js']) {
    const p = path.join(projectDir, c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Не найден entry-файл (src/index.ts). Укажите --entry.');
}

function wantsRspack(projectDir) {
  try {
    const cfg = fs.readFileSync(path.join(projectDir, 'remotion.config.ts'), 'utf8');
    return /setRspack\(\s*true\s*\)/.test(cfg);
  } catch {
    return false;
  }
}

export async function openComposition({ projectDir, entry, compId, props, bundleDir, log, noCache }) {
  const R = loadRemotion(projectDir);
  const { renderer, bundler, noReact } = R;

  // 1. bundle
  let outDir = bundleDir;
  if (!outDir || !fs.existsSync(path.join(outDir, 'index.html'))) {
    outDir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'remotion-check-bundle-'));
    log(`Сборка бандла (${wantsRspack(projectDir) ? 'rspack' : 'webpack'})...`);
    const t0 = Date.now();
    let last = -1;
    outDir = await bundler.bundle({
      entryPoint: entry,
      outDir,
      rootDir: projectDir,
      enableCaching: !noCache,
      rspack: wantsRspack(projectDir),
      onProgress: (p) => {
        const pc = Math.floor(p / 25) * 25;
        if (pc !== last) { last = pc; }
      },
    });
    log(`Бандл готов за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  }

  // 2. сервер
  const serverRes = await renderer.RenderInternals.makeOrReuseServer(
    undefined,
    {
      webpackConfigOrServeUrl: outDir,
      port: null,
      remotionRoot: projectDir,
      offthreadVideoThreads: 2,
      logLevel: 'error',
      indent: false,
      offthreadVideoCacheSizeInBytes: null,
      binariesDirectory: null,
      forceIPv4: false,
      sampleRate: 48000,
    },
    { onDownload: () => undefined },
  );
  const server = serverRes.server;

  // 3. браузер (тот же Chrome, что у рендерера)
  // Remotion ищет/качает chrome-headless-shell от текущей папки: запускаем из папки проекта,
  // чтобы взять уже скачанный браузер проекта (node_modules/.remotion), а не качать 280 МБ в cwd.
  const prevCwd = process.cwd();
  process.chdir(projectDir);
  let browser;
  try {
    browser = await renderer.openBrowser('chrome', {
      chromiumOptions: { gl: 'angle' },
      viewport: null,
      logLevel: 'error',
      chromeMode: 'headless-shell',
    });
  } finally {
    process.chdir(prevCwd);
  }

  // 4. метаданные композиции (calculateMetadata, props по умолчанию + --props)
  const inputProps = props ?? {};
  const meta = await renderer.selectComposition({
    serveUrl: outDir,
    id: compId,
    inputProps,
    puppeteerInstance: browser,
    logLevel: 'error',
  });
  const composition = meta;

  const serializedInput = noReact.NoReactInternals.serializeJSONWithSpecialTypes({
    indent: undefined, staticBase: null, data: inputProps,
  }).serializedString;
  const serializedResolved = noReact.NoReactInternals.serializeJSONWithSpecialTypes({
    indent: undefined, staticBase: null, data: composition.props,
  }).serializedString;

  // 5. страница
  const pagesArray = [];
  const consoleEvents = [];
  const page = await R.makePage({
    context: () => null,
    initialFrame: 0,
    browserReplacer: { getBrowser: () => browser },
    logLevel: 'error',
    indent: false,
    pagesArray,
    onBrowserLog: (l) => consoleEvents.push({ type: l.type, text: l.text, url: l.stackTrace?.[0]?.url ?? null }),
    scale: 1,
    timeoutInMilliseconds: 60000,
    composition,
    proxyPort: server.offthreadPort,
    serveUrl: server.serveUrl,
    muted: true,
    envVariables: {},
    serializedInputPropsWithCustomSchema: serializedInput,
    imageFormat: 'jpeg',
    serializedResolvedPropsWithCustomSchema: serializedResolved,
    pageIndex: 0,
    isMainTab: true,
    mediaCacheSizeInBytes: null,
    onLog: () => undefined,
    darkMode: false,
    sampleRate: 48000,
  });

  const client = page._client();
  const netErrors = [];
  const reqUrl = new Map();
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', (e) => reqUrl.set(e.requestId, e.request.url));
  client.on('Network.loadingFailed', (e) => {
    if (e.canceled) return;
    netErrors.push({ url: reqUrl.get(e.requestId) ?? '?', error: e.errorText });
  });
  client.on('Network.responseReceived', (e) => {
    if (e.response.status >= 400) netErrors.push({ url: e.response.url, error: 'HTTP ' + e.response.status });
  });
  const pageErrors = [];
  client.on('Runtime.exceptionThrown', (e) => pageErrors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? 'exception'));

  let curFrame = 0;
  const api = {
    composition,
    page,
    client,
    outDir,
    consoleEvents,
    netErrors,
    pageErrors,
    version: R.version,
    async seek(frame) {
      curFrame = frame;
      await R.seek.seekToFrame({
        frame,
        page,
        composition: composition.id,
        timeoutInMilliseconds: 60000,
        logLevel: 'error',
        indent: false,
        attempt: 0,
      });
    },
    get frame() { return curFrame; },
    async run(expression) {
      const r = await api.cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      const res = r && r.result ? r : r && r.value && r.value.result ? r.value : r;
      if (res.exceptionDetails) throw new Error('page: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
      return res.result ? res.result.value : undefined;
    },
    async cdp(method, params) {
      const r = await client.send(method, params);
      return r && typeof r.value === 'object' && r.value !== null && !('data' in r) ? r.value : r;
    },
    async evaluate(fn, ...args) {
      return page.evaluate(fn, ...args);
    },
    async screenshot({ format = 'png', quality, scale, clip } = {}) {
      const params = { format, fromSurface: true };
      if (quality) params.quality = quality;
      if (scale) params.clip = { x: 0, y: 0, width: composition.width, height: composition.height, scale };
      if (clip) params.clip = { ...clip, scale: scale || 1 };
      const r = await api.cdp('Page.captureScreenshot', params);
      return r.data; // base64
    },
    async close() {
      try { await browser.close({ silent: true }); } catch { /* ignore */ }
      try { await serverRes.cleanupServer(true); } catch { /* ignore */ }
    },
    browser,
  };
  return api;
}
