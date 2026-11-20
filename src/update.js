// Atualização automática a partir dos Releases do GitHub.
// Cada release publica update.json (versão, hash e tamanho do zip), update.json.sig (assinatura Ed25519 desse arquivo) e o zip do código.
// Nada é instalado sem a assinatura valer para uma das PUBLIC_KEYS: quem não tem a chave privada não consegue empurrar código.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fetchPublic, readCapped } from './netguard.js';
import { extractZip } from './zip.js';
import { contractHash } from './manifest.js';

export const DEFAULT_REPO = 'brl0820/sleuth';
// Mais de uma chave permite trocar a chave de assinatura sem deixar instalações antigas sem atualizar.
export const PUBLIC_KEYS = ['MCowBQYDK2VwAyEAXHmYcAKNbjvaabp12RlTHvvts5Q4R6Oo2EAWfBGmI94='];
export const LAUNCHER_API = 1;
export const CHECK_EVERY_MS = 6 * 3600e3;

const MAX = { meta: 64 * 1024, sig: 1024, zip: 40e6 };
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

export function compare(a, b) {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

export function verifySignature(data, signatureB64, keys = PUBLIC_KEYS) {
    const sig = Buffer.from(String(signatureB64).trim(), 'base64');
    if (sig.length !== 64) return false;
    return keys.some(k => {
        try { return crypto.verify(null, data, crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), sig); } catch { return false; }
    });
}

// update.json já autenticado: confere os campos e diz se esta máquina pode instalar.
export function readUpdateInfo(bytes, { nodeMajor, launcherApi, contract }) {
    let j;
    try { j = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('update.json ilegível'); }
    const bad = why => { throw new Error('update.json inválido: ' + why); };
    if (!j || typeof j !== 'object' || j.format !== 1) bad('formato');
    if (!SEMVER.test(String(j.version))) bad('versão');
    const z = j.zip || {};
    if (z.name !== `sleuth-app-${j.version}.zip`) bad('nome do pacote');
    if (!/^[a-f0-9]{64}$/.test(String(z.sha256))) bad('hash');
    if (!Number.isInteger(z.size) || z.size < 1 || z.size > MAX.zip) bad('tamanho');
    if (!/^[a-f0-9]{64}$/.test(String(j.contract))) bad('contrato');
    const node = Number.isInteger(j.node) ? j.node : 0, launcher = Number.isInteger(j.launcher) ? j.launcher : 1;
    let blocked = '';
    if (j.contract !== contract) blocked = 'Esta versão muda as permissões ou as páginas do addon: instale o pacote novo (.maddon) pela página de Releases.';
    else if (launcher > launcherApi) blocked = 'Esta versão exige um pacote novo (.maddon): baixe-o pela página de Releases.';
    else if (node > nodeMajor) blocked = `Esta versão exige Node ${node} ou mais novo: baixe o pacote novo (.maddon) pela página de Releases.`;
    return { version: j.version, zip: { name: z.name, sha256: z.sha256, size: z.size }, notes: typeof j.notes === 'string' ? j.notes.slice(0, 600) : '', blocked };
}

