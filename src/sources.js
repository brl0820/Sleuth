// Motor de busca: um runner por fonte (Library Genesis, Anna's Archive, Z-Library, Internet Archive, Gutenberg, OpenStax, LibreTexts,
// Memory of the World, RoyalLib, Mobilism, AudiobookBay, LibriVox, AudiobooksBee), ranking por consenso e resolução dos links.

import { browserGet, browserFetch, browserAvailable, verifyWindowOpen } from './browser.js';
import { slumOrder } from './slum.js';
import { probeFile } from './probe.js';
import { assertPublicUrl } from './netguard.js';
import { searchCustom, swapOrigin, originOf } from './custom.js';

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // X-API-Key não é um cabeçalho simples e exige permissão na verificação prévia entre origens.
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Content-Type':                 'application/json',
    'X-Content-Type-Options':       'nosniff',
    'Referrer-Policy':              'no-referrer',
};

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

const apiKeyOk = (request, env) => !env.API_KEY || timingSafeEqual(request.headers.get('X-API-Key') || '', env.API_KEY);

// Capas e links extraídos de sites só são usados quando possuem URLs HTTP(S).
// Caso contrário, uma listagem poderia direcionar a capa ao host de um invasor e rastrear quem busca.
function isHttpUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u);
}

const LIBGEN_MIRRORS = ['https://libgen.li', 'https://libgen.bz', 'https://libgen.gl', 'https://libgen.la', 'https://libgen.vg'];
const ANNAS_MIRRORS  = ['https://annas-archive.gl', 'https://annas-archive.pk', 'https://annas-archive.gd'];

const hostHealth = new Map();
const HOST_COOLDOWN_MS = 5 * 60 * 1000;
function noteHost(host, ok, ms, reason) {
    const h = hostHealth.get(host) || { fails: 0, coolUntil: 0, avgMs: null };
    if (ok) { h.fails = 0; h.avgMs = h.avgMs == null ? ms : h.avgMs * 0.7 + ms * 0.3; }
    else {
        if (reason) h.lastFailure = reason;
        if (++h.fails >= 3) { h.coolUntil = Date.now() + HOST_COOLDOWN_MS; h.fails = 0; }
    }
    hostHealth.set(host, h);
}

