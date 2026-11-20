// Gera os arquivos de um release.
//   node scripts/build-release.mjs app [--no-sign] [--key arquivo.pem] [--notes "texto"]   zip de código + update.json + update.json.sig
//   node scripts/build-release.mjs maddon --platform win32-x64|linux-x64 [--node caminho]    pacote .maddon (com o Node da plataforma)
//   node scripts/build-release.mjs sums                                                      SHA256SUMS de tudo em dist/
// A chave de assinatura vem de UPDATE_SIGNING_KEY (conteúdo do .pem) ou de --key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../src/zip.js';
import { manifest, contractHash } from '../src/manifest.js';
import { PUBLIC_KEYS, verifySignature } from '../src/update.js';
import { LAUNCHER_API } from '../launcher.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
const flag = name => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : '');
const has = name => rest.includes(name);

const walk = (dir, prefix, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name), rel = prefix + e.name;
        if (e.isDirectory()) walk(full, rel + '/', out);
        else if (e.isFile()) out.push({ name: rel, data: fs.readFileSync(full), mode: 0o100644 });
    }
    return out;
};
// O código do addon (o que uma atualização troca).
const codeFiles = () => [
    ...['server.js', 'package.json', 'LICENSE'].filter(f => fs.existsSync(path.join(root, f))).map(f => ({ name: f, data: fs.readFileSync(path.join(root, f)), mode: 0o100644 })),
    ...walk(path.join(root, 'src'), 'src/'),
    ...walk(path.join(root, 'ui'), 'ui/'),
];
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const nodeMajor = Number(/(\d+)/.exec(pkg.engines.node)[1]);

function notesFor(version) {
    if (flag('--notes')) return flag('--notes').slice(0, 600);
    try {
        const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
        const m = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(log);
        return m ? m[1].trim().replace(/\s+/g, ' ').slice(0, 600) : '';
    } catch { return ''; }
}

function signKey() {
    const pem = process.env.UPDATE_SIGNING_KEY || (flag('--key') ? fs.readFileSync(flag('--key'), 'utf8') : '');
    return pem ? crypto.createPrivateKey(pem) : null;
}

fs.mkdirSync(dist, { recursive: true });

if (cmd === 'app') {
    const zipName = `sleuth-app-${pkg.version}.zip`;
    const zip = createZip(codeFiles());
    fs.writeFileSync(path.join(dist, zipName), zip);
    const meta = Buffer.from(JSON.stringify({
        format: 1, version: pkg.version, zip: { name: zipName, sha256: sha256(zip), size: zip.length },
        contract: contractHash(), node: nodeMajor, launcher: LAUNCHER_API, notes: notesFor(pkg.version),
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dist, 'update.json'), meta);
    const key = signKey();
    if (key) {
        const sig = crypto.sign(null, meta, key).toString('base64');
        if (!verifySignature(meta, sig, PUBLIC_KEYS)) throw new Error('A assinatura não confere com PUBLIC_KEYS (src/update.js): a chave privada é a errada. Nenhum cliente conseguiria instalar este release.');
        fs.writeFileSync(path.join(dist, 'update.json.sig'), sig);
        console.log('update.json assinado e conferido contra PUBLIC_KEYS');
    } else if (has('--no-sign')) console.warn('AVISO: sem assinatura (--no-sign). Nenhum cliente instalaria este release.');
    else throw new Error('Sem chave de assinatura: defina UPDATE_SIGNING_KEY ou use --key (ou --no-sign só para testes locais).');
    console.log(`${zipName} (${(zip.length / 1e3).toFixed(0)} KB)`);
} else if (cmd === 'maddon') {
    const platform = flag('--platform');
    const exe = { 'win32-x64': 'node.exe', 'linux-x64': 'node' }[platform];
    if (!exe) throw new Error('Use --platform win32-x64 ou linux-x64');
    const nodePath = path.resolve(flag('--node') || process.execPath);
    if (!fs.existsSync(nodePath)) throw new Error('Node não encontrado: ' + nodePath);
    const pw = path.join(root, 'node_modules', 'playwright-core');
    if (!fs.existsSync(pw)) console.warn('AVISO: node_modules/playwright-core não existe (rode npm ci): o pacote sai sem o componente do navegador.');
    const license = [path.dirname(nodePath), path.dirname(path.dirname(nodePath))].map(d => path.join(d, 'LICENSE')).find(f => fs.existsSync(f));
    if (!license) {
        if (process.env.CI) throw new Error('LICENSE do Node não encontrada ao lado do executável: o pacote precisa levá-la junto.');
        console.warn('AVISO: LICENSE do Node não encontrada ao lado do executável.');
    }
    const m = { ...manifest(pkg.version), service: { run: { [platform]: [exe, 'launcher.js'] } } };
    const items = [
        { name: 'manifest.json', data: JSON.stringify(m, null, 2) + '\n', mode: 0o100644 },
        { name: exe, data: fs.readFileSync(nodePath), mode: platform === 'linux-x64' ? 0o100755 : 0o100644 },
        ...(license ? [{ name: 'NODE-LICENSE', data: fs.readFileSync(license), mode: 0o100644 }] : []),
        { name: 'launcher.js', data: fs.readFileSync(path.join(root, 'launcher.js')), mode: 0o100644 },
        ...codeFiles(),
        ...(fs.existsSync(pw) ? walk(pw, 'node_modules/playwright-core/') : []),
    ];
    const out = path.join(dist, `sleuth-${pkg.version}-${platform}.maddon`);
    fs.writeFileSync(out, createZip(items));
    console.log(`${path.basename(out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${items.length} arquivos)`);
} else if (cmd === 'sums') {
    const files = fs.readdirSync(dist).filter(f => f !== 'SHA256SUMS' && fs.statSync(path.join(dist, f)).isFile()).sort();
    fs.writeFileSync(path.join(dist, 'SHA256SUMS'), files.map(f => `${sha256(fs.readFileSync(path.join(dist, f)))}  ${f}`).join('\n') + '\n');
    console.log('SHA256SUMS:', files.length, 'arquivos');
} else {
    console.error('Uso: build-release.mjs app|maddon|sums (veja o topo do arquivo)');
    process.exit(1);
}
