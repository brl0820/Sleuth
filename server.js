// Sleuth: servidor do addon de busca de livros e audiolivros.
// Rotas: /search/start|poll|all, /resolve, /relink, /zliblink, /status, /dl/*, /torrent e /api/* (painel e confirmação de acesso).
import { startAddon, json, configurePage, readJson } from './src/kit.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appSettings } from './src/app-settings.js';
import { manifest } from './src/manifest.js';
import { runsAsPackage } from './src/host.js';
import { createUpdater, DEFAULT_REPO } from './src/update.js';
import core, {
    setUserAgentMode, setCreds, setSourcesOff, freshLibgenLink, zlibFileLink, sourceHealth, setUserMirrors, setCustomSources, testSource, mirrorStatus, activeSources, verifyNeeded,
    annasVerifyUrl, zlibVerifyUrl, annasPageState, zlibPageState, annasRecheck, zlibRecheck, testMirror, mirrorServices, SOURCE_ORIGINS, setUserDownloads, downloadStatus, downloadServices, testDownload,
} from './src/sources.js';
import { logAccesses, aboutInfo } from './src/about.js';
import { settings } from './src/config.js';
import { slum, refreshSlum, slumSummary } from './src/slum.js';
import { createJobs } from './src/jobs.js';
import * as state from './src/state.js';
import { searchCustom, clearTemplates, cleanCatalogUrl } from './src/custom.js';
import {
    setProfileDir, setBrowsersDir, browserInfo, installBrowser, startVerification, verificationFrame, verificationInput, verificationHtml, stopVerification, reloadVerification, restartBrowser,
} from './src/browser.js';

const PORT = Number(process.env.PORT) || 7002;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const INTERNAL_URL = process.env.INTERNAL_URL || PUBLIC_URL;
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
setProfileDir(state.dir());
setBrowsersDir(state.dir());
logAccesses();

// Atualização automática (só quando iniciado pelo launcher). Depois de instalada, reinicia quando o addon está ocioso: o app (ou o
// Docker, com SLEUTH_RESTART=1) sobe o processo de novo e o launcher escolhe a versão nova.
let lastActivity = Date.now();
const restartable = runsAsPackage() || process.env.SLEUTH_RESTART === '1';
let restartTimer = null;
function scheduleRestart(info) {
    if (!restartable || restartTimer) return;
    const since = Date.now();
    restartTimer = setInterval(() => {
        if (Date.now() - lastActivity < 30000 && Date.now() - since < 10 * 60000) return;
        console.log('Reiniciando para aplicar a versão', info.version);
        process.exit(0);
    }, 10000);
}
const updater = createUpdater({
    dataDir: state.dir(), version: VERSION, supervised: restartable, onInstalled: scheduleRestart,
    enabled: process.env.SLEUTH_LAUNCHER === '1' && process.env.SLEUTH_UPDATES !== '0',
    auto: () => state.load().updates.auto !== false, repo: () => state.load().updates.repo || DEFAULT_REPO,
});
updater.start();

const cacheStore = new Map();
globalThis.caches = {
    default: {
        async match(req) { const hit = cacheStore.get(req.url); if (!hit || hit.exp < Date.now()) { cacheStore.delete(req.url); return undefined; } return new Response(hit.body, { headers: hit.headers }); },
        async put(req, res) {
            const m = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '');
            cacheStore.set(req.url, { body: await res.text(), headers: [...res.headers], exp: Date.now() + (m ? +m[1] : 60) * 1000 });
            while (cacheStore.size > 300) cacheStore.delete(cacheStore.keys().next().value);
        },
    },
};