// Ordena os espelhos por desempenho, omitindo os em espera e priorizando respostas rápidas.
// Mantém a ordem original nos empates e nunca retorna lista vazia.
export function rankMirrors(staticList, health, now = Date.now()) {
    const ok = staticList
        .map((u, i) => ({ host: u.replace(/^https:\/\//, ''), i }))
        .filter(({ host }) => { const h = health.get(host); return !(h && h.coolUntil > now); });
    if (!ok.length) return staticList.slice();
    ok.sort((a, b) => {
        const la = (health.get(a.host) || {}).avgMs, lb = (health.get(b.host) || {}).avgMs;
        if ((la == null) !== (lb == null)) return la == null ? 1 : -1;
        if (la != null && la !== lb) return la - lb;
        return a.i - b.i;
    });
    return ok.map(({ host }) => 'https://' + host);
}

const hostOf = m => String(m).replace(/^https?:\/\//, '');
let userMirrors = {};
export const setUserMirrors = m => { userMirrors = m || {}; for (const s of Object.keys(activeOrigin)) if (!(userMirrors[s] || []).includes(activeOrigin[s])) delete activeOrigin[s]; };
export const mirrorsFor = (service, staticList) => [...new Set([...(userMirrors[service] || []), ...staticList])];
async function orderedMirrors(service, staticList) {
    const extra = userMirrors[service] || [];
    return [...new Set([...extra.filter(m => { const h = hostHealth.get(hostOf(m)); return !(h && h.coolUntil > Date.now()); }), ...rankMirrors(slumOrder(service, staticList), hostHealth)])];
}
export const mirrorHealth = (service, staticList) => mirrorsFor(service, staticList).map(m => { const host = hostOf(m), h = hostHealth.get(host) || {}; return { host, origin: m, user: (userMirrors[service] || []).includes(m), avgMs: h.avgMs == null ? null : Math.round(h.avgMs), cooling: !!(h.coolUntil && h.coolUntil > Date.now()), lastFailure: h.lastFailure || '' }; });

export function fetchFirstValid(mirrors, buildUrl, validate, { ms = 7000, hedge = 2, headers = {} } = {}) {
    const attempt = async m => {
        const t0 = Date.now(), host = m.replace(/^https:\/\//, '');
        try {
            const res = await get(buildUrl(m), ms, headers);
            const text = await res.text();
            const v = validate(text, res);
            if (v === true) noteHost(host, true, Date.now() - t0);
            else if (v !== 'challenged') noteHost(host, false, 0, `HTTP ${res.status}, ${text.length} bytes: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
            return { v, text };
        } catch (e) { noteHost(host, false, 0, `${e && e.name || 'error'} after ${Date.now() - t0}ms: ${String(e && e.message || e).slice(0, 80)}`); return { v: false }; }
    };
    return new Promise(resolve => {
        let next = 0, active = 0, tried = 0, challenged = 0, done = false;
        const launch = () => {
            if (next >= mirrors.length) return false;
            const m = mirrors[next++];
            active++; tried++;
            attempt(m).then(r => {
                active--;
                if (done) return;
                if (r.v === true) { done = true; return resolve({ mirror: m, text: r.text }); }
                if (r.v === 'challenged') challenged++;
                if (!launch() && active === 0) { done = true; resolve({ mirror: null, challengedAll: tried > 0 && challenged === tried }); }
            });
            return true;
        };
        if (!mirrors.length) return resolve({ mirror: null, challengedAll: false });
        for (let i = 0; i < hedge && launch(); i++);
    });
}

export function mirrorDebug() {
    return {
        health: Object.fromEntries(hostHealth),
        annasBlockedUntil: annasBlockedUntil ? new Date(annasBlockedUntil).toISOString() : null,
    };
}

const FORMAT_SCORE = {
    epub: 40, mobi: 30, fb2: 25, azw3: 25,
    djvu: 15, pdf: 10, cbz: 5, cbr: 5,
    doc: 2, docx: 2, txt: 1,
    m4b: 35, mp3: 20, m4a: 20, flac: 15, aac: 15,
};

// ── Utilitários ──

const ok  = d    => new Response(JSON.stringify(d), { headers: CORS });
const err = (m,s)=> new Response(JSON.stringify({ error: m, results: [] }), { status: s||500, headers: CORS });

export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
export const RAVE_UA = 'Sleuth/3';
let uaMode = 'browser';
export const setUserAgentMode = m => { uaMode = m === 'rave' ? 'rave' : 'browser'; };
export const currentUA = () => (uaMode === 'rave' ? RAVE_UA : BROWSER_UA);

export const creds = {};
export const setCreds = c => { for (const k of Object.keys(creds)) delete creds[k]; Object.assign(creds, c || {}); };

async function rawGet(url, ms = 7000, extra = {}, init = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'User-Agent': currentUA(),
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
                'Accept-Language': 'en-US,en;q=0.5',
                ...extra,
            },
            ...init,
        });
        // Mantém o prazo durante a leitura do corpo; encerrá-lo nos cabeçalhos permitiria que respostas lentas
        // bloqueassem text()/json() indefinidamente.
        ['text', 'json', 'arrayBuffer'].forEach(m => {
            const orig = r[m].bind(r);
            r[m] = () => orig().finally(() => clearTimeout(t));
        });
        return r;
    } catch(e) { clearTimeout(t); throw e; }
}

const GENERIC_ORIGINS = {
    archive: ['https://archive.org'], gutenberg: ['https://www.gutenberg.org'], openstax: ['https://openstax.org'], libretexts: ['https://commons.libretexts.org'],
    memoryoftheworld: ['https://library.memoryoftheworld.org'], royallib: ['https://royallib.com'], librivox: ['https://librivox.org'], audiobooksbee: ['https://audiobooksbee.com'],
};
const GENERIC_HOSTS = new Map(Object.entries(GENERIC_ORIGINS).map(([svc, [o]]) => [new URL(o).host, svc]));

export const activeOrigin = {};
export async function get(url, ms = 7000, extra = {}, init = {}) {
    let svc = '', u = null;
    try { u = new URL(url); if (u.protocol === 'https:') svc = GENERIC_HOSTS.get(u.host) || ''; } catch { }
    const mine = svc ? (userMirrors[svc] || []).filter(m => { const h = hostHealth.get(hostOf(m)); return !(h && h.coolUntil > Date.now()); }).slice(0, 2) : [];
    if (!mine.length) return rawGet(url, ms, extra, init);
    const origins = [...mine, u.origin];
    for (let i = 0; i < origins.length; i++) {
        const o = origins[i], last = i === origins.length - 1, t0 = Date.now();
        try {
            const r = await rawGet(o + u.pathname + u.search, last ? ms : Math.min(ms, 6000), extra, init);
            if (!last && !r.ok) { noteHost(hostOf(o), false, 0, 'HTTP ' + r.status); if (r.body) r.body.cancel().catch(() => {}); continue; }
            if (!last) { noteHost(hostOf(o), true, Date.now() - t0); activeOrigin[svc] = o; } else delete activeOrigin[svc];
            return r;
        } catch (e) {
            if (last) throw e;
            noteHost(hostOf(o), false, 0, `${e && e.name || 'error'}: ${String(e && e.message || e).slice(0, 80)}`);
        }
    }
}

const URL_FIELDS = ['downloadUrl', 'directUrl', 'pageUrl', 'coverUrl', 'detailUrl', 'topicUrl'];
export function rewriteOrigins(r, from, to) {
    if (!r || !from || !to || from === to) return r;
    for (const k of URL_FIELDS) if (typeof r[k] === 'string' && (r[k] === from || r[k].startsWith(from + '/'))) r[k] = to + r[k].slice(from.length);
    return r;
}
function mirrorize(r) { for (const [svc, [def]] of Object.entries(GENERIC_ORIGINS)) if (activeOrigin[svc]) rewriteOrigins(r, def, activeOrigin[svc]); return r; }
const mirrorizeAll = rs => { if (Array.isArray(rs)) rs.forEach(mirrorize); return rs; };

export const withDeadline = (p, ms, fallback) =>
    Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

// Cache para rotas custosas. produce() retorna [response, cacheable]. Resultados vazios ou falhas não são
// armazenados para evitar persistir indisponibilidades temporárias. edgeGet/edgePut usam caches.default
// implementado por src/server.js.
const edgeCache = () => (typeof caches !== 'undefined' ? caches.default : null);

async function edgeGet(keyUrl) {
    const cache = edgeCache();
    if (!cache) return null;
    try { return (await cache.match(new Request(keyUrl))) || null; } catch (e) { return null; }
}

function edgePut(keyUrl, ctx, ttlSec, res) {
    const cache = edgeCache();
    if (!cache) return;
    const copy = new Response(res.clone().body, { headers: res.headers });
    copy.headers.set('Cache-Control', 'public, max-age=' + ttlSec);
    ctx.waitUntil(cache.put(new Request(keyUrl), copy).catch(() => {}));
}

export async function withEdgeCache(keyUrl, ctx, ttlSec, produce) {
    const hit = await edgeGet(keyUrl);
    if (hit) return hit;
    const [res, cacheable] = await produce();
    if (cacheable) edgePut(keyUrl, ctx, typeof cacheable === 'number' ? cacheable : ttlSec, res);
    return res;
}

function strip(s) {
    return (s || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&#39;/g,  "'")
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
        .replace(/\s+/g, ' ')
        .trim();
}

export function parseFilesizeBytes(numStr, unitStr) {
    const n = parseFloat(numStr);
    const u = (unitStr || '').trim().toLowerCase().charAt(0);
    return u === 'g' ? n * 1e9 : u === 'm' ? n * 1e6 : n * 1e3;
}

function parseLibgenTitleCell(titleCell) {
    let isbn = '';
    const isbnMatch = titleCell.match(/<font color="green">\s*([^<]+)<\/font>/i);
    if (isbnMatch) isbn = isbnMatch[1].split(';')[0].trim();

    const cleaned = titleCell
        .replace(/\stitle="[^"]*"/gi, '')
        .replace(/<nobr>[\s\S]*?<\/nobr>/gi, '')
        .replace(/<font size=1[^>]*>[\s\S]*?<\/font>/gi, '')
        .replace(/<font color="green">[\s\S]*?<\/font>/gi, '');

    const segments = [];
    cleaned.split(/<br\s*\/?>/i).forEach(seg => {
        const t = strip(seg);
        if (!t) return;
        const lower = t.toLowerCase();
        for (let j = segments.length - 1; j >= 0; j--) {
            const kLower = segments[j].toLowerCase();
            if (lower.includes(kLower))      segments.splice(j, 1);
            else if (kLower.includes(lower)) return;
        }
        segments.push(t);
    });

    return { title: segments.join(' · '), isbn };
}

const normText = t => (t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const STOP = new Set('a an and the of for to in on at by with from is are was be or as it its his her de la le les el los las del der die das und et y du des un une'.split(' '));
const fold = t => normText(String(t || '').normalize('NFD').replace(/\p{M}/gu, ''));
const stem = w => (w.length > 3 ? w.replace(/(?:es|s)$/, '') : w);
function queryWords(q) {
    const all = fold(q).split(' ').filter(w => w.length > 1 || /\d/.test(w));
    const key = all.filter(w => !STOP.has(w));
    return (key.length ? key : all).map(stem);
}
export function relevance(r, q) {
    const words = queryWords(q);
    if (!words.length) return 1;
    const hay = new Set(fold([r.title, r.author, r.series].filter(Boolean).join(' ')).split(' ').map(stem));
    return words.filter(w => hay.has(w)).length / words.length;
}
export const relevanceBand = (r, q) => { const c = relevance(r, q); return c >= 0.99 ? 3 : c >= 0.6 ? 2 : c >= 0.3 ? 1 : 0; };
function withoutAuthor(r, q) {
    const qw = fold(q).split(' ').filter(Boolean), aw = new Set(fold(r.author).split(' ')), tw = new Set(fold(r.title).split(' '));
    const rest = qw.filter(w => !aw.has(w) || tw.has(w));
    return rest.length && rest.length < qw.length ? rest.join(' ') : '';
}
export function titleWordsOf(q, results) {
    const votes = new Map();
    for (const r of results) { const t = r.author && relevanceBand(r, q) === 3 && withoutAuthor(r, q); if (t) votes.set(t, (votes.get(t) || 0) + 1); }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}
// Buscas por ISBN não correspondem a títulos e nunca são filtradas por eles.
const isIsbnQuery = q => /(?:^|\D)(?:97[89])?\d{9}[\dx](?:\D|$)/i.test(String(q || '').replace(/[-\s]/g, ''));

export function tokenCoverage(r, q) {
    const words = normText(q).split(' ').filter(w => w.length > 1);
    if (!words.length) return 0;
    const hay = ' ' + normText((r.title || '') + ' ' + (r.author || '')) + ' ';
    return words.filter(w => hay.includes(' ' + w + ' ')).length / words.length;
}

export function scoreResult(r, q) {
    let s = 0;
    const fmt  = (r.format   || '').toLowerCase();
    const ttl  = normText(r.title);
    const qn   = normText(q);
    s += FORMAT_SCORE[fmt] || 0;
    if (ttl === qn)              s += 60;
    else if (ttl.startsWith(qn)) s += 40;
    else if (ttl.includes(qn))   s += 20;
    else {
        const cov = tokenCoverage(r, q);
        s += Math.round(cov * 50);
        if (cov === 1) s += 15;
    }
    if (parseInt(r.filesize || 0) > 50000) s += 5;
    if (r.year && parseInt(r.year) > 0)    s += 3;
    if (r.source === 'Project Gutenberg' || r.source === 'OpenStax' || r.source === 'LibreTexts') s += 14;
    return s;
}

// Extrai ISBN-10 ou ISBN-13, como “ISBN 978-0-547-92822-7” -> “9780547928227”, ou vazio
// se inválido. Verifica o dígito para não aceitar qualquer número de dez ou treze dígitos.
export function isbnOf(query) {
    const s = String(query || '').replace(/^\s*isbn(?:-1[03])?:?/i, '').replace(/[\s-]/g, '').toUpperCase();
    if (/^\d{9}[\dX]$/.test(s)) {
        const sum = [...s].reduce((t, c, i) => t + (c === 'X' ? 10 : +c) * (10 - i), 0);
        return sum % 11 === 0 ? s : '';
    }
    if (/^97[89]\d{10}$/.test(s)) {
        const sum = [...s].reduce((t, c, i) => t + +c * (i % 2 ? 3 : 1), 0);
        return sum % 10 === 0 ? s : '';
    }
    return '';
}

// LibGen só encontra ISBN na coluna própria; buscar ISBN como título ou autor não funciona.
export function libgenSearchParams(query, mode) {
    const isbn = isbnOf(query);
    const params = new URLSearchParams();
    params.append('req', isbn || query);
    if (isbn) params.append('columns[]', 'i');
    else {
        params.append('columns[]', 't');
        params.append('columns[]', 'a');
    }
    ['f','e','s','a','p','w'].forEach(o => params.append('objects[]', o));
    const topics = mode === 'audiobooks' ? ['a','m'] : ['l','c','f','a','m','r','s'];
    topics.forEach(t => params.append('topics[]', t));
    params.append('res', '50');
    params.append('filesuns', 'all');
    return params;
}

async function searchLibgen(query, mode) {
    const params = libgenSearchParams(query, mode);
    const found = await fetchFirstValid(
        await orderedMirrors('libgen', LIBGEN_MIRRORS),
        m => `${m}/index.php?${params}`,
        text => text.includes('tablelibgen'),
        { headers: { 'Cookie': 'covers=on' }, hedge: 3, ms: 15000 }
    );
    const html = found.text;
    const mirror = found.mirror;

    if (!html) return [];

    const tStart = html.indexOf('id="tablelibgen"');
    const tEnd   = html.indexOf('</table>', tStart);
    if (tStart === -1 || tEnd === -1) return [];
    const table = html.slice(tStart, tEnd + 8);

    const results = [];

    const rows = table.split(/<tr[\s>]/i);

    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        if (!row.includes('<td')) continue;

        const cells = row.split(/<td[^>]*>/i);
        if (cells.length < 9) continue;

        const firstCell = cells[1] || '';
        const hasCover  = /covers/.test(firstCell);
        const o = hasCover ? 1 : 0;

        let coverUrl = '';
        if (hasCover) {
            const imgMatch = firstCell.match(/src="([^"]+)"/i);
            if (imgMatch) {
                const src = imgMatch[1];
                const absolute = /^https?:\/\//i.test(src) ? src : mirror + src;
                coverUrl = isHttpUrl(absolute) ? absolute : '';
            }
        }

        const titleCell = cells[1 + o] || '';
        const idMatch = titleCell.match(/href="[^"]*\?id=(\d+)/);
        if (!idMatch) continue;
        const bookId = idMatch[1];

        const { title: rawTitle, isbn } = parseLibgenTitleCell(titleCell);
        if (!rawTitle) continue;

        const author    = strip(cells[2 + o] || '');
        const publisher = strip(cells[3 + o] || '');
        const year      = strip(cells[4 + o] || '').replace(/\D/g, '');
        const language  = strip(cells[5 + o] || '');
        const pages     = strip(cells[6 + o] || '').replace(/\D/g, '');
        const size      = strip(cells[7 + o] || '');
        const ext       = strip(cells[8 + o] || '').toLowerCase();

        const mirrorCell = cells[9 + o] || '';
        const md5Match   = mirrorCell.match(/[?&]md5=([a-fA-F0-9]{32})/i);
        const md5 = md5Match ? md5Match[1].toUpperCase() : '';

        let filesize = 0;
        const szM = size.match(/([\d.]+)\s*(k|m|g)b?/i);
        if (szM) filesize = parseFilesizeBytes(szM[1], szM[2]);

        if (!md5 && !bookId) continue;

        results.push({
            title:       rawTitle,
            author:      author.slice(0, 100),
            publisher,
            year:        year.slice(0, 4),
            language,
            pages:       pages === '0' ? '' : pages,
            isbn,
            filesize,
            format:      ext,
            source:      'Library Genesis',
            downloadUrl: md5
                ? `${mirror}/ads.php?md5=${md5}`
                : `${mirror}/index.php?id=${bookId}`,
            md5,
            coverUrl,
        });
    }

    return results;
}

const SOURCE_SVC = {
    'Library Genesis': 'libgen', "Anna's Archive": 'annas', 'Internet Archive': 'archive', 'Project Gutenberg': 'gutenberg', OpenStax: 'openstax',
    LibreTexts: 'libretexts', 'Memory of the World': 'memoryoftheworld', RoyalLib: 'royallib', LibriVox: 'librivox',
};
export const DOWNLOAD_SERVICES = Object.values(SOURCE_SVC);
export const DOWNLOAD_ALTERNATIVES = { libgen: ['https://libgen.download/api/download?id={md5}', 'https://libgen.fyi/api/download?id={md5}', 'https://libgen.stream/api/download?id={md5}'] };
export const DOWNLOAD_SAMPLE_MD5 = '4a702054b356e7ed5364318bc954c99c';
const svcOf = r => {
    if (SOURCE_SVC[r.source]) return SOURCE_SVC[r.source];
    const c = customSources.find(x => x.name === r.source);
    return c ? 'c:' + c.id : '';
};
let userDownloads = {};
export const setUserDownloads = d => { userDownloads = d || {}; fallbackMemo.clear(); };
export const downloadServices = () => [...DOWNLOAD_SERVICES, ...customSources.map(c => 'c:' + c.id)];
const dlHost = tpl => { const m = /^https?:\/\/([^/?#{]+)/i.exec(tpl); return m ? m[1].toLowerCase() : tpl; };
const dlCooling = tpl => { const h = hostHealth.get(dlHost(tpl)); return !!(h && h.coolUntil > Date.now()); };
const ownDownloads = service => [...new Set([...(userDownloads[service] || []), ...(DOWNLOAD_ALTERNATIVES[service] || [])])];
export const downloadsFor = service => [...new Set(service === 'annas' ? [...ownDownloads('annas'), ...ownDownloads('libgen')] : ownDownloads(service))];
export const downloadStatus = service => ownDownloads(service).map(tpl => {
    const host = dlHost(tpl), h = hostHealth.get(host) || {};
    return { template: tpl, host, user: (userDownloads[service] || []).includes(tpl), avgMs: h.avgMs == null ? null : Math.round(h.avgMs), cooling: !!(h.coolUntil && h.coolUntil > Date.now()), lastFailure: h.lastFailure || '' };
});

export function fillDownload(tpl, r) {
    let u = null;
    try { if (/^https?:\/\//i.test(r.directUrl || '')) u = new URL(r.directUrl); } catch { u = null; }
    const v = {
        md5: String(r.md5 || '').toLowerCase(), path: u ? u.pathname + u.search : '', file: u ? (u.pathname.split('/').filter(Boolean).pop() || '') : '',
        url: u ? u.href : '', urlenc: u ? encodeURIComponent(u.href) : '', identifier: String(r.identifier || ''),
    };
    let ok = true;
    const out = String(tpl).replace(/\{(md5|path|file|url|urlenc|identifier)\}/g, (m, k) => { if (!v[k]) ok = false; return v[k]; });
    return ok ? out : '';
}

const fallbackMemo = new Map();
// Procura um link que funcione entre as alternativas da fonte do resultado. Devolve { url, host, size, from } ou null (nunca um link que não entrega).
export async function downloadFallback(r) {
    const svc = svcOf(r);
    if (!svc) return null;
    const md5 = String(r.md5 || '').toLowerCase(), key = svc + '|' + (md5 || r.directUrl || '');
    if (!md5 && !r.directUrl) return null;
    const hit = fallbackMemo.get(key);
    if (hit && Date.now() - hit.at < (hit.value ? 5 : 2) * 60e3) return hit.value;
    const from = svc === 'libgen' || svc === 'annas' ? 'LibGen (servidor alternativo)' : 'Servidor alternativo';
    const probe = async url => {
        const host = dlHost(url), t0 = Date.now(), p = await probeFile(url, { timeoutMs: 9000 });
        noteHost(host, p.ok, Date.now() - t0, p.ok ? '' : p.error);
        if (!p.ok) throw new Error(p.error || 'falhou');
        return { url, host: p.host, size: p.size || 0, from };
    };
    const urls = [...new Set(downloadsFor(svc).filter(t => !dlCooling(t)).map(t => fillDownload(t, r)).filter(u => u && u !== r.directUrl))].slice(0, 10);
    const tasks = urls.map(probe);
    if (md5 && (svc === 'libgen' || svc === 'annas') && /^[a-f0-9]{32}$/.test(md5)) {
        tasks.push((async () => {
            const res = await get(`https://libgen.me/api/download/links-by-id?id=${md5}`, 4000, { Accept: 'application/json' });
            const j = res.ok ? await res.json() : null;
            const known = new Set(downloadsFor(svc).map(dlHost));
            const fresh = ((j && j.result && j.result.list) || []).filter(h => /^https:\/\/[a-z0-9.-]+$/i.test(h) && !/annas-archive|freescienceengineering/i.test(h) && !known.has(h.slice(8))).slice(0, 4);
            if (!fresh.length) throw new Error('nada novo');
            return Promise.any(fresh.map(h => probe(`${h}/api/download?id=${md5}`)));
        })());
    }
    const value = tasks.length ? await Promise.any(tasks).catch(() => null) : null;
    fallbackMemo.set(key, { at: Date.now(), value });
    while (fallbackMemo.size > 200) fallbackMemo.delete(fallbackMemo.keys().next().value);
    return value;
}
export const libgenFallbackLink = md5 => downloadFallback({ md5, source: 'Library Genesis' });

const samples = new Map();
async function downloadSample(service) {
    const hit = samples.get(service);
    if (hit && Date.now() - hit.at < 10 * 60e3 && hit.r) return hit.r;
    const custom = service.startsWith('c:') ? customSources.find(c => 'c:' + c.id === service) : null;
    const runner = custom ? { run: q => searchCustomMirrored(custom, q, 'ebooks') } : RUNNERS[service];
    if (!runner) return null;
    const mode = service === 'librivox' ? 'audiobooks' : 'ebooks';
    const queries = mode === 'audiobooks' ? ['pride and prejudice', 'alice in wonderland'] : ['pride and prejudice', 'physics', 'alice in wonderland', 'dune'];
    const end = Date.now() + 50000;
    for (const q of queries) {
        if (Date.now() > end) break;
        const rs = await withDeadline(runner.run(q, mode), 20000, null).catch(() => null);
        for (const r of (rs || []).slice(0, 4)) {
            registerResult(r, mode);
            const x = await withDeadline(resolveOne(r.id, { fallback: false, dl: false }), 15000, null).catch(() => null);
            if (x && x.directUrl && !x.directUrl.startsWith('/')) { const keep = { ...resultStore.get(r.id), directUrl: x.directUrl }; samples.set(service, { at: Date.now(), r: keep }); return keep; }
        }
    }
    samples.set(service, { at: Date.now(), r: null });
    return null;
}

export async function testDownload(service, template, ms = 15000) {
    const t0 = Date.now(), host = dlHost(template);
    try {
        let sample = { md5: DOWNLOAD_SAMPLE_MD5 };
        if (/\{(path|file|url|urlenc|identifier)\}/.test(template)) {
            sample = await downloadSample(service);
            if (!sample) return { status: 'error', ms: Date.now() - t0, error: 'Não consegui um livro de exemplo desta fonte agora (a busca de teste falhou). Tente de novo mais tarde.' };
        }
        const url = fillDownload(template, sample);
        if (!url) return { status: 'error', ms: Date.now() - t0, error: 'O modelo usa um campo que o livro de exemplo não tem' };
        await assertPublicUrl(url);
        const p = await probeFile(url, { timeoutMs: ms });
        const took = Date.now() - t0;
        if (p.ok) { noteHost(host, true, took); return { status: 'ok', ms: took, host: p.host, type: p.type, sample: sample.title ? String(sample.title).slice(0, 60) : '' }; }
        noteHost(host, false, 0, p.error);
        return { status: /não respondeu em/.test(p.error || '') ? 'timeout' : 'error', ms: took, error: p.error };
    } catch (e) { const why = whyFailed(e); noteHost(host, false, 0, why); return why === 'timeout' ? { status: 'timeout', ms: Date.now() - t0 } : { status: 'error', ms: Date.now() - t0, error: why }; }
}

async function resolveLibgenLinks(results, topN = 8, skip = []) {
    const adsMirrors = (await orderedMirrors('libgen', LIBGEN_MIRRORS)).filter(m => !skip.includes(m)).slice(0, 3);

    const toResolve = results.slice(0, topN).filter(r => r.md5);
    await Promise.allSettled(toResolve.map(async r => {
        for (const adsMirror of adsMirrors) {
            try {
                const adsUrl = `${adsMirror}/ads.php?md5=${r.md5.toLowerCase()}`;
                const res = await get(adsUrl, 5000);
                if (!res.ok) continue;
                const html = await res.text();
                const keyMatch = html.match(/get\.php\?md5=[a-f0-9]+&(?:amp;)?key=([A-Za-z0-9]+)/i);
                if (keyMatch) {
                    r.directUrl   = `${adsMirror}/get.php?md5=${r.md5.toLowerCase()}&key=${keyMatch[1]}`;
                    break;
                }
            } catch(e) { }
        }
    }));
    return results;
}

async function searchRoyalLib(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const res = await get('https://royallib.com/search/', 7000, {
            'Content-Type': 'application/x-www-form-urlencoded',
        }, {
            method: 'POST',
            body: `to=result&q=${encodeURIComponent(query)}`,
        });
        if (!res.ok) return [];
        const html = await res.text();

        const secStart = html.indexOf('id="pp-books"');
        if (secStart === -1) return [];
        const secEnd = html.indexOf('</ul>', secStart);
        if (secEnd === -1) return [];
        const section = html.slice(secStart, secEnd);

        const results = [];
        const rowRe = /href="(?:\/\/royallib\.com)?(\/book\/[^"]+)\.html"[^>]*data-rl-id="(\d+)"[^>]*>([^<]+)<\/a>[\s\S]*?class="pp-bauthor"[^>]*>(?:<a[^>]*>)?([^<]*)/g;
        let m;
        while ((m = rowRe.exec(section)) && results.length < 20) {
            const [, bookPath, , rawTitle, rawAuthor] = m;
            const title = strip(rawTitle);
            if (!title) continue;
            results.push({
                title,
                author:      strip(rawAuthor),
                format:      '',
                filesize:    0,
                source:      'RoyalLib',
                downloadUrl: `https://royallib.com${bookPath}.html`,
                coverUrl:    '',
                _bookPath:   bookPath,
            });
        }
        return results;
    } catch(e) { return []; }
}

const ROYALLIB_FORMAT_PREFS = ['epub', 'fb2', 'doc', 'rtf', 'txt', 'html'];

export function royallibUnitChar(cyrillic) {
    const c = (cyrillic || '').trim().charAt(0).toLowerCase();
    return c === 'м' ? 'm' : c === 'г' ? 'g' : 'k';
}

async function resolveRoyalLibLinks(results, topN = 8) {
    const toResolve = results.slice(0, topN).filter(r => r._bookPath);
    await Promise.allSettled(toResolve.map(async r => {
        try {
            const res = await get(`https://royallib.com${r._bookPath}.html`, 7000);
            if (!res.ok) return;
            const html = await res.text();

            const dlStart = html.indexOf('bv-dl-h');
            if (dlStart !== -1) {
                let dlEnd = html.indexOf('bv-side', dlStart);
                if (dlEnd === -1) dlEnd = dlStart + 3000;
                const dlBlock = html.slice(dlStart, dlEnd);
                const found = {};
                const fmtRe = /href="(?:\/\/royallib\.com)?(\/get\/([a-z0-9]+)\/[^"]+\.zip)"[^>]*>[^<]*<\/a><span class="bv-sz">\(([\d.]+)\s*([^)]+)\)/g;
                let fm;
                while ((fm = fmtRe.exec(dlBlock))) {
                    const [, href, fmt, sizeNum, unit] = fm;
                    found[fmt] = { href, sizeNum, unit };
                }
                for (const fmt of ROYALLIB_FORMAT_PREFS) {
                    if (found[fmt]) {
                        r.directUrl   = `https://royallib.com${found[fmt].href}`;
                        r.format      = fmt;
                        r.directReady = true;
                        r.filesize    = parseFilesizeBytes(found[fmt].sizeNum, royallibUnitChar(found[fmt].unit));
                        break;
                    }
                }
            }

            const coverMatch = html.match(/class="bv-cover"[^>]*src="(\/\/[^"]+)"/);
            if (coverMatch) {
                const absolute = 'https:' + coverMatch[1];
                if (isHttpUrl(absolute)) r.coverUrl = absolute;
            }
        } catch(e) { }
    }));
    return results;
}

