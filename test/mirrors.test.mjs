// Sleuth 2.4: espelhos de qualquer fonte (guardados, tentados antes do site original, reescritos nos links), teste de espelho e "Sobre".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleuth-mirrors-'));
process.env.DATA_DIR = dir;
const state = await import('../src/state.js');
const src = await import('../src/sources.js');
const about = await import('../src/about.js');

// ── Estado: espelhos de qualquer fonte conhecida, só endereços públicos ──
state.update(s => {
    s.mirrors.royallib = ['royallib.example', 'https://royallib.example/livro', 'localhost.local', 'http://127.0.0.1:8080', 'http://192.168.0.5', 'http://[::1]', 'https://intranet.internal'];
    s.mirrors.archive = ['arquivo.example'];
    s.mirrors['c:abc'] = ['nao.vale']; s.mirrors['Ruim!'] = ['nao.vale'];
});
state.testReset();
const m = state.load().mirrors;
assert.deepEqual(m.royallib, ['https://royallib.example'], 'sem caminho, duplicado, localhost, rede local, IP privado nem .internal');
assert.deepEqual(m.archive, ['https://arquivo.example']);
assert.deepEqual(Object.keys(m).sort(), ['archive', 'royallib'], 'chaves que não são de fonte são descartadas');
state.update(s => { s.mirrors.gutenberg = Array.from({ length: 12 }, (_, i) => `g${i}.example`); });
assert.equal(state.load().mirrors.gutenberg.length, 8, 'no máximo 8 por fonte');

// ── Reescrita de links (função pura) ──
const r = { title: 'x', directUrl: 'https://royallib.com/get/a.epub', downloadUrl: 'https://royallib.com/book/1.html', coverUrl: 'https://outro.org/c.jpg', pageUrl: 'https://royallib.com.evil.org/x' };
src.rewriteOrigins(r, 'https://royallib.com', 'https://royallib.example');
assert.equal(r.directUrl, 'https://royallib.example/get/a.epub');
assert.equal(r.downloadUrl, 'https://royallib.example/book/1.html');
assert.equal(r.coverUrl, 'https://outro.org/c.jpg', 'outro host não muda');
assert.equal(r.pageUrl, 'https://royallib.com.evil.org/x', 'só troca a origem inteira, não um prefixo de outro domínio');

// ── get(): tenta o espelho primeiro, cai no site original quando ele falha, e reaproveita a origem que respondeu ──
const calls = [];
const realFetch = globalThis.fetch;
let mirrorUp = true;
globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).startsWith('https://royallib.example/')) { if (!mirrorUp) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); return new Response('do espelho', { status: 200 }); }
    if (String(url).startsWith('https://royallib.com/')) return new Response('do original', { status: 200 });
    return new Response('?', { status: 404 });
};
src.setUserMirrors({ royallib: ['https://royallib.example'] });
let res = await src.get('https://royallib.com/search/?q=1', 2000);
assert.equal(await res.text(), 'do espelho');
assert.deepEqual(calls, ['https://royallib.example/search/?q=1'], 'foi direto ao espelho, com o mesmo caminho e consulta');
assert.equal(src.activeOrigin.royallib, 'https://royallib.example');
mirrorUp = false; calls.length = 0;
res = await src.get('https://royallib.com/search/?q=1', 2000);
assert.equal(await res.text(), 'do original', 'espelho fora: volta ao site original');
assert.deepEqual(calls, ['https://royallib.example/search/?q=1', 'https://royallib.com/search/?q=1']);
assert.equal(src.activeOrigin.royallib, undefined, 'o original respondeu: os links ficam com o endereço padrão');
calls.length = 0;
src.setUserMirrors({});
res = await src.get('https://royallib.com/x', 2000);
assert.deepEqual(calls, ['https://royallib.com/x'], 'sem espelhos cadastrados, nada muda');
calls.length = 0;
src.setUserMirrors({ archive: ['https://arquivo.example'] });
await src.get('https://www.gutenberg.org/x', 2000);
assert.deepEqual(calls, ['https://www.gutenberg.org/x'], 'espelho de outra fonte não desvia esta');