const SOURCES = [
    ['libgen', 'Library Genesis', ['ebooks'], ''], ['annas', "Anna's Archive", ['ebooks'], 'opcional'], ['zlibrary', 'Z-Library', ['ebooks'], 'opcional'], ['archive', 'Internet Archive', ['ebooks', 'audiobooks'], ''],
    ['gutenberg', 'Project Gutenberg', ['ebooks'], ''], ['openstax', 'OpenStax', ['ebooks'], ''], ['libretexts', 'LibreTexts', ['ebooks'], ''], ['memoryoftheworld', 'Memory of the World', ['ebooks'], ''],
    ['royallib', 'RoyalLib', ['ebooks'], ''], ['mobilism', 'Mobilism', ['ebooks'], 'exige'],
    ['audiobookbay', 'AudiobookBay', ['audiobooks'], ''], ['librivox', 'LibriVox', ['audiobooks'], ''], ['audiobooksbee', 'AudiobooksBee', ['audiobooks'], ''],
];
const ON_BY_DEFAULT = id => id !== 'mobilism';
const nameOf = id => {
    const hit = SOURCES.find(s => s[0] === id);
    if (hit) return hit[1];
    const c = state.load().custom.find(x => 'c:' + x.id === id);
    return c ? c.name : id;
};
const ACTION = { page: 'verificar', label: 'Confirmar acesso' };

const jobs = createJobs({
    labels: nameOf,
    active: mode => activeSources(mode),
    statusOf: id => (sourceHealth[id] || {}).status,
    actionOf: (id, status) => (status === 'verify' ? ACTION : null),
    search: (q, mode, lang) => core.fetch(new Request(new URL('/search/all?' + new URLSearchParams({ q, mode, stream: '1', ...(lang ? { pref: lang } : {}) }), 'http://addon')), {}, { waitUntil: p => p.catch(() => {}), passThroughOnException() {} }),
});
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim().slice(0, 300)]));

function apply(config) {
    const eff = state.effective(config);
    const custom = eff.custom;
    const allIds = [...SOURCES.map(s => s[0]), ...custom.map(c => 'c:' + c.id)];
    const enabled = new Set(eff.enabled || SOURCES.filter(([id]) => ON_BY_DEFAULT(id)).map(([id]) => id));
    setSourcesOff(allIds.filter(id => !enabled.has(id)));
    setCustomSources(custom);
    setUserMirrors(eff.mirrors);
    setUserDownloads(eff.downloads);
    setUserAgentMode('browser');
    const c = eff.creds, creds = {};
    const zlib = clean({ email: c.zlib_email, password: c.zlib_password, domain: c.zlib_domain });
    const mobilism = clean({ username: c.mobilism_user, password: c.mobilism_pass });
    const annas = clean({ cookie: c.annas_cookie, mirror: c.annas_mirror });
    if (Object.keys(zlib).length) creds.zlib = zlib;
    if (Object.keys(mobilism).length) creds.mobilism = mobilism;
    if (Object.keys(annas).length) creds.annas = annas;
    setCreds(creds);
    settings.sources.slum = eff.slum !== false;
    return eff;
}

// ── /api/* (chamado pela interface do addon: painel e confirmação de acesso) ──
const HEALTH_LABEL = { ok: 'No ar', unavailable: 'Indisponível', verify: 'Precisa de confirmação', error: 'Erro', timeout: 'Demorou demais' };
function panelState(config) {
    const eff = apply(config);
    const on = new Set(eff.enabled || SOURCES.filter(([id]) => ON_BY_DEFAULT(id)).map(([id]) => id));
    const row = (id, name, kinds, account, extra = {}) => {
        const h = sourceHealth[id] || null;
        return { id, name, kinds, account, enabled: on.has(id), health: h ? { status: h.status, label: HEALTH_LABEL[h.status] || h.status, at: h.at, ms: h.ms } : null, ...extra };
    };
    const c = eff.creds;
    return {
        version: VERSION,
        sources: SOURCES.map(([id, name, kinds, account]) => row(id, name, kinds, account, { builtin: true })),
        custom: eff.custom.map(x => row('c:' + x.id, x.name, ['ebooks', 'audiobooks'], '', { url: x.url, builtin: false })),
        mirrors: Object.fromEntries(mirrorIds(eff).map(s => [s, mirrorStatus(s)])),
        mirrorTests: Object.fromEntries([...mirrorTests]),
        downloads: Object.fromEntries(downloadServices().map(s => [s, downloadStatus(s)])),
        downloadTests: Object.fromEntries([...downloadTests]),
        slum: { on: eff.slum !== false, at: slum.at, error: slum.error },
        creds: { zlibrary: !!(c.zlib_email && c.zlib_password), annas: !!c.annas_cookie, mobilism: !!(c.mobilism_user && c.mobilism_pass) },
        verify: verifyNeeded(),
        tests: Object.fromEntries([...tests]),
        saved: !!state.load().enabled,
        update: updater.status(),
    };
}
const mirrorIds = eff => [...mirrorServices(), ...eff.custom.map(c => 'c:' + c.id)];
const tests = new Map();
const mirrorTests = new Map();
const downloadTests = new Map();
const sourceId = v => { const s = String(v || ''); return /^[a-z0-9:_-]{1,40}$/.test(s) ? s : ''; };

