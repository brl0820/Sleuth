// Fontes personalizadas: catálogos OPDS (Calibre-Web, Kavita, Standard Ebooks e outros). O addon descobre a busca sozinho (OpenSearch).
// Só endereços públicos.
import { fetchPublic, readCapped } from './netguard.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const MAX_FEED = 2_000_000;
const FORMATS = {
    'application/epub+zip': 'epub', 'application/pdf': 'pdf', 'application/x-mobipocket-ebook': 'mobi', 'application/vnd.amazon.ebook': 'azw3', 'application/x-mobi8-ebook': 'azw3',
    'application/x-fb2+xml': 'fb2', 'application/fb2+zip': 'fb2', 'application/x-cbz': 'cbz', 'application/vnd.comicbook+zip': 'cbz', 'image/vnd.djvu': 'djvu', 'text/plain': 'txt',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4b', 'audio/x-m4b': 'm4b', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'application/zip': 'zip',
};
const AUDIO = new Set(['mp3', 'm4b', 'm4a', 'aac', 'ogg', 'flac']);
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const t = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e.toLowerCase()];
    if (t) return t;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
}).replace(/\s+/g, ' ').trim();
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), decode(m[3] ?? m[4] ?? '')]));
const links = xml => [...xml.matchAll(/<link\b[^>]*?\/?>/gi)].map(m => attrs(m[0]));
const tagText = (xml, name) => { const m = new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(xml); return m ? decode(m[1]) : ''; };
const abs = (href, base) => { try { const u = new URL(href, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };

async function fetchText(url, accept, timeout = 12000) {
    const res = await fetchPublic(url, { headers: { 'User-Agent': UA, Accept: accept || 'application/atom+xml, application/xml, text/xml, */*;q=0.5' }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) { if (res.body) res.body.cancel().catch(() => {}); throw new Error(`O catálogo respondeu ${res.status}`); }
    return { text: (await readCapped(res, MAX_FEED)).toString('utf8'), url: res.url };
}

const isJson = text => text.trimStart().startsWith('{');
function jsonTemplate(feed, base) {
    for (const l of (feed.links || [])) {
        if (l && l.rel === 'search' && l.href) {
            const href = String(l.href), m = /\{\?([^}]*)\}/.exec(href);
            const names = m ? m[1].split(',') : [];
            const param = names.includes('query') ? 'query' : names.includes('q') ? 'q' : names[0];
            return abs(m ? href.replace(m[0], param ? '?' + param + '=__Q__' : '') : href.replace(/\{searchTerms\}/gi, '__Q__'), base).replace(/__Q__/g, '{q}');
        }
    }
    return '';
}
const FORMAT_ORDER = ['epub', 'm4b', 'mp3', 'pdf', 'azw3', 'mobi', 'fb2', 'djvu', 'txt'];
export function parseOpds2(feed, base, sourceName, mode = 'ebooks') {
    const out = [];
    for (const p of (feed.publications || [])) {
        const md = p.metadata || {}, title = decode(md.title);
        if (!title) continue;
        const acq = (p.links || []).filter(l => l && l.href && /opds-spec\.org\/acquisition/i.test(l.rel || '') && !/\/(borrow|buy|subscribe|sample)/i.test(l.rel || '') && !/^application\/opds-authentication/.test(l.type || ''))
            .map(l => ({ url: abs(l.href, base), format: FORMATS[String(l.type || '').split(';')[0].trim().toLowerCase()] || '', size: Number(l.length) || 0 })).filter(a => a.url && a.format && a.format !== 'zip');
        const authors = (Array.isArray(md.author) ? md.author : md.author ? [md.author] : []).map(a => decode(typeof a === 'string' ? a : a && a.name)).filter(Boolean);
        const image = (p.images || [])[0], lang = Array.isArray(md.language) ? md.language[0] : md.language;
        for (const a of acq.sort((x, y) => FORMAT_ORDER.indexOf(x.format) - FORMAT_ORDER.indexOf(y.format))) {
            if ((mode === 'audiobooks') !== AUDIO.has(a.format)) continue;
            out.push({
                title, author: authors.join('; '), year: String(md.published || '').slice(0, 4).replace(/\D/g, ''), language: String(lang || ''), publisher: decode((md.publisher && md.publisher.name) || md.publisher),
                format: a.format, filesize: a.size, source: sourceName, directUrl: a.url, downloadUrl: a.url, coverUrl: image && image.href ? abs(image.href, base) : '',
            });
        }
    }
    return out;
}

const templates = new Map();
export async function searchTemplate(def, { timeout = 12000 } = {}) {
    if (/\{searchTerms\}/i.test(def.url)) return def.url.replace(/\{searchTerms\}/gi, '{q}');
    const hit = templates.get(def.url);
    if (hit && hit.exp > Date.now()) return hit.value;
    const root = await fetchText(def.url, 'application/opds+json, application/atom+xml, application/xml, */*;q=0.5', timeout);
    let template = '';
    if (isJson(root.text)) { try { template = jsonTemplate(JSON.parse(root.text), root.url); } catch { /* não é OPDS 2 */ } }
    if (!template) for (const l of links(isJson(root.text) ? '' : root.text)) {
        if ((l.rel || '').toLowerCase() !== 'search') continue;
        const type = (l.type || '').toLowerCase(), href = abs(l.href.replace(/\{searchTerms\}/gi, '__Q__'), root.url).replace(/__Q__/g, '{q}');
        if (/opensearchdescription/.test(type)) {
            const d = await fetchText(href, 'application/opensearchdescription+xml, application/xml, */*;q=0.5', timeout);
            const urls = [...d.text.matchAll(/<Url\b[^>]*?\/?>/gi)].map(m => attrs(m[0])).filter(u => u.template);
            const best = urls.find(u => /atom|opds/i.test(u.type || '')) || urls[0];
            if (best) template = abs(best.template.replace(/\{searchTerms\??\}/gi, '__Q__').replace(/\{[^}]+\?\}/g, '').replace(/\{startPage\??\}/gi, '1'), d.url).replace(/__Q__/g, '{q}');
        } else if (/atom|opds|xml/.test(type) || !type) template = href;
        if (template) break;
    }
    if (!template) throw new Error('Não achei a busca desse catálogo. Informe o endereço com {searchTerms}, por exemplo https://exemplo.org/opds/search/{searchTerms}');
    templates.set(def.url, { value: template, exp: Date.now() + 6 * 3600e3 });
    return template;
}

export function parseOpds(xml, base, sourceName, mode = 'ebooks') {
    const out = [];
    for (const m of String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
        const e = m[1], title = tagText(e, 'title');
        if (!title) continue;
        const ls = links(e);
        const acq = ls.filter(l => /opds-spec\.org\/acquisition/i.test(l.rel || '') && l.href).map(l => ({ url: abs(l.href, base), type: (l.type || '').split(';')[0].trim().toLowerCase(), size: Number(l.length) || 0 })).filter(l => l.url);
        const pick = acq.map(a => ({ ...a, format: FORMATS[a.type] || (/\.(epub|pdf|mobi|azw3|fb2|cbz|djvu|mp3|m4b|m4a|flac|ogg)(?:$|\?)/i.exec(a.url) || [])[1]?.toLowerCase() || '' })).filter(a => a.format && a.format !== 'zip');
        const order = ['epub', 'm4b', 'mp3', 'pdf', 'azw3', 'mobi', 'fb2', 'djvu', 'txt'];
        const wantAudio = mode === 'audiobooks';
        for (const a of pick.sort((x, y) => order.indexOf(x.format) - order.indexOf(y.format))) {
            if (wantAudio !== AUDIO.has(a.format)) continue;
            const cover = ls.find(l => /opds-spec\.org\/image(?!\/thumbnail)|opds-spec\.org\/cover/i.test(l.rel || '') && l.href) || ls.find(l => /opds-spec\.org\/image\/thumbnail/i.test(l.rel || '') && l.href);
            const page = ls.find(l => (l.rel || '') === 'alternate' && /html/.test(l.type || '') && l.href);
            const authors = [...e.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].map(x => tagText(x[1], 'name')).filter(Boolean);
            const year = (tagText(e, 'dcterms:issued') || tagText(e, 'published') || tagText(e, 'updated')).match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
            out.push({
                title, author: authors.join('; '), year: year ? year[1] : '', language: tagText(e, 'dcterms:language') || tagText(e, 'dc:language'), publisher: tagText(e, 'dcterms:publisher') || tagText(e, 'dc:publisher'),
                format: a.format, filesize: a.size, source: sourceName, directUrl: a.url, downloadUrl: page ? abs(page.href, base) : a.url, coverUrl: cover ? abs(cover.href, base) : '',
            });
        }
    }
    return out;
}

export const swapOrigin = (url, origin) => String(url).replace(/^https?:\/\/[^/?#]+/i, origin);
export const originOf = url => { const m = /^https?:\/\/[^/?#]+/i.exec(String(url)); return m ? m[0].toLowerCase() : ''; };

export const cleanCatalogUrl = url => String(url || '').trim().replace(/(https?:\/\/[^\s\]]*)\]\((https?:\/\/[^)\s]*)\)/g, '$2').replace(/^[<\[(]+|[>\])]+$/g, '');

// Só catálogos OPDS valem: o Atom (OPDS 1) é um <feed>, o JSON (OPDS 2) traz publications, navigation, groups ou links. Um catálogo sem
// nenhum livro para a busca ainda é um catálogo; uma página HTML de site comum não é.
export function isCatalog(text) {
    const t = String(text || '');
    if (isJson(t)) { try { const j = JSON.parse(t); return !!(j && typeof j === 'object' && (j.publications || j.navigation || j.groups || j.links || j.metadata)); } catch { return false; } }
    return /<feed\b/i.test(t.slice(0, 5000));
}
const NOT_OPDS = 'Este endereço não devolve um catálogo OPDS (veio uma página comum de site). Fontes personalizadas só funcionam com catálogos OPDS, como os de Calibre-Web, Kavita e Standard Ebooks; sites comuns não funcionam.';

export async function searchCustom(def, query, mode, timeout = 12000) {
    def = { ...def, url: cleanCatalogUrl(def.url) };
    const template = await searchTemplate(def, { timeout });
    const feed = await fetchText(template.replace(/\{q\}/g, encodeURIComponent(query)), 'application/opds+json, application/atom+xml, application/xml, */*;q=0.5', timeout);
    if (!isCatalog(feed.text)) throw new Error(NOT_OPDS);
    if (isJson(feed.text)) {
        let j; try { j = JSON.parse(feed.text); } catch { throw new Error('O catálogo não respondeu um feed OPDS'); }
        return parseOpds2(j, feed.url, def.name, mode).slice(0, 40);
    }
    return parseOpds(feed.text, feed.url, def.name, mode).slice(0, 40);
}

export const clearTemplates = () => templates.clear();
