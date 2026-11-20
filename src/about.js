// Informações do addon para o painel: o que ele faz, onde ficam os arquivos, o que baixou e com quem fala.
// Tamanhos e endereços acessados são medidos em tempo real; o registro de acessos fica só na memória.
import fs from 'node:fs';
import path from 'node:path';
import { runsAsPackage } from './host.js';

// ── Registro de acessos de rede ──
const seen = new Map();
const MAX_HOSTS = 300;
function note(url, status, failed) {
    let host = '';
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return; host = u.host; } catch { return; }
    if (host === 'addon' || host.endsWith('.internal')) return;
    let h = seen.get(host);
    if (!h) { if (seen.size >= MAX_HOSTS) seen.delete(seen.keys().next().value); h = { count: 0, fails: 0, at: 0, last: '' }; seen.set(host, h); }
    h.count++; h.at = Date.now();
    if (failed) { h.fails++; h.last = failed; } else h.last = 'HTTP ' + status;
}
let installed = false;
// Envolve o fetch do processo: todo acesso do addon (buscas, espelhos, conferência de links, monitor SLUM) passa por ele.
// O tráfego interno do Chromium (navegador em segundo plano) não passa por aqui.
export function logAccesses() {
    if (installed) return; installed = true;
    const real = globalThis.fetch;
    globalThis.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        return real.call(this, input, init).then(r => { note(url, r.status); return r; }, e => { note(url, 0, String((e && e.cause && e.cause.code) || (e && e.name) || 'erro')); throw e; });
    };
}
export const accessLog = () => [...seen].map(([host, v]) => ({ host, ...v })).sort((a, b) => b.at - a.at);

// ── Tamanho das pastas (assíncrono, com limite de tempo e cache, porque o Chromium tem milhares de arquivos) ──
const sizes = new Map();
export async function dirStats(dir, budgetMs = 3500) {
    const hit = sizes.get(dir);
    if (hit && Date.now() - hit.at < 60000) return hit;
    const out = { at: Date.now(), bytes: 0, files: 0, partial: false, exists: false };
    try { await fs.promises.access(dir); out.exists = true; } catch { sizes.set(dir, out); return out; }
    const end = Date.now() + budgetMs, stack = [dir];
    while (stack.length) {
        if (Date.now() > end) { out.partial = true; break; }
        const d = stack.pop();
        let entries = [];
        try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
        await Promise.all(entries.map(async e => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.isFile()) { try { const { size } = await fs.promises.stat(p); out.bytes += size; out.files++; } catch { } } // soma depois do await: `x += await f()` perderia somas concorrentes
        }));
    }
    sizes.set(dir, out);
    return out;
}
const mtime = async p => { try { return (await fs.promises.stat(p)).mtimeMs; } catch { return 0; } };

// ── O texto ──
const DOES = [
    'Procura livros e audiolivros nos sites que você deixa ligados (Library Genesis, Anna’s Archive, Z-Library, Internet Archive, Project Gutenberg, OpenStax, LibreTexts, Memory of the World, RoyalLib, Mobilism, AudiobookBay, LibriVox, AudiobooksBee e as fontes OPDS que você adicionar).',
    'Junta e ordena os resultados de todas as fontes e entrega ao app a lista com os links dos arquivos.',
    'Confere se cada link realmente entrega o arquivo: faz uma requisição que lê só o primeiro 1 KB e descarta o resto. O arquivo em si é baixado pelo app, direto da fonte para o seu aparelho.',
    'Quando o link de download de uma fonte falha, tenta as alternativas de download dela (no LibGen, todos os espelhos de busca entregam o arquivo pelo mesmo servidor, então trocar de espelho não ajuda): os servidores conhecidos, os que você cadastrou e, no LibGen, os que a API do libgen.me lista para o livro, conferindo cada um antes de entregar.',
    'Verifica atualizações nos Releases do GitHub (a cada 6 horas, se a atualização automática estiver ligada), confere a assinatura e o hash do pacote e instala sozinho; você pode desligar isso, voltar à versão anterior ou conferir na hora.',
    'Quando um servidor de arquivo está fora do ar, tenta outra edição do mesmo livro e lembra do servidor ruim por 5 minutos.',
    'Escolhe o melhor espelho de cada site (os seus primeiro, depois os conhecidos), medindo a velocidade e pondo em pausa os que falham. Se o monitor SLUM estiver ligado, lê a página open-slum.org a cada 30 minutos para saber quais domínios estão no ar.',
    'Guarda suas preferências (fontes ligadas, espelhos, fontes personalizadas e contas) num arquivo na pasta de dados.',
    'Usa um navegador (Chromium) em segundo plano, escondido, só para Anna’s Archive e Z-Library, que exigem um navegador de verdade; ele lembra as confirmações “não sou um robô” que você faz e fecha sozinho depois de 5 minutos parado.',
    'Entrega o arquivo .torrent de resultados AudiobookBay buscando-o em itorrents.org/.net e repassando sem guardar; e redireciona o download do Z-Library usando a sua conta.',
];
const DOES_NOT = [
    'Não grava livros nem audiolivros no disco, nem passa o arquivo por ele: o app baixa direto da fonte.',
    'Não resolve verificações “não sou um robô” sozinho: só você, pela página “Confirmar acesso”.',
    'Não manda suas contas para ninguém além do site correspondente (Z-Library, Mobilism ou Anna’s Archive). Elas ficam só no sleuth.json e nunca são mostradas de novo no painel.',
    'Não lê seus livros, sua estante, seus outros addons nem outras pastas do computador.',
    'Não aceita comandos de páginas abertas no navegador: só o app (ponte nativa) altera as preferências.',
];
const KNOWN = {
    'open-slum.org': 'Monitor de espelhos (SLUM): diz quais domínios estão no ar',
    'itorrents.org': 'Caches públicos de arquivos .torrent (AudiobookBay)', 'itorrents.net': 'Caches públicos de arquivos .torrent (AudiobookBay)',
    'forum.mobilism.org': 'Mobilism (fórum, com a sua conta)',
};

