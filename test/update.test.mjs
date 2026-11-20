import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createUpdater, compare, verifySignature, readUpdateInfo } from '../src/update.js';
import { createZip } from '../src/zip.js';
import { contractHash } from '../src/manifest.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sleuth-upd-'));
const keyPair = () => crypto.generateKeyPairSync('ed25519');
const spki = k => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const good = keyPair(), other = keyPair();
const CONTRACT = contractHash();

// Monta os arquivos de um release, como o build faz.
function release({ version = '3.1.0', files, sign = good, contract = CONTRACT, node = 24, launcher = 1, notes = 'novidades', tamper, zipName } = {}) {
    const zip = createZip(files || [
        { name: 'server.js', data: '// servidor' }, { name: 'package.json', data: JSON.stringify({ name: 'sleuth', version }) }, { name: 'src/x.js', data: 'export {}' },
    ]);
    const meta = Buffer.from(JSON.stringify({
        format: 1, version, zip: { name: zipName || `sleuth-app-${version}.zip`, sha256: crypto.createHash('sha256').update(zip).digest('hex'), size: zip.length }, contract, node, launcher, notes,
    }));
    const sig = crypto.sign(null, meta, sign.privateKey).toString('base64');
    const assets = { latest: { 'update.json': meta, 'update.json.sig': Buffer.from(sig) }, tag: { [`v${version}`]: { [`sleuth-app-${version}.zip`]: zip } } };
    if (tamper === 'zip') { const bad = Buffer.from(zip); bad[bad.length >> 1] ^= 0xff; assets.tag[`v${version}`][`sleuth-app-${version}.zip`] = bad; }
    if (tamper === 'meta') assets.latest['update.json'] = Buffer.from(meta.toString().replace(notes, 'outra coisa'));
    return assets;
}

let current = release();
const server = http.createServer((req, res) => {
    const m = /^\/(latest|tag\/(v[\d.]+))\/(.+)$/.exec(req.url);
    const body = m && (m[1] === 'latest' ? current.latest[m[3]] : (current.tag[m[2]] || {})[m[3]]);
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;
const urls = { latest: `${origin}/latest/`, tag: v => `${origin}/tag/v${v}/` };

let n = 0;
const make = (over = {}) => {
    const dataDir = path.join(tmp, 'd' + ++n), installs = [];
    const u = createUpdater({ dataDir, version: '3.0.0', keys: [spki(good)], urls, fetchFn: fetch, allowHttp: true, nodeMajor: 24, launcherApi: 1, onInstalled: i => installs.push(i), ...over });
    return { u, dataDir, installs, state: () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'updates', 'state.json'), 'utf8')); } catch { return null; } } };
};

// ── versões e assinatura ──
assert.equal(compare('3.0.0', '3.0.1'), -1); assert.equal(compare('3.10.0', '3.9.9'), 1); assert.equal(compare('3.1.0', '3.1.0'), 0);
const sample = release();
assert.equal(verifySignature(sample.latest['update.json'], sample.latest['update.json.sig'].toString(), [spki(good)]), true);
assert.equal(verifySignature(sample.latest['update.json'], sample.latest['update.json.sig'].toString(), [spki(other)]), false, 'outra chave não vale');
assert.equal(verifySignature(sample.latest['update.json'], sample.latest['update.json.sig'].toString(), [spki(other), spki(good)]), true, 'aceita várias chaves (troca de chave)');
assert.equal(verifySignature(Buffer.from('outro conteúdo'), sample.latest['update.json.sig'].toString(), [spki(good)]), false);
assert.equal(verifySignature(sample.latest['update.json'], 'não é base64 de 64 bytes', [spki(good)]), false);

// ── atualização válida ──
{
    current = release();
    const t = make();
    const s = await t.u.check();
    assert.equal(s.lastError, '', s.lastError);
    assert.equal(s.pending, '3.1.0');
    assert.deepEqual(t.installs, [{ version: '3.1.0' }]);
    assert.equal(t.state().current, '3.1.0');
    assert.equal(fs.readFileSync(path.join(t.dataDir, 'updates', '3.1.0', 'src/x.js'), 'utf8'), 'export {}');
    assert.equal(fs.readdirSync(path.join(t.dataDir, 'updates')).some(f => f.startsWith('.tmp-')), false, 'sem sobras');
    // já instalada: nada de novo
    const again = await t.u.check();
    assert.equal(again.available, null); assert.equal(t.installs.length, 1);
}

// ── em dia, e nunca volta a uma versão menor ou igual ──
for (const v of ['3.0.0', '2.9.9']) {
    current = release({ version: v });
    const t = make();
    const s = await t.u.check();
    assert.equal(s.available, null); assert.equal(t.installs.length, 0, `release ${v} não é novidade para a 3.0.0`);
}

