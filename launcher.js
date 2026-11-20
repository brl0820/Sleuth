// Ponto de entrada do pacote. Escolhe qual código roda (o do pacote ou uma atualização instalada em <dados>/updates/<versão>) e volta
// para uma versão boa se a nova não subir. Este arquivo nunca é atualizado: fica pequeno e sem dependências além de src/host.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataDir } from './src/host.js';

export const LAUNCHER_API = 1;
const STABLE_AFTER_MS = 30000;
const MAX_FAILURES = 2;
const SEMVER = /^\d+\.\d+\.\d+$/;

const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
const readJson = file => { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const writeJson = (file, value) => {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
        fs.renameSync(tmp, file);
    } catch (e) { console.warn('Não consegui gravar', path.basename(file), e.message); }
};

// Devolve qual versão rodar. Uma atualização que não ficou de pé em duas partidas seguidas é marcada como ruim e deixa de ser usada.
export function chooseApp({ bundleDir, data }) {
    const dir = path.join(data, 'updates');
    const bundled = readJson(path.join(bundleDir, 'package.json')).version;
    const state = readJson(path.join(dir, 'state.json'));
    const boot = readJson(path.join(dir, 'boot.json'));
    const bad = new Set(Array.isArray(boot.bad) ? boot.bad : []);
    const failures = { ...(boot.failures || {}) };
    const usable = v => typeof v === 'string' && SEMVER.test(v) && !bad.has(v) && cmp(v, bundled) > 0
        && readJson(path.join(dir, v, 'package.json')).version === v && fs.existsSync(path.join(dir, v, 'server.js'));

    let chosen = [state.current, state.previous].find(usable) || null;
    if (chosen && boot.version === chosen && boot.stable === false) {
        failures[chosen] = (failures[chosen] || 0) + 1;
        if (failures[chosen] >= MAX_FAILURES) {
            bad.add(chosen);
            chosen = [state.current, state.previous].find(usable) || null;
        }
    }
    return { version: chosen || bundled, root: chosen ? path.join(dir, chosen) : bundleDir, bundled, bad: [...bad], failures };
}

const bootFile = data => path.join(data, 'updates', 'boot.json');
const saveBoot = (data, sel, stable) => writeJson(bootFile(data), { version: sel.version, startedAt: Date.now(), stable, failures: sel.failures, bad: sel.bad });

export async function main() {
    const bundleDir = path.dirname(fileURLToPath(import.meta.url));
    const data = dataDir();
    process.env.SLEUTH_LAUNCHER = '1';
    process.env.SLEUTH_LAUNCHER_API = String(LAUNCHER_API);
    process.env.SLEUTH_BUNDLE_DIR = bundleDir;

    let sel = chooseApp({ bundleDir, data });
    for (;;) {
        process.env.SLEUTH_APP_DIR = sel.root;
        saveBoot(data, sel, sel.root === bundleDir);
        try {
            await import(pathToFileURL(path.join(sel.root, 'server.js')).href);
            break;
        } catch (e) {
            console.error(`A versão ${sel.version} não subiu:`, e && e.stack || e);
            if (sel.root === bundleDir) throw e;
            // Marca a versão como ruim e tenta a anterior (ou o pacote original).
            const boot = readJson(bootFile(data));
            writeJson(bootFile(data), { ...boot, bad: [...new Set([...(boot.bad || []), sel.version])] });
            sel = chooseApp({ bundleDir, data });
        }
    }
    const timer = setTimeout(() => {
        const boot = readJson(bootFile(data));
        if (boot.version === sel.version) writeJson(bootFile(data), { ...boot, stable: true, failures: { ...boot.failures, [sel.version]: 0 } });
    }, STABLE_AFTER_MS);
    timer.unref();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(e => { console.error(e); process.exit(1); });