const VERIFY = {
    annas: { name: "Anna's Archive", url: () => annasVerifyUrl(), state: annasPageState, recheck: annasRecheck },
    zlibrary: { name: 'Z-Library', url: () => zlibVerifyUrl(), state: zlibPageState, recheck: zlibRecheck },
};
let verifySession = null;

async function api(route, body, config) {
    const eff = apply(config);
    switch (route) {
        case 'state': return panelState(config);
        case 'toggle': {
            const id = sourceId(body.id);
            if (!id || !(SOURCES.some(s => s[0] === id) || eff.custom.some(c => 'c:' + c.id === id))) throw Object.assign(new Error('Fonte desconhecida'), { status: 400 });
            state.update(s => {
                const cur = new Set(s.enabled || eff.enabled || SOURCES.filter(([sid]) => ON_BY_DEFAULT(sid)).map(([sid]) => sid));
                if (body.enabled) cur.add(id); else cur.delete(id);
                s.enabled = [...cur];
            });
            cacheStore.clear(); return panelState(config);
        }
        case 'mirrors': {
            const service = mirrorIds(eff).includes(body.service) ? body.service : '';
            if (!service) throw Object.assign(new Error('Serviço desconhecido'), { status: 400 });
            const list = (Array.isArray(body.list) ? body.list : []).map(x => state.cleanMirror(String(x))).filter(Boolean);
            const bad = (Array.isArray(body.list) ? body.list : []).filter(x => String(x).trim() && !state.cleanMirror(String(x)));
            if (bad.length) throw Object.assign(new Error('Endereço inválido: ' + String(bad[0]).slice(0, 60)), { status: 400 });
            state.update(s => { s.mirrors[service] = list; });
            cacheStore.clear(); return panelState(config);
        }
        case 'mirrors/test': {
            const service = mirrorIds(eff).includes(body.service) ? body.service : '';
            const origin = service ? (mirrorStatus(service).find(m => m.origin === body.origin) || {}).origin : '';
            if (!origin) throw Object.assign(new Error('Espelho desconhecido'), { status: 400 });
            const key = service + '|' + origin;
            if (!(mirrorTests.get(key) || {}).running) {
                mirrorTests.set(key, { running: true, at: Date.now() });
                testMirror(service, origin).then(r => mirrorTests.set(key, { running: false, at: Date.now(), result: r }), e => mirrorTests.set(key, { running: false, at: Date.now(), result: { status: 'error', ms: 0, error: String(e.message || e).slice(0, 140) } }));
            }
            return { ok: true };
        }
        case 'downloads': {
            const service = downloadServices().includes(body.service) ? body.service : '';
            if (!service) throw Object.assign(new Error('Fonte desconhecida'), { status: 400 });
            const raw = Array.isArray(body.list) ? body.list : [];
            const bad = raw.filter(x => String(x).trim() && !state.cleanDownload(String(x), service));
            if (bad.length) throw Object.assign(new Error('Endereço inválido: ' + String(bad[0]).slice(0, 80) + '. Use https e um endereço público; se for o endereço completo, use {md5}, {path}, {file}, {url}, {urlenc} ou {identifier} depois do domínio.'), { status: 400 });
            state.update(s => { s.downloads[service] = raw.map(x => state.cleanDownload(String(x), service)).filter(Boolean); });
            cacheStore.clear(); return panelState(config);
        }
        case 'downloads/test': {
            const service = downloadServices().includes(body.service) ? body.service : '';
            const template = service ? (downloadStatus(service).find(d => d.template === body.template) || {}).template : '';
            if (!template) throw Object.assign(new Error('Alternativa desconhecida'), { status: 400 });
            const key = service + '|' + template;
            if (!(downloadTests.get(key) || {}).running) {
                downloadTests.set(key, { running: true, at: Date.now() });
                testDownload(service, template).then(r => downloadTests.set(key, { running: false, at: Date.now(), result: r }), e => downloadTests.set(key, { running: false, at: Date.now(), result: { status: 'error', ms: 0, error: String(e.message || e).slice(0, 140) } }));
            }
            return { ok: true };
        }
        case 'about': {
            const on = new Set(eff.enabled || SOURCES.filter(([sid]) => ON_BY_DEFAULT(sid)).map(([sid]) => sid));
            const mf = manifestBase(config);
            return aboutInfo({
                version: VERSION, id: mf.id, name: mf.name, author: mf.author, description: mf.description, permissions: mf.permissions, resources: mf.resources, types: mf.types,
                dataDir: state.dir(), installDir: path.dirname(UI_DIR), host: process.env.HOST || '0.0.0.0', port: PORT,
                sourceLabels: Object.fromEntries(SOURCES.map(s => [s[0], s[1]])), sourceOrigins: { ...SOURCE_ORIGINS, mobilism: ['https://forum.mobilism.org'] }, updates: updater.status(),
                mirrors: eff.mirrors, downloads: downloadServices().flatMap(svc => downloadStatus(svc).map(d => ({ ...d, service: svc }))), custom: eff.custom, enabled: on,
            });
        }
        case 'slum': state.update(s => { s.slum = !!body.on; }); cacheStore.clear(); return panelState(config);
        // Atualizações: a verificação roda em segundo plano (pode levar mais que a espera da ponte); o resultado volta em `state`.
        case 'update/check': updater.check({ install: body.install === true }); return panelState(config);
        case 'update/auto': state.update(s => { s.updates.auto = !!body.on; }); return panelState(config);
        case 'update/repo': {
            const repo = String(body.repo || '').trim();
            if (repo && !/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw Object.assign(new Error('Use o formato dono/repositório, por exemplo ' + DEFAULT_REPO), { status: 400 });
            state.update(s => { s.updates.repo = repo === DEFAULT_REPO ? '' : repo; });
            return panelState(config);
        }
        case 'update/rollback':
            try { updater.rollback(); } catch (e) { throw Object.assign(e, { status: 400 }); }
            return panelState(config);
        case 'creds': {
            const allowed = ['zlib_email', 'zlib_password', 'zlib_domain', 'annas_cookie', 'annas_mirror', 'mobilism_user', 'mobilism_pass'];
            state.update(s => { for (const k of allowed) if (k in body) { const v = String(body[k] || '').trim().slice(0, 2000); if (v) s.creds[k] = v; else delete s.creds[k]; } });
            cacheStore.clear(); return panelState(config);
        }
        case 'custom/add': {
            const name = String(body.name || '').trim().slice(0, 40), url = cleanCatalogUrl(String(body.url || '').slice(0, 800)).slice(0, 500);
            if (!name) throw Object.assign(new Error('Dê um nome para a fonte'), { status: 400 });
            if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error('Informe o endereço do catálogo (começa com https://)'), { status: 400 });
            if (eff.custom.length >= 12) throw Object.assign(new Error('Limite de 12 fontes personalizadas'), { status: 400 });
            clearTemplates();
            try { await searchCustom({ id: 'novo', name, url }, 'dune', 'ebooks', 5500); } catch (e) { throw Object.assign(new Error(String(e.message || e).slice(0, 220)), { status: 400 }); }
            const id = Math.random().toString(36).slice(2, 8);
            state.update(s => {
                const cur = new Set(s.enabled || eff.enabled || SOURCES.filter(([sid]) => ON_BY_DEFAULT(sid)).map(([sid]) => sid));
                cur.add('c:' + id); s.enabled = [...cur];
                s.custom.push({ id, name, url, type: 'opds' });
            });
            cacheStore.clear(); return panelState(config);
        }
        case 'custom/remove': {
            const id = sourceId(body.id).replace(/^c:/, '');
            state.update(s => { s.custom = s.custom.filter(c => c.id !== id); if (s.enabled) s.enabled = s.enabled.filter(x => x !== 'c:' + id); });
            cacheStore.clear(); return panelState(config);
        }
        case 'test': {
            const id = sourceId(body.id);
            if (!id) throw Object.assign(new Error('Fonte desconhecida'), { status: 400 });
            const info = SOURCES.find(s => s[0] === id);
            const mode = info && !info[2].includes('ebooks') ? 'audiobooks' : (body.mode === 'audiobooks' ? 'audiobooks' : 'ebooks');
            if (!(tests.get(id) || {}).running) {
                tests.set(id, { running: true, at: Date.now() });
                testSource(id, mode).then(r => tests.set(id, { running: false, at: Date.now(), result: r }), e => tests.set(id, { running: false, at: Date.now(), result: { status: 'error', error: String(e.message || e).slice(0, 160) } }));
            }
            return { ok: true };
        }
        case 'browser': return browserInfo();
        case 'browser/install': return installBrowser();
        case 'browser/restart': await restartBrowser(); return browserInfo();

        case 'verify/sites': {
            const need = verifyNeeded(), info = await browserInfo();
            return { browser: info, sites: Object.entries(VERIFY).map(([id, v]) => ({ id, name: v.name, needs: !!need[id] })), session: verifySession && { site: verifySession.site, starting: verifySession.starting, error: verifySession.error, solved: verifySession.solved } };
        }
        case 'verify/start': {
            const site = VERIFY[body.site] ? body.site : '';
            if (!site) throw Object.assign(new Error('Site desconhecido'), { status: 400 });
            const info = await browserInfo();
            if (!info.available) throw Object.assign(new Error('O navegador do addon ainda não está instalado'), { status: 409 });
            stopVerification();
            verifySession = { site, starting: true, error: '', startedAt: Date.now(), solved: false };
            const sess = verifySession;
            (async () => {
                try {
                    const url = await VERIFY[site].url();
                    const r = await startVerification(url, { phone: body.phone === true });
                    if (!r.ok) sess.error = r.reason || 'Não consegui abrir o site';
                } catch (e) { sess.error = String(e.message || e).slice(0, 160); }
                sess.starting = false;
            })();
            return { ok: true };
        }
        case 'verify/frame': {
            const sess = verifySession;
            if (!sess) return { open: false };
            if (sess.starting) return { open: false, starting: true };
            if (sess.error) return { open: false, error: sess.error };
            const html = await verificationHtml();
            if (!html && !(await verificationFrame({ full: false }))) return { open: false, closed: true };
            const pageState = VERIFY[sess.site].state(html || '');
            if (pageState === 'solved' && !sess.solved) {
                sess.solved = true;
                stopVerification();
                const ok = await VERIFY[sess.site].recheck().catch(() => false);
                cacheStore.clear();
                return { open: false, solved: true, confirmed: !!ok };
            }
            const f = await verificationFrame({ full: body.full === true });
            if (!f) return { open: false, closed: true };
            return { open: true, state: pageState, image: 'data:image/jpeg;base64,' + f.img.toString('base64'), area: f.area };
        }
        case 'verify/input': return { ok: await verificationInput(body.event || {}) };
        case 'verify/reload': return { ok: await reloadVerification() };
        case 'verify/stop': stopVerification(); verifySession = null; return { ok: true };
        default: throw Object.assign(new Error('Rota desconhecida'), { status: 404 });
    }
}

