// Zip mínimo, sem dependências: leitura segura (pacotes baixados) e gravação (build). Só métodos 0 (store) e 8 (deflate).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const DEFAULT_LIMITS = { files: 600, file: 60e6, total: 150e6 };

function checkName(name) {
    const parts = name.split('/');
    if (!name || name.length > 240 || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`Caminho inválido no pacote: ${name.slice(0, 80)}`);
    const dir = name.endsWith('/');
    if (dir) parts.pop();
    for (const p of parts) if (!p || p === '.' || p === '..') throw new Error(`Caminho inválido no pacote: ${name.slice(0, 80)}`);
    return dir;
}

export function readZip(buf, limits = DEFAULT_LIMITS) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Pacote inválido');
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Pacote inválido (sem diretório central)');
    const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('Pacotes zip64 não são aceitos');
    if (count > limits.files) throw new Error('Arquivos demais no pacote');
    if (cdOffset + cdSize > eocd) throw new Error('Pacote corrompido');

    const entries = [], seen = new Set();
    let total = 0, pos = cdOffset;
    for (let n = 0; n < count; n++) {
        if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Pacote corrompido');
        const madeBy = buf.readUInt16LE(pos + 4), flags = buf.readUInt16LE(pos + 8), method = buf.readUInt16LE(pos + 10);
        const crc = buf.readUInt32LE(pos + 16), csize = buf.readUInt32LE(pos + 20), usize = buf.readUInt32LE(pos + 24);
        const nameLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), commentLen = buf.readUInt16LE(pos + 32);
        const attrs = buf.readUInt32LE(pos + 38), offset = buf.readUInt32LE(pos + 42);
        const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
        pos += 46 + nameLen + extraLen + commentLen;
        const dir = checkName(name);
        const key = name.toLowerCase();
        if (seen.has(key)) throw new Error(`Entrada repetida no pacote: ${name.slice(0, 80)}`);
        seen.add(key);
        if (flags & 1) throw new Error('Pacote criptografado não é aceito');
        if (method !== 0 && method !== 8) throw new Error('Método de compressão não suportado');
        if ((madeBy >> 8) === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) throw new Error('Link simbólico no pacote');
        if (usize > limits.file) throw new Error('Arquivo grande demais no pacote');
        total += usize;
        if (total > limits.total) throw new Error('Pacote grande demais depois de descompactado');
        entries.push({ name, dir, method, crc, csize, usize, offset });
    }
    return entries;
}

export function entryData(buf, e) {
    const o = e.offset;
    if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error('Pacote corrompido');
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
    if (start + e.csize > buf.length) throw new Error('Pacote corrompido');
    const raw = buf.subarray(start, start + e.csize);
    const data = e.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: e.usize + 1 });
    if (data.length !== e.usize) throw new Error(`Tamanho inesperado: ${e.name.slice(0, 80)}`);
    if (zlib.crc32(data) !== e.crc) throw new Error(`Arquivo corrompido (CRC): ${e.name.slice(0, 80)}`);
    return data;
}

// Extrai para `dest` (que deve estar vazia ou não existir). Nada sai de `dest`.
export function extractZip(buf, dest, limits = DEFAULT_LIMITS) {
    const entries = readZip(buf, limits);
    const root = path.resolve(dest);
    fs.mkdirSync(root, { recursive: true });
    for (const e of entries) {
        const target = path.resolve(root, e.name);
        if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Caminho fora da pasta: ${e.name.slice(0, 80)}`);
        if (e.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
        const data = entryData(buf, e);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data, { flag: 'wx' });
    }
    return entries.filter(e => !e.dir).map(e => e.name);
}

// items: [{ name, data, mode }]
export function createZip(items) {
    const locals = [], central = [];
    let offset = 0;
    for (const it of items) {
        const raw = Buffer.from(it.data), body = zlib.deflateRawSync(raw), name = Buffer.from(it.name), crc = zlib.crc32(raw);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
        lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
        locals.push(lh, name, body);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
        ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
        ch.writeUInt32LE(((it.mode || 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
        central.push(ch, name);
        offset += lh.length + name.length + body.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}
