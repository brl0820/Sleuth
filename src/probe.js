// Confere se o link de um arquivo realmente entrega o arquivo. Muitos sites respondem normalmente, mas o servidor que guarda o
// arquivo (CDN) está fora do ar ou devolve uma página de erro: sem essa conferência a pessoa espera o download inteiro
// travar para descobrir. Pede só o começo do arquivo (Range) e segue os redirecionamentos conferindo cada endereço.
import { assertPublicUrl } from './netguard.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

const DEAD_MS = 5 * 60e3;
const dead = new Map();
export const deadHosts = () => { const now = Date.now(); return [...dead].filter(([, until]) => until > now).map(([h]) => h); };
const isDead = host => (dead.get(host) || 0) > Date.now();
export const clearDeadHosts = () => dead.clear();

// Os primeiros bytes de um livro ou áudio nunca parecem uma página HTML.
export const looksLikeHtml = (bytes, type) => /html|xml|json|text\/plain/i.test(type || '') && /^\s*(<|\{)/.test(Buffer.from(bytes || []).subarray(0, 64).toString('utf8'));

// Devolve { ok, status, type, size, ms, host, error } e nunca lança. `host` é o do servidor que de fato entrega o arquivo
// (depois dos redirecionamentos), que é o que costuma estar fora do ar.
export async function probeFile(url, { timeoutMs = 9000, headers = {} } = {}) {
    const t0 = Date.now(), ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let current = url;
    const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
    const done = extra => ({ ms: Date.now() - t0, host: hostOf(current), ...extra });
    try {
        for (let hop = 0; hop <= 5; hop++) {
            await assertPublicUrl(current);
            if (hop > 0 && isDead(hostOf(current))) return done({ ok: false, status: 0, type: '', error: `O servidor do arquivo (${hostOf(current)}) está fora do ar` });
            const res = await fetch(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: '*/*', Range: 'bytes=0-1023', ...headers } });
            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                current = new URL(res.headers.get('location'), current).href;
                if (res.body) res.body.cancel().catch(() => {});
                continue;
            }
            const type = String(res.headers.get('content-type') || ''), host = hostOf(current);
            if (res.status !== 200 && res.status !== 206) { if (res.body) res.body.cancel().catch(() => {}); return done({ ok: false, status: res.status, type, error: `O servidor do arquivo (${host}) respondeu ${res.status}` }); }
            const reader = res.body.getReader();
            const { value } = await reader.read();
            reader.cancel().catch(() => {});
            if (!value || !value.length) return done({ ok: false, status: res.status, type, error: `O servidor do arquivo (${host}) não enviou nada` });
            if (looksLikeHtml(value, type)) return done({ ok: false, status: res.status, type, error: `O servidor do arquivo (${host}) devolveu uma página em vez do arquivo` });
            const range = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
            return done({ ok: true, status: res.status, type, size: range ? +range[1] : (+res.headers.get('content-length') || 0) });
        }
        return done({ ok: false, status: 0, type: '', error: 'O link redireciona demais' });
    } catch (e) {
        const stalled = ctrl.signal.aborted;
        if (stalled && hostOf(current) !== hostOf(url)) dead.set(hostOf(current), Date.now() + DEAD_MS);
        return done({ ok: false, status: 0, type: '', error: stalled ? `O servidor do arquivo (${hostOf(current)}) não respondeu em ${Math.round(timeoutMs / 1000)} s` : String((e && e.message) || e).slice(0, 140) });
    } finally { clearTimeout(timer); }
}