let annasBlockedUntil = 0;
let annasExpired = false;
const ANNAS_BLOCK_MS = 10 * 60 * 1000;
const ANNAS_PROBE_MS = 30 * 1000;
const isDdosGuard = t => /<title>DDoS-Guard|\/\.well-known\/ddos-guard\//i.test(t);
let annasNeedsVerify = false;
let annasChallenged = false;
export const annasStatus = async () => ({
    configured: !!(creds.annas && creds.annas.cookie),
    expired: annasExpired && !!(creds.annas && creds.annas.cookie),
    needsVerify: annasNeedsVerify,
    browser: await browserAvailable(),
    verifyOpen: verifyWindowOpen(),
});
// Inicia a verificação na página de busca, pois a página inicial não é protegida.
export const annasVerifyUrl = () => ((creds.annas && creds.annas.mirror) || slumOrder('annas', ANNAS_MIRRORS)[0]).replace(/\/+$/, '') + '/search?q=dune';
export const annasPageState = html =>
    html.includes('ddg-captcha') ? 'captcha'
    : ((html.includes('js-vim-focus') || html.includes('/md5/')) && !isDdosGuard(html)) ? 'solved' : 'loading';

export async function annasRecheck() {
    const html = await browserGet(annasVerifyUrl(), {
        timeoutMs: 15000,
        isReady: t => (t.includes('js-vim-focus') || t.includes('/md5/')) && !isDdosGuard(t) || t.includes('ddg-captcha'),
    });
    const solved = !!html && !html.includes('ddg-captcha') && !isDdosGuard(html);
    annasNeedsVerify = !solved;
    if (solved) { annasBlockedUntil = 0; annasChallenged = false; }
    return solved;
}

async function searchAnnas(query, mode) {
    const unavailable = () => Object.assign([], { unavailable: true, needsVerify: annasChallenged });
    if (Date.now() < annasBlockedUntil) return unavailable();
    // Reserva a sondagem para evitar tentativas simultâneas de buscas concorrentes.
    if (annasBlockedUntil) annasBlockedUntil = Date.now() + ANNAS_PROBE_MS;

    const a = creds.annas && creds.annas.cookie ? creds.annas : null;
    const mirrors = a ? [(a.mirror || ANNAS_MIRRORS[0]).replace(/\/+$/, '')] : await orderedMirrors('annas', ANNAS_MIRRORS);
    const headers = a ? { Cookie: a.cookie, ...(a.ua ? { 'User-Agent': a.ua } : {}) } : {};
    const extra = mode === 'audiobooks' ? '&ext=mp3&ext=m4b&ext=aac' : '';
    const found = await fetchFirstValid(
        mirrors,
        m => `${m}/search?q=${encodeURIComponent(query)}${extra}`,
        text => (text.includes('js-vim-focus') || text.includes('/md5/')) ? true : (isDdosGuard(text) ? 'challenged' : false),
        { ms: 8000, headers }
    );
    if (found.mirror) { annasBlockedUntil = 0; annasExpired = false; annasNeedsVerify = false; annasChallenged = false; return parseAnnasHtml(found.text, found.mirror); }
    if (found.challengedAll) annasChallenged = true;
    if (found.challengedAll && !verifyWindowOpen()) {
        // Se fetch comum recebe desafio, tenta o navegador com perfil que lembra verificações
        // humanas já concluídas. O código nunca tenta resolvê-las sozinho.
        const mirror = mirrors[0];
        const html = await browserGet(`${mirror}/search?q=${encodeURIComponent(query)}${extra}`, {
            timeoutMs: 15000,
            isReady: t => (t.includes('js-vim-focus') || t.includes('/md5/')) && !isDdosGuard(t) || t.includes('ddg-captcha'),
        });
        if (html && !html.includes('ddg-captcha') && !isDdosGuard(html)) { annasBlockedUntil = 0; annasExpired = false; annasNeedsVerify = false; annasChallenged = false; return parseAnnasHtml(html, mirror); }
        annasNeedsVerify = !!html;
    }
    if (found.challengedAll) { if (a) annasExpired = true; annasBlockedUntil = Date.now() + ANNAS_BLOCK_MS; return unavailable(); }
    annasBlockedUntil = 0;
    return [];
}

export function parseAnnasHtml(html, mirror) {
    const results = [];

    const titlePattern = /<a\s[^>]*href="(\/md5\/[a-f0-9]+)"[^>]*class="[^"]*js-vim-focus[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    let m;
    while ((m = titlePattern.exec(html)) !== null) {
        const href  = m[1];
        const title = strip(m[2]);
        if (!title || title.length < 2) continue;

        const md5 = href.replace('/md5/', '').toUpperCase();

        const preContext = html.slice(Math.max(0, m.index - 1200), m.index);
        let coverUrl = '';
        const coverImgMatch = preContext.match(/src="(https?:\/\/libgen\.li\/fictioncovers\/[^"]+\.(?:jpg|jpeg|png|webp))"/i);
        if (coverImgMatch) {
            coverUrl = coverImgMatch[1];
        } else {
            const fallbackCover = preContext.match(/src="(https?:\/\/[^"]*(?:covers|thumb)[^"]*\.(?:jpg|jpeg|png|webp))"/i);
            if (fallbackCover) coverUrl = fallbackCover[1];
        }

        const from = m.index + m[0].length, nextTitle = html.indexOf('js-vim-focus', from);
        const context = html.slice(from, Math.min(nextTitle > 0 ? nextTitle : from + 8000, from + 8000));

        let author = '';
        const authorMatch = context.match(/<a[^>]*href="\/search\?q=[^"]*"[^>]*>[\s\S]*?icon-\[mdi--user-edit\][\s\S]*?<\/a>/i);
        if (authorMatch) {
            author = strip(authorMatch[0]);
        } else {
            const fallbackAuthor = context.match(/<a[^>]*href="\/search\?q=([^"]*)"[^>]*>([^<]*)<\/a>/i);
            if (fallbackAuthor) author = strip(fallbackAuthor[2]);
        }

        let format = '', language = '', year = '', filesize = 0;
        const metaMatch = context.match(/<div[^>]*text-gray-800[^>]*>([\s\S]*?)<\/div>/i);
        if (metaMatch) {
            const metaText = strip(metaMatch[1]);
            const langM = metaText.match(/([A-Za-z]+)\s*\[([a-z]{2})\]/);
            if (langM) language = langM[1];

            const fmtM = metaText.match(/\b(epub|mobi|fb2|azw3|pdf|djvu|cbz|cbr|doc|docx|txt|mp3|m4b)\b/i);
            if (fmtM) format = fmtM[1].toLowerCase();

            const szM = metaText.match(/([\d.]+)\s*(KB|MB|GB)/i);
            if (szM) filesize = parseFilesizeBytes(szM[1], szM[2]);

            const yearM = metaText.match(/\b(1[89]\d{2}|20[012]\d)\b/);
            if (yearM) year = yearM[1];
        }

        results.push({
            title,
            author,
            year,
            format,
            filesize,
            language,
            source:      "Anna's Archive",
            downloadUrl: `${mirror}${href}`,
            md5,
            coverUrl,
        });
    }

    return results.slice(0, 20);
}

// ── Internet Archive ──

async function searchArchive(query, mode) {
    const mediaType = mode === 'audiobooks' ? 'audio' : 'texts';
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:${mediaType}+AND+NOT+collection:(inlibrary+OR+printdisabled)+AND+NOT+access-restricted-item:true&fl[]=identifier,title,creator,year,format,downloads,language&sort[]=downloads+desc&rows=10&page=1&output=json`;
    try {
        const res = await get(url, 6000, { 'Accept': 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        const docs = (data.response && data.response.docs) || [];
        // Não usa formats[0], pois a lista inclui notas, torrents e miniaturas;
        // a primeira entrada frequentemente não representa o livro. Mantém vazio até
        // resolveArchiveLinks() preencher o formato real.
        const preferred = mode === 'audiobooks'
            ? ['MP3', 'VBR MP3', '128Kbps MP3', '64Kbps MP3', 'Ogg Vorbis', 'FLAC']
            : ['EPUB', 'MOBI', 'PDF', 'Text', 'DjVu'];
        return docs.map(doc => {
            const formats = Array.isArray(doc.format) ? doc.format : [doc.format].filter(Boolean);
            const best = preferred.find(f => formats.some(df => df && df.toLowerCase().includes(f.toLowerCase())));
            return {
                title:       doc.title || 'Unknown Title',
                author:      Array.isArray(doc.creator) ? doc.creator.join(', ') : (doc.creator || ''),
                year:        String(doc.year || ''),
                format:      best ? best.toLowerCase() : '',
                filesize:    0,
                language:    Array.isArray(doc.language) ? doc.language[0] : (doc.language || ''),
                source:      'Internet Archive',
                downloadUrl: `https://archive.org/details/${doc.identifier || ''}`,
                coverUrl: doc.identifier ? `https://archive.org/services/img/${doc.identifier}` : '',
                identifier: doc.identifier || '',
            };
        });
    } catch(e) { return []; }
}

const IA_EBOOK_EXTS = ['epub', 'pdf', 'mobi', 'azw3', 'djvu', 'txt'];
const IA_AUDIO_EXTS = ['mp3', 'm4b', 'm4a', 'flac'];

