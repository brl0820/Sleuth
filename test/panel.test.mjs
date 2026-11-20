// Sleuth 2.3: preferências salvas, fontes personalizadas (OPDS 1 e 2) e conferência de links.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleuth-test-'));
process.env.DATA_DIR = dir;
const state = await import('../src/state.js');
const custom = await import('../src/custom.js');
const probe = await import('../src/probe.js');

// ── Preferências: sem nada salvo vale o endereço do manifest; salvo, vale o salvo. ──
assert.equal(state.effective({ enabled: ['libgen'] }).enabled[0], 'libgen');
state.update(s => { s.enabled = ['archive']; s.mirrors.libgen = ['libgen.example', 'https://libgen.zzz/x', 'ftp://nao.vale', 'semponto']; s.creds.zlib_email = '  a@b.c  '; s.slum = false; });
state.testReset();
const e = state.effective({ enabled: ['libgen'], zlib_password: 'senha-do-endereco' });
assert.deepEqual(e.enabled, ['archive'], 'o painel vence o endereço do manifest');
assert.deepEqual(e.mirrors.libgen, ['https://libgen.example', 'https://libgen.zzz'], 'só domínios https/http válidos, sem caminho');
assert.equal(e.creds.zlib_email, 'a@b.c');
assert.equal(e.creds.zlib_password, 'senha-do-endereco', 'o que não foi salvo vem do endereço');
assert.equal(e.slum, false);
assert.ok(fs.existsSync(path.join(dir, 'sleuth.json')), 'gravou na pasta de dados');
state.update(s => { s.custom.push({ id: 'abc', name: 'Minha', url: 'https://exemplo.org/opds' }, { id: 'x', name: '', url: 'https://sem-nome.org' }, { id: 'y', name: 'Ruim', url: 'file:///etc/passwd' }); });
assert.deepEqual(state.load().custom.map(c => c.id), ['abc'], 'fonte sem nome ou com endereço que não é web é descartada');
fs.writeFileSync(path.join(dir, 'sleuth.json'), '{ quebrado'); state.testReset();
assert.equal(state.load().enabled, null, 'arquivo corrompido não derruba o addon');

