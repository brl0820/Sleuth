import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseApp } from '../launcher.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sleuth-launch-'));
const put = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); };
const app = (data, v, server = '// ok') => { put(path.join(data, 'updates', v, 'package.json'), { version: v }); put(path.join(data, 'updates', v, 'server.js'), server); };
let n = 0;
const fresh = () => { const base = path.join(tmp, 'c' + ++n), bundle = path.join(base, 'bundle'), data = path.join(base, 'data'); put(path.join(bundle, 'package.json'), { version: '3.0.0' }); return { bundle, data }; };
const state = (data, s) => put(path.join(data, 'updates', 'state.json'), s);
const boot = (data, b) => put(path.join(data, 'updates', 'boot.json'), b);
const choose = ({ bundle, data }) => chooseApp({ bundleDir: bundle, data });

// pacote original quando não há atualização, ou ela não vale
let c = fresh();
assert.equal(choose(c).version, '3.0.0');
state(c.data, { current: '3.1.0' });
assert.equal(choose(c).version, '3.0.0', 'estado aponta para uma pasta que não existe');
app(c.data, '3.1.0');
assert.equal(choose(c).version, '3.1.0');
assert.equal(choose(c).root, path.join(c.data, 'updates', '3.1.0'));
put(path.join(c.data, 'updates', '3.1.0', 'package.json'), { version: '9.9.9' });
assert.equal(choose(c).version, '3.0.0', 'pasta que não é a versão anunciada');
c = fresh(); app(c.data, '2.9.0'); state(c.data, { current: '2.9.0' });
assert.equal(choose(c).version, '3.0.0', 'o pacote mais novo vence uma atualização antiga que ficou nos dados');

// duas partidas seguidas sem ficar de pé: a atualização é descartada e volta a anterior (ou o original)
c = fresh(); app(c.data, '3.1.0'); app(c.data, '3.2.0'); state(c.data, { current: '3.2.0', previous: '3.1.0' });
boot(c.data, { version: '3.2.0', stable: false, failures: {} });
let sel = choose(c);
assert.equal(sel.version, '3.2.0', 'uma falha só ainda dá nova chance'); assert.equal(sel.failures['3.2.0'], 1);
boot(c.data, { version: '3.2.0', stable: false, failures: sel.failures });
sel = choose(c);
assert.equal(sel.version, '3.1.0', 'depois da segunda, volta para a anterior'); assert.deepEqual(sel.bad, ['3.2.0']);
boot(c.data, { version: '3.1.0', stable: false, failures: sel.failures, bad: sel.bad });
assert.equal(choose(c).version, '3.1.0', 'a ruim continua ignorada');
boot(c.data, { version: '3.2.0', stable: true, failures: {} });
assert.equal(choose(c).version, '3.2.0', 'quem ficou de pé não é descartada');
c = fresh(); app(c.data, '3.1.0'); state(c.data, { current: '3.1.0' });
boot(c.data, { version: '3.1.0', stable: false, failures: { '3.1.0': 1 } });
assert.equal(choose(c).version, '3.0.0', 'sem anterior, volta ao pacote original');
boot(c.data, { version: '3.0.0', stable: false, failures: {}, bad: ['3.1.0'] });
assert.equal(choose(c).version, '3.0.0');

// de verdade: um processo roda o launcher; a atualização quebrada é abandonada e o pacote original sobe
{
    const { bundle, data } = fresh();
    fs.copyFileSync('launcher.js', path.join(bundle, 'launcher.js'));
    fs.mkdirSync(path.join(bundle, 'src'));
    fs.copyFileSync('src/host.js', path.join(bundle, 'src', 'host.js'));
    const marker = path.join(tmp, 'marker.txt');
    put(path.join(bundle, 'package.json'), { version: '3.0.0', type: 'module' });
    put(path.join(bundle, 'server.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'original ' + process.env.SLEUTH_LAUNCHER + ' ' + process.env.SLEUTH_BUNDLE_DIR); setInterval(() => {}, 1000);`);
    put(path.join(data, 'updates', '3.1.0', 'package.json'), { version: '3.1.0', type: 'module' });
    put(path.join(data, 'updates', '3.1.0', 'server.js'), `throw new Error('quebrou ao subir');`);
    state(data, { current: '3.1.0' });
    const child = spawn(process.execPath, [path.join(bundle, 'launcher.js')], { env: { ...process.env, M_LIBRARY_ADDON_DATA: data }, stdio: 'ignore' });
    for (let i = 0; i < 60 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 100));
    child.kill();
    assert.equal(fs.readFileSync(marker, 'utf8').split(' ').slice(0, 2).join(' '), 'original 1', 'subiu o pacote original e avisou que roda pelo launcher');
    const b = JSON.parse(fs.readFileSync(path.join(data, 'updates', 'boot.json'), 'utf8'));
    assert.deepEqual(b.bad, ['3.1.0'], 'a versão que não subiu foi marcada como ruim');
    assert.equal(b.version, '3.0.0');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Launcher: escolhe a versão, descarta atualização que não fica de pé e volta ao pacote original: ok');
