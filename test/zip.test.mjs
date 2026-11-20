import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZip, readZip, extractZip } from '../src/zip.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sleuth-zip-'));

const z = createZip([{ name: 'a/b.txt', data: 'olá' }, { name: 'c.json', data: '{"x":1}' }]);
const dest = path.join(tmp, 'ok');
assert.deepEqual(extractZip(z, dest).sort(), ['a/b.txt', 'c.json']);
assert.equal(fs.readFileSync(path.join(dest, 'a/b.txt'), 'utf8'), 'olá');

for (const name of ['../evil.txt', 'a/../../x', '/abs.txt', 'C:/x.txt', 'a\\b.txt', 'a//b', './x', 'a/./b', '']) {
    assert.throws(() => readZip(createZip([{ name, data: 'x' }])), /inválido/, `recusa o caminho "${name}"`);
}
assert.throws(() => readZip(createZip([{ name: 'A.txt', data: '1' }, { name: 'a.txt', data: '2' }])), /repetida/, 'repetido, mesmo mudando a caixa');
assert.throws(() => readZip(createZip([{ name: 'l', data: 'alvo', mode: 0o120777 }])), /simbólico/);
assert.throws(() => readZip(z, { files: 1, file: 1e6, total: 1e6 }), /demais/);
assert.throws(() => readZip(z, { files: 10, file: 1e6, total: 5 }), /grande demais/);

const centralOffset = buf => buf.readUInt32LE(buf.length - 22 + 16);
const crcBad = Buffer.from(createZip([{ name: 'f', data: 'conteudo '.repeat(20) }]));
crcBad.writeUInt32LE(0x1234, centralOffset(crcBad) + 16);
assert.throws(() => extractZip(crcBad, path.join(tmp, 'crc')), /CRC/, 'arquivo adulterado');

const bomb = Buffer.from(createZip([{ name: 'f', data: Buffer.alloc(100000, 7) }]));
bomb.writeUInt32LE(10, centralOffset(bomb) + 24);
assert.throws(() => extractZip(bomb, path.join(tmp, 'bomb')), 'tamanho declarado menor que o real não passa');

const enc = Buffer.from(z);
enc.writeUInt16LE(enc.readUInt16LE(centralOffset(enc) + 8) | 1, centralOffset(enc) + 8);
assert.throws(() => readZip(enc), /criptografado/);
assert.throws(() => readZip(Buffer.from('isto não é um zip, só texto comprido o bastante para passar do tamanho mínimo')), /inválido/);
assert.throws(() => readZip(z.subarray(0, z.length - 10)), /inválido|corrompido/);

// Uma extração recusada não deixa nada fora da pasta
const evil = path.join(tmp, 'evil-target');
assert.throws(() => extractZip(createZip([{ name: 'ok.txt', data: '1' }, { name: '../fora.txt', data: '2' }]), evil));
assert.equal(fs.existsSync(path.join(tmp, 'fora.txt')), false);
assert.equal(fs.existsSync(path.join(evil, 'ok.txt')), false, 'valida tudo antes de gravar qualquer arquivo');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Zip: extração segura (zip-slip, repetidos, links, CRC, limites): ok');