const manifestBase = config => manifest(VERSION, { behaviorHints: { configurable: true, configurationURL: PUBLIC_URL + '/configure', appSettings: appSettings(config) } });

startAddon({
    name: 'sleuth', port: PORT, uiDir: UI_DIR,
    manifest: manifestBase,
    configure: config => configurePage({
        title: 'Sleuth', description: 'Escolha as fontes, o monitor de espelhos e, se quiser, suas contas. Depois de instalado, tudo isso também pode ser mudado no painel do Sleuth em Configurações do app (o que for salvo lá vale mais que esta página).',
        fields: [
            { name: 'enabled', label: 'Fontes ativas', type: 'checks', options: SOURCES.map(([value, label]) => ({ value, label: value === 'mobilism' ? label + ' (exige conta)' : label, default: ON_BY_DEFAULT(value) })) },
            { name: 'slum', label: 'Monitor de espelhos (SLUM)', type: 'toggle', help: 'Priorizar os domínios que o Shadow Library Uptime Monitor mostra no ar', default: true },
            { name: 'zlib_email', label: 'Z-Library: e-mail (opcional)', type: 'text' }, { name: 'zlib_password', label: 'Z-Library: senha', type: 'password' },
            { name: 'mobilism_user', label: 'Mobilism: usuário', type: 'text' }, { name: 'mobilism_pass', label: 'Mobilism: senha', type: 'password' },
            { group: 'Busca de arquivos', name: 'search_view', label: 'Como mostrar os resultados', type: 'select', options: [{ value: 'shelf', label: 'Estante (lombadas)' }, { value: 'list', label: 'Lista' }] },
            { name: 'search_links', label: 'Links dos resultados', type: 'select', options: [{ value: 'direct', label: 'Só arquivos diretos' }, { value: 'any', label: 'Qualquer link' }] },
            { name: 'search_length', label: 'Audiolivros', type: 'select', options: [{ value: 'unabridged', label: 'Completos' }, { value: 'abridged', label: 'Resumidos' }, { value: 'any', label: 'Qualquer' }] },
        ],
        config, internalUrl: INTERNAL_URL,
    }),
    async handle({ req, res, url, path: p, config }) {
        if (p !== '/api/state' && p !== '/api/browser') lastActivity = Date.now();
        if (p.startsWith('/api/')) {
            if (req.method !== 'POST' && req.method !== 'GET') return false;
            if (req.headers.origin) { json(res, 403, { error: 'Acesso negado' }); return true; }
            try {
                const body = req.method === 'POST' ? await readJson(req, 65536) : {};
                json(res, 200, await api(p.slice(5), body && typeof body === 'object' ? body : {}, config));
            } catch (e) { json(res, e.status || 500, { error: String(e.message || e).slice(0, 300) }); }
            return true;
        }
        if (p === '/status') { apply(config); json(res, 200, { health: sourceHealth, mirrors: slumSummary() }); return true; }
        if (p === '/relink') {
            apply(config);
            const skip = (url.searchParams.get('skip') || '').split(',').filter(Boolean).slice(0, 20);
            json(res, 200, { url: (await freshLibgenLink(String(url.searchParams.get('md5') || '').toLowerCase().slice(0, 40), skip)) || '' }); return true;
        }
        if (p === '/zliblink') {
            apply(config);
            try { json(res, 200, { url: await zlibFileLink(url.searchParams.get('id') || '', url.searchParams.get('hash') || '') }); } catch (e) { json(res, 502, { error: e.message }); }
            return true;
        }
        if (p === '/search/start') {
            apply(config);
            const q = (url.searchParams.get('q') || '').trim().slice(0, 200), mode = url.searchParams.get('mode') === 'audiobooks' ? 'audiobooks' : 'ebooks';
            if (!q) { json(res, 400, { error: 'Informe o que procurar' }); return true; }
            const lang = (url.searchParams.get('lang') || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
            json(res, 200, jobs.start(q, mode, lang)); return true;
        }
        if (p === '/search/poll') {
            const out = jobs.poll(url.searchParams.get('job') || '', Number(url.searchParams.get('rev')) || 0);
            if (!out) { json(res, 404, { error: 'Busca não encontrada ou expirada' }); return true; }
            json(res, 200, out); return true;
        }
        if (!/^\/(search\/[a-z]+|resolve|torrent|dl\/[a-z]+)$/.test(p)) return false;
        apply(config);
        const r = await core.fetch(new Request(new URL(p + url.search, 'http://addon'), { method: req.method, headers: req.headers }), {}, { waitUntil: q => q.catch(() => {}), passThroughOnException() {} });
        const headers = Object.fromEntries(r.headers);
        for (const k of Object.keys(headers)) if (k.startsWith('access-control-')) delete headers[k];
        res.writeHead(r.status, { ...headers, 'Access-Control-Allow-Origin': '*' });
        if (!r.body) { res.end(); return true; }
        for await (const chunk of r.body) res.write(chunk);
        res.end(); return true;
    },
});
refreshSlum();
