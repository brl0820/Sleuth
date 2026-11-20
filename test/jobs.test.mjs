// Sleuth: busca em segundo plano com o andamento por fonte (src/jobs.js).
import assert from 'node:assert/strict';
const { createJobs } = await import('../src/jobs.js');

const nd = lines => new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(JSON.stringify(l) + '\n')); c.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
const wait = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('tempo esgotado'); };

let t = 1000;
const jobs = createJobs({ labels: { libgen: 'Library Genesis', annas: "Anna's Archive" }, now: () => t,
    search: async () => nd([{ sources: ['libgen', 'annas'] }, { done: 'libgen', count: 2, status: 'ok', results: [{ id: 'a' }, { id: 'b' }] }, { done: 'annas', count: 0, status: 'timeout', results: [{ id: 'a' }, { id: 'b' }] }, { final: { results: [{ id: 'a' }, { id: 'b' }] } }]) });
const { job } = jobs.start('dune', 'ebooks');
assert.match(job, /^[0-9a-f]{18}$/);
await wait(() => jobs.poll(job, 0).done);
const out = jobs.poll(job, 0);
assert.deepEqual(out.sources, [{ id: 'libgen', name: 'Library Genesis', status: 'ok', count: 2 }, { id: 'annas', name: "Anna's Archive", status: 'timeout', count: 0 }]);
assert.equal(out.results.length, 2);
assert.equal(jobs.poll(job, out.rev).results, undefined, 'sem mudança: não repete os resultados');
assert.equal(jobs.poll('inexistente', 0), null);

// Fonte que nunca respondeu vira "timeout" quando a busca termina.
const j2 = createJobs({ search: async () => nd([{ sources: ['x'] }, { final: { results: [] } }]) });
const a = j2.start('q', 'ebooks'); await wait(() => j2.poll(a.job, 0).done);
assert.equal(j2.poll(a.job, 0).sources[0].status, 'timeout');

const j3 = createJobs({ search: async () => new Response(JSON.stringify({ results: [{ id: 'z' }], meta: { libgen: 1, annas: 0 } }), { headers: { 'Content-Type': 'application/json' } }) });
const c = j3.start('q', 'ebooks'); await wait(() => j3.poll(c.job, 0).done);
assert.deepEqual(j3.poll(c.job, 0).sources.map(s => [s.id, s.count]), [['libgen', 1], ['annas', 0]]);
assert.equal(j3.poll(c.job, 0).results[0].id, 'z');

const j4 = createJobs({ search: async () => { throw new Error('quebrou'); } });
const e = j4.start('q', 'ebooks'); await wait(() => j4.poll(e.job, 0).done);
assert.equal(j4.poll(e.job, 0).error, 'quebrou');

const j5 = createJobs({ max: 3, ttlMs: 100, now: () => t, search: async () => nd([{ final: { results: [] } }]) });
const ids = [1, 2, 3, 4, 5].map(() => j5.start('q', 'ebooks').job);
assert.equal(j5.size() <= 4, true);
t += 500; j5.start('q', 'ebooks');
assert.equal(j5.size(), 1, 'buscas antigas expiram');

const j6 = createJobs({ search: async () => nd([{ final: { results: Array.from({ length: 150 }, (_, i) => ({ id: String(i) })) } }]) });
const f = j6.start('q', 'ebooks'); await wait(() => j6.poll(f.job, 0).done);
assert.equal(j6.poll(f.job, 0).results.length, 100);
console.log('Sleuth: busca com andamento por fonte (nd-json, cache, erro, validade, limite): ok');

const health = { libgen: 'ok', annas: 'verify' };
const j7 = createJobs({
    labels: id => ({ libgen: 'Library Genesis', annas: "Anna's Archive" }[id] || id),
    active: mode => (mode === 'ebooks' ? ['libgen', 'annas'] : ['librivox']),
    statusOf: id => health[id],
    actionOf: (id, status) => (status === 'verify' ? { page: 'verificar', label: 'Confirmar acesso' } : null),
    search: async () => new Response(JSON.stringify({ results: [], meta: { libgen: 3, annas: 0, mobilism: 0, librivox: 0 } }), { headers: { 'Content-Type': 'application/json' } }),
});
const k = j7.start('q', 'ebooks'); await wait(() => j7.poll(k.job, 0).done);
assert.deepEqual(j7.poll(k.job, 0).sources, [
    { id: 'libgen', name: 'Library Genesis', status: 'ok', count: 3 },
    { id: 'annas', name: "Anna's Archive", status: 'verify', count: 0, action: { page: 'verificar', label: 'Confirmar acesso' } },
], 'fontes desligadas ou de outro modo não aparecem; "verify" traz a ação');
console.log('Sleuth: estado das fontes em respostas em cache e pedido de confirmação: ok');