// ── Teste de espelho: confere o conteúdo, não só o 200 ──
const probe = async (service, body, status = 200) => {
    globalThis.fetch = async () => new Response(body, { status });
    return src.testMirror(service, 'https://espelho-de-teste.example');
};
const dns = (await import('node:dns/promises')).default;
const realLookup = dns.lookup; dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
try {
    assert.equal((await probe('gutenberg', '<feed><entry>x</entry></feed>')).status, 'ok');
    assert.equal((await probe('gutenberg', '<html>domínio à venda</html>')).status, 'error', 'página estacionada responde 200 mas não é o site');
    assert.equal((await probe('annas', '<title>DDoS-Guard</title>')).status, 'verify', 'desafio de robô aparece como "pede confirmação"');
    assert.equal((await probe('libgen', '<table id="tablelibgen">')).status, 'ok');
    const bad = await probe('archive', 'erro', 503);
    assert.equal(bad.status, 'error'); assert.match(bad.error, /503/);
    globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
    assert.match((await src.testMirror('royallib', 'https://nao-existe.example')).error, /não existe/);
    assert.equal((await src.testMirror('fonte-que-nao-existe', 'https://a.example')).status, 'error');
} finally { dns.lookup = realLookup; globalThis.fetch = realFetch; }
const priv = await src.testMirror('royallib', 'http://127.0.0.1:9');
assert.equal(priv.status, 'error'); assert.match(priv.error, /rede privada/, 'espelho nunca aponta para dentro da rede local');

// ── Tabela única de origens e estado por fonte ──
for (const svc of src.mirrorServices()) assert.ok(src.SOURCE_ORIGINS[svc]?.length, `origem padrão de ${svc}`);
src.setUserMirrors({ royallib: ['https://royallib.example'] });
assert.deepEqual(src.mirrorStatus('royallib').map(x => [x.origin, x.user]), [['https://royallib.example', true], ['https://royallib.com', false]], 'os seus vêm primeiro');

// ── Sobre: caminhos reais, tamanho medido, registro de acessos ──
let netMode = 'ok';
globalThis.fetch = async () => { if (netMode === 'ok') return new Response('x'); throw Object.assign(new TypeError('x'), { cause: { code: 'ECONNRESET' } }); };
about.logAccesses();
await fetch('https://royallib.com/a'); await fetch('https://royallib.com/b');
netMode = 'falha';
await fetch('https://cdn.exemplo.org/f.epub').catch(() => {});
globalThis.fetch = realFetch;
const log = about.accessLog();
assert.equal(log.find(a => a.host === 'royallib.com').count, 2);
assert.equal(log.find(a => a.host === 'cdn.exemplo.org').fails, 1);
fs.writeFileSync(path.join(dir, 'dado.bin'), Buffer.alloc(2048));
const st = await about.dirStats(dir);
assert.ok(st.exists && st.files >= 1 && st.bytes >= 2048);
const info = await about.aboutInfo({
    version: '3.0.0', id: 'sleuth.search', name: 'Sleuth', author: 'x', description: 'd', permissions: ['service'], resources: ['sources'], types: ['book'],
    dataDir: dir, installDir: path.resolve('.'), host: '127.0.0.1', port: 7002,
    sourceLabels: { royallib: 'RoyalLib' }, sourceOrigins: { royallib: ['https://royallib.com'] }, mirrors: { royallib: ['https://royallib.example'] }, custom: [{ id: 'a1', name: 'Minha', url: 'https://opds.example/c' }], enabled: new Set(['royallib']),
});
assert.equal(info.paths.find(p => p.label.startsWith('Pasta de dados')).path, dir);
assert.equal(info.accessed.find(a => a.host === 'royallib.com').why, 'RoyalLib');
assert.equal(info.accessed.find(a => a.host === 'cdn.exemplo.org').why.startsWith('Servidor de arquivo'), true, 'host desconhecido é explicado');
assert.ok(info.sites.some(s => s.label === 'RoyalLib' && s.on && s.mine[0] === 'royallib.example'));
assert.ok(info.sites.some(s => s.label === 'Minha (fonte sua)'));
assert.equal(info.runtime.onlyThisComputer, true);
const pf = info.paths.find(p => p.label.startsWith('Preferências'));
assert.ok(pf.exists && pf.bytes > 0 && pf.files === 1, 'sleuth.json é medido como arquivo');
JSON.stringify(info);