export const lengthText = secs => { const m = Math.round(secs / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`; };
const iaSecs = v => { const t = String(v || ''); return t.includes(':') ? t.split(':').reduce((a, x) => a * 60 + (+x || 0), 0) : +t || 0; };
const IA_AUDIO_FORMATS = ['VBR MP3', '128Kbps MP3', '64Kbps MP3', 'MP3', 'Apple Lossless Audio', 'M4B', 'Ogg Vorbis', 'Flac'];
function iaAudioBook(identifier, files) {
    const audio = files.filter(f => IA_AUDIO_EXTS.some(e => (f.name || '').toLowerCase().endsWith('.' + e)) && f.source !== 'metadata');
    const fmt = IA_AUDIO_FORMATS.find(x => audio.some(f => f.format === x)) || (audio[0] && audio[0].format);
    const tracks = audio.filter(f => f.format === fmt);
    if (!tracks.length) return null;
    const size = tracks.reduce((a, f) => a + (parseInt(f.size) || 0), 0), secs = tracks.reduce((a, f) => a + iaSecs(f.length), 0);
    const kbps = (String(fmt).match(/(\d+)Kbps/i) || [])[1];
    return {
        url: tracks.length === 1 ? `https://archive.org/download/${identifier}/${encodeURIComponent(tracks[0].name)}`
            : `https://archive.org/compress/${identifier}/formats=${encodeURIComponent(fmt)}&file=/${identifier}.zip`,
        format: tracks.length === 1 ? tracks[0].name.split('.').pop().toLowerCase() : 'zip',
        size, length: secs > 60 ? lengthText(secs) : '', bitrate: kbps ? kbps + ' kbps' : '', tracks: tracks.length,
    };
}

async function resolveArchiveLinks(results, mode, topN = 10) {
    const exts = mode === 'audiobooks' ? IA_AUDIO_EXTS : IA_EBOOK_EXTS;
    const toResolve = results.slice(0, topN).filter(r => r.identifier);
    await Promise.allSettled(toResolve.map(async r => {
        try {
            const res = await get(`https://archive.org/metadata/${r.identifier}`, 7000, { 'Accept': 'application/json' });
            if (!res.ok) return;
            const meta = await res.json();
            const files = Array.isArray(meta.files) ? meta.files : [];
            const book = mode === 'audiobooks' && iaAudioBook(r.identifier, files);
            if (book) {
                Object.assign(r, { directUrl: book.url, directReady: true, format: book.format, tracks: book.tracks });
                if (book.size) r.filesize = book.size;
                if (book.length) r.length = book.length;
                if (book.bitrate) r.bitrate = book.bitrate;
                return;
            }
            let best = null;
            for (const ext of exts) {
                best = files.find(f => (f.name || '').toLowerCase().endsWith('.' + ext));
                if (best) break;
            }
            if (best) {
                r.directUrl   = `https://archive.org/download/${r.identifier}/${encodeURIComponent(best.name)}`;
                r.directReady = true;
                if (!r.format) r.format = best.name.split('.').pop().toLowerCase();
                const size = parseInt(best.size);
                if (size > 0) r.filesize = size;
            }
        } catch(e) { }
    }));
    return results;
}

