#!/usr/bin/env node
/**
 * Headless content screenshot for Cocos Creator 3.x web builds.
 *
 * Why this exists: in the editor's edit-mode the render pipeline does NOT
 * rasterize scene geometry into a custom RenderTexture, and the in-editor
 * gameView preview runs in a separate engine context the MCP scene process
 * can't reach. So the only way to get a REAL engine render of just the Canvas
 * content (no editor chrome) is to run the actual runtime. This script loads a
 * web build in headless Chrome, switches to the target scene, waits for it to
 * render, and screenshots the game canvas — producing a content-only PNG at the
 * design resolution with a transparent (or chosen) background.
 *
 * Pipeline: static-serve the web build -> headless Chrome -> wait engine boot
 *   -> director.loadScene(name) -> wait assets+layout+frames -> canvas screenshot.
 *
 * Usage:
 *   node headless-screenshot.js --build <web-build-dir> --scene <name|db://...>
 *        [--out <png>] [--width N] [--height N]
 *        [--bg r,g,b,a]  (0-255; default transparent)
 *        [--chrome <path>] [--timeout ms] [--keep-fps]
 *
 * Exit 0 on success; prints a JSON result line (success,path,width,height,opaquePixels...).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- self-contained PNG encoder (RGBA8 -> PNG, no external deps) ----
// Kept inline so this script is a single portable file (works in the cocosMcp
// repo and in any copy, e.g. dropped into the RT project). Mirrors the logic of
// cocosMcp/source/tools/cocos/utils/png-encoder.ts.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let _crc;
function crcTable() {
    if (_crc) return _crc;
    _crc = new Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); _crc[n] = c >>> 0; }
    return _crc;
}
function crc32(buf) { const t = crcTable(); let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
    const tb = Buffer.from(type, 'ascii'), lb = Buffer.alloc(4), cb = Buffer.alloc(4);
    lb.writeUInt32BE(data.length, 0);
    cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
    return Buffer.concat([lb, tb, data, cb]);
}
function encodePng(opts) {
    const { width, height, flipY } = opts;
    const src = Buffer.isBuffer(opts.rgba) ? opts.rgba : Buffer.from(opts.rgba);
    const rowBytes = width * 4;
    const raw = Buffer.alloc((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
        const sy = flipY ? (height - 1 - y) : y;
        raw[y * (rowBytes + 1)] = 0;
        src.copy(raw, y * (rowBytes + 1) + 1, sy * rowBytes, sy * rowBytes + rowBytes);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8); ihdr.writeUInt8(6, 9); ihdr.writeUInt8(0, 10); ihdr.writeUInt8(0, 11); ihdr.writeUInt8(0, 12);
    return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- arg parsing ----
function parseArgs(argv) {
    const a = {};
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        if (k.startsWith('--')) {
            const key = k.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) { a[key] = true; }
            else { a[key] = next; i++; }
        }
    }
    return a;
}
const args = parseArgs(process.argv);

function fail(msg) {
    console.log(JSON.stringify({ success: false, error: msg }));
    process.exit(1);
}

const BUILD_DIR = args.build && path.resolve(args.build);
if (!BUILD_DIR || !fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
    fail(`--build must point to a web build dir containing index.html (got: ${args.build})`);
}
// Scene: accept a db:// path or a bare name; we use the basename without extension.
let sceneArg = args.scene;
if (!sceneArg || sceneArg === true) fail('--scene <name|db://assets/.../X.scene> is required');
const sceneName = String(sceneArg).replace(/^db:\/\//, '').replace(/\.scene$/, '').split('/').pop();

const OUT = args.out ? path.resolve(args.out) : path.join(require('os').tmpdir(), `cocos3x_headless_${sceneName}.png`);
const WANT_W = args.width ? parseInt(args.width, 10) : 0;
const WANT_H = args.height ? parseInt(args.height, 10) : 0;
let BG = { r: 0, g: 0, b: 0, a: 0 };
if (args.bg && args.bg !== true) {
    const p = String(args.bg).split(',').map(s => parseInt(s.trim(), 10));
    BG = { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p[3] === undefined ? 255 : p[3] };
}
const TIMEOUT = args.timeout ? parseInt(args.timeout, 10) : 30000;
const KEEP_FPS = !!args['keep-fps'];
// Optional: deactivate node(s) by name before capture (comma-separated). Useful to
// drop a scene's full-screen background to verify a truly transparent capture.
const HIDE_NODES = (args.hide && args.hide !== true) ? String(args.hide).split(',').map(s => s.trim()).filter(Boolean) : [];

// Locate system Chrome (avoid bundling Chromium).
function findChrome() {
    if (args.chrome && args.chrome !== true) return args.chrome;
    const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
}

// ---- minimal static file server for the build dir ----
const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.mp3': 'audio/mpeg',
    '.ttf': 'font/ttf', '.plist': 'application/xml', '.svg': 'image/svg+xml',
};
function startServer(root) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let urlPath = decodeURIComponent(req.url.split('?')[0]);
            if (urlPath === '/') urlPath = '/index.html';
            const filePath = path.join(root, urlPath);
            if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                res.writeHead(404); res.end('not found'); return;
            }
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
            fs.createReadStream(filePath).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

// ---- in-page driver: boot wait + loadScene + readiness + transparent bg ----
// Runs inside the headless page. Returns {ok, w, h, err}.
function pageDriver(sceneName, wantW, wantH, bg, keepFps, hideNodes) {
    return new Promise((resolve) => {
        const T0 = Date.now();
        const HARD = 25000;
        function err(m) { resolve({ ok: false, err: m, t: Date.now() - T0 }); }

        // 1) Wait for the engine to FULLY boot AND the start scene to actually be
        //    running before we switch scenes. Proceeding as soon as `director` exists
        //    races the in-flight start-scene load, which then clobbers our loadScene
        //    (capturing the start scene instead of the target). Require getScene() to
        //    return a real scene, then a short settle.
        let bootSeenAt = 0;
        (function waitEngine() {
            const cc = window.cc;
            const scene = cc && cc.director && cc.director.getScene ? cc.director.getScene() : null;
            const booted = cc && cc.director && cc.game && cc.game.canvas && scene && scene.name;
            if (booted) {
                if (!bootSeenAt) bootSeenAt = Date.now();
                // Let the start scene fully settle so its async load can't clobber ours.
                if (Date.now() - bootSeenAt >= 600) { afterEngine(cc); return; }
            }
            if (Date.now() - T0 > HARD) { err('engine did not boot (no running scene)'); return; }
            setTimeout(waitEngine, 50);
        })();

        function afterEngine(cc) {
            try {
                const dr = cc.view && cc.view.getDesignResolutionSize ? cc.view.getDesignResolutionSize() : null;
                const W = wantW || (dr && dr.width) || 960;
                const H = wantH || (dr && dr.height) || 640;
                window.__shot = { W: Math.round(W), H: Math.round(H) };

                // Switch to the target scene (the build starts at the project start scene).
                let switched = false;
                // loadScene returns false synchronously for an unknown scene and never
                // calls back — guard with that and a timeout so a bad scene name yields
                // a clean error instead of hanging until the outer timeout.
                const ret = cc.director.loadScene(sceneName, function (e) {
                    switched = true;
                    if (e) { err('loadScene("' + sceneName + '") failed: ' + (e.message || e)); return; }
                    const cur = cc.director.getScene();
                    window.__loadedScene = cur ? cur.name : null;
                    afterScene(cc, Math.round(W), Math.round(H));
                });
                if (ret === false) { err('Scene not found in build: "' + sceneName + '". Check the scene name/path, or rebuild (rebuild:true) if it was added/renamed.'); return; }
                setTimeout(() => { if (!switched) err('loadScene("' + sceneName + '") timed out (scene may not exist in the build).'); }, 8000);
            } catch (e) { err('afterEngine: ' + (e && e.message || e)); }
        }

        function afterScene(cc, W, H) {
            try {
                // Hide the FPS/profiler stats overlay so it isn't captured as content.
                // Must be DETERMINISTIC for pixel-diff baselines: the engine can
                // (re)create the PROFILER_NODE on scene load and re-show stats a frame
                // later, so a one-shot hideStats() races. We hide it three ways and
                // re-apply every frame (see hideProfiler in the per-frame hook below):
                //   1) cc.profiler.hideStats()  2) deactivate the PROFILER_NODE
                //   3) zero the profiler setting so it can't re-show.
                const hideProfiler = () => {
                    if (keepFps) return;
                    try { if (cc.profiler && cc.profiler.hideStats) cc.profiler.hideStats(); } catch (e) {}
                    try {
                        const sc = cc.director.getScene();
                        if (sc) {
                            for (const n of sc.children) {
                                if (n && n.name === 'PROFILER_NODE') { n.active = false; }
                            }
                        }
                    } catch (e) {}
                    try { if (cc.settings && cc.settings.overrideSettings) cc.settings.overrideSettings('profiling', 'showFPS', false); } catch (e) {}
                };
                hideProfiler();
                window.__hideProfiler = hideProfiler;

                // Optionally deactivate named nodes (e.g. a full-screen Background) so
                // a truly transparent capture can be produced for verification.
                if (hideNodes && hideNodes.length) {
                    try {
                        const sc0 = cc.director.getScene();
                        const want = new Set(hideNodes);
                        (function walk(n) {
                            if (!n) return;
                            if (want.has(n.name)) n.active = false;
                            (n.children || []).forEach(walk);
                        })(sc0);
                    } catch (e) {}
                }

                // The web build's style.css gives <body> an opaque grey background.
                // With a transparent canvas, that grey would show through the canvas
                // compositing (and leak into the element screenshot). Null out the
                // page background so only the canvas content is captured.
                if (bg.a === 0) {
                    try {
                        document.documentElement.style.background = 'transparent';
                        document.body.style.background = 'transparent';
                        const c = cc.game.canvas;
                        if (c) c.style.background = 'transparent';
                    } catch (e) {}
                }

                // Make the on-screen canvas exactly the design resolution and force
                // the Canvas camera(s) to clear to the requested (transparent) color.
                const scene = cc.director.getScene();
                const Color = cc.Color;
                const cams = [];
                (function walk(n) {
                    if (!n) return;
                    if (n.getComponent) {
                        const cam = n.getComponent(cc.Camera);
                        if (cam) cams.push(cam);
                    }
                    (n.children || []).forEach(walk);
                })(scene);
                const diag = { forcedAlpha: !!window.__forcedAlpha, camCount: cams.length, camInfo: [] };
                const FLAG = cc.gfx.ClearFlagBit;
                // Re-apply the requested clear color to every camera (component +
                // low-level render camera) BEFORE EACH DRAW. The engine re-syncs the
                // low-level camera from the component each frame, so a one-shot set is
                // overwritten — re-applying every frame keeps it stuck until capture.
                const applyClear = () => {
                    // Keep the FPS overlay hidden every frame (it can re-show otherwise).
                    hideProfiler();
                    for (const cam of cams) {
                        try {
                            cam.clearColor = new Color(bg.r, bg.g, bg.b, bg.a);
                            cam.clearFlags = FLAG.ALL;
                            const low = cam.camera;
                            if (low) {
                                if (low.clearColor && typeof low.clearColor.set === 'function') {
                                    low.clearColor.set(bg.r / 255, bg.g / 255, bg.b / 255, bg.a / 255);
                                } else {
                                    low.clearColor = { x: bg.r / 255, y: bg.g / 255, z: bg.b / 255, w: bg.a / 255 };
                                }
                                if ('clearFlag' in low) low.clearFlag = FLAG.ALL;
                            }
                        } catch (e) {}
                    }
                };
                applyClear();
                try { cc.director.on(cc.Director.EVENT_BEFORE_DRAW, applyClear); } catch (e) {}
                window.__applyClear = applyClear;
                for (const cam of cams) {
                    const low = cam.camera;
                    diag.camInfo.push({ node: cam.node && cam.node.name, afterClear: [cam.clearColor.r, cam.clearColor.g, cam.clearColor.b, cam.clearColor.a], clearFlags: cam.clearFlags, lowClear: low && low.clearColor ? [Math.round(low.clearColor.x * 255), Math.round(low.clearColor.y * 255), Math.round(low.clearColor.z * 255), Math.round(low.clearColor.w * 255)] : null });
                }
                window.__diag = diag;
                // NOTE: do NOT force canvas.width/height here — the engine's design
                // resolution policy already sizes the backbuffer, and resizing
                // mid-switch can capture a stale/previous scene. The page viewport is
                // set to the target size before load so the canvas comes up correct.
                diag.canvasWH = [cc.game.canvas.width, cc.game.canvas.height];

                // Wait for several real frames, then read the WebGL pixels DIRECTLY
                // off the backbuffer (inside the AFTER_DRAW handler, before the browser
                // composites/clears). This bypasses puppeteer's element-screenshot
                // compositing — which leaks the page background and drops alpha — and
                // gives the exact canvas content with a correct alpha channel.
                const canvas = cc.game.canvas;
                const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
                let frames = 0;
                let done = false;
                const finish = (rgbaBase64) => {
                    if (done) return; done = true;
                    cc.director.off(cc.Director.EVENT_AFTER_DRAW, onDraw);
                    // Report the ACTUAL backbuffer dimensions (the PNG must match what
                    // gl.readPixels returned, not the requested size which the engine's
                    // resolution policy may have adjusted).
                    resolve({ ok: true, w: canvas.width, h: canvas.height, requestedW: W, requestedH: H, frames: frames, diag: window.__diag, rgbaBase64: rgbaBase64, glReadback: !!rgbaBase64 });
                };
                const grab = () => {
                    try {
                        try { const s = cc.director.getScene(); window.__diag.sceneAtGrab = s ? s.name : null; window.__diag.topKids = s ? s.children.map(function(c){return c.name;}) : null; } catch (e) {}
                        if (gl && !window.__diag.glAlpha) {
                            const a = gl.getContextAttributes ? gl.getContextAttributes() : null;
                            window.__diag.glAlpha = a ? a.alpha : null;
                            window.__diag.glPreserve = a ? a.preserveDrawingBuffer : null;
                        }
                        const cw = canvas.width, ch = canvas.height;
                        const buf = new Uint8Array(cw * ch * 4);
                        gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, buf);
                        // base64-encode in-page (binary-safe).
                        let bin = '';
                        const CHUNK = 0x8000;
                        for (let i = 0; i < buf.length; i += CHUNK) {
                            bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
                        }
                        return btoa(bin);
                    } catch (e) { return null; }
                };
                // Give the freshly-loaded scene time to (a) finish loading async
                // sprite/font textures and (b) settle layout, BEFORE we start counting
                // the frames we capture. Reading too early can grab the previous scene
                // (preserveDrawingBuffer keeps the last frame) or a half-loaded one.
                const SETTLE_MS = 1200;
                const t0 = Date.now();
                let counting = false;
                const onDraw = () => {
                    if (!counting) {
                        if (Date.now() - t0 < SETTLE_MS) return;
                        counting = true; frames = 0;
                    }
                    frames++;
                    if (frames >= 4) {
                        const data = gl ? grab() : null;
                        finish(data);
                    }
                };
                cc.director.on(cc.Director.EVENT_AFTER_DRAW, onDraw);
                // Safety timeout: if AFTER_DRAW stalls, grab whatever is there.
                setTimeout(() => { if (!done) finish(gl ? grab() : null); }, SETTLE_MS + 4000);
            } catch (e) { err('afterScene: ' + (e && e.message || e)); }
        }
    });
}

// ---- main ----
(async () => {
    const chromePath = findChrome();
    if (!chromePath) fail('No Chrome/Chromium/Edge found. Pass --chrome <path>.');

    // Resolve puppeteer-core. Modern puppeteer-core ships as ESM, which can't be
    // require()'d from CommonJS (and we run under ELECTRON_RUN_AS_NODE), so load it
    // via dynamic import(). Try a passed --puppeteer path, then common locations,
    // so this single file works both in-repo and when copied into the extension.
    let puppeteer;
    const { pathToFileURL } = require('url');
    const ppCandidates = [
        'puppeteer-core',
        path.join(__dirname, 'node_modules', 'puppeteer-core'),
        path.join(__dirname, '..', 'node_modules', 'puppeteer-core'),
        path.join(__dirname, '..', '..', 'node_modules', 'puppeteer-core'),
        // 通用兜底：从调用进程的工作目录解析（不再硬编码任何作者机器上的绝对路径）。
        path.join(process.cwd(), 'node_modules', 'puppeteer-core'),
    ];
    if (args['puppeteer'] && args['puppeteer'] !== true) ppCandidates.unshift(args['puppeteer']);
    let ppErr = '';
    for (const c of ppCandidates) {
        try {
            // For bare specifiers, import by name; for filesystem paths, import the
            // package's resolved entry. Resolve via require.resolve first so import()
            // gets the actual ESM entry file URL.
            let mod;
            if (c.startsWith('/') || c.startsWith('.')) {
                let entry;
                try { entry = require.resolve(c); } catch (e) { entry = path.join(c, 'lib', 'esm', 'puppeteer', 'puppeteer-core.js'); }
                mod = await import(pathToFileURL(entry).href);
            } else {
                mod = await import(c);
            }
            puppeteer = mod.default || mod;
            if (puppeteer && (puppeteer.launch || (puppeteer.default && puppeteer.default.launch))) {
                puppeteer = puppeteer.launch ? puppeteer : puppeteer.default;
                break;
            }
            puppeteer = null;
        } catch (e) { ppErr = String(e && e.message || e); }
    }
    if (!puppeteer || typeof puppeteer.launch !== 'function') {
        fail('puppeteer-core not loadable (ESM import failed). Last error: ' + ppErr + '. Pass --puppeteer <dir>.');
    }

    const server = await startServer(BUILD_DIR);
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/index.html`;

    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--use-gl=angle',
                '--use-angle=swiftshader',           // software WebGL — reliable in headless
                '--enable-webgl',
                '--ignore-gpu-blocklist',
                '--hide-scrollbars',
                '--mute-audio',
                '--force-device-scale-factor=1',
            ],
        });
        const page = await browser.newPage();
        await page.setViewport({ width: Math.max(WANT_W || 960, 320), height: Math.max(WANT_H || 640, 240), deviceScaleFactor: 1 });

        const pageErrors = [];
        page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
        page.on('console', m => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text()); });

        // Patch HTMLCanvasElement.getContext BEFORE any page script runs:
        //  - alpha:true so a transparent backbuffer is possible (the engine otherwise
        //    creates the context opaque from cc.macro.ENABLE_TRANSPARENT_CANVAS=false,
        //    which we can't reliably flip before context creation);
        //  - preserveDrawingBuffer:true so gl.readPixels returns the rendered frame
        //    instead of a cleared buffer.
        // We then read the canvas pixels directly (in the page driver) and encode the
        // PNG in Node — bypassing puppeteer's element screenshot, which composites the
        // canvas against the page's grey body background and drops the alpha channel.
        await page.evaluateOnNewDocument((wantAlpha) => {
            try {
                const orig = HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext = function (type, attrs) {
                    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
                        attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
                        if (wantAlpha) { attrs.alpha = true; attrs.premultipliedAlpha = true; window.__forcedAlpha = true; }
                        else { attrs.alpha = false; }
                    }
                    return orig.call(this, type, attrs);
                };
            } catch (e) { /* ignore */ }
        }, BG.a === 0);

        await page.goto(url, { waitUntil: 'networkidle2', timeout: TIMEOUT });

        const driveResult = await page.evaluate(pageDriver, sceneName, WANT_W, WANT_H, BG, KEEP_FPS, HIDE_NODES);
        if (!driveResult || !driveResult.ok) {
            fail(`in-page driver failed: ${driveResult && driveResult.err}. pageErrors=${JSON.stringify(pageErrors.slice(0, 5))}`);
        }
        const W = driveResult.w, H = driveResult.h;

        let pngBuf;
        let opaquePixels;
        if (driveResult.rgbaBase64) {
            // Direct WebGL readback path (preferred): exact content + correct alpha.
            const rgba = Buffer.from(driveResult.rgbaBase64, 'base64');
            opaquePixels = 0;
            for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) opaquePixels++;
            // gl.readPixels is bottom-up; flip to top-down for PNG.
            pngBuf = encodePng({ rgba, width: W, height: H, flipY: true });
        } else {
            // Fallback: puppeteer element screenshot (may include page bg / no alpha).
            const canvasEl = await page.$('#GameCanvas') || await page.$('canvas');
            if (!canvasEl) fail('No game canvas element found and no GL readback.');
            pngBuf = await canvasEl.screenshot({ omitBackground: BG.a === 0, type: 'png' });
        }
        fs.writeFileSync(OUT, pngBuf);

        console.log(JSON.stringify({
            success: true,
            path: OUT,
            width: W,
            height: H,
            bytes: pngBuf.length,
            scene: sceneName,
            background: BG,
            frames: driveResult.frames,
            opaquePixels: opaquePixels,
            captureMethod: driveResult.rgbaBase64 ? 'gl-readback' : 'puppeteer-screenshot',
            diag: driveResult.diag,
            pageErrors: pageErrors.slice(0, 3),
        }));
        await browser.close();
        server.close();
        process.exit(0);
    } catch (e) {
        try { if (browser) await browser.close(); } catch (_) {}
        try { server.close(); } catch (_) {}
        fail('headless run error: ' + (e && e.message || e));
    }
})();