// ── Fonte personalizada (OPDS) também tem espelhos ──
state.update(s => { s.custom.push({ id: 'abc', name: 'Minha', url: 'https://exemplo.org/opds/search/{searchTerms}' }); s.mirrors['c:abc'] = ['espelho.example', 'http://10.0.0.1']; s.mirrors['c:zzz'] = ['x.example']; });
assert.deepEqual(state.load().mirrors['c:abc'], ['https://espelho.example'], 'espelho de fonte personalizada guardado, só público');
assert.equal(state.load().mirrors['c:zzz'], undefined, 'espelho de fonte que não existe é descartado');
const custom = await import('../src/custom.js');
assert.equal(custom.swapOrigin('https://exemplo.org/opds/search/{searchTerms}', 'https://espelho.example'), 'https://espelho.example/opds/search/{searchTerms}', 'mesmo caminho, outro domínio (o modelo {searchTerms} continua)');
assert.equal(custom.swapOrigin('https://exemplo.org:8080/a?q=1', 'https://e.example'), 'https://e.example/a?q=1');
src.setCustomSources(state.load().custom);
src.setUserMirrors({ 'c:abc': ['https://espelho.example'] });
assert.deepEqual(src.mirrorStatus('c:abc').map(x => [x.origin, x.user]), [['https://espelho.example', true], ['https://exemplo.org', false]], 'o endereço da própria fonte aparece como o original');
const feed = host => `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Dune</title><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="/files/dune.epub"/></entry></feed>`;
const dns2 = (await import('node:dns/promises')).default, lookup2 = dns2.lookup; dns2.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const calls2 = []; let up = true;
globalThis.fetch = async (url, init) => {
    calls2.push(String(url));
    if (String(url).startsWith('https://espelho.example/')) { if (!up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); return new Response(feed(), { status: 200 }); }
    if (String(url).startsWith('https://exemplo.org/')) return new Response(feed(), { status: 200 });
    return new Response('?', { status: 404 });
};
try {
    custom.clearTemplates();
    const cdef = state.load().custom[0];
    let rs = await src.searchCustomMirrored(cdef, 'dune', 'ebooks');
    assert.equal(rs[0].directUrl, 'https://espelho.example/files/dune.epub', 'os links vêm do domínio que respondeu');
    assert.ok(calls2.every(u => u.startsWith('https://espelho.example/')), 'foi direto ao espelho');
    up = false; calls2.length = 0; custom.clearTemplates();
    rs = await src.searchCustomMirrored(cdef, 'dune', 'ebooks');
    assert.equal(rs[0].directUrl, 'https://exemplo.org/files/dune.epub', 'espelho fora: volta ao endereço da fonte');
    assert.ok(calls2[0].startsWith('https://espelho.example/') && calls2.at(-1).startsWith('https://exemplo.org/'));
    up = true;
    assert.equal((await src.testMirror('c:abc', 'https://espelho.example')).status, 'ok');
    globalThis.fetch = async () => new Response('<html>domínio à venda</html>', { status: 200 });
    assert.equal((await src.testMirror('c:abc', 'https://espelho.example')).status, 'error', 'página qualquer não é um catálogo');
} finally { dns2.lookup = lookup2; globalThis.fetch = realFetch; }
state.update(s => { s.custom = []; });
assert.equal(state.load().mirrors['c:abc'], undefined, 'remover a fonte leva os espelhos dela junto');