// ── OPDS 1 (Atom) ──
const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:dcterms="http://purl.org/dc/terms/">
<entry><title>Dom &amp; Casmurro</title><author><name>Machado de Assis</name></author><dcterms:language>pt</dcterms:language><published>1899-01-01</published>
<link rel="http://opds-spec.org/acquisition/open-access" type="application/epub+zip" href="/files/dom.epub" length="123456"/>
<link rel="http://opds-spec.org/acquisition" type="application/pdf" href="/files/dom.pdf"/>
<link rel="http://opds-spec.org/image" type="image/jpeg" href="/c/dom.jpg"/><link rel="alternate" type="text/html" href="/livro/1"/></entry>
<entry><title>Sem arquivo</title><link rel="alternate" type="text/html" href="/livro/2"/></entry>
<entry><title>Áudio</title><link rel="http://opds-spec.org/acquisition" type="audio/mpeg" href="https://cdn.exemplo.org/a.mp3"/></entry></feed>`;
const ebooks = custom.parseOpds(atom, 'https://exemplo.org/opds/search?q=dom', 'Minha', 'ebooks');
assert.deepEqual(ebooks.map(r => [r.title, r.format]), [['Dom & Casmurro', 'epub'], ['Dom & Casmurro', 'pdf']], 'um resultado por formato, epub antes; sem arquivo não entra; áudio fica de fora dos e-books');
assert.equal(ebooks[0].directUrl, 'https://exemplo.org/files/dom.epub');
assert.equal(ebooks[0].filesize, 123456); assert.equal(ebooks[0].year, '1899'); assert.equal(ebooks[0].author, 'Machado de Assis');
assert.equal(ebooks[0].coverUrl, 'https://exemplo.org/c/dom.jpg'); assert.equal(ebooks[0].source, 'Minha');
assert.deepEqual(custom.parseOpds(atom, 'https://exemplo.org/', 'Minha', 'audiobooks').map(r => r.format), ['mp3']);
assert.equal(custom.parseOpds('<entry><title>X</title><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="javascript:alert(1)"/></entry>', 'https://a.org/', 'S').length, 0, 'link que não é web não vale');

// ── OPDS 2 (JSON): empréstimo e compra não entregam o arquivo ──
const opds2 = { publications: [
    { metadata: { title: 'Livro livre', author: [{ name: 'Fulana' }], language: ['pt'], published: '2001-05-01' }, images: [{ href: '/img/1.jpg' }],
      links: [{ rel: 'http://opds-spec.org/acquisition/open-access', type: 'application/epub+zip', href: '/dl/1.epub' }] },
    { metadata: { title: 'Livro emprestado' }, links: [{ rel: 'http://opds-spec.org/acquisition/borrow', type: 'application/epub+zip', href: '/borrow/2' }] },
] };
const r2 = custom.parseOpds2(opds2, 'https://exemplo.org/opds/', 'Fonte 2', 'ebooks');
assert.equal(r2.length, 1); assert.equal(r2[0].directUrl, 'https://exemplo.org/dl/1.epub'); assert.equal(r2[0].year, '2001'); assert.equal(r2[0].coverUrl, 'https://exemplo.org/img/1.jpg');

// ── Conferência de links ──
assert.equal(probe.looksLikeHtml(Buffer.from('<!DOCTYPE html><html>'), 'text/html; charset=utf-8'), true);
assert.equal(probe.looksLikeHtml(Buffer.from('PK\u0003\u0004'), 'application/octet-stream'), false);
assert.equal(probe.looksLikeHtml(Buffer.from('<html>'), 'application/epub+zip'), false, 'tipo declarado de arquivo vale');
const priv = await probe.probeFile('http://127.0.0.1:1/arquivo.epub', { timeoutMs: 1000 });
assert.equal(priv.ok, false); assert.match(priv.error, /private/i, 'não segue link para a rede local');

fs.rmSync(dir, { recursive: true, force: true });
console.log('Sleuth: preferências salvas, fontes OPDS 1 e 2 e conferência de links: ok');

// ── Fonte personalizada: só catálogo OPDS vale (site comum não pode virar "0 resultados") ──
{
    const c2 = await import('../src/custom.js');
    assert.equal(c2.cleanCatalogUrl('https://libgen.pw/search?query=](https://libgen.pw/search?query=){searchTerms}&collection=libgen&view=list'), 'https://libgen.pw/search?query={searchTerms}&collection=libgen&view=list', 'endereço colado do Markdown é corrigido');
    assert.equal(c2.cleanCatalogUrl('  <https://exemplo.org/opds>  '), 'https://exemplo.org/opds');
    assert.equal(c2.cleanCatalogUrl('https://exemplo.org/opds'), 'https://exemplo.org/opds', 'endereço normal não muda');
    assert.equal(c2.isCatalog('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'), true, 'catálogo sem resultados continua sendo catálogo');
    assert.equal(c2.isCatalog('{"metadata":{"title":"x"},"publications":[]}'), true);
    assert.equal(c2.isCatalog('<!doctype html><html><head><title>WeLib</title></head><body>...</body></html>'), false, 'página de site comum não é catálogo');
    assert.equal(c2.isCatalog('{"erro":"x"}'), false);
    const dnsP = (await import('node:dns/promises')).default, look = dnsP.lookup, realF = globalThis.fetch;
    dnsP.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    globalThis.fetch = async () => new Response('<!doctype html><html><body>resultados da busca</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    try {
        c2.clearTemplates();
        await assert.rejects(() => c2.searchCustom({ id: 'x', name: 'Site', url: 'https://exemplo.org/search/{searchTerms}' }, 'dune', 'ebooks'), /não devolve um catálogo OPDS/);
    } finally { dnsP.lookup = look; globalThis.fetch = realF; }
}
console.log('Sleuth: fonte personalizada recusa site que não é OPDS: ok');
