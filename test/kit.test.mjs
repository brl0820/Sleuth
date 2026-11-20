// Kit dos addons: a configuração viaja no endereço (como no Stremio) e a página de configuração é gerada.
import assert from 'node:assert/strict';
const { encodeConfig, decodeConfig, configurePage } = await import('../src/kit.js');

// ── Kit: a configuração viaja no endereço (como no Stremio)
const cfg = { enabled: ['libgen', 'gutenberg'], slum: false, nome: 'ção' };
assert.deepEqual(decodeConfig(encodeConfig(cfg)), cfg);
assert.deepEqual(decodeConfig('não é base64 válido!!'), {}, 'configuração inválida vira vazia');
assert.deepEqual(decodeConfig('A'.repeat(9000)), {}, 'limite de tamanho');
const page = configurePage({ title: 'T', description: 'D', fields: [{ name: 'x', label: 'X', type: 'text' }], config: {}, internalUrl: 'http://addon-x:7000' });
assert.match(page, /http:\/\/addon-x:7000/);

const sel = configurePage({ title: 'T', description: 'D', fields: [{ name: 'language', label: 'Idioma', type: 'select', options: [{ value: 'pt', label: 'Português' }, { value: 'en', label: 'English' }] },
    { name: 'lists', label: 'Listas', type: 'checks', options: [{ value: 'a', label: 'Ficção', labels: { pt: 'Ficção', en: 'Fiction' } }] }], config: {}, internalUrl: 'http://x' });
assert.match(sel, /type==='select'/);
assert.match(sel, /relabel/);
assert.match(sel, /Fiction/);
console.log('Addon kit: config in the address, select fields and per-language labels: ok');