async function searchGutenberg(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const res = await get(`https://www.gutenberg.org/ebooks/search.opds/?query=${encodeURIComponent(query)}`, 8000, { 'Accept': 'application/atom+xml' });
        if (!res.ok) return [];
        const xml = await res.text();
        const out = [];
        for (const e of xml.split('<entry>').slice(1)) {
            const id = (e.match(/<id>[^<]*\/ebooks\/(\d+)\.opds<\/id>/) || [])[1];
            if (!id) continue;
            const title = strip((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
            const file = `https://www.gutenberg.org/ebooks/${id}.epub3.images`;
            out.push({
                title:       title || 'Unknown Title',
                author:      strip((e.match(/<content type="text">([\s\S]*?)<\/content>/) || [])[1] || ''),
                year:        '',
                format:      'epub',
                filesize:    0,
                language:    '',
                source:      'Project Gutenberg',
                downloadUrl: file,
                directUrl:   file,
                pageUrl:     `https://www.gutenberg.org/ebooks/${id}`,
                coverUrl:    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`,
            });
            if (out.length >= 10) break;
        }
        return out;
    } catch(e) { return []; }
}

async function searchOpenStax(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const listRes = await get('https://openstax.org/apps/cms/api/v2/pages/?type=books.Book&limit=250', 6000, { 'Accept': 'application/json' });
        if (!listRes.ok) return [];
        const listData = await listRes.json();
        const books = Array.isArray(listData.items) ? listData.items : [];
        const qn = query.toLowerCase().trim();
        const matches = books.filter(b => (b.title || '').toLowerCase().includes(qn)).slice(0, 5);
        if (!matches.length) return [];

        const details = await Promise.all(matches.map(async b => {
            try {
                const detailUrl = b.meta && b.meta.detail_url;
                if (!detailUrl) return null;
                const res = await get(detailUrl, 6000, { 'Accept': 'application/json' });
                return res.ok ? await res.json() : null;
            } catch(e) { return null; }
        }));

        const out = [];
        for (const d of details) {
            if (!d || !d.pdf_url) continue;
            out.push({
                title:       d.title || 'Unknown Title',
                author:      Array.isArray(d.authors) ? d.authors.map(a => (a.value && a.value.name) || '').filter(Boolean).join(', ') : '',
                year:        d.publish_date ? String(d.publish_date).slice(0, 4) : '',
                format:      'pdf',
                filesize:    0,
                language:    'en',
                source:      'OpenStax',
                downloadUrl: d.pdf_url,
                directUrl:   d.pdf_url,
                pageUrl:     (d.meta && d.meta.html_url) || '',
                directReady: true,
                coverUrl:    d.cover_url || '',
            });
        }
        return out;
    } catch(e) { return []; }
}

async function searchLibreTexts(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const url = `https://commons.libretexts.org/api/v1/search/books-v2?searchQuery=${encodeURIComponent(query)}&limit=10&page=1`;
        const res = await get(url, 7000, { 'Accept': 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        const books = Array.isArray(data.results) ? data.results : [];
        const out = [];
        for (const b of books) {
            const pdfUrl = b.links && b.links.pdf;
            if (!pdfUrl) continue;
            out.push({
                title:       b.title || 'Unknown Title',
                author:      b.author || '',
                year:        '',
                format:      'pdf',
                filesize:    0,
                language:    '',
                source:      'LibreTexts',
                downloadUrl: pdfUrl,
                directUrl:   pdfUrl,
                pageUrl:     (b.links && b.links.online) || '',
                directReady: true,
                coverUrl:    b.thumbnail || '',
            });
        }
        return out;
    } catch(e) { return []; }
}

const MOTW_FORMAT_PREFS = ['epub', 'pdf', 'mobi', 'azw3'];

function motwEncodePath(path) {
    return path.split('/').map(seg => seg ? encodeURIComponent(seg) : '').join('/');
}

async function searchMemoryOfTheWorld(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const url = `https://library.memoryoftheworld.org/search?q=${encodeURIComponent(query)}`;
        const res = await get(url, 7000, { 'Accept': 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        const books = Array.isArray(data._items) ? data._items : [];
        const out = [];
        for (const b of books.slice(0, 10)) {
            const formats = Array.isArray(b.formats) ? b.formats : [];
            let picked = null;
            for (const pref of MOTW_FORMAT_PREFS) {
                picked = formats.find(f => f.format === pref);
                if (picked) break;
            }
            if (!picked) continue;
            const base = 'https://library.memoryoftheworld.org';
            const fileUrl = base + motwEncodePath((b.library_url || '') + (picked.dir_path || '') + picked.file_name);
            const coverUrl = b.cover_url ? base + motwEncodePath((b.library_url || '') + b.cover_url) : '';
            out.push({
                title:       b.title || 'Unknown Title',
                author:      Array.isArray(b.authors) ? b.authors.join(', ') : '',
                year:        b.pubdate ? String(b.pubdate).slice(0, 4) : '',
                format:      picked.format,
                filesize:    picked.size || 0,
                language:    Array.isArray(b.languages) ? b.languages[0] : '',
                source:      'Memory of the World',
                downloadUrl: fileUrl,
                directUrl:   fileUrl,
                directReady: true,
                coverUrl,
            });
        }
        return out;
    } catch(e) { return []; }
}

async function searchLibriVox(query, mode) {
    if (mode !== 'audiobooks') return [];
    try {
        const url = 'https://librivox.org/api/feed/audiobooks/?' + new URLSearchParams({
            title: '^' + query.trim().replace(/^(the|a|an)\s+/i, ''),
            format: 'json',
            extended: '1',
            limit: '10',
        });
        const res = await get(url, 7000, { 'Accept': 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        const books = Array.isArray(data.books) ? data.books : [];
        const out = [];
        for (const b of books) {
            if (!b.url_zip_file) continue;
            out.push({
                title:       b.title || 'Unknown Title',
                author:      Array.isArray(b.authors) ? b.authors.map(a => [a.first_name, a.last_name].filter(Boolean).join(' ')).join(', ') : '',
                year:        b.copyright_year && b.copyright_year !== '0' ? b.copyright_year : '',
                format:      'zip',
                filesize:    b.totaltimesecs > 0 ? b.totaltimesecs * 8000 : 0,
                length:      b.totaltimesecs > 60 ? lengthText(b.totaltimesecs) : '',
                bitrate:     '64 kbps',
                abridged:    false,
                narrator:    [...new Set((b.sections || []).flatMap(s => (s.readers || []).map(x => x.display_name)).filter(Boolean))].slice(0, 3).join(', '),
                language:    b.language || '',
                source:      'LibriVox',
                downloadUrl: b.url_zip_file,
                directUrl:   b.url_zip_file,
                pageUrl:     b.url_librivox || '',
                directReady: true,
                coverUrl:    /archive\.org\/details\/[^/?#]+/.test(b.url_iarchive || '') ? 'https://archive.org/services/img/' + b.url_iarchive.match(/details\/([^/?#]+)/)[1] : '',
            });
        }
        return out;
    } catch(e) { return []; }
}

const ABB_MIRRORS = ['https://audiobookbay.lu'];

async function searchAudiobookBay(query) {
    const lowerQuery = query.toLowerCase();
    let answered = false;
    for (const mirror of mirrorsFor('audiobookbay', ABB_MIRRORS)) {
        try {
            const url = `${mirror}/?s=${encodeURIComponent(lowerQuery)}&cat=undefined%2Cundefined`;
            const res = await get(url, 8000);
            answered = true;
            if (!res.ok) continue;
            const html = await res.text();
            if (!html.includes('archiveTitle')) {
                console.warn('[AudiobookBay] response had no archiveTitle heading, likely blocked or redirected');
                continue;
            }
            const results = parseAbbSearchHtml(html, mirror);
            if (results.length > 0) return results;
        } catch(e) {
            console.warn('[AudiobookBay] mirror request failed:', e && e.message ? e.message : e);
        }
    }
    if (!answered) throw new Error('AudiobookBay did not answer');
    return [];
}

function parseAbbSearchHtml(html, mirror) {
    const results = [];
    const blocks = html.split('<div class="post">').slice(1);

    for (const block of blocks) {
        const titleMatch = block.match(/<div class="postTitle"><h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;

        let href = titleMatch[1];
        if (href.startsWith('/')) href = mirror + href;
        const title = strip(titleMatch[2]);
        if (!title) continue;

        let language = '';
        const categories = [];
        const infoMatch = block.match(/<div class="postInfo">([\s\S]*?)<\/div>/i);
        if (infoMatch) {
            const langM = infoMatch[1].match(/Language:\s*([A-Za-z]+)/i);
            if (langM) language = langM[1];

            const catMatch = infoMatch[1].match(/Category:\s*([\s\S]*?)<br/i);
            if (catMatch) {
                catMatch[1].split('&nbsp;').map(s => strip(s)).filter(Boolean).forEach(c => {
                    if (!categories.includes(c)) categories.push(c);
                });
            }
        }

        const coverMatch = block.match(/<img src="([^"]+)"/i);
        const coverUrl = coverMatch && isHttpUrl(coverMatch[1]) ? coverMatch[1] : '';

        results.push({ title, detailUrl: href, language, categories, coverUrl });
    }

    return results.slice(0, 15);
}

const ABB_RESOLVE_BATCH_SIZE = 4;

async function resolveAbbMagnets(results, topN = 8) {
    const toResolve = results.slice(0, topN);

    for (let i = 0; i < toResolve.length; i += ABB_RESOLVE_BATCH_SIZE) {
        const batch = toResolve.slice(i, i + ABB_RESOLVE_BATCH_SIZE);
        await Promise.allSettled(batch.map(async r => {
            try {
                const res = await get(r.detailUrl, 7000);
                if (!res.ok) {
                    console.warn(`[AudiobookBay] detail page returned HTTP ${res.status}`);
                    return;
                }
                const html = await res.text();

                const hashMatch = html.match(/Info Hash:<\/td>\s*<td>([a-fA-F0-9]{40})<\/td>/i);
                if (!hashMatch) {
                    console.warn('[AudiobookBay] no Info Hash found on a detail page');
                    return;
                }
                const hash = hashMatch[1];

                const trackers = [];
                const announceMatch = html.match(/Announce URL:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i);
                if (announceMatch) trackers.push(announceMatch[1].trim());
                const trackerRe = /Tracker:<\/td>\s*<td>([^<]+)<\/td>/gi;
                let tm;
                while ((tm = trackerRe.exec(html)) !== null) trackers.push(tm[1].trim());
                const uniqTrackers = [...new Set(trackers)];

                let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(r.title)}`;
                uniqTrackers.forEach(t => { magnet += `&tr=${encodeURIComponent(t)}`; });

                const fmtMatch = html.match(/class=['"]format['"][^>]*>([^<]+)</i);
                const format = fmtMatch ? fmtMatch[1].trim().toLowerCase() : '';

                let filesize = 0;
                const sizeMatch = html.match(/(?:Combined File Size|File Size):<\/td>\s*<td>[\s\S]*?<span[^>]*>([\d.]+)<\/span>\s*(\w+)/i);
                if (sizeMatch) filesize = parseFilesizeBytes(sizeMatch[1], sizeMatch[2]);

                const authorMatch = html.match(/<span class=['"]author['"][^>]*>([^<]+)<\/span>/i);
                const author = authorMatch ? strip(authorMatch[1]) : '';

                const narrators = [];
                const narratorRe = /<span class=['"]narrator['"][^>]*>([^<]+)<\/span>/gi;
                let nm;
                while ((nm = narratorRe.exec(html)) !== null) {
                    const n = strip(nm[1]);
                    if (n && !narrators.includes(n)) narrators.push(n);
                }
                const narrator = narrators.join(', ');

                let bitrate = '';
                const bitrateSpanMatch = html.match(/<span class=['"]bitrate['"][^>]*>([^<]+)<\/span>/i);
                if (bitrateSpanMatch) {
                    bitrate = strip(bitrateSpanMatch[1]);
                } else {
                    const bitrateTextMatch = html.match(/Bit Rate:\s*([^<\n]+?)(?:<br|\s*<\/p>)/i);
                    if (bitrateTextMatch) bitrate = strip(bitrateTextMatch[1]);
                }

                const abridgedMatch = html.match(/<span class=['"]is_abridged['"][^>]*>([^<]+)<\/span>/i);
                const abridged = abridgedMatch ? strip(abridgedMatch[1]) : '';

                r.magnet   = magnet;
                r.infoHash = hash;
                r.format   = format;
                r.filesize = filesize;
                r.author   = author;
                r.narrator = narrator;
                r.bitrate  = bitrate;
                r.abridged = /unabridged/i.test(abridged) ? false : /abridged/i.test(abridged) ? true : null;
            } catch(e) {
                console.warn('[AudiobookBay] detail request failed:', e && e.message ? e.message : e);
            }
        }));
    }

    const resolved = results.filter(r => r.magnet);
    return resolved;
}

function mapAbbResults(results) {
    return results.map(r => ({
        title:       r.title,
        author:      r.author || '',
        year:        '',
        format:      r.format || '',
        filesize:    r.filesize || 0,
        language:    r.language || '',
        source:      'AudiobookBay',
        downloadUrl: r.detailUrl,
        detailUrl:   r.detailUrl,
        magnet:      r.magnet,
        infoHash:    r.infoHash,
        coverUrl:    r.coverUrl || '',
        narrator:    r.narrator || '',
        bitrate:     r.bitrate || '',
        abridged:    typeof r.abridged === 'boolean' ? r.abridged : null,
        categories:  r.categories || [],
    }));
}

async function searchAudiobooksBee(query) {
    const url = `https://audiobooksbee.com/?s=${encodeURIComponent(query)}`;
    const res = await get(url, 8000);
    if (!res.ok) return [];
    const html = await res.text();
    return parseAudiobooksBeeSearchHtml(html);
}

function parseAudiobooksBeeSearchHtml(html) {
    const results = [];
    const blocks = html.split(/<article\b(?=[^>]*\b(?:id="post-|class="col_item))/).slice(1);

    for (const block of blocks) {
        const titleMatch = block.match(/<h2[^>]*><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
        if (!titleMatch) continue;

        const href = titleMatch[1];
        let title = strip(titleMatch[2]);
        if (!title) continue;

        let author = '';
        const byMatch = title.match(/^(.*?)\s+By\s+(.+)$/);
        if (byMatch) { title = byMatch[1].trim(); author = byMatch[2].trim(); }

        const coverMatch = block.match(/<img[^>]*?\b(?:data-src|src)="([^"]+)"/i);
        const coverUrl = coverMatch && isHttpUrl(coverMatch[1]) ? coverMatch[1] : '';

        results.push({ title, author, detailUrl: href, downloadUrl: href, coverUrl });
    }

    return results.slice(0, 15);
}

const ABB_BEE_RESOLVE_BATCH_SIZE = 4;

async function resolveAudiobooksBeeLinks(results, topN = 5) {
    const toResolve = results.slice(0, topN);

    for (let i = 0; i < toResolve.length; i += ABB_BEE_RESOLVE_BATCH_SIZE) {
        const batch = toResolve.slice(i, i + ABB_BEE_RESOLVE_BATCH_SIZE);
        await Promise.allSettled(batch.map(async r => {
            try {
                const res = await get(r.detailUrl, 7000);
                if (!res.ok) return;
                const html = await res.text();

                const linkMatch = html.match(/href="(https:\/\/rg\.to\/file\/[^"]+)"/i);
                if (!linkMatch) return;
                r.downloadUrl = linkMatch[1];

                const fmtMatch = r.downloadUrl.match(/\.(m4b|mp3|zip|flac)\.html/i);
                if (fmtMatch) r.format = fmtMatch[1].toLowerCase();
            } catch(e) {
                console.warn('[AudiobooksBee] detail request failed:', e && e.message ? e.message : e);
            }
        }));
    }

    return results;
}

function mapAudiobooksBeeResults(results) {
    return results.map(r => ({
        title:       r.title,
        author:      r.author || '',
        year:        '',
        format:      r.format || '',
        filesize:    0,
        language:    '',
        source:      'AudiobooksBee',
        downloadUrl: r.downloadUrl,
        detailUrl:   r.detailUrl,
        coverUrl:    r.coverUrl || '',
    }));
}

const okR = async (env, source, results) => ok({ source, results });

// ── Z-Library (conta própria pela API do aplicativo) ──
// Tenta domínios até autenticar. Como downloads consomem a cota diária,
// /dl/zlib resolve o arquivo apenas no clique, nunca para todos os resultados.
const ZLIB_DOMAINS = ['https://z-library.sk', 'https://1lib.sk', 'https://z-lib.gd', 'https://z-lib.gl', 'https://libb.la', 'https://zlib.li'];
const ZLIB_SESSION_MS = 6 * 3600 * 1000;
let zlibSession = null;
let zlibError = '';
// Domínios usam DiamWall com caixa “Não sou um robô”. Como no Anna's Archive,
// a pessoa conclui uma vez no navegador do servidor; o Sleuth nunca resolve sozinho.
const isDiamWall = t => /DiamWall/.test(t);
let zlibWall = '';
export const zlibStatus = () => ({ error: zlibError, needsVerify: !!zlibWall });
export async function zlibVerifyUrl() {
    // A barreira redireciona para si com 307; não segue redirecionamentos para evitar ciclo.
    if (!zlibWall) zlibWall = await Promise.any((await orderedMirrors('zlibrary', ZLIB_DOMAINS)).map(d => get(d + '/', 6000, {}, { redirect: 'manual' }).then(() => d))).catch(() => '');
    return (zlibWall || ZLIB_DOMAINS[0]) + '/s/dune';
}
export const zlibPageState = html => isDiamWall(html) ? 'captcha' : html.includes('<z-bookcard') ? 'solved' : 'loading';
export async function zlibRecheck() {
    const t0 = Date.now();
    const html = await browserGet(await zlibVerifyUrl(), { timeoutMs: 15000, isReady: t => t.includes('<z-bookcard') || (isDiamWall(t) && Date.now() - t0 > 8000) });
    const solved = !!html && !isDiamWall(html);
    if (solved) { zlibWall = ''; zlibSession = null; }
    return solved;
}
const wallError = d => { zlibWall = d; zlibError = 'Z-Library wants proof you are a person'; return Object.assign(new Error(zlibError), { wall: true }); };
const zlibConfigured = () => !!(creds.zlib && creds.zlib.email && creds.zlib.password);

async function zlibCall(domain, path, form, cookie, method = 'POST') {
    const type = method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {};
    const body = method === 'POST' ? { body: form.toString() } : {};
    // A barreira responde 307 para si mesma, então não segue redirecionamentos.
    const host = domain.replace(/^https:\/\//, ''), t0 = Date.now();
    let text;
    try {
        const res = await get(domain + path, 15000, { ...type, ...(cookie ? { Cookie: cookie } : {}) }, { method, ...body, redirect: 'manual' });
        text = await res.text();
    } catch (e) { noteHost(host, false, 0, String(e.message).slice(0, 80)); throw e; }
    noteHost(host, true, Date.now() - t0);
    if (!isDiamWall(text)) return JSON.parse(text);
    const b = await browserFetch(domain, path, { method, headers: type, credentials: 'include', ...body }, isDiamWall, cookie);
    if (!b || isDiamWall(b.text)) throw wallError(domain);
    if (zlibWall === domain) zlibWall = '';
    return JSON.parse(b.text);
}

async function zlibLogin() {
    const c = creds.zlib;
    const domains = c.domain ? [c.domain.replace(/\/+$/, '')] : await orderedMirrors('zlibrary', ZLIB_DOMAINS);
    for (const d of domains) {
        try {
            const j = await zlibCall(d, '/eapi/user/login', new URLSearchParams({ email: c.email, password: c.password }));
            if (j && j.success && j.user) {
                zlibError = '';
                return (zlibSession = { domain: d, cookie: `remix_userid=${j.user.id}; remix_userkey=${j.user.remix_userkey}`, at: Date.now() });
            }
            if (j && j.error) { zlibError = String(j.error).slice(0, 120); return null; }
        } catch (e) { if (e.wall) return null; /* caso contrário, domínio indisponível; tenta o próximo */ }
    }
    zlibError = 'No Z-Library domain reachable';
    return null;
}

async function zlibEnsureSession() {
    if (zlibSession && Date.now() - zlibSession.at < ZLIB_SESSION_MS) return zlibSession;
    return zlibLogin();
}

export function parseZlibCards(html, domain) {
    const out = [];
    const cardRe = /<z-bookcard\s([^>]*)>([\s\S]*?)<\/z-bookcard>/g;
    let m;
    while ((m = cardRe.exec(html))) {
        const attr = n => ((m[1].match(new RegExp('\\b' + n + '="([^"]*)"')) || [])[1] || '');
        const slot = n => strip((m[2].match(new RegExp('<div slot="' + n + '">([\\s\\S]*?)</div>')) || [])[1] || '');
        const title = slot('title');
        if (!title || !attr('href') || attr('deleted') === '1') continue;
        const size = attr('filesize').match(/([\d.]+)\s*(KB|MB|GB)/i);
        out.push({
            title, author: slot('author'), year: attr('year'), language: attr('language'),
            format: attr('extension').toLowerCase(), filesize: size ? parseFilesizeBytes(size[1], size[2].toUpperCase()) : 0,
            // Sem conta, o link de download (/dl/...) fica atrás da verificação do navegador (DiamWall) e não entrega o arquivo a quem não é um
            // navegador: o resultado aparece, mas sem link direto (com conta configurada, o download vai pela API: /dl/zlib).
            source: 'Z-Library', downloadUrl: domain + attr('href'),
            coverUrl: (isHttpUrl((m[2].match(/<img data-src="([^"]+)"/) || [])[1]) ? m[2].match(/<img data-src="([^"]+)"/)[1] : ''),
        });
    }
    return out;
}

const zlibUnavailable = () => Object.assign([], { unavailable: true, needsVerify: !!zlibWall });
async function zlibWallAt(d) {
    try { const res = await get(d + '/', 6000, {}, { redirect: 'manual' }); const t = await res.text(); return isDiamWall(t) || /diamwall/i.test(res.headers.get('server') || ''); } catch (e) { return false; }
}
async function searchZlibraryGuest(query) {
    const domains = (await orderedMirrors('zlibrary', ZLIB_DOMAINS)).slice(0, 3);
    for (const d of domains) {
        const t0 = Date.now();
        const html = await browserGet(`${d}/s/${encodeURIComponent(query)}`, { timeoutMs: 15000, isReady: h => h.includes('<z-bookcard') || (isDiamWall(h) && Date.now() - t0 > 8000) });
        if (html && isDiamWall(html)) { wallError(d); break; }
        if (html) { if (zlibWall === d) zlibWall = ''; return parseZlibCards(html, d).slice(0, 50); }
    }
    if (!zlibWall) for (const d of domains) if (await zlibWallAt(d)) { wallError(d); break; }
    return zlibUnavailable();
}

async function searchZlibrary(query, mode) {
    if (mode === 'audiobooks') return [];
    if (!zlibConfigured()) return searchZlibraryGuest(query);
    const unavailable = zlibUnavailable;
    const run = async s => zlibCall(s.domain, '/eapi/book/search', new URLSearchParams({ message: query, limit: '50', page: '1' }), s.cookie);
    try {
        let s = await zlibEnsureSession();
        if (!s) return zlibWall ? unavailable() : searchZlibraryGuest(query);
        let j = await run(s);
        if (!j || !j.success) {
            zlibSession = null;
            s = await zlibLogin();
            if (!s) return zlibWall ? unavailable() : searchZlibraryGuest(query);
            j = await run(s);
        }
        if (!j || !Array.isArray(j.books)) return searchZlibraryGuest(query);
        return j.books.map(b => ({
            title:       strip(b.title),
            author:      strip(b.author),
            year:        b.year ? String(b.year) : '',
            language:    b.language || '',
            format:      String(b.extension || '').toLowerCase(),
            filesize:    Number(b.filesize) || 0,
            source:      'Z-Library',
            downloadUrl: s.domain + (b.href || ''),
            directUrl:   `/dl/zlib?id=${encodeURIComponent(b.id)}&hash=${encodeURIComponent(b.hash)}`,
            coverUrl:    isHttpUrl(b.cover) ? b.cover : '',
        })).filter(r => r.title);
    } catch (e) { return searchZlibraryGuest(query); }
}

export async function zlibFileLink(id, hash) {
    if (!/^\d+$/.test(id) || !/^[a-z0-9]+$/i.test(hash) || !zlibConfigured()) throw new Error('Z-Library is not set up');
    const s = await zlibEnsureSession();
    if (!s) throw new Error('Z-Library login failed: ' + zlibError);
    const j = await zlibCall(s.domain, `/eapi/book/${id}/${hash}/file`, null, s.cookie, 'GET');
    const link = j && j.file && j.file.downloadLink;
    if (!isHttpUrl(link)) throw new Error((j && j.error) ? String(j.error).slice(0, 160) : 'No download link (daily limit reached?)');
    return link;
}
async function zlibDownload(id, hash) {
    try {
        const link = await zlibFileLink(id, hash);
        return new Response(null, { status: 302, headers: { Location: link, 'Referrer-Policy': 'no-referrer' } });
    } catch (e) { return err(e.message || 'Z-Library request failed', 502); }
}

const torrentCaches = hash => [`https://itorrents.org/torrent/${hash}.torrent`, `https://itorrents.net/torrent/${hash}.torrent`];

async function torrentFile(id) {
    if (resultStore.has(id) && !resultStore.get(id).infoHash) await resolveOne(id);
    const r = resultStore.get(id);
    const hash = String((r && r.infoHash) || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) return err('No torrent information for this result', 404);
    for (const url of torrentCaches(hash)) {
        try {
            const res = await get(url, 20000);
            if (!res.ok) continue;
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.length < 50 || bytes.length > 5e6 || bytes[0] !== 0x64) continue;
            const name = String(r.title || '').replace(/[^\w .()-]+/g, '').trim().slice(0, 80) || hash;
            return new Response(bytes, { headers: {
                'Content-Type': 'application/x-bittorrent',
                'Content-Disposition': `attachment; filename="${name}.torrent"`,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            } });
        } catch (e) { }
    }
    return err('No cached torrent file was found for this result. Use the magnet link instead.', 404);
}

const MOBILISM_BASE = 'https://forum.mobilism.org';
const MOBILISM_FORUMS = {
    audiobooks: [124],
    ebooks: [1285, 122, 1345, 1328, 545, 1346, 892, 126, 1292, 1340, 1293, 1294, 121, 1295],
};
const MOBILISM_SESSION_MS = 3600 * 1000;
let mobilismSession = null;
let mobilismError = '';
export const mobilismStatus = () => ({ error: mobilismError });
const mobilismConfigured = () => !!(creds.mobilism && creds.mobilism.username && creds.mobilism.password);

function mergeCookies(prev, res) {
    const jar = new Map((prev ? prev.split('; ') : []).filter(Boolean).map(p => [p.split('=')[0], p]));
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const pair = c.split(';')[0];
        jar.set(pair.split('=')[0], pair);
    }
    return [...jar.values()].join('; ');
}

async function mobilismLogin() {
    const c = creds.mobilism;
    try {
        const page = await get(`${MOBILISM_BASE}/ucp.php?mode=login`, 15000);
        let cookie = mergeCookies('', page);
        const html = await page.text();
        const sid = (html.match(/name="sid" value="([a-f0-9]+)"/) || [])[1];
        // Ressalva: Cloudflare recusa este servidor; usar o navegador em segundo plano,
        // como no Z-Library, poderia permitir acesso caso a proteção continue ativa.
        if (!sid) { mobilismError = /Just a moment|cf-chl|challenge-platform/i.test(html) ? 'Mobilism is behind a bot check that refuses this server' : 'Login page not recognised'; return null; }
        const res = await get(`${MOBILISM_BASE}/ucp.php?mode=login&sid=${sid}`, 15000,
            { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
            { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: c.username, password: c.password, login: 'Login', redirect: 'index.php', sid, autologin: 'on' }).toString() });
        cookie = mergeCookies(cookie, res);
        const uid = (cookie.match(/_u=(\d+)/) || [])[1];
        if (!uid || uid === '1') {
            const err = ((await res.text()).match(/class="error"[^>]*>([\s\S]*?)<\/(?:div|p)>/) || [])[1];
            mobilismError = strip(err || 'Login failed').slice(0, 140);
            return null;
        }
        mobilismError = '';
        return (mobilismSession = { cookie, at: Date.now() });
    } catch (e) { mobilismError = 'Mobilism unreachable'; return null; }
}

export function parseMobilismResults(html) {
    const out = [], seen = new Set();
    const tagRe = /<a\s[^>]*class="topictitle"[^>]*>([^<]+)<\/a>/g;
    let m;
    while ((m = tagRe.exec(html))) {
        const href = (m[0].match(/href="([^"]+)"/) || [])[1] || '';
        const ids = href.match(/[?&;]f=(\d+)(?:&amp;|&)t=(\d+)/) || href.match(/[?&;]t=(\d+)/) && [null, '', href.match(/[?&;]t=(\d+)/)[1]];
        if (!ids || seen.has(ids[2])) continue;
        seen.add(ids[2]);
        const raw = strip(m[1]);
        const f = raw.match(/\s*\(\.([A-Za-z0-9/+, ]+)\)\s*$/);
        const topicUrl = `${MOBILISM_BASE}/viewtopic.php?${ids[1] ? `f=${ids[1]}&` : ''}t=${ids[2]}`;
        out.push({
            title: f ? raw.slice(0, f.index).trim() : raw, author: '', year: '',
            format: f ? f[1].trim().toLowerCase() : '', filesize: 0, language: '',
            source: 'Mobilism', topicUrl, downloadUrl: topicUrl, coverUrl: '',
        });
    }
    return out;
}

async function searchMobilism(query, mode) {
    if (!mobilismConfigured()) return [];
    const unavailable = () => Object.assign([], { unavailable: true });
    const forums = MOBILISM_FORUMS[mode];
    if (!forums) return [];
    const run = async s => {
        const qs = new URLSearchParams({ keywords: query, terms: 'all', sr: 'topics', sf: 'titleonly' });
        forums.forEach(f => qs.append('fid[]', String(f)));
        const res = await get(`${MOBILISM_BASE}/search.php?${qs}`, 20000, { Cookie: s.cookie });
        return res.text();
    };
    try {
        let s = mobilismSession && Date.now() - mobilismSession.at < MOBILISM_SESSION_MS ? mobilismSession : await mobilismLogin();
        if (!s) return unavailable();
        let html = await run(s);
        if (/not permitted to use the search system/i.test(html)) {
            mobilismSession = null;
            s = await mobilismLogin();
            if (!s) return unavailable();
            html = await run(s);
        }
        if (/cannot make another search so soon/i.test(html)) return unavailable();
        return parseMobilismResults(html).slice(0, 25);
    } catch (e) { return unavailable(); }
}

// ── Combinação, classificação e remoção de duplicatas ──

const resultStore = new Map();
const RESULT_STORE_MAX = 5000;
export const getResult = id => resultStore.get(id);
let decorate = r => r;
export const setResultDecorator = fn => { decorate = fn; };
// Fontes desativadas nas configurações nunca são executadas.
let sourcesOff = new Set();
export const setSourcesOff = list => { sourcesOff = new Set(list || []); };
let searchBlocked = () => '';
export const setSearchGate = fn => { searchBlocked = fn; };
export const sourceHealth = {};
export const RESOLVABLE = new Set(['Library Genesis', "Anna's Archive", 'RoyalLib', 'Internet Archive', 'AudiobookBay', 'AudiobooksBee']);
let idSeq = 0;
export const registerResult = (r, mode) => {
    for (const k of ['pageUrl', 'downloadUrl', 'detailUrl', 'directUrl', 'coverUrl', 'topicUrl']) if (r[k] && !isHttpUrl(r[k]) && !String(r[k]).startsWith('/dl/')) delete r[k];
    if (!r.id) r.id = Date.now().toString(36) + (idSeq++).toString(36);
    if (mode) r._mode = mode;
    r.resolvable = RESOLVABLE.has(r.source);
    resultStore.delete(r.id);
    resultStore.set(r.id, r);
    if (resultStore.size > RESULT_STORE_MAX) resultStore.delete(resultStore.keys().next().value);
};
const keepResults = (results, mode) => { for (const r of results || []) registerResult(resultStore.get(r.id) || r, mode); };

const linkTier = r => (r.directUrl ? 2 : r.magnet ? 1 : 0);
const rankTier = (r, mode) => (mode === 'audiobooks' && r.source === 'AudiobookBay' ? 3 : linkTier(r));

// Dentro de grupos de relevância e tipo de link iguais, alterna fontes, mantendo a ordem de pontuação
// de cada uma para impedir que uma só ocupe a primeira página. A relevância sempre prevalece:
// um livro sem relação nunca supera uma correspondência real por ter link direto.
export function interleaveGroups(sorted, keyOf) {
    const out = [];
    for (let i = 0; i < sorted.length;) {
        const k = keyOf(sorted[i]);
        let j = i;
        while (j < sorted.length && keyOf(sorted[j]) === k) j++;
        const queues = new Map();
        for (const r of sorted.slice(i, j)) { if (!queues.has(r.source)) queues.set(r.source, []); queues.get(r.source).push(r); }
        const lists = [...queues.values()];
        for (let n = 0; lists.some(l => n < l.length); n++) for (const l of lists) if (n < l.length) out.push(l[n]);
        i = j;
    }
    return out;
}

export function capPerSource(sorted, window = 30, max = 12) {
    const head = [], used = new Map();
    for (const r of sorted) { if (head.length >= window) break; if ((used.get(r.source) || 0) >= max) continue; head.push(r); used.set(r.source, (used.get(r.source) || 0) + 1); }
    const inHead = new Set(head);
    return head.concat(sorted.filter(r => !inHead.has(r)));
}

const keepResult = (r, o) =>
    (!o.formats.length || !r.format || o.formats.includes(String(r.format).toLowerCase().replace(/^\./, '')))
    && (!o.yearFrom || !(parseInt(r.year) > 0) || (parseInt(r.year) >= o.yearFrom && parseInt(r.year) <= o.yearTo))
    && (!o.lang || !r.language || langOf(r.language) === langOf(o.lang));
export const LANGS = { en: 'english|eng', es: 'spanish|spa|español|espanol', fr: 'french|fra|fre|français|francais', de: 'german|deu|ger|deutsch',
    it: 'italian|ita|italiano', pt: 'portuguese|por|português|portugues', ru: 'russian|rus|русский', ja: 'japanese|jpn|日本語', zh: 'chinese|zho|chi|中文', nl: 'dutch|nld|dut', pl: 'polish|pol' };
export const langOf = l => { const s = String(l).trim().toLowerCase(); for (const [k, v] of Object.entries(LANGS)) if (s === k || s.startsWith(k + '-') || v.split('|').includes(s)) return k; return s; };

export function parseOpts(url) {
    const list = k => (url.searchParams.get(k) || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const y = (url.searchParams.get('year') || '').match(/^\s*(\d{4})(?:\s*-\s*(\d{4}))?\s*$/);
    const lang = (url.searchParams.get('lang') || '').trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 20);
    const title = (url.searchParams.get('q') && url.searchParams.get('title') || '').trim().slice(0, 300);
    const pref = (url.searchParams.get('pref') || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
    return { formats: list('formats'), sources: list('sources'), yearFrom: y ? +y[1] : 0, yearTo: y ? +(y[2] || y[1]) : 0, lang, title, pref };
}
const optsKey = o => (o && (o.formats.length || o.sources.length || o.yearFrom || o.lang || o.title || o.pref)) ? JSON.stringify(o) : '';
export const inLanguage = (language, pref) => {
    const s = String(language || '').trim().toLowerCase();
    if (!s || !pref) return false;
    return langOf(s) === pref || (LANGS[pref] || pref).split('|').some(n => (n.length >= 4 ? s.includes(n) : s === n || s.startsWith(n + '-')));
};

export const workKey = r => fold(String(r.title || '').replace(/^.*·\s*/, '').replace(/\s*[:(\[].*$/, '').replace(/\s+\d+$/, '')).replace(/\s+/g, ' ').trim();
const authorTokens = a => new Set(fold(String(a || '')).split(/[^a-z]+/).filter(w => w.length >= 3 && !['and', 'the', 'with', 'edited', 'illustrated', 'translated'].includes(w)));
export function consensusBonus(results) {
    const groups = new Map();
    for (const r of results) {
        const k = workKey(r);
        if (!k) continue;
        const g = groups.get(k) || { sources: new Set(), n: 0 };
        g.sources.add(r.source); g.n++;
        groups.set(k, g);
    }
    const tally = new Map(); let multi = 0;
    for (const r of results) {
        const g = groups.get(workKey(r));
        if (!g || g.sources.size < 2) continue;
        multi++;
        for (const w of authorTokens(r.author)) tally.set(w, (tally.get(w) || 0) + 1);
    }
    const top = [...tally].sort((a, b) => b[1] - a[1])[0];
    const dominant = top && multi >= 4 && top[1] / multi >= 0.35 ? top[0] : '';
    const bonus = new Map();
    for (const r of results) {
        const g = groups.get(workKey(r));
        let b = g ? Math.min(3, g.sources.size - 1) * 18 + Math.min(4, g.n - 1) * 4 : 0;
        if (dominant && authorTokens(r.author).has(dominant)) b += 20;
        bonus.set(r, b);
    }
    return bonus;
}

function mergeAndRank(all, query, mode, opts) {
    if (opts) all = all.filter(r => keepResult(r, opts));
    const isbn = isIsbnQuery(query);
    const phrase = fold(query);
    all.forEach(r => {
        r._score = scoreResult(r, query);
        r._band = isbn ? 3 : relevanceBand(r, query);
        const p = r._band === 3 ? (opts && opts.title ? fold(opts.title) : withoutAuthor(r, query)) || phrase : phrase;
        if (r._band === 3 && p && fold(r.title).includes(p)) r._band = 4;
        if (r._band === 4 && fold(String(r.title).replace(/^.*·\s*/, '').replace(/\s*[:(\[].*$/, '')) === p) r._band = 5;
    });
    let pool = all.filter(r => r._band > 0);
    if (!pool.length) pool = all;
    const pop = consensusBonus(pool);
    const tier = r => (r._band >= 4 ? 4 : r._band);
    const linkBonus = r => (r.directUrl ? 8 : r.resolvable || r.magnet ? 5 : 0) + (mode === 'audiobooks' && r.source === 'AudiobookBay' ? 10 : 0);
    const prefer = r => (opts && opts.pref && inLanguage(r.language, opts.pref) ? 25 : 0);
    const final = r => r._score + (pop.get(r) || 0) + linkBonus(r) + prefer(r);
    pool.sort((a, b) => tier(b) - tier(a) || final(b) - final(a));
    const seen = new Set();
    const out = capPerSource(pool, 30, 12).filter(r => {
        const key = ((r.title||'') + '|' + (r.author||'') + '|' + (r.source||'') + '|' + (r.format||'')).toLowerCase().replace(/\s+/g,' ').trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    out.forEach(r => { registerResult(r, mode); decorate(r); });
    return out;
}

export async function freshLibgenLink(md5, skip = []) {
    if (!/^[a-f0-9]{32}$/i.test(md5 || '')) return '';
    if (skip.length) { const alt = await libgenFallbackLink(md5); if (alt) return alt.url; }
    const t = { md5 };
    await resolveLibgenLinks([t], 1, skip);
    return t.directUrl || '';
}

const resolving = new Map();
export async function resolveOne(id, { fallback = true, dl = true } = {}) { // dl: false não usa as alternativas de download (o teste de uma alternativa precisa do link original)
    const r = resultStore.get(id);
    if (!r) return null;
    if (r.directUrl || r.magnet) { mirrorize(r); await checkLink(r, dl); if (fallback && r.linkError && !r.magnet) await useAlternative(r); return decorate(r); }
    if (!resolving.has(id)) {
        resolving.set(id, (async () => {
            const mode = r._mode || 'ebooks';
            switch (r.source) {
                case 'Library Genesis': if (r.md5) await resolveLibgenLinks([r], 1); break;
                case "Anna's Archive":
                    if (r.md5) { const t = { md5: r.md5 }; await resolveLibgenLinks([t], 1); if (t.directUrl) { r.directUrl = t.directUrl; r.directFrom = 'LibGen'; } }
                    break;
                case 'RoyalLib': await resolveRoyalLibLinks([r], 1); break;
                case 'Internet Archive': await resolveArchiveLinks([r], mode, 1); break;
                case 'AudiobookBay': {
                    const raw = { ...r, detailUrl: r.detailUrl || r.downloadUrl };
                    await resolveAbbMagnets([raw], 1);
                    if (raw.magnet) { r.magnet = raw.magnet; r.infoHash = raw.infoHash; }
                    break;
                }
                case 'AudiobooksBee': {
                    const raw = { ...r, detailUrl: r.detailUrl };
                    if (raw.detailUrl) { await resolveAudiobooksBeeLinks([raw], 1); if (raw.downloadUrl) { r.downloadUrl = raw.downloadUrl; if (raw.format) r.format = raw.format; } }
                    break;
                }
            }
            resolving.delete(id);
        })().catch(() => resolving.delete(id)));
    }
    await resolving.get(id);
    mirrorize(r);
    if (dl && !r.directUrl && r.md5 && (r.source === 'Library Genesis' || r.source === "Anna's Archive")) {
        const alt = await downloadFallback(r);
        if (alt) { r.directUrl = alt.url; r.directFrom = alt.from; r.filesize = r.filesize || alt.size; }
    }
    r._resolved = true;
    await checkLink(r, dl);
    if (fallback && !r.magnet && (r.linkError || !r.directUrl)) await useAlternative(r);
    return decorate(r);
}

const IMPORTABLE = new Set(['epub', 'pdf', 'mobi', 'azw3', 'fb2', 'txt', 'mp3', 'm4b', 'm4a', 'flac', 'ogg', 'aac']);
export function alternativesFor(r, store = resultStore) {
    const key = workKey(r), authors = authorTokens(r.author), lang = langOf(r.language || '');
    const same = x => x !== r && x.id !== r.id && x._mode === r._mode && workKey(x) === key && IMPORTABLE.has(String(x.format || '').toLowerCase())
        && (x.directUrl || x.md5) && !NO_PROBE.has(x.source) && (!x.md5 || !r.md5 || x.md5 !== r.md5)
        && (!authors.size || !x.author || [...authorTokens(x.author)].some(w => authors.has(w)))
        && (!lang || !x.language || langOf(x.language) === lang)
        && !(x._probe && !x._probe.ok && Date.now() - x._probe.at < 5 * 60e3);
    const score = x => (x.format === r.format ? 0 : 2) + (x.directUrl ? 0 : 1);
    return [...store.values()].filter(same).sort((a, b) => score(a) - score(b)).slice(0, 5);
}
async function useAlternative(r) {
    if (r._alt) return;
    r._alt = true;
    const cands = alternativesFor(r);
    if (!cands.length) return;
    const found = await withDeadline(Promise.any(cands.map(async x => {
        const y = await resolveOne(x.id, { fallback: false });
        if (!y || !y.directUrl || y.linkError) throw new Error('sem link');
        return y;
    })).catch(() => null), 16000, null);
    if (!found) return;
    Object.assign(r, { directUrl: found.directUrl, format: found.format, filesize: found.filesize || r.filesize, directFrom: 'outra edição do mesmo livro', linkError: '', _probe: found._probe });
}

// Confere (uma vez a cada 5 minutos por resultado) se o servidor do arquivo responde. Sem isso um CDN fora do ar só aparece
// depois de o download travar. Links do próprio addon (/dl/...) e fontes que exigem sessão não são testados daqui.
const NO_PROBE = new Set(['Z-Library', 'Mobilism']);
async function checkLink(r, dl = true) {
    r.linkError = '';
    if (!r.directUrl || r.directUrl.startsWith('/') || NO_PROBE.has(r.source)) return;
    if (r._probe && Date.now() - r._probe.at < 5 * 60e3 && r._probe.url === r.directUrl) { r.linkError = r._probe.ok ? '' : r._probe.error; return; }
    let p = await probeFile(r.directUrl, { timeoutMs: 9000 });
    if (!p.ok && r.source === 'Library Genesis' && r.md5 && !r._renewed) {
        r._renewed = true;
        const fresh = { md5: r.md5 };
        await resolveLibgenLinks([fresh], 1);
        if (fresh.directUrl && fresh.directUrl !== r.directUrl) { r.directUrl = fresh.directUrl; p = await probeFile(r.directUrl, { timeoutMs: 7000 }); }
    }
    if (!p.ok && dl) {
        const alt = await downloadFallback(r);
        if (alt) { r.directUrl = alt.url; r.directFrom = alt.from; if (alt.size) r.filesize = r.filesize || alt.size; p = { ok: true, error: '' }; }
    }
    r._probe = { at: Date.now(), url: r.directUrl, ok: p.ok, error: p.error || '' };
    r.linkError = p.ok ? '' : p.error;
}

const RUNNERS = {
    libgen: { applies: () => true, run: (q, mode) => searchLibgen(q, mode).then(rs => mode === 'audiobooks' ? rs.filter(r => IA_AUDIO_EXTS.includes(String(r.format).toLowerCase())) : rs) },
    annas: { applies: m => m !== 'audiobooks', run: (q, m) => searchAnnas(q, m) },
    archive: { applies: () => true, run: (q, m) => searchArchive(q, m) },
    gutenberg: { applies: m => m !== 'audiobooks', run: (q, m) => searchGutenberg(q, m) },
    openstax: { applies: m => m !== 'audiobooks', run: (q, m) => searchOpenStax(q, m) },
    libretexts: { applies: m => m !== 'audiobooks', run: (q, m) => searchLibreTexts(q, m) },
    memoryoftheworld: { applies: m => m !== 'audiobooks', run: (q, m) => searchMemoryOfTheWorld(q, m) },
    royallib: { applies: m => m !== 'audiobooks', run: (q, m) => searchRoyalLib(q, m) },
    zlibrary: { applies: m => m !== 'audiobooks', run: (q, m) => searchZlibrary(q, m) },
    mobilism: { applies: () => mobilismConfigured(), run: (q, m) => searchMobilism(q, m) },
    audiobookbay: { applies: m => m === 'audiobooks', run: q => searchAudiobookBay(q) },
    librivox: { applies: m => m === 'audiobooks', run: (q, m) => searchLibriVox(q, m) },
    audiobooksbee: { applies: m => m === 'audiobooks', run: q => searchAudiobooksBee(q) },
};
for (const svc of Object.keys(GENERIC_ORIGINS)) { const run = RUNNERS[svc].run; RUNNERS[svc].run = async (...a) => mirrorizeAll(await run(...a)); }
let customSources = [];
export const setCustomSources = list => { customSources = Array.isArray(list) ? list : []; };
export async function searchCustomMirrored(def, query, mode) {
    const mirrors = (userMirrors['c:' + def.id] || []).filter(m => { const h = hostHealth.get(hostOf(m)); return !(h && h.coolUntil > Date.now()); }).slice(0, 2);
    if (!mirrors.length) return searchCustom(def, query, mode);
    const urls = [...mirrors.map(m => swapOrigin(def.url, m)), def.url];
    let firstError = null;
    for (let i = 0; i < urls.length; i++) {
        const last = i === urls.length - 1, host = hostOf(originOf(urls[i])), t0 = Date.now();
        try {
            const r = await searchCustom({ ...def, url: urls[i] }, query, mode, last ? 12000 : 7000);
            noteHost(host, true, Date.now() - t0);
            return r;
        } catch (e) {
            noteHost(host, false, 0, String(e && e.message || e).slice(0, 80));
            if (!firstError) firstError = e;
            if (last) throw firstError;
        }
    }
}
const customOrigins = service => { const c = customSources.find(x => 'c:' + x.id === service); return c ? [originOf(c.url.replace(/\{searchTerms\}/gi, 'q'))].filter(Boolean) : []; };

// Teste do painel: roda uma busca de verdade nessa fonte e confere se o primeiro link realmente entrega um arquivo.
// Devolve { status, count, ms, sample, link }. Não passa pelo cache nem pelo bloqueio de 10 min do Anna's.
export async function testSource(name, mode = 'ebooks') {
    const custom = name.startsWith('c:') ? customSources.find(c => 'c:' + c.id === name) : null;
    const runner = custom ? { run: q => searchCustomMirrored(custom, q, mode) } : RUNNERS[name];
    if (!runner) return { status: 'error', count: 0, ms: 0, error: 'Fonte desconhecida' };
    const q = mode === 'audiobooks' ? 'pride and prejudice' : 'dune';
    const t0 = Date.now();
    let rs;
    if (name === 'annas') annasBlockedUntil = 0;
    try { rs = await withDeadline(runner.run(q, mode), SEARCH_DEADLINE_MS, null); } catch (e) { return { status: 'error', count: 0, ms: Date.now() - t0, error: String(e.message || e).slice(0, 160) }; }
    const ms = Date.now() - t0;
    if (rs === null) return { status: 'timeout', count: 0, ms };
    const out = { status: rs.unavailable ? (rs.needsVerify ? 'verify' : 'unavailable') : 'ok', count: rs.length, ms };
    sourceHealth[name] = { status: out.status, at: Date.now(), ms };
    const cands = rs.filter(r => r.directUrl || r.md5 || r.detailUrl).slice(0, 3);
    if (cands.length) {
        out.sample = String(cands[0].title || '').slice(0, 80);
        const checks = await Promise.all(cands.map(async r => {
            try {
                let url = r.directUrl;
                if (!url) { registerResult(r, mode); const x = await resolveOne(r.id); if (x && x.linkError) return { ok: false, error: x.linkError }; url = x && x.directUrl; }
                if (url && !url.startsWith('/')) { const p = await probeFile(url, { timeoutMs: 9000 }); return { ok: p.ok, host: p.host, ms: p.ms, error: p.ok ? '' : p.error }; }
                return url ? { ok: true, host: 'addon' } : { ok: false, error: 'Não achei o link do arquivo' };
            } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 140) }; }
        }));
        const good = checks.filter(c => c.ok), bad = checks.find(c => !c.ok);
        out.link = { ok: good.length > 0, checked: checks.length, working: good.length, host: (good[0] || {}).host || '', ms: (good[0] || {}).ms, ...(bad ? { error: bad.error } : {}) };
    } else if (rs.length) out.link = { ok: false, checked: 0, working: 0, error: 'Os resultados não trazem link para baixar' };
    return out;
}

const SEARCH_DEADLINE_MS = 30000;
const RESOLVE_DEADLINE_MS = 12000;

async function runFullSearch(query, mode, resolveTopN, env, onProgress, opts) {
    opts = opts || { formats: [], sources: [], yearFrom: 0, yearTo: 0 };
    const started = Date.now();
    const jobs = [];
    const add = (name, applies, run) => { if (applies && !sourcesOff.has(name) && (!opts.sources.length || opts.sources.includes(name))) jobs.push({ name, fn: run, run: run(query) }); };
    for (const name of Object.keys(RUNNERS)) add(name, RUNNERS[name].applies(mode), q => RUNNERS[name].run(q, mode));
    for (const c of customSources) add('c:' + c.id, true, q => searchCustomMirrored(c, q, mode));

    const streaming = !!onProgress;
    const norm = (name, v) => name === 'audiobookbay' ? mapAbbResults(v) : name === 'audiobooksbee' ? mapAudiobooksBeeResults(v) : v;
    const got = {};
    let finished = false;
    const snapshot = () => mergeAndRank([].concat(...Object.values(got).map(v => v.slice())), query, mode, opts);
    const RESOLVERS = {
        libgen: rs => resolveLibgenLinks(rs, resolveTopN), royallib: rs => resolveRoyalLibLinks(rs, resolveTopN),
        archive: rs => resolveArchiveLinks(rs, mode, resolveTopN), audiobookbay: rs => resolveAbbMagnets(rs), audiobooksbee: rs => resolveAudiobooksBeeLinks(rs),
    };
    const resolveJobs = [];
    const resolveSoon = (name, v) => { if (!streaming && v.length && RESOLVERS[name]) resolveJobs.push(RESOLVERS[name](v).then(() => mirrorizeAll(v)).catch(() => {})); };

    if (onProgress) onProgress({ sources: jobs.map(j => j.name) });
    const settled = await Promise.allSettled(jobs.map(j => {
        let reported = false;
        const report = (v, count, status) => {
            if (reported) return;
            reported = true;
            sourceHealth[j.name] = { status, at: Date.now(), ms: Date.now() - started };
            if (!streaming || finished) return;
            got[j.name] = norm(j.name, v);
            onProgress({ done: j.name, count, status, results: snapshot() });
        };
        j.run.then(v => report(v, v.length, v.unavailable ? (v.needsVerify ? 'verify' : 'unavailable') : 'ok'), () => report([], 0, 'error'));
        return withDeadline(j.run, SEARCH_DEADLINE_MS, []).then(v => { report([], 0, 'timeout'); resolveSoon(j.name, v); return v; });
    }));
    const byName = {};
    jobs.forEach((j, i) => { byName[j.name] = settled[i].status === 'fulfilled' ? settled[i].value : []; });
    const titleQ = opts.title || titleWordsOf(query, [].concat(...Object.values(byName)));
    const empty = jobs.filter(j => !byName[j.name].length && sourceHealth[j.name] && sourceHealth[j.name].status === 'ok');
    if (titleQ && fold(titleQ) !== fold(query) && empty.length) {
        await Promise.allSettled(empty.map(j => withDeadline(j.fn(titleQ), SEARCH_DEADLINE_MS, []).then(v => {
            if (!v.length || finished) return;
            byName[j.name] = v;
            resolveSoon(j.name, v);
            sourceHealth[j.name] = { status: 'ok', at: Date.now(), ms: Date.now() - started };
            if (streaming) { got[j.name] = norm(j.name, v); onProgress({ done: j.name, count: v.length, status: 'ok', results: snapshot() }); }
        }).catch(() => {})));
    }
    const count = n => (byName[n] || []).length;
    const meta = () => ({
        libgen: count('libgen'), annas: count('annas'), archive: count('archive'), gutenberg: count('gutenberg'),
        openstax: count('openstax'), libretexts: count('libretexts'), memoryoftheworld: count('memoryoftheworld'),
        royallib: count('royallib'), audiobookbay: count('audiobookbay'), librivox: count('librivox'),
        audiobooksbee: count('audiobooksbee'), zlibrary: count('zlibrary'), mobilism: count('mobilism'),
        ...Object.fromEntries(customSources.map(c => ['c:' + c.id, count('c:' + c.id)])),
    });

    if (streaming) {
        finished = true;
        jobs.forEach(j => { if (!got[j.name]) got[j.name] = norm(j.name, byName[j.name] || []); });
        return { results: snapshot(), meta: meta() };
    }

    await withDeadline(Promise.allSettled(resolveJobs), RESOLVE_DEADLINE_MS, null);
    jobs.forEach(j => { got[j.name] = norm(j.name, byName[j.name] || []); });
    return { results: snapshot(), meta: meta() };
}

const SEARCH_EDGE_TTL_S = 600;
const degradedTtl = meta => (meta && meta.libgen > 0 ? SEARCH_EDGE_TTL_S : 60);
const searchCacheKey = (mode, query, opts) =>
    'https://edge-cache.internal/search/all?mode=' + encodeURIComponent(mode) + '&q=' + encodeURIComponent((query || '').trim().toLowerCase().slice(0, 200))
    + (optsKey(opts) ? '&o=' + encodeURIComponent(optsKey(opts)) : '')
    + (sourcesOff.size ? '&off=' + [...sourcesOff].sort().join(',') : '');

async function plainSearch(url, mode, query, opts, env, ctx) {
    const res = await withEdgeCache(searchCacheKey(mode, query, opts), ctx, SEARCH_EDGE_TTL_S, async () => {
        const { results, meta } = await runFullSearch(query, mode, undefined, env, undefined, opts);
        return [ok({ source: 'all', results, meta }), results.length > 0 && degradedTtl(meta)];
    });
    const out = await res.json();
    keepResults(out.results, mode);
    if (url.searchParams.get('links') === 'direct') out.results = out.results.filter(r => r.directUrl);
    const names = Object.keys(out.meta || {});
    out.libraries = { answered: names.filter(n => out.meta[n] > 0).length, total: names.length };
    return ok(out);
}

// ── Roteador ──

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

        const url   = new URL(request.url);
        const path  = url.pathname;

        if (path === '/torrent') return torrentFile(url.searchParams.get('id') || '');

        if (path === '/resolve') {
            const r = await resolveOne(url.searchParams.get('id') || '');
            if (!r) return err('Unknown or expired result', 404);
            if (r.linkError && !r.magnet) return err(r.linkError, 502);
            return ok({ id: r.id, directUrl: r.directUrl || '', magnet: r.magnet || '', infoHash: r.infoHash || '', downloadUrl: r.downloadUrl, format: r.format || '', filesize: r.filesize || 0, directFrom: r.directFrom || '', linkType: r.linkType, fileAs: r.fileAs, onShelf: r.onShelf, length: r.length || '', bitrate: r.bitrate || '', tracks: r.tracks || 0, abridged: r.abridged ?? null, narrator: r.narrator || ''});
        }
        if (path === '/dl/zlib') return zlibDownload(url.searchParams.get('id') || '', url.searchParams.get('hash') || '');

        const query = (url.searchParams.get('q') || [url.searchParams.get('title'), url.searchParams.get('author')].filter(Boolean).join(' ')).trim().slice(0, 300);
        const mode  = url.searchParams.get('mode') === 'audiobooks' || /^audio/.test(url.searchParams.get('kind') || '') ? 'audiobooks' : 'ebooks';
        const opts  = parseOpts(url);

        if (!query) return err('No query provided', 400);
        const blocked = searchBlocked();
        if (blocked) return err(blocked, 503);

        try {
            if (path === '/search/libgen') {
                let results = await searchLibgen(query, mode);
                if (results.length > 0) await resolveLibgenLinks(results);
                return okR(env, 'libgen', results);
            }
            if (path === '/search/royallib') {
                let results = await searchRoyalLib(query, mode);
                if (results.length > 0) await resolveRoyalLibLinks(results);
                return okR(env, 'royallib', results);
            }
            // O filtro ext do Anna's não aceita áudio e só devolveria e-books.
            // Ignora Anna's no modo audiolivros.
            if (path === '/search/annas') {
                if (mode === 'audiobooks') return okR(env, 'annas', []);
                return okR(env, 'annas', await searchAnnas(query, mode));
            }

            if (path === '/search/archive') {
                let results = await searchArchive(query, mode);
                if (results.length > 0) await resolveArchiveLinks(results, mode);
                return okR(env, 'archive', results);
            }

            if (path === '/search/audiobookbay') {
                let results = await searchAudiobookBay(query);
                results = await resolveAbbMagnets(results);
                return okR(env, 'audiobookbay', mapAbbResults(results));
            }

            if (path === '/search/gutenberg') {
                return okR(env, 'gutenberg', await searchGutenberg(query, mode));
            }

            if (path === '/search/openstax') {
                return okR(env, 'openstax', await searchOpenStax(query, mode));
            }

            if (path === '/search/libretexts') {
                return okR(env, 'libretexts', await searchLibreTexts(query, mode));
            }

            if (path === '/search/memoryoftheworld') {
                return okR(env, 'memoryoftheworld', await searchMemoryOfTheWorld(query, mode));
            }

            if (path === '/search/librivox') {
                return okR(env, 'librivox', await searchLibriVox(query, mode));
            }

            if (path === '/search/audiobooksbee') {
                let results = await searchAudiobooksBee(query);
                results = await resolveAudiobooksBeeLinks(results);
                return okR(env, 'audiobooksbee', mapAudiobooksBeeResults(results));
            }

            if (path === '/search/zlibrary') return okR(env, 'zlibrary', await searchZlibrary(query, mode));
            if (path === '/search/mobilism') return okR(env, 'mobilism', await searchMobilism(query, mode));

            if (path === '/search/all') {
                if (url.searchParams.get('stream') === '1') {
                    const key = searchCacheKey(mode, query, opts);
                    const hit = await edgeGet(key);
                    if (hit) { const out = await hit.json(); keepResults(out.results, mode); return ok(out); }
                    const ts = new TransformStream();
                    const writer = ts.writable.getWriter();
                    const enc = new TextEncoder();
                    const send = o => writer.write(enc.encode(JSON.stringify(o) + '\n')).catch(() => {});
                    ctx.waitUntil((async () => {
                        try {
                            const { results, meta } = await runFullSearch(query, mode, undefined, env, send, opts);
                            await send({ final: { source: 'all', results, meta } });
                            if (results.length > 0) edgePut(key, ctx, degradedTtl(meta), ok({ source: 'all', results, meta }));
                        } catch (e) {
                            await send({ error: String(e && e.message || e) });
                        } finally { writer.close().catch(() => {}); }
                    })());
                    return new Response(ts.readable, { headers: Object.assign({}, CORS, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' }) });
                }

                return plainSearch(url, mode, query, opts, env, ctx);
            }

            if (path === '/api/v1/search') {
                if (!apiKeyOk(request, env)) return err('Missing or invalid X-API-Key', 401);
                return plainSearch(url, mode, query, opts, env, ctx);
            }

            return err('Unknown endpoint', 404);
        } catch(e) {
            return err('Search error: ' + e.message);
        }
    },
};

// ── Para o painel do addon ──
export const SOURCE_ORIGINS = { libgen: LIBGEN_MIRRORS, annas: ANNAS_MIRRORS, zlibrary: ZLIB_DOMAINS, audiobookbay: ABB_MIRRORS, ...GENERIC_ORIGINS };
export const STATIC_MIRRORS = SOURCE_ORIGINS;
export const mirrorStatus = service => mirrorHealth(service, service.startsWith('c:') ? customOrigins(service) : (SOURCE_ORIGINS[service] || []));

const looks = re => t => re.test(t);
const MIRROR_PROBES = {
    libgen: { path: () => '/index.php?' + libgenSearchParams('dune', 'ebooks'), check: t => t.includes('tablelibgen'), headers: { Cookie: 'covers=on' } },
    annas: { path: () => '/search?q=dune', check: t => (t.includes('js-vim-focus') || t.includes('/md5/')) ? true : (isDdosGuard(t) ? 'challenged' : false) },
    zlibrary: { path: () => '/', init: { redirect: 'manual' }, check: (t, r) => ((r.status >= 300 && r.status < 400) || isDiamWall(t)) ? 'challenged' : (r.status === 200 && /z-?lib|1lib/i.test(t)) },
    archive: { path: () => '/advancedsearch.php?q=dune&fl[]=identifier&rows=1&output=json', check: looks(/"docs"/) },
    gutenberg: { path: () => '/ebooks/search.opds/?query=dune', check: looks(/<entry>/) },
    openstax: { path: () => '/apps/cms/api/v2/pages/?type=books.Book&limit=1', check: looks(/"items"/) },
    libretexts: { path: () => '/', check: looks(/libretexts/i) },
    memoryoftheworld: { path: () => '/search?q=dune', check: looks(/"_items"/) },
    royallib: { path: () => '/', check: looks(/royallib/i) },
    audiobookbay: { path: () => '/?s=dune&cat=undefined%2Cundefined', check: t => t.includes('archiveTitle') },
    librivox: { path: () => '/api/feed/audiobooks/?title=%5Epride&format=json&limit=1', check: looks(/"books"/) },
    audiobooksbee: { path: () => '/?s=dune', check: looks(/audiobooks?bee/i) },
};
export const mirrorServices = () => Object.keys(MIRROR_PROBES);
const whyFailed = e => {
    const code = (e && (e.code || (e.cause && e.cause.code))) || '';
    if (e && e.name === 'AbortError') return 'timeout';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'O endereço não existe (o nome do site não foi encontrado)';
    if (code === 'ECONNREFUSED') return 'O servidor recusou a conexão';
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'A conexão foi cortada pelo servidor';
    if (/CERT|SSL|TLS/i.test(code + (e && e.message))) return 'Certificado de segurança inválido';
    if (e && /private network/i.test(e.message)) return 'O endereço aponta para uma rede privada, o que não é permitido';
    return String((e && ((e.cause && e.cause.message) || e.message)) || e).slice(0, 140);
};
export async function testMirror(service, origin, ms = 12000) {
    const def = service.startsWith('c:') ? customSources.find(c => 'c:' + c.id === service) : null;
    const probe = def ? { path: () => def.url.replace(/^https?:\/\/[^/?#]+/i, '').replace(/\{searchTerms\}/gi, 'dune'), check: looks(/<feed\b|<entry\b|"publications"|"navigation"|opensearch/i) } : MIRROR_PROBES[service];
    if (!probe) return { status: 'error', ms: 0, error: 'Esta fonte não aceita espelhos' };
    const t0 = Date.now(), host = hostOf(origin);
    try {
        await assertPublicUrl(origin);
        const res = await rawGet(origin + probe.path(), ms, probe.headers || {}, probe.init || {});
        const text = await res.text(), took = Date.now() - t0, v = probe.check(text, res);
        if (v === true) { noteHost(host, true, took); return { status: 'ok', ms: took, http: res.status }; }
        if (v === 'challenged') return { status: 'verify', ms: took, http: res.status };
        if (service === 'libgen' && /id="__nuxt"/.test(text)) return { status: 'error', ms: took, http: res.status, error: 'Este endereço é o aplicativo web do LibGen (como o libgen.me): ele não tem a busca que os espelhos precisam. Para usá-lo, adicione-o em “Alternativas de download” (o Sleuth já tenta o download dele sozinho quando o link normal falha).' };
        const error = res.status >= 400 ? `O site respondeu com erro (HTTP ${res.status})` : 'Respondeu, mas não parece ser o site (página estacionada, bloqueada ou outro conteúdo)';
        noteHost(host, false, 0, error);
        return { status: 'error', ms: took, http: res.status, error };
    } catch (e) {
        const why = whyFailed(e);
        if (why === 'timeout') return { status: 'timeout', ms: Date.now() - t0 };
        noteHost(host, false, 0, why);
        return { status: 'error', ms: Date.now() - t0, error: why };
    }
}
export const activeSources = mode => [
    ...Object.keys(RUNNERS).filter(n => !sourcesOff.has(n) && RUNNERS[n].applies(mode)),
    ...customSources.map(c => 'c:' + c.id).filter(n => !sourcesOff.has(n)),
];
export const verifyNeeded = () => ({ annas: annasChallenged, zlibrary: !!zlibWall });