// ── adulterações ──
{
    current = release({ tamper: 'zip' });
    const t = make();
    const s = await t.u.check();
    assert.match(s.lastError, /hash assinado/); assert.equal(t.state(), null, 'zip adulterado não instala nada');
    assert.equal(fs.existsSync(path.join(t.dataDir, 'updates', '3.1.0')), false);

    current = release({ tamper: 'meta' });
    assert.match((await make().u.check()).lastError, /assinatura/i, 'update.json alterado depois de assinado');

    current = release({ sign: other });
    const t2 = make();
    assert.match((await t2.u.check()).lastError, /assinatura/i, 'assinado por outra chave');
    assert.equal(t2.installs.length, 0);

    current = release({ zipName: 'sleuth-app-9.9.9.zip' });
    assert.match((await make().u.check()).lastError, /nome do pacote/);

    current = release({ files: [{ name: 'server.js', data: 'x' }, { name: '../fora.js', data: 'x' }] });
    const t3 = make();
    assert.match((await t3.u.check()).lastError, /inválido/, 'zip-slip');
    assert.equal(fs.existsSync(path.join(tmp, 'fora.js')), false);
    const up = path.join(t3.dataDir, 'updates');
    assert.equal((fs.existsSync(up) ? fs.readdirSync(up) : []).filter(f => f.startsWith('.tmp-')).length, 0, 'extração recusada não deixa sobras');

    current = release({ files: [{ name: 'server.js', data: 'x' }, { name: 'package.json', data: JSON.stringify({ version: '9.9.9' }) }] });
    assert.match((await make().u.check()).lastError, /não é a versão anunciada/);
}

// ── o que o app aprovou não muda sozinho ──
{
    current = release({ contract: 'a'.repeat(64) });
    const t = make();
    const s = await t.u.check();
    assert.match(s.blocked, /permissões|páginas/); assert.equal(t.installs.length, 0);
    current = release({ node: 99 });
    assert.match((await make().u.check()).blocked, /Node 99/);
    current = release({ launcher: 2 });
    assert.match((await make().u.check()).blocked, /pacote novo/);
}

// ── atualização automática desligada: avisa, mas só instala quando mandarem ──
{
    current = release();
    const t = make({ auto: () => false });
    const s = await t.u.check();
    assert.equal(s.available.version, '3.1.0'); assert.equal(t.installs.length, 0);
    const s2 = await t.u.check({ install: true });
    assert.equal(s2.pending, '3.1.0'); assert.equal(t.installs.length, 1);
}

// ── guarda a versão anterior e volta a ela ──
{
    const t = make();
    current = release({ version: '3.1.0' }); await t.u.check();
    current = release({ version: '3.2.0' }); await t.u.check();
    assert.deepEqual([t.state().current, t.state().previous], ['3.2.0', '3.1.0']);
    assert.deepEqual(fs.readdirSync(path.join(t.dataDir, 'updates')).filter(f => /^\d/.test(f)).sort(), ['3.1.0', '3.2.0']);
    const r = t.u.rollback();
    assert.equal(r.pending, '3.1.0'); assert.equal(t.state().current, '3.1.0');
    assert.ok(t.state().rejected.includes('3.2.0'));
    // a versão de que a pessoa saiu não volta sozinha
    current = release({ version: '3.2.0' });
    const again = await t.u.check();
    assert.match(again.lastError, /ignorada/); assert.equal(t.state().current, '3.1.0');
    // sem anterior: volta para o pacote original
    t.u.rollback();
    assert.equal(t.state().current, null);
    assert.throws(() => t.u.rollback(), /pacote original/);
}

// ── versão marcada como ruim pela inicialização não é reinstalada ──
{
    current = release({ version: '3.3.0' });
    const t = make();
    fs.mkdirSync(path.join(t.dataDir, 'updates'), { recursive: true });
    fs.writeFileSync(path.join(t.dataDir, 'updates', 'boot.json'), JSON.stringify({ bad: ['3.3.0'] }));
    assert.match((await t.u.check()).lastError, /falhou nesta máquina/);
    assert.equal(t.installs.length, 0);
}

// ── desligado, origem e limites ──
{
    const off = make({ enabled: false });
    assert.match((await off.u.check()).lastError, /desligadas/);
    const insecure = createUpdater({ dataDir: path.join(tmp, 'x'), version: '3.0.0', keys: [spki(good)], urls, fetchFn: fetch, allowHttp: false });
    assert.match((await insecure.check()).lastError, /https/);
    assert.throws(() => readUpdateInfo(Buffer.from('{"format":2}'), { nodeMajor: 24, launcherApi: 1, contract: CONTRACT }), /inválido/);
    const dead = createUpdater({ dataDir: path.join(tmp, 'y'), version: '3.0.0', keys: [spki(good)], urls: { latest: `${origin}/nada/`, tag: v => v }, fetchFn: fetch, allowHttp: true });
    assert.match((await dead.check()).lastError, /404/, 'sem release: erro claro, nada quebra');
}

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Atualização: assinatura, hash, zip-slip, contrato, versões e reversão: ok');
