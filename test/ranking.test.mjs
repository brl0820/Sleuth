// Sleuth: leitura do Anna's Archive (formato depois de uma descrição longa) e ordem dos resultados (consenso entre fontes, idioma, limite por fonte).
import assert from 'node:assert/strict';

const S = await import('../src/sources.js');

// ── Anna's: a linha "idioma · FORMATO · tamanho · ano" vem depois da descrição, que pode passar de mil caracteres ──
const longDescription = 'Texto da descrição. '.repeat(120);
const card = (md5, title, author, meta) => `<div class="flex pt-3"><a href="/md5/${md5}" class="custom-a block"><img src="https://covers.openlibrary.org/b/id/1-L.jpg"></a>
<div><a href="/md5/${md5}" class="line-clamp-[3] js-vim-focus custom-a text-lg">${title}</a>
<a href="/search?q=${author}" class="block custom-a"><span class="icon-[mdi--user-edit]"></span> ${author}</a>
<div class="line-clamp-[2] text-sm">${longDescription}</div><script>window.addReadMoreButton(document.currentScript.parentElement);</script></div>
<div class="text-gray-800 dark:text-slate-400 font-semibold text-sm">✅ ${meta}</div></div>`;
const html = card('a'.repeat(32), 'Harry Potter and the Goblet of Fire', 'J. K. Rowling', 'English [en] · EPUB · 0.7MB · 2015 · 📕 Book (fiction)')
    + card('b'.repeat(32), 'Dom Casmurro', 'Machado de Assis', 'Portuguese [pt] · PDF · 1.5MB · 1899 · 📕 Book (fiction)');
const parsed = S.parseAnnasHtml(html, 'https://annas-archive.gl');
assert.equal(parsed.length, 2);
assert.deepEqual([parsed[0].format, parsed[0].language, parsed[0].year, parsed[0].filesize], ['epub', 'English', '2015', 700000], 'o formato não pode ficar em branco');
assert.deepEqual([parsed[1].format, parsed[1].language, parsed[1].year], ['pdf', 'Portuguese', '1899'], 'cada livro lê só o próprio bloco (não pega o do vizinho)');
assert.equal(parsed[0].author, 'J. K. Rowling');

// ── Chave da obra: ignora prefixo de série, subtítulo e numeração ──
assert.equal(S.workKey({ title: 'Harry Potter 3 · Harry Potter et le prisonnier d\'Azkaban 3' }), S.workKey({ title: "Harry Potter et le prisonnier d'Azkaban" }));
assert.equal(S.workKey({ title: 'Dune: Edição de Colecionador (Dune #1)' }), 'dune');

// ── Consenso: o livro que várias fontes trazem sobe; o título isolado de outro autor não ──
const r = (title, author, source) => ({ title, author, source });
const list = [
    r('Harry Potter and the Goblet of Fire', 'J. K. Rowling', "Anna's Archive"), r('Harry Potter and the Goblet of Fire', 'Rowling, J.K.', 'Z-Library'), r('Harry Potter and the Goblet of Fire', 'J.K. Rowling', 'Library Genesis'),
    r('Harry Potter and the Chamber of Secrets', 'J. K. Rowling', "Anna's Archive"), r('Harry Potter and the Chamber of Secrets', 'Rowling', 'Z-Library'),
    r('Harry Potter and the Order of the Phoenix', 'J. K. Rowling', "Anna's Archive"), r('Harry Potter and the Order of the Phoenix', 'J.K. Rowling', 'Library Genesis'),
    r('Harry Potter and the Deathly Hallows', 'J. K. Rowling', 'Library Genesis'), r('Harry Potter and the Deathly Hallows', 'J. K. Rowling', 'Z-Library'),
    r('Harry Potter Cookbook', 'Fulano', 'Library Genesis'), r('Harry Potter fanfic', 'Beltrano', 'Internet Archive'),
];
const bonus = S.consensusBonus(list);
const bonusOf = t => bonus.get(list.find(x => x.title === t));
assert.ok(bonusOf('Harry Potter and the Goblet of Fire') > bonusOf('Harry Potter and the Chamber of Secrets'), 'três fontes valem mais que duas');
assert.ok(bonusOf('Harry Potter and the Chamber of Secrets') >= 18 + 4 + 20, 'duas fontes + autor dominante');
assert.equal(bonusOf('Harry Potter Cookbook'), 0); assert.equal(bonusOf('Harry Potter fanfic'), 0);
assert.equal(S.consensusBonus([r('Um', 'A', 'x'), r('Dois', 'B', 'y')]).get(list[0]), undefined, 'sem consenso, sem bônus');

// ── Idioma preferido ──
assert.deepEqual(['Portuguese', 'Brazilian Portuguese', 'pt-BR', 'por', 'Português', 'English', '', null].map(l => S.inLanguage(l, 'pt')), [true, true, true, true, true, false, false, false]);
assert.equal(S.inLanguage('English', ''), false);
assert.equal(S.inLanguage('eng', 'en'), true);

// ── Nenhuma fonte ocupa tudo no começo da lista ──
const sorted = [...Array(20).fill(0).map((_, i) => ({ id: 'z' + i, source: 'Z' })), ...Array(10).fill(0).map((_, i) => ({ id: 'l' + i, source: 'L' }))];
const capped = S.capPerSource(sorted, 15, 6);
assert.deepEqual(['Z', 'L'].map(s => capped.slice(0, 12).filter(x => x.source === s).length), [6, 6], 'cada fonte tem no máximo 6 nas primeiras posições; o resto vem depois');
assert.equal(capped.length, 30); assert.equal(new Set(capped.map(x => x.id)).size, 30, 'ninguém some nem se repete');
assert.deepEqual(S.capPerSource([{ source: 'a' }, { source: 'b' }]).length, 2);

// ── Outras edições do mesmo livro, quando o servidor do arquivo de um deles está fora do ar ──
const mk = (id, over) => ({ id, _mode: 'ebooks', title: 'Harry Potter and the Prisoner of Azkaban', author: 'J. K. Rowling', language: 'English', format: 'epub', source: "Anna's Archive", md5: id.toUpperCase().padEnd(32, '0'), ...over });
const alvo = mk('aaa');
const store = new Map([alvo, mk('bbb', { format: 'mobi', source: 'Library Genesis' }), mk('ccc', { directUrl: 'https://x.org/a.epub', source: 'Internet Archive' }),
    mk('ddd', { language: 'French' }), mk('eee', { author: 'Outra Pessoa' }), mk('fff', { title: 'Harry Potter and the Chamber of Secrets' }), mk('ggg', { source: 'Z-Library' }),
    mk('hhh', { format: 'djvu' }), mk('iii', { _mode: 'audiobooks' }), mk('jjj', { md5: alvo.md5 }), mk('kkk', { _probe: { ok: false, at: Date.now(), error: 'fora' } }), mk('lll', { author: '' })].map(r => [r.id, r]));
const alts = S.alternativesFor(alvo, store).map(r => r.id);
assert.deepEqual([...alts].sort(), ['bbb', 'ccc', 'lll'], 'mesma obra, idioma, modo e autor; sem o mesmo arquivo, sem Z-Library, sem formato que o app não abre, sem o que acabou de falhar');
assert.equal(alts[0], 'ccc', 'link direto e mesmo formato primeiro');

// ── Servidor de arquivos que não respondeu fica marcado: o próximo link nele falha na hora ──
const probe = await import('../src/probe.js');
assert.deepEqual(probe.deadHosts(), []);

console.log('Sleuth: leitura do Anna\'s, consenso entre fontes, idioma, limite por fonte e outras edições: ok');