const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
};
const readJson = file => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export function createUpdater({
    dataDir, version, enabled = true, supervised = false, repo = () => DEFAULT_REPO, auto = () => true, keys = PUBLIC_KEYS,
    contract = contractHash(), nodeMajor = Number(process.versions.node.split('.')[0]), launcherApi = Number(process.env.SLEUTH_LAUNCHER_API || LAUNCHER_API),
    fetchFn = fetchPublic, urls = null, allowHttp = false, onInstalled = () => {}, now = Date.now,
}) {
    const dir = path.join(dataDir, 'updates');
    const statePath = path.join(dir, 'state.json'), bootPath = path.join(dir, 'boot.json');
    const mem = { checking: false, lastCheckAt: 0, lastError: '', available: null, blocked: '', pending: null };
    let timers = [];

    const repoName = () => { const r = String(repo() || ''); return REPO.test(r) ? r : DEFAULT_REPO; };
    const base = () => urls || { latest: `https://github.com/${repoName()}/releases/latest/download/`, tag: v => `https://github.com/${repoName()}/releases/download/v${v}/` };
    const dirOk = v => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, v, 'package.json'), 'utf8')).version === v && fs.existsSync(path.join(dir, v, 'server.js')); } catch { return false; }
    };

    async function download(url, max) {
        if (!allowHttp && new URL(url).protocol !== 'https:') throw new Error('A atualização só é baixada por https');
        const res = await fetchFn(url, { headers: { 'User-Agent': 'Sleuth-Updater', Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(90000) });
        if (!res.ok) { if (res.body) res.body.cancel().catch(() => {}); throw new Error(`O GitHub respondeu ${res.status}`); }
        return readCapped(res, max);
    }

    function prune(keep) {
        for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
            if ((SEMVER.test(name) && !keep.has(name)) || name.startsWith('.tmp-')) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
    }

    async function installUpdate(info) {
        const buf = await download(base().tag(info.version) + info.zip.name, MAX.zip);
        if (buf.length !== info.zip.size) throw new Error('Tamanho do pacote diferente do anunciado');
        if (crypto.createHash('sha256').update(buf).digest('hex') !== info.zip.sha256) throw new Error('O pacote baixado não confere com o hash assinado: descartado');
        const tmp = path.join(dir, `.tmp-${info.version}-${crypto.randomBytes(4).toString('hex')}`);
        try {
            extractZip(buf, tmp);
            const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
            if (pkg.version !== info.version || !fs.existsSync(path.join(tmp, 'server.js'))) throw new Error('O conteúdo do pacote não é a versão anunciada');
            const dest = path.join(dir, info.version);
            fs.rmSync(dest, { recursive: true, force: true });
            fs.renameSync(tmp, dest);
        } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
        const st = readJson(statePath);
        const previous = st.current && st.current !== info.version && dirOk(st.current) ? st.current : (st.previous && dirOk(st.previous) ? st.previous : null);
        const history = [{ version: info.version, at: now(), from: st.current || version }, ...(Array.isArray(st.history) ? st.history : [])].slice(0, 10);
        writeJson(statePath, { ...st, current: info.version, previous, history });
        prune(new Set([info.version, previous].filter(Boolean)));
        mem.available = null;
        mem.pending = info.version;
        onInstalled({ version: info.version });
    }

    async function check({ install = false } = {}) {
        if (!enabled) { mem.lastError = 'As atualizações estão desligadas neste modo de execução.'; return status(); }
        if (mem.checking) return status();
        mem.checking = true;
        mem.lastError = '';
        try {
            const b = base();
            const meta = await download(b.latest + 'update.json', MAX.meta);
            const sig = await download(b.latest + 'update.json.sig', MAX.sig);
            if (!verifySignature(meta, sig.toString('utf8'), keys)) throw new Error('A assinatura da atualização não confere: ignorada');
            const info = readUpdateInfo(meta, { nodeMajor, launcherApi, contract });
            const st = readJson(statePath), boot = readJson(bootPath);
            const installed = st.current && compare(st.current, version) > 0 ? st.current : version;
            mem.available = null; mem.blocked = '';
            if (compare(info.version, installed) <= 0) return status();
            if ([...(st.rejected || []), ...(boot.bad || [])].includes(info.version)) { mem.lastError = `A versão ${info.version} falhou nesta máquina e foi ignorada.`; return status(); }
            if (info.blocked) { mem.blocked = info.blocked; return status(); }
            mem.available = { version: info.version, notes: info.notes };
            if (install || auto()) await installUpdate(info);
        } catch (e) {
            mem.lastError = String((e && e.message) || e).slice(0, 220);
        } finally { mem.checking = false; mem.lastCheckAt = now(); }
        return status();
    }

    function rollback() {
        const st = readJson(statePath);
        if (!st.current && !st.previous) throw new Error('Não há versão anterior guardada: este já é o pacote original.');
        const target = st.previous && dirOk(st.previous) ? st.previous : null;
        writeJson(statePath, { ...st, current: target, previous: null, rejected: [...new Set([...(st.rejected || []), st.current].filter(Boolean))].slice(-20) });
        prune(new Set([target].filter(Boolean)));
        mem.pending = target || 'original';
        mem.available = null;
        onInstalled({ version: target || 'original', rollback: true });
        return status();
    }

    function status() {
        const st = readJson(statePath);
        return {
            enabled, supervised, running: version, repo: repoName(), auto: !!auto(), checking: mem.checking, lastCheckAt: mem.lastCheckAt, lastError: mem.lastError,
            available: mem.available, blocked: mem.blocked, pending: mem.pending, canRollback: !!(st.current || st.previous), history: Array.isArray(st.history) ? st.history.slice(0, 5) : [],
        };
    }

    function start() {
        if (!enabled || timers.length) return;
        const first = setTimeout(() => { if (auto()) check(); }, 45e3);
        const every = setInterval(() => { if (auto()) check(); }, CHECK_EVERY_MS);
        for (const t of [first, every]) t.unref();
        timers = [first, every];
    }
    const stop = () => { timers.forEach(clearTimeout); timers = []; };

    return { check, rollback, status, start, stop };
}