// ── Alternativas de download do LibGen: à parte dos espelhos de busca, com a lista da pessoa ──
{
    assert.equal(state.cleanDownload('libgen.download'), 'https://libgen.download/api/download?id={md5}', 'só o servidor vira o modelo padrão');
    assert.equal(state.cleanDownload('https://meu.example/baixar/{md5}.bin'), 'https://meu.example/baixar/{md5}.bin', 'modelo completo com {md5} vale');
    assert.equal(state.cleanDownload('http://meu.example/baixar/{md5}'), '', 'só https');
    assert.equal(state.cleanDownload('https://{md5}.evil.example/x'), '', '{md5} não pode estar no domínio');
    assert.equal(state.cleanDownload('https://127.0.0.1/api/download?id={md5}'), '', 'nada de rede local');
    assert.equal(state.cleanDownload('https://user:pw@meu.example/{md5}'), '', 'sem credenciais no endereço');
    state.update(s => { s.downloads.libgen = ['libgen.download', 'https://meu.example/baixar/{md5}.bin', 'http://ruim.example/{md5}', 'https://meu.example/baixar/{md5}.bin']; });
    assert.deepEqual(state.load().downloads.libgen, ['https://libgen.download/api/download?id={md5}', 'https://meu.example/baixar/{md5}.bin'], 'sem repetidos nem inválidos');
    assert.deepEqual(state.effective({}).downloads.libgen.length, 2);
    state.update(s => { s.downloads.libgen = []; });

    const MD5 = '4a702054b356e7ed5364318bc954c99c';
    const dns3 = (await import('node:dns/promises')).default, look3 = dns3.lookup; dns3.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const seen = [];
    const FILE = () => new Response(Buffer.from('PK\u0003\u0004conteudo-do-arquivo'), { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-20/999' } });
    let up = new Set(['https://libgen.download/']);
    globalThis.fetch = async url => {
        const u = String(url); seen.push(u);
        if (u.startsWith('https://libgen.me/api/download/links-by-id')) return new Response(JSON.stringify({ result: { list: ['https://novo-servidor.example', 'https://annas-archive.gl'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (u.includes('/api/download?id=') || u.includes('/baixar/')) return [...up].some(p => u.startsWith(p)) ? FILE() : new Response('indisponível', { status: 503 });
        return new Response('?', { status: 404 });
    };
    try {
        src.setUserDownloads({});
        let alt = await src.libgenFallbackLink(MD5);
        assert.equal(alt.url, `https://libgen.download/api/download?id=${MD5}`);
        assert.ok(alt.size === 999, 'tamanho vem da conferência');
        up = new Set(['https://meu.example/']);
        src.setUserDownloads({ libgen: ['https://meu.example/baixar/{md5}.bin'] });
        alt = await src.libgenFallbackLink(MD5);
        assert.equal(alt.url, `https://meu.example/baixar/${MD5}.bin`, 'a alternativa cadastrada pela pessoa é usada');
        up = new Set(['https://novo-servidor.example/']);
        src.setUserDownloads({});
        alt = await src.libgenFallbackLink(MD5);
        assert.equal(alt.url, `https://novo-servidor.example/api/download?id=${MD5}`, 'servidor descoberto pela API é conferido e usado');
        assert.ok(!seen.some(u => u.startsWith('https://annas-archive.gl/api/download')), 'não tenta o Anna’s como se fosse download');
        // 4) nada no ar: devolve null (nunca um link que não entrega)
        up = new Set(); src.setUserDownloads({});
        assert.equal(await src.libgenFallbackLink(MD5), null);
        up = new Set(['https://relink.example/']); src.setUserDownloads({ libgen: ['https://relink.example/api/download?id={md5}'] });
        assert.equal(await src.freshLibgenLink(MD5, ['https://libgen.bz']), `https://relink.example/api/download?id=${MD5}`);
        up = new Set(['https://libgen.download/']);
        const ok = await src.testDownload('libgen', 'https://libgen.download/api/download?id={md5}');
        assert.equal(ok.status, 'ok');
        const bad = await src.testDownload('libgen', 'https://libgen.stream/api/download?id={md5}');
        assert.equal(bad.status, 'error'); assert.match(bad.error, /503/);
        src.setUserDownloads({ libgen: ['https://meu.example/baixar/{md5}.bin'] });
        assert.deepEqual(src.downloadStatus('libgen').slice(0, 2).map(d => [d.host, d.user]), [['meu.example', true], ['libgen.download', false]]);
        globalThis.fetch = async () => new Response('<!DOCTYPE html><html><body><div id="__nuxt"></div></body></html>', { status: 200 });
        const spa = await src.testMirror('libgen', 'https://libgen.me');
        assert.equal(spa.status, 'error'); assert.match(spa.error, /Alternativas de download/);
    } finally { dns3.lookup = look3; globalThis.fetch = realFetch; src.setUserDownloads({}); }
}

// ── Alternativas de download das outras fontes (sem md5: o servidor serve o mesmo caminho, ou um modelo com campos) ──
{
    assert.equal(state.cleanDownload('outro-site.org', 'royallib'), 'https://outro-site.org{path}', 'fonte comum: só o servidor vira o mesmo caminho');
    assert.equal(state.cleanDownload('outro-site.org', 'annas'), 'https://outro-site.org/api/download?id={md5}', "Anna's usa o md5 como o LibGen");
    assert.equal(state.cleanDownload('https://web.archive.org/web/0if_/{url}', 'gutenberg'), 'https://web.archive.org/web/0if_/{url}');
    assert.equal(state.cleanDownload('https://alt.example/{identifier}/{file}', 'archive'), 'https://alt.example/{identifier}/{file}');
    assert.equal(state.cleanDownload('https://alt.example:8443{path}', 'royallib'), 'https://alt.example:8443{path}', 'porta e {path} logo depois do domínio');
    assert.equal(state.cleanDownload('https://{file}.evil.example/x', 'royallib'), '', 'campo no domínio é recusado');
    assert.equal(state.cleanDownload('http://alt.example{path}', 'royallib'), '', 'só https');
    assert.equal(state.cleanDownload('https://10.0.0.5{path}', 'royallib'), '', 'nada de rede local');
    state.update(s => {
        s.custom.push({ id: 'dl1', name: 'Catalogo', url: 'https://exemplo.org/opds/search/{searchTerms}' });
        s.downloads['c:dl1'] = ['alt.example']; s.downloads['c:zzz'] = ['x.example']; s.downloads.royallib = ['alt2.example'];
    });
    assert.deepEqual(state.load().downloads['c:dl1'], ['https://alt.example{path}'], 'fonte personalizada também tem alternativas');
    assert.equal(state.load().downloads['c:zzz'], undefined, 'de fonte que não existe é descartado');
    assert.deepEqual(state.load().downloads.royallib, ['https://alt2.example{path}']);

    const rr = { md5: '4A702054B356E7ED5364318BC954C99C', directUrl: 'https://royallib.com/get/a%20b.epub?x=1', identifier: 'ident' };
    assert.equal(src.fillDownload('https://alt.example{path}', rr), 'https://alt.example/get/a%20b.epub?x=1');
    assert.equal(src.fillDownload('https://alt.example/dl/{file}', rr), 'https://alt.example/dl/a%20b.epub');
    assert.equal(src.fillDownload('https://px.example/?u={urlenc}', rr), 'https://px.example/?u=' + encodeURIComponent('https://royallib.com/get/a%20b.epub?x=1'));
    assert.equal(src.fillDownload('https://alt.example/{identifier}', rr), 'https://alt.example/ident');
    assert.equal(src.fillDownload('https://alt.example/{md5}', rr), 'https://alt.example/4a702054b356e7ed5364318bc954c99c', 'md5 sempre em minúsculas');
    assert.equal(src.fillDownload('https://alt.example/{identifier}', { directUrl: 'https://royallib.com/x' }), '', 'campo que o resultado não tem: não usa o modelo');

    const dns4 = (await import('node:dns/promises')).default, look4 = dns4.lookup; dns4.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const FILE2 = () => new Response(Buffer.from('PK\u0003\u0004conteudo'), { status: 206, headers: { 'content-type': 'application/epub+zip', 'content-range': 'bytes 0-9/500' } });
    let live = new Set();
    globalThis.fetch = async url => {
        const u = String(url);
        if (u.startsWith('https://exemplo.org/opds/')) return new Response(feed(), { status: 200 });
        return [...live].some(p => u.startsWith(p)) ? FILE2() : new Response('fora do ar', { status: 503 });
    };
    try {
        src.setCustomSources(state.load().custom);
        live = new Set(['https://alt2.example/']);
        src.setUserDownloads(state.load().downloads);
        const falho = { source: 'RoyalLib', directUrl: 'https://royallib.com/get/a.epub' };
        const alt = await src.downloadFallback(falho);
        assert.equal(alt.url, 'https://alt2.example/get/a.epub');
        assert.equal(alt.from, 'Servidor alternativo');
        // Nenhum candidato no ar: nunca devolve um link que não entrega
        live = new Set();
        assert.equal(await src.downloadFallback({ source: 'RoyalLib', directUrl: 'https://royallib.com/get/outro.epub' }), null);
        assert.equal(await src.downloadFallback({ source: 'Z-Library', directUrl: 'https://z.example/x' }), null, 'Z-Library exige sessão: não entra');
        assert.equal(await src.downloadFallback({ source: 'RoyalLib' }), null, 'sem link nem md5 não há o que preencher');
        live = new Set(['https://alt.example/']);
        const altC = await src.downloadFallback({ source: 'Catalogo', directUrl: 'https://exemplo.org/files/livro.epub' });
        assert.equal(altC.url, 'https://alt.example/files/livro.epub');
        custom.clearTemplates();
        live = new Set(['https://exemplo.org/files/', 'https://alt.example/']);
        const t1 = await src.testDownload('c:dl1', 'https://alt.example{path}');
        assert.equal(t1.status, 'ok', 'livro de exemplo da fonte + mesmo caminho no servidor da alternativa');
        live = new Set(['https://exemplo.org/files/']);
        const t2 = await src.testDownload('c:dl1', 'https://alt-fora.example{path}');
        assert.equal(t2.status, 'error'); assert.match(t2.error, /503/);
        const t3 = await src.testDownload('c:dl1', 'https://alt.example/{identifier}');
        assert.equal(t3.status, 'error'); assert.match(t3.error, /campo/);
        assert.deepEqual(src.downloadServices().filter(s => s.startsWith('c:')), ['c:dl1'], 'fontes personalizadas entram na lista');
        assert.ok(!src.downloadServices().includes('zlibrary') && !src.downloadServices().includes('mobilism'), 'Z-Library e Mobilism ficam de fora');
    } finally { dns4.lookup = look4; globalThis.fetch = realFetch; src.setUserDownloads({}); src.setCustomSources([]); }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('Sleuth: espelhos por fonte, teste de espelho e informações do addon: ok');