export async function aboutInfo({ version, id, name, author, description, permissions, resources, types, dataDir, installDir, host, port, sourceLabels, sourceOrigins, mirrors, downloads = [], custom, enabled, updates = null, extraHosts = {} }) {
    const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(dataDir, 'browsers');
    const profile = path.join(dataDir, 'browser-profile');
    const prefs = path.join(dataDir, 'sleuth.json');
    const [dData, dBrowsers, dProfile, dInstall, prefsStat, browsersTime] = await Promise.all([
        dirStats(dataDir), dirStats(browsers), dirStats(profile), dirStats(installDir, 1500), fs.promises.stat(prefs).then(s => ({ exists: true, bytes: s.size, files: 1 }), () => ({ exists: false, bytes: 0, files: 0 })), mtime(browsers)]);
    const mode = runsAsPackage() ? 'Pacote .maddon (instalado pelo app, processo próprio nesta máquina)'
        : process.env.BROWSER_IN_CONTAINER ? 'Serviço em contêiner (Docker)'
        : process.env.DATA_DIR ? 'Serviço com pasta de dados própria (DATA_DIR)' : 'Execução direta (desenvolvimento)';

    const labelByHost = {};
    const sites = [];
    for (const [svc, list] of Object.entries(sourceOrigins)) {
        for (const o of list) { const h = new URL(o).host; labelByHost[h] = sourceLabels[svc] || svc; }
        sites.push({ label: sourceLabels[svc] || svc, on: enabled.has(svc), hosts: list.map(o => new URL(o).host), mine: (mirrors[svc] || []).map(o => new URL(o).host) });
    }
    const labelOf = svc => sourceLabels[svc] || ((custom.find(c => 'c:' + c.id === svc) || {}).name) || svc;
    for (const svc of Object.keys(mirrors)) for (const o of mirrors[svc]) { try { labelByHost[new URL(o).host] = labelOf(svc) + ' (espelho seu)'; } catch { } }
    for (const c of custom) { try { const h = new URL(c.url).host; labelByHost[h] = c.name + ' (fonte sua)'; } catch { } }
    sites.push(...custom.map(c => { let h = ''; try { h = new URL(c.url).host; } catch { } return { label: c.name + ' (fonte sua)', on: enabled.has('c:' + c.id), hosts: [h].filter(Boolean), mine: (mirrors['c:' + c.id] || []).map(o => { try { return new URL(o).host; } catch { return ''; } }).filter(Boolean) }; }));

    const dlLabel = d => 'Alternativa de download' + (d.service ? ' — ' + (sourceLabels[d.service] || (custom.find(c => 'c:' + c.id === d.service) || {}).name || d.service) : '') + (d.user ? ' (sua)' : '');
    for (const d of downloads) labelByHost[d.host] = dlLabel(d);
    sites.push({ label: 'Alternativas de download', on: true, hosts: [...new Set(downloads.filter(d => !d.user).map(d => d.host))], mine: [...new Set(downloads.filter(d => d.user).map(d => d.host))] });

    if (updates) sites.push({ label: 'Atualizações do Sleuth (Releases do GitHub)', on: updates.enabled && updates.auto, hosts: ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'], mine: [] });
    for (const h of ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']) extraHosts[h] = extraHosts[h] || 'Atualizações do Sleuth (Releases do GitHub)';

    const accessed = accessLog().map(a => ({
        host: a.host, count: a.count, fails: a.fails, at: a.at, last: a.last,
        why: labelByHost[a.host] || extraHosts[a.host] || KNOWN[a.host] || 'Servidor de arquivo ou espelho descoberto durante as buscas e a conferência de links',
    }));

    return {
        version, id, name, author, description,
        runtime: { mode, node: process.version, exec: process.execPath, platform: process.platform + ' ' + process.arch, pid: process.pid, uptime: Math.round(process.uptime()), host, port, onlyThisComputer: host === '127.0.0.1' || host === 'localhost' },
        paths: [
            { label: 'Programa do addon (código)', path: installDir, what: 'Os arquivos do Sleuth: server.js, src/ (motor de busca) e ui/ (painel). Só leitura.', bytes: dInstall.bytes, files: dInstall.files, partial: dInstall.partial, exists: dInstall.exists },
            { label: 'Pasta de dados', path: dataDir, what: 'Tudo que o addon grava fica aqui dentro. Apagar essa pasta apaga as suas preferências, contas, confirmações e o navegador baixado.', bytes: dData.bytes, files: dData.files, partial: dData.partial, exists: dData.exists },
            { label: 'Preferências e contas (sleuth.json)', path: prefs, what: 'Fontes ligadas, espelhos, fontes personalizadas e as contas. Em Linux e Docker, só o dono do arquivo consegue ler (permissão 0600).', bytes: prefsStat.bytes, files: prefsStat.files, exists: prefsStat.exists },
            { label: 'Perfil do navegador (browser-profile)', path: profile, what: 'Cookies e confirmações “não sou um robô” do Chromium, para as próximas buscas.', bytes: dProfile.bytes, files: dProfile.files, partial: dProfile.partial, exists: dProfile.exists },
            { label: 'Navegador Chromium (browsers)', path: browsers, what: 'O Chromium baixado uma vez para o addon. Pode ser removido: o addon volta a oferecer o botão “Baixar o navegador”.', bytes: dBrowsers.bytes, files: dBrowsers.files, partial: dBrowsers.partial, exists: dBrowsers.exists },
        ],
        downloaded: [
            { what: 'Navegador Chromium (Playwright)', state: dBrowsers.exists && dBrowsers.files ? 'Baixado' : 'Não baixado', bytes: dBrowsers.bytes, at: browsersTime, note: 'Baixado do servidor da Microsoft (Playwright) uma única vez, quando você clica em “Baixar o navegador” (no Docker já vem na imagem). Roda escondido, só quando preciso.' },
            { what: 'Livros e audiolivros', state: 'Nenhum', bytes: 0, at: 0, note: 'O addon nunca guarda o arquivo: o app baixa direto da fonte. O que ele lê é a lista de resultados (em memória, por 10 minutos) e o primeiro 1 KB de cada link, para conferir.' },
            { what: 'Arquivos .torrent', state: 'Nenhum guardado', bytes: 0, at: 0, note: 'Quando você pede um, o addon o busca (até 5 MB) e repassa direto ao app, sem salvar.' },
            { what: 'Páginas e listas de resultados', state: 'Só em memória', bytes: 0, at: 0, note: 'Cache de buscas por 10 minutos (até 300 itens). Some quando o addon é desligado.' },
        ],
        sites, accessed,
        local: [
            `Rede: escuta em ${host}:${port}` + (host === '0.0.0.0' ? ' (todas as interfaces: é assim em contêiner; no Docker, o compose publica a porta).' : ' (só este computador; nenhum outro aparelho da rede consegue falar com ele).'),
            'Disco: lê a pasta do programa e escreve só na pasta de dados (veja acima).',
            'Programas: abre o Chromium em segundo plano quando Anna’s Archive, Z-Library ou a confirmação de acesso precisam; roda o instalador do Playwright (com o Node do próprio addon) quando você baixa o navegador.',
            'Permissões no app: ' + permissions.map(p => p === 'service' ? '“service” (o painel conversa só com este addon, pela ponte do app)' : p).join(', ') + '. Recursos: ' + resources.join(', ') + '. Tipos: ' + types.join(', ') + '.',
        ],
        does: DOES, doesNot: DOES_NOT,
        removal: 'Desativar ou remover o addon no app encerra o processo. Para apagar também os dados, apague a pasta de dados indicada acima.',
        note: 'A lista de endereços acessados vale desde que o addon foi ligado e não inclui o que o navegador em segundo plano acessa dentro das páginas.',
    };
}
