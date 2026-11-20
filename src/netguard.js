// O servidor busca capas e arquivos indicados por sites externos. Como esses links poderiam apontar
// para a rede do proprietário (roteadores ou outros contêineres), as requisições só aceitam
// endereços públicos, verificados novamente a cada redirecionamento.
import dns from 'node:dns/promises';
import net from 'node:net';

function v4Private(ip) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
}
function v6Groups(ip) {
    let s = ip.toLowerCase().replace(/%.*$/, '');
    const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (dotted) { const [a, b, c, d] = dotted.slice(1).map(Number); s = s.slice(0, -dotted[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16); }
    const [head, rest] = s.split('::');
    const h = head ? head.split(':') : [], r = rest === undefined ? null : rest ? rest.split(':') : [];
    const g = r === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - r.length)).fill('0'), ...r];
    return g.map(x => parseInt(x || '0', 16) || 0);
}
const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
export function isPrivateIp(ip) {
    if (net.isIPv4(ip)) return v4Private(ip);
    const g = v6Groups(ip);
    if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return g[6] === 0 && g[7] <= 1 ? true : v4Private(v4From(g[6], g[7]));
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4Private(v4From(g[6], g[7]));
    if (g[0] === 0x2002) return v4Private(v4From(g[1], g[2]));
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;
    if (g[0] === 0x100 && g.slice(1, 4).every(x => x === 0)) return true;
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

export async function assertPublicUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Not a web link');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
    if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('That link points inside a private network');
}

// fetch() que segue até cinco redirecionamentos, verificando cada endereço antes.
// Ressalva: o DNS é consultado aqui e no fetch; respostas diferentes poderiam alcançar endereços privados.
// Fixar o endereço validado com um Agent do undici (connect.lookup) elimina essa possibilidade.
export async function fetchPublic(url, init = {}) {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
        await assertPublicUrl(current);
        const res = await fetch(current, { ...init, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            current = new URL(res.headers.get('location'), current).href;
            if (res.body) res.body.cancel().catch(() => {});
            continue;
        }
        Object.defineProperty(res, 'url', { value: current });
        return res;
    }
    throw new Error('The site kept redirecting. Try again, or open its page.');
}

export async function readCapped(res, max) {
    if (+res.headers.get('content-length') > max) { if (res.body) res.body.cancel().catch(() => {}); throw new Error('Too big'); }
    const parts = [];
    let n = 0;
    for await (const chunk of res.body || []) {
        n += chunk.length;
        if (n > max) throw new Error('Too big');
        parts.push(chunk);
    }
    return Buffer.concat(parts);
}
