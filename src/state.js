// Preferências do addon que a pessoa muda no painel (Configurações): fontes ligadas/desligadas, espelhos extras, fontes
// personalizadas (OPDS) e contas. Ficam num arquivo na pasta de dados do addon e são a fonte da verdade; a configuração do
// endereço do manifest (/c/<config>) vale só enquanto a pessoa não tiver salvo nada.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { isPrivateIp } from './netguard.js';

import { dataDir } from './host.js';
const file = () => path.join(dataDir(), 'sleuth.json');
export const dir = dataDir;

const EMPTY = () => ({ v: 1, enabled: null, mirrors: {}, downloads: {}, custom: [], creds: {}, slum: null, updates: { auto: null, repo: '' } });
let cache = null;

const host = v => {
    try {
        const u = new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v), h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (!/^https?:$/.test(u.protocol) || !h.includes('.') || u.username || /\.(local|localhost|internal|lan|home|arpa)$/.test(h)) return '';
        if (net.isIP(h) && isPrivateIp(h)) return '';
        return u.origin;
    } catch { return ''; }
};
export const cleanMirror = host;
export const cleanDownload = (v, service = 'libgen') => {
    const s = String(v || '').trim().slice(0, 300);
    if (!s) return '';
    const FIELDS = /\{(md5|path|file|url|urlenc|identifier)\}/g;
    if (!FIELDS.test(s)) {
        const o = host(s);
        if (!o || !o.startsWith('https://')) return '';
        return service === 'libgen' || service === 'annas' ? o + '/api/download?id={md5}' : o + '{path}';
    }
    const sample = { md5: 'a'.repeat(32), path: '/p', file: 'f', url: 'https://a.example/f', urlenc: 'https%3A%2F%2Fa.example%2Ff', identifier: 'i' };
    const filled = s.replace(/\{(md5|path|file|url|urlenc|identifier)\}/g, (m, k) => sample[k]), o = host(filled);
    const pre = (/^https:\/\/[^/?#{]*/i.exec(s) || [''])[0].toLowerCase();
    if (!o || !o.startsWith('https://') || o.toLowerCase() !== pre) return '';
    try { new URL(filled); } catch { return ''; }
    return s;
};
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

function sanitize(raw) {
    const out = EMPTY();
    if (!raw || typeof raw !== 'object') return out;
    if (Array.isArray(raw.enabled)) out.enabled = raw.enabled.filter(x => typeof x === 'string' && /^[a-z0-9:_-]{1,40}$/.test(x)).slice(0, 60);
    out.custom = (Array.isArray(raw.custom) ? raw.custom : []).map(c => ({
        id: str(c && c.id, 12).replace(/[^a-z0-9]/g, ''), name: str(c && c.name, 40), url: str(c && c.url, 500), type: 'opds',
    })).filter(c => c.id && c.name && /^https?:\/\//i.test(c.url)).slice(0, 12);
    const rawMirrors = raw.mirrors && typeof raw.mirrors === 'object' ? raw.mirrors : {};
    const customKeys = new Set(out.custom.map(c => 'c:' + c.id));
    for (const k of Object.keys(rawMirrors).filter(k => /^[a-z0-9]{1,30}$/.test(k) || customKeys.has(k)).slice(0, 45)) {
        const list = [...new Set((Array.isArray(rawMirrors[k]) ? rawMirrors[k] : []).map(host).filter(Boolean))].slice(0, 8);
        if (list.length) out.mirrors[k] = list;
    }
    const credKeys = ['zlib_email', 'zlib_password', 'zlib_domain', 'annas_cookie', 'annas_mirror', 'mobilism_user', 'mobilism_pass'];
    for (const k of credKeys) { const v = str(raw.creds && raw.creds[k], 2000); if (v) out.creds[k] = v; }
    if (typeof raw.slum === 'boolean') out.slum = raw.slum;
    const up = raw.updates && typeof raw.updates === 'object' ? raw.updates : {};
    if (typeof up.auto === 'boolean') out.updates.auto = up.auto;
    if (typeof up.repo === 'string' && /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(up.repo.trim())) out.updates.repo = up.repo.trim();
    const rawDl = raw.downloads && typeof raw.downloads === 'object' ? raw.downloads : {};
    for (const k of Object.keys(rawDl).filter(k => /^[a-z0-9]{1,30}$/.test(k) || customKeys.has(k)).slice(0, 25)) {
        const list = [...new Set((Array.isArray(rawDl[k]) ? rawDl[k] : []).map(x => cleanDownload(x, k)).filter(Boolean))].slice(0, 8);
        if (list.length) out.downloads[k] = list;
    }
    return out;
}

export function load() {
    if (cache) return cache;
    try { cache = sanitize(JSON.parse(fs.readFileSync(file(), 'utf8'))); } catch { cache = EMPTY(); }
    return cache;
}

export function update(fn) {
    const next = sanitize(JSON.parse(JSON.stringify(load())));
    fn(next);
    cache = sanitize(next);
    try {
        fs.mkdirSync(dataDir(), { recursive: true });
        const tmp = file() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file());
    } catch (e) { cache.saveError = String(e.message).slice(0, 120); }
    return cache;
}

export function effective(urlConfig = {}) {
    const s = load();
    return {
        enabled: s.enabled || (Array.isArray(urlConfig.enabled) ? urlConfig.enabled : null),
        slum: s.slum !== null ? s.slum : urlConfig.slum !== false,
        mirrors: s.mirrors,
        downloads: s.downloads,
        updates: s.updates,
        custom: s.custom,
        creds: { ...Object.fromEntries(['zlib_email', 'zlib_password', 'zlib_domain', 'mobilism_user', 'mobilism_pass', 'annas_cookie', 'annas_mirror'].filter(k => urlConfig[k]).map(k => [k, urlConfig[k]])), ...s.creds },
    };
}

export const testReset = () => { cache = null; };
