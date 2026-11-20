// Navegador Chromium opcional em segundo plano (Playwright), com perfil persistente para lembrar as verificações feitas pela pessoa.
// Sem Playwright ou Chromium, as funções devolvem null/false e o resto continua funcionando.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// User-Agent de computador com a versão principal real do Chromium instalado. Uma versão antiga fixa contradizia
// o navegador e fazia verificações como DiamWall do Z-Library recusarem até cliques humanos.
// Sites vinculam cookies ao User-Agent, que só muda quando o Chromium é atualizado.
const uaFor = version => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(version).split('.')[0]}.0.0.0 Safari/537.36`;
let chromeUa = '';
const IDLE_CLOSE_MS = 5 * 60 * 1000;

let profileDir = path.join(process.cwd(), 'data', 'browser-profile');
export const setProfileDir = d => { profileDir = path.join(d, 'browser-profile'); };

let ctx = null;
let idleTimer = null;
let chain = Promise.resolve();

// O Playwright vem junto do pacote original (node_modules ao lado do launcher). Uma atualização roda de outra pasta, sem node_modules:
// por isso também se procura em SLEUTH_BUNDLE_DIR, a pasta do pacote.
const requires = () => [createRequire(import.meta.url), ...(process.env.SLEUTH_BUNDLE_DIR ? [createRequire(path.join(process.env.SLEUTH_BUNDLE_DIR, 'package.json'))] : [])];
const playwright = async () => {
    for (const name of ['playwright', 'playwright-core']) {
        for (const req of requires()) {
            try {
                const m = await import(pathToFileURL(req.resolve(name)).href);
                return m.chromium ? m : (m.default && m.default.chromium ? m.default : null);
            } catch { /* tenta o próximo */ }
        }
    }
    return null;
};
const packageDir = () => {
    for (const name of ['playwright', 'playwright-core']) {
        for (const req of requires()) { try { return path.dirname(req.resolve(name + '/package.json')); } catch { /* tenta o próximo */ } }
    }
    return '';
};
export const setBrowsersDir = d => { if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(d, 'browsers'); };
// page.content() aguarda navegações em andamento, indefinidamente se a página nunca terminar de carregar.
const htmlOf = page => Promise.race([page.content().catch(() => ''), new Promise(ok => setTimeout(() => ok(''), 5000).unref())]);
// Cada tarefa tem no máximo 60 segundos para impedir que uma página travada bloqueie as próximas;
// depois retorna a alternativa. Ressalva: a página travada fica aberta até o encerramento por ociosidade.
const queue = (fn, fallback = null) => {
    const run = () => Promise.race([fn(), new Promise(ok => setTimeout(() => { console.warn('Background browser job took over 60 s, skipped'); ok(fallback); }, 60e3).unref())]);
    const p = chain.then(run, run); chain = p.catch(() => {}); return p;
};

export const browserAvailable = async () => {
    const pw = await playwright();
    try { return !!pw && fs.existsSync(pw.chromium.executablePath()); } catch (e) { return false; }
};

let installing = null;
export async function ensureBrowser() {
    const pw = await playwright();
    if (!pw) return false;
    if (await browserAvailable()) return true;
    if (installing && !installing.error) return false;
    installing ={ at: Date.now(), error: '', log: '' };
    console.log('Setting up the background browser (one time, about 150 MB)...');
    try {
        // O arquivo da CLI não é exportado como subcaminho; procura ao lado de package.json.
        const cli = path.join(packageDir(), 'cli.js');
        await new Promise((done, fail) => {
            const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            const keep = d => { installing.log = (installing.log + d).slice(-400); };
            child.stdout.on('data', keep); child.stderr.on('data', keep);
            child.on('exit', code => (code === 0 ? done() : fail(new Error('A instalação terminou com o código ' + code)))).on('error', fail);
        });
    } catch (e) {
        installing.error = String(e && e.message || e).slice(0, 160);
        console.warn('Could not set up the background browser automatically. Run: npx playwright install chromium');
    }
    const ok = await browserAvailable();
    if (ok) installing = null; else if (!installing.error) installing.error = 'O Chromium não ficou disponível';
    return ok;
}
export async function browserInfo() {
    const pw = await playwright();
    return { driver: !!pw, available: (await browserAvailable()) && !(installing && !installing.error), sandboxed, installing: installing ? { running: !installing.error, error: installing.error, since: installing.at, log: installing.log.split(/[\r\n]+/).filter(Boolean).pop() || '' } : null, open: !!verify };
}
export const installBrowser = () => { ensureBrowser().catch(() => {}); return browserInfo(); };

// O Chromium executa isolado para impedir que páginas alcancem o restante do servidor. Alguns hosts bloqueiam
// recursos do kernel necessários ao isolamento em contêineres (namespaces de usuário); nesses casos, executa sem isolamento,
// registra no log e informa em Sistema no painel de administração.
let sandboxed = null;
export const browserSandboxed = () => sandboxed;
const sandboxRefused = e => /sandbox|namespace|clone|Operation not permitted|setuid/i.test(String(e && e.message));
async function launchBoth(pw, args, sandbox) {
    const opts = { headless: true, channel: 'chromium', chromiumSandbox: sandbox, args, ignoreDefaultArgs: ['--enable-automation'] };
    if (!chromeUa) { const b = await pw.chromium.launch(opts); chromeUa = uaFor(b.version()); await b.close(); }
    return pw.chromium.launchPersistentContext(profileDir, { ...opts, userAgent: chromeUa });
}
async function headlessContext() {
    if (!ctx) {
        const pw = await playwright();
        if (!pw) return null;
        const args = [...(process.env.BROWSER_IN_CONTAINER ? ['--disable-dev-shm-usage'] : []), '--disable-blink-features=AutomationControlled'];
        if (sandboxed !== false) {
            try { ctx = await launchBoth(pw, args, true); sandboxed = true; }
            catch (e) {
                if (!sandboxRefused(e)) throw e;
                sandboxed = false;
                console.warn('The background browser cannot use its sandbox here, so it runs without it. In Docker this is expected unless the container is allowed to create user namespaces.');
            }
        }
        if (!ctx) ctx = await launchBoth(pw, args, false);
        ctx.on('close', () => { ctx = null; });
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (ctx && !verify) ctx.close().catch(() => {}); }, IDLE_CLOSE_MS);
    return ctx;
}

export function browserGet(url, { isReady = () => true, timeoutMs = 20000 } = {}) {
    return queue(async () => {
        let page;
        try {
            const c = await headlessContext();
            if (!c) return null;
            page = await c.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const html = await htmlOf(page);
                if (isReady(html)) return html;
                await page.waitForTimeout(500);
            }
            return null;
        } catch (e) { return null; } finally { if (page) await page.close().catch(() => {}); }
    });
}

let apiPage = null;
export function browserFetch(origin, path, init, blocked, cookie = '') {
    return queue(async () => {
        try {
            const c = await headlessContext();
            if (!c) return null;
            if (!apiPage || apiPage.isClosed() || !apiPage.url().startsWith(origin)) {
                if (apiPage && !apiPage.isClosed()) await apiPage.close().catch(() => {});
                apiPage = await c.newPage();
                await apiPage.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            }
            const until = Date.now() + 12000;
            while (blocked(await htmlOf(apiPage)) && Date.now() < until) await apiPage.waitForTimeout(500);
            if (blocked(await htmlOf(apiPage))) { await apiPage.close().catch(() => {}); apiPage = null; return null; }
            const jar = cookie.split(/;\s*/).map(kv => kv.split('=')).filter(([n, v]) => n && v);
            if (jar.length) await c.addCookies(jar.map(([name, value]) => ({ name, value, url: origin })));
            return await apiPage.evaluate(([u, i]) => fetch(u, { ...i, signal: AbortSignal.timeout(15000) }).then(async r => ({ status: r.status, text: await r.text() })), [path, init]);
        } catch (e) { return null; }
    });
}

export const VIEWPORT = { width: 1000, height: 860 };
const VERIFY_MAX_MS = 10 * 60 * 1000;
let verify = null;
export const verifyWindowOpen = () => !!verify;

export function startVerification(url, { phone = false } = {}) {
    return queue(async () => {
        if (verify) return { ok: true };
        try {
            const c = await headlessContext();
            if (!c) return { ok: false, reason: 'Playwright/Chromium is not installed.' };
            const host = new URL(url).hostname;
            const page = await c.newPage();
            const size = phone ? { width: 420, height: 760 } : VIEWPORT;
            await page.setViewportSize(size);
            try {
                const cdp = await c.newCDPSession(page);
                await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: phone });
            } catch (e) { }
            await page.route('**/*', route => {
                const r = route.request();
                if (r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).hostname !== host) return route.abort();
                return route.continue();
            });
            if (!c.popupGuard) { c.popupGuard = true; c.on('page', p => { if (verify && p !== verify.page) p.close().catch(() => {}); }); }
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            const stop = () => { if (verify && verify.page === page) { clearTimeout(verify.timer); verify = null; } page.close().catch(() => {}); };
            verify = { page, timer: setTimeout(stop, VERIFY_MAX_MS) };
            page.on('close', () => { if (verify && verify.page === page) { clearTimeout(verify.timer); verify = null; } });
            return { ok: true };
        } catch (e) { return { ok: false, reason: 'Could not start the browser: ' + String(e.message).split('\n')[0].slice(0, 120) }; }
    }, { ok: false, reason: 'The background browser is busy or stuck. Try again, or restart it in the admin panel, under System.' });
}

export async function verificationHtml() {
    if (!verify) return '';
    return htmlOf(verify.page);
}

// Região relevante: caixa “Não sou um robô” ou desafio com imagem, campo e botão
// dentro do quadro. DDoS-Guard (Anna's Archive) ou DiamWall (Z-Library). null indica a página inteira.
const CHECKS = [['#ddg-captcha iframe', ['#ddg-challenge', '.ddg-captcha']], ['iframe#verification', ['.dw-captcha-root']]];
async function checkArea(page) {
    try {
        let host = null, sels;
        for (const [h, inner] of CHECKS) { host = await page.$(h); if (host) { sels = inner; break; } }
        if (!host) return null;
        const outer = await host.boundingBox();
        const frame = await host.contentFrame();
        if (!outer || !frame) return null;
        const inner = await frame.evaluate(sels => {
            const shown = el => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
            const el = sels.map(q => document.querySelector(q)).find(shown);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        }, sels);
        if (!inner) return null;
        const vp = page.viewportSize(), pad = 20;
        const x = Math.max(0, outer.x + inner.x - pad), y = Math.max(0, outer.y + inner.y - pad);
        const width = Math.min(vp.width - x, inner.width + pad * 2), height = Math.min(vp.height - y, inner.height + pad * 2);
        return width > 40 && height > 30 ? { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } : null;
    } catch (e) { return null; }
}

export async function verificationFrame({ full = false } = {}) {
    if (!verify) return null;
    try {
        const page = verify.page, vp = page.viewportSize();
        const clip = full ? null : await checkArea(page);
        let img;
        for (const quality of [60, 40, 25]) {
            img = await page.screenshot({ type: 'jpeg', quality, scale: clip ? 'device' : 'css', ...(clip ? { clip } : {}) });
            if (img.length < 150000) break;
        }
        return { img, area: clip || { x: 0, y: 0, width: vp.width, height: vp.height } };
    } catch (e) { return null; }
}

export async function verificationInput(ev) {
    if (!verify) return false;
    const { page } = verify, num = v => Math.max(0, Math.min(5000, Number(v) || 0));
    try {
        if (ev.type === 'click') { await page.mouse.move(num(ev.x), num(ev.y), { steps: 4 }); await page.mouse.click(num(ev.x), num(ev.y), { delay: 60 }); }
        else if (ev.type === 'move') await page.mouse.move(num(ev.x), num(ev.y));
        else if (ev.type === 'type') await page.keyboard.type(String(ev.text || '').slice(0, 200));
        else if (ev.type === 'key') await page.keyboard.press(String(ev.key || '').slice(0, 30));
        else if (ev.type === 'scroll') await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(ev.dy) || 0)));
        else return false;
        return true;
    } catch (e) { return false; }
}

export async function reloadVerification() {
    if (!verify) return false;
    try { await verify.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); return true; } catch (e) { return false; }
}

export function stopVerification() {
    if (!verify) return;
    clearTimeout(verify.timer);
    const { page } = verify;
    verify = null;
    page.close().catch(() => {});
}

export async function restartBrowser() {
    stopVerification();
    if (ctx) await ctx.close().catch(() => {});
    ctx = null;
    return browserAvailable();
}
