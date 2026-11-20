// Painel do Sleuth. Roda num iframe isolado: tudo passa por Bridge.service → /api/* do addon.
// Texto vindo de fora (nomes de fontes personalizadas, erros, endereços) entra sempre por textContent.
(() => {
    const $ = s => document.querySelector(s);
    const h = (tag, props, ...kids) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
        }
        for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
        return e;
    };
    const call = (path, body) => Bridge.service(path, body);
    let S = null, busy = false, ABOUT = null, aboutBusy = false;
    const say = (text, bad) => { const m = $('#msg'); m.replaceChildren(text ? h('div', { class: bad ? 'err' : 'okmsg', text }) : ''); };
    const secs = ms => (ms / 1000).toFixed(1).replace('.', ',') + ' s';
    const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? 'agora há pouco' : s < 3600 ? `há ${Math.round(s / 60)} min` : s < 86400 ? `há ${Math.round(s / 3600)} h` : `há ${Math.round(s / 86400)} d`; };
    const bytes = n => n >= 1e9 ? (n / 1e9).toFixed(2).replace('.', ',') + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' bytes';
    const KIND = { ebooks: 'Livros', audiobooks: 'Audiolivros' };

    // ── Categorias e espelhos abertos/fechados (o painel se redesenha a cada poucos segundos: o estado fica aqui) ──
    const CATS = { fontes: true, contas: false, navegador: false, atualizacoes: false, sobre: false };
    try { const saved = JSON.parse(localStorage.getItem('sleuth-cats') || '{}'); for (const k of Object.keys(CATS)) if (typeof saved[k] === 'boolean') CATS[k] = saved[k]; } catch { }
    const openMirrors = new Set();
    const saveCats = () => { try { localStorage.setItem('sleuth-cats', JSON.stringify(CATS)); } catch { } };
    function applyCats() {
        for (const sec of document.querySelectorAll('.cat')) {
            const key = sec.dataset.cat, open = !!CATS[key], head = sec.querySelector('.cat-head'), body = sec.querySelector('.cat-body');
            head.setAttribute('aria-expanded', String(open)); body.hidden = !open;
        }
    }
    function setCat(key, open) {
        CATS[key] = open; saveCats(); applyCats(); if (S) top();
        if (open && key === 'sobre') loadAbout();
    }

    async function act(fn) {
        if (busy) return;
        busy = true; say('');
        const prev = S && S.browserInfo;
        try { S = await fn() || S; if (S && !S.browserInfo) S.browserInfo = prev; } catch (e) { say(e.message || 'Algo deu errado', true); }
        busy = false; render();
    }
    function statusOf(src) {
        const t = (S.tests || {})[src.id];
        if (t && t.running) return { cls: 'idle', label: 'Testando…' };
        const r = t && t.result;
        if (r) {
            if (r.status === 'ok' && r.link && !r.link.ok) return { cls: 'bad', label: 'Site no ar, arquivo fora' };
            const map = { ok: ['ok', 'No ar'], verify: ['warn', 'Precisa de confirmação'], unavailable: ['warn', 'Indisponível'], timeout: ['bad', 'Demorou demais'], error: ['bad', 'Com erro'] };
            const [cls, label] = map[r.status] || ['idle', r.status];
            return { cls, label };
        }
        const hh = src.health;
        if (!hh) return { cls: 'idle', label: 'Ainda não testada' };
        const map = { ok: 'ok', verify: 'warn', unavailable: 'warn', timeout: 'bad', error: 'bad' };
        return { cls: map[hh.status] || 'idle', label: hh.label };
    }
    function detail(src) {
        const t = (S.tests || {})[src.id], r = t && t.result;
        if (r) {
            const bits = [];
            if (r.error) bits.push(r.error);
            else if (r.status === 'verify') bits.push('O site pede para provar que você é uma pessoa.');
            else if (r.status === 'unavailable') bits.push('O site não respondeu a esta busca.');
            else if (r.status === 'timeout') bits.push('Passou de 30 s sem responder.');
            else bits.push(`${r.count} resultado${r.count === 1 ? '' : 's'} em ${secs(r.ms)}`);
            if (r.link) {
                const w = r.link.working, c = r.link.checked;
                if (!r.link.ok) bits.push(c ? `nenhum dos ${c} arquivos conferidos chegou: ${r.link.error}` : r.link.error);
                else if (c && w < c) bits.push(`${w} de ${c} arquivos conferidos chegam (${r.link.error})`);
                else bits.push(c > 1 ? `${c} arquivos conferidos, todos chegam` : 'arquivo conferido, chega');
            }
            return bits.join(' · ') + ' · ' + ago(t.at);
        }
        if (src.health) return `Última busca: ${src.health.label.toLowerCase()} · ${secs(src.health.ms)} · ${ago(src.health.at)}`;
        if (src.id === 'zlibrary' && !S.creds.zlibrary) return 'Sem conta, o Z-Library mostra os livros, mas não entrega o arquivo. Configure a sua conta em Contas e acessos para baixar.';
        return src.account === 'exige' ? 'Só funciona com a sua conta (veja Contas e acessos).' : '';
    }

    // ── Espelhos de uma fonte: recolhido por padrão ──
    const mkey = (service, origin) => service + '|' + origin;
    function mirrorStatus(service, m) {
        const t = (S.mirrorTests || {})[mkey(service, m.origin)], r = t && t.result;
        if (t && t.running) return { cls: 'idle', label: 'Testando…', note: '' };
        if (r) {
            const note = ago(t.at);
            if (r.status === 'ok') return { cls: 'ok', label: 'Funcionando · ' + secs(r.ms), note };
            if (r.status === 'verify') return { cls: 'warn', label: 'Pede confirmação', note: 'O site responde, mas quer provar que você é uma pessoa (use “Confirmar acesso”). ' + note };
            if (r.status === 'timeout') return { cls: 'bad', label: 'Demorou demais', note: 'Sem resposta em 12 s. ' + note };
            return { cls: 'bad', label: 'Não funciona', note: (r.error || 'Erro') + ' · ' + note };
        }
        if (m.cooling) return { cls: 'warn', label: 'Em pausa por falhas', note: m.lastFailure ? 'Último erro: ' + m.lastFailure : '' };
        if (m.avgMs != null) return { cls: 'ok', label: m.avgMs + ' ms', note: 'Média das últimas buscas' };
        return { cls: 'idle', label: 'Ainda não testado', note: '' };
    }
    const runMirrorTests = (service, list) => act(async () => { for (const m of list) await call('mirrors/test', { service, origin: m.origin }).catch(() => {}); return call('state'); });

    function mirrorPanel(src) {
        const service = src.id, list = (S.mirrors || {})[service];
        if (!list) return null;
        const isOpen = openMirrors.has(service), mine = list.filter(m => m.user);
        const anyRunning = list.some(m => ((S.mirrorTests || {})[mkey(service, m.origin)] || {}).running);
        let body = null;
        const toggle = h('button', { type: 'button', class: 'sub-toggle', 'aria-expanded': String(isOpen), 'aria-controls': 'mir-' + service, onclick: () => { const open = !openMirrors.has(service); if (open) openMirrors.add(service); else openMirrors.delete(service); toggle.setAttribute('aria-expanded', String(open)); body.hidden = !open; } },
            h('span', { class: 'chev', 'aria-hidden': 'true' }), `Espelhos (${list.length}${mine.length ? `, ${mine.length} seu${mine.length > 1 ? 's' : ''}` : ''})`);
        const input = h('input', { type: 'text', placeholder: 'novo endereço, ex.: ' + (service === 'libgen' ? 'libgen.example' : 'espelho.example'), 'aria-label': 'Novo espelho de ' + src.name, maxlength: 200 });
        const add = () => {
            const before = new Set(list.map(m => m.origin));
            act(async () => {
                if (!input.value.trim()) throw new Error('Digite o endereço do espelho');
                const r = await call('mirrors', { service, list: [...mine.map(m => m.origin), input.value] });
                for (const m of (r.mirrors[service] || []).filter(m => !before.has(m.origin))) await call('mirrors/test', { service, origin: m.origin }).catch(() => {});
                say('Espelho adicionado. Ele passa a ser tentado antes dos endereços padrão.');
                return call('state');
            });
        };
        body = h('div', { class: 'mirbox', id: 'mir-' + service, hidden: !isOpen },
            h('p', { class: 'help', text: src.builtin ? 'Endereços alternativos deste site. Os seus são tentados primeiro; se nenhum responder, o Sleuth usa os padrão. “Testar” faz uma busca de verdade no endereço.' : 'Outros domínios do mesmo catálogo (o Sleuth usa o mesmo caminho do endereço da fonte). Os seus são tentados primeiro; se nenhum responder, vale o endereço da fonte. “Testar” confere se o endereço entrega o catálogo.' }),
            h('ul', { class: 'plain' }, ...list.map(m => {
                const st = mirrorStatus(service, m), running = ((S.mirrorTests || {})[mkey(service, m.origin)] || {}).running;
                return h('li', { class: 'mir' },
                    h('span', { class: 'grow', text: m.host }),
                    h('span', { class: 'tag', text: m.user ? 'seu' : src.builtin ? 'padrão' : 'endereço da fonte' }),
                    h('span', { class: 'pill ' + st.cls, text: st.label }),
                    h('button', { class: 'small', disabled: running || busy, onclick: () => runMirrorTests(service, [m]) }, running ? 'Testando…' : 'Testar'),
                    m.user ? h('button', { class: 'link', disabled: busy, onclick: () => act(() => call('mirrors', { service, list: mine.filter(x => x.origin !== m.origin).map(x => x.origin) })) }, 'Remover') : null,
                    st.note ? h('span', { class: 'sub', text: st.note }) : null);
            })),
            h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'grow' }, input),
                h('button', { disabled: busy, onclick: add }, 'Adicionar'),
                h('button', { disabled: busy || anyRunning, onclick: () => runMirrorTests(service, list) }, anyRunning ? 'Testando…' : 'Testar todos')));
        return h('div', {}, toggle, body);
    }

    // ── Alternativas de download (à parte dos espelhos: espelho serve para PROCURAR; isto é outro caminho para BAIXAR o arquivo) ──
    const openDownloads = new Set();
    const dkey = (service, tpl) => service + '|' + tpl;
    function downloadState(service, d) {
        const t = (S.downloadTests || {})[dkey(service, d.template)], r = t && t.result;
        if (t && t.running) return { cls: 'idle', label: 'Testando…', note: '' };
        if (r) {
            const note = ago(t.at);
            if (r.status === 'ok') return { cls: 'ok', label: 'Entrega o arquivo · ' + secs(r.ms), note: 'Respondeu pelo servidor ' + (r.host || d.host) + '. ' + note };
            if (r.status === 'timeout') return { cls: 'bad', label: 'Demorou demais', note: 'Sem resposta em 15 s. ' + note };
            return { cls: 'bad', label: 'Não entrega', note: (r.error || 'Erro') + ' · ' + note };
        }
        if (d.cooling) return { cls: 'warn', label: 'Em pausa por falhas', note: d.lastFailure ? 'Último erro: ' + d.lastFailure : '' };
        if (d.avgMs != null) return { cls: 'ok', label: d.avgMs + ' ms', note: 'Média dos últimos downloads' };
        return { cls: 'idle', label: 'Ainda não testada', note: '' };
    }
    const runDownloadTests = (service, list) => act(async () => { for (const d of list) await call('downloads/test', { service, template: d.template }).catch(() => {}); return call('state'); });

    function dlHelp(service) {
        if (service === 'libgen' || service === 'annas') {
            return 'Os espelhos servem para procurar o livro. Aqui ficam outros caminhos para baixar o arquivo, usados quando o link normal falha (todos os espelhos entregam o arquivo pelo mesmo servidor, então trocar de espelho não resolve). '
                + (service === 'annas' ? 'O Anna’s Archive também usa as do Library Genesis. ' : 'Valem também para o Anna’s Archive. ')
                + 'Digite só o servidor ou o endereço completo com {md5} no lugar do código do livro. “Testar” baixa o primeiro KB de um livro de exemplo.';
        }
        return 'Outros servidores que entregam o mesmo arquivo, usados quando o link desta fonte falha. Digite só o servidor (o Sleuth usa o mesmo caminho do link que falhou) '
            + 'ou um endereço completo com {path} (caminho), {file} (nome do arquivo), {url} ou {urlenc} (o link que falhou, puro ou codificado)'
            + (service === 'archive' ? ' ou {identifier} (código do Internet Archive)' : '')
            + '. “Testar” usa um livro de exemplo desta fonte.';
    }

    function downloadPanel(src) {
        const service = src.id, list = (S.downloads || {})[service];
        if (!list) return null;
        const isOpen = openDownloads.has(service), mine = list.filter(d => d.user), md5Svc = service === 'libgen' || service === 'annas';
        const anyRunning = list.some(d => ((S.downloadTests || {})[dkey(service, d.template)] || {}).running);
        let body = null;
        const toggle = h('button', { type: 'button', class: 'sub-toggle', 'aria-expanded': String(isOpen), 'aria-controls': 'dl-' + service, onclick: () => { const open = !openDownloads.has(service); if (open) openDownloads.add(service); else openDownloads.delete(service); toggle.setAttribute('aria-expanded', String(open)); body.hidden = !open; } },
            h('span', { class: 'chev', 'aria-hidden': 'true' }), `Alternativas de download (${list.length}${mine.length ? `, ${mine.length} sua${mine.length > 1 ? 's' : ''}` : ''})`);
        const input = h('input', { type: 'text', placeholder: md5Svc ? 'servidor (libgen.download) ou https://…/baixar?id={md5}' : 'servidor (outro-site.org) ou https://…{path}', 'aria-label': 'Nova alternativa de download', maxlength: 300 });
        const add = () => {
            const before = new Set(list.map(d => d.template));
            act(async () => {
                if (!input.value.trim()) throw new Error('Digite o servidor ou o endereço da alternativa');
                const r = await call('downloads', { service, list: [...mine.map(d => d.template), input.value] });
                for (const d of (r.downloads[service] || []).filter(d => !before.has(d.template))) await call('downloads/test', { service, template: d.template }).catch(() => {});
                say('Alternativa adicionada. Ela entra quando o link normal de download falha.');
                return call('state');
            });
        };
        body = h('div', { class: 'mirbox', id: 'dl-' + service, hidden: !isOpen },
            h('p', { class: 'help', text: dlHelp(service) }),
            list.length ? null : h('p', { class: 'sub', text: 'Nenhuma alternativa ainda. Adicione um servidor que também tenha os arquivos desta fonte.' }),
            h('ul', { class: 'plain' }, ...list.map(d => {
                const st = downloadState(service, d), running = ((S.downloadTests || {})[dkey(service, d.template)] || {}).running;
                return h('li', { class: 'mir' },
                    h('span', { class: 'grow', text: d.host }),
                    h('span', { class: 'tag', text: d.user ? 'sua' : 'padrão' }),
                    h('span', { class: 'pill ' + st.cls, text: st.label }),
                    h('button', { class: 'small', disabled: running || busy, onclick: () => runDownloadTests(service, [d]) }, running ? 'Testando…' : 'Testar'),
                    d.user ? h('button', { class: 'link', disabled: busy, onclick: () => act(() => call('downloads', { service, list: mine.filter(x => x.template !== d.template).map(x => x.template) })) }, 'Remover') : null,
                    h('span', { class: 'sub', text: d.template.replace(/^https:\/\//, '') + (st.note ? ' · ' + st.note : '') }));
            })),
            h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'grow' }, input),
                h('button', { disabled: busy, onclick: add }, 'Adicionar'),
                h('button', { disabled: busy || anyRunning || !list.length, onclick: () => runDownloadTests(service, list) }, anyRunning ? 'Testando…' : 'Testar todas')));
        return h('div', {}, toggle, body);
    }

    function sourceRow(src) {
        const st = statusOf(src), running = ((S.tests || {})[src.id] || {}).running;
        const needs = (S.tests || {})[src.id]?.result?.status === 'verify' || (src.health && src.health.status === 'verify');
        return h('li', { class: 'card' },
            h('div', { class: 'row' },
                h('label', { class: 'sw', title: src.enabled ? 'Desligar ' + src.name : 'Ligar ' + src.name },
                    h('input', { type: 'checkbox', checked: src.enabled, 'aria-label': src.name, onchange: e => act(() => call('toggle', { id: src.id, enabled: e.target.checked })) }), h('span')),
                h('div', { class: 'grow' },
                    h('div', { class: 'name' }, src.name, ...src.kinds.map(k => h('span', { class: 'tag', text: KIND[k] || k })), src.account === 'exige' ? h('span', { class: 'tag', text: 'exige conta' }) : null),
                    h('div', { class: 'sub', text: detail(src) })),
                h('span', { class: 'pill ' + st.cls, text: st.label }),
                needs ? h('button', { class: 'primary', onclick: () => Bridge.openPage('verificar') }, 'Confirmar acesso') : null,
                h('button', { disabled: running || !src.enabled, onclick: () => act(async () => { await call('test', { id: src.id }); return call('state'); }) }, running ? 'Testando…' : 'Testar'),
                src.builtin ? null : h('button', { class: 'danger', onclick: () => confirmRemove(src) }, 'Remover')),
            mirrorPanel(src), downloadPanel(src));
    }
    function confirmRemove(src) { if (confirmed === src.id) { confirmed = ''; act(() => call('custom/remove', { id: src.id })); } else { confirmed = src.id; say(`Toque em Remover de novo para tirar “${src.name}”.`, true); } }
    let confirmed = '';

    function top() {
        const all = [...S.sources, ...S.custom].filter(s => s.enabled);
        const allOpen = Object.values(CATS).every(Boolean);
        $('#top').replaceChildren(
            h('button', { class: 'primary', disabled: !all.length || busy, onclick: () => act(async () => { for (const s of all) await call('test', { id: s.id }).catch(() => {}); return call('state'); }) }, 'Testar todas as fontes ligadas'),
            h('button', { type: 'button', onclick: () => { for (const k of Object.keys(CATS)) CATS[k] = !allOpen; saveCats(); applyCats(); top(); if (!allOpen) loadAbout(); } }, allOpen ? 'Recolher tudo' : 'Expandir tudo'),
            h('span', { class: 'sub', text: `Versão ${S.version}` }));
    }

    function addForm() {
        const name = h('input', { type: 'text', id: 'cname', maxlength: 40, placeholder: 'Nome (ex.: Minha biblioteca)', 'aria-label': 'Nome da fonte' });
        const url = h('input', { type: 'url', id: 'curl', maxlength: 500, placeholder: 'https://…/opds', 'aria-label': 'Endereço do catálogo' });
        $('#add').replaceChildren(
            h('p', { text: 'Catálogos no padrão OPDS (versões 1 e 2) que entregam o arquivo direto. Informe o endereço do catálogo; o Sleuth descobre a busca sozinho. Só endereços públicos (https).' }),
            h('label', { class: 'field' }, 'Nome', name), h('label', { class: 'field' }, 'Endereço do catálogo', url),
            h('button', { class: 'primary', disabled: busy, onclick: () => act(async () => { const r = await call('custom/add', { name: name.value, url: url.value }); say('Fonte adicionada. Use “Testar” para ver se ela responde.'); return r; }) }, busy ? 'Conferindo…' : 'Adicionar'));
    }

    function slumView() {
        $('#slum').replaceChildren(
            h('div', { class: 'card row' },
                h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: S.slum.on, 'aria-label': 'Monitor de espelhos', onchange: e => act(() => call('slum', { on: e.target.checked })) }), h('span')),
                h('div', { class: 'grow' }, h('div', { class: 'name', text: 'Monitor de espelhos (SLUM)' }),
                    h('div', { class: 'sub', text: S.slum.error ? 'Sem acesso ao monitor: ' + S.slum.error : 'Prioriza os endereços que o open-slum.org mostra no ar (vale para Library Genesis, Anna’s Archive e Z-Library).' }))));
    }

    function credsView() {
        const box = (title, has, fields, keys) => {
            const inputs = fields.map(([key, label, type]) => h('label', { class: 'field' }, label, h('input', { type, autocomplete: 'off', 'data-k': key, placeholder: has ? '•••••• (já configurado)' : '' })));
            const save = () => act(() => { const body = {}; for (const i of box_inputs(inputs)) if (i.value.trim()) body[i.dataset.k] = i.value.trim(); if (!Object.keys(body).length) throw new Error('Preencha os campos para salvar'); return call('creds', body); });
            const clear = () => act(() => call('creds', Object.fromEntries(keys.map(k => [k, '']))));
            return h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'name grow', text: title }), h('span', { class: 'pill ' + (has ? 'ok' : 'idle'), text: has ? 'Configurado' : 'Sem conta' })),
                ...inputs, h('div', { class: 'row' }, h('button', { disabled: busy, onclick: save }, 'Salvar'), has ? h('button', { class: 'danger', disabled: busy, onclick: clear }, 'Remover') : null));
        };
        const box_inputs = inputs => inputs.map(l => l.querySelector('input'));
        $('#creds').replaceChildren(
            box('Z-Library', S.creds.zlibrary, [['zlib_email', 'E-mail', 'text'], ['zlib_password', 'Senha', 'password']], ['zlib_email', 'zlib_password']),
            box('Mobilism (precisa para a fonte funcionar)', S.creds.mobilism, [['mobilism_user', 'Usuário', 'text'], ['mobilism_pass', 'Senha', 'password']], ['mobilism_user', 'mobilism_pass']),
            box("Anna's Archive (cookie, avançado)", S.creds.annas, [['annas_cookie', 'Cookie copiado do seu navegador', 'password']], ['annas_cookie']));
    }

    function browserView(b) {
        const el = $('#browser');
        if (!b) { el.replaceChildren(h('div', { class: 'sub', text: 'Verificando…' })); return; }
        const inst = b.installing;
        let pill, text, actions = [];
        if (b.available) { pill = ['ok', 'Instalado']; text = 'O navegador está pronto. ' + (b.sandboxed === false ? 'Rodando sem a proteção extra do sistema (normal em contêiner).' : ''); actions = [h('button', { disabled: busy, onclick: () => act(async () => { await call('browser/restart'); S.browserInfo = await call('browser'); return S; }) }, 'Reiniciar navegador')]; }
        else if (!b.driver) { pill = ['warn', 'Indisponível']; text = 'Esta instalação do Sleuth não traz o componente do navegador. Reinstale o pacote mais recente do Sleuth, ou use a versão em contêiner (Docker).'; }
        else if (inst && inst.running) { pill = ['idle', 'Baixando…']; text = 'Baixando o navegador (cerca de 150 MB). Pode levar alguns minutos. ' + (inst.log || ''); }
        else { pill = ['warn', 'Não instalado']; text = (inst && inst.error ? 'A instalação falhou: ' + inst.error + '. ' : '') + 'Sem ele, Anna’s Archive e Z-Library não funcionam. O download vem do servidor da Microsoft (Playwright) e acontece uma vez.'; actions = [h('button', { class: 'primary', disabled: busy, onclick: () => act(async () => { S.browserInfo = await call('browser/install'); return S; }) }, 'Baixar o navegador')]; }
        el.replaceChildren(h('div', { class: 'row' }, h('div', { class: 'name grow', text: 'Chromium em segundo plano' }), h('span', { class: 'pill ' + pill[0], text: pill[1] })), h('div', { class: 'sub', text }), h('div', { class: 'row', style: 'margin-top:8px' }, ...actions));
        return pill[1];
    }

    // ── Atualizações (Releases do GitHub) ──
    let confirmRollback = false;
    function updateView() {
        const u = S.update, el = $('#update');
        if (!u) { el.replaceChildren(); return; }
        const repoInput = h('input', { type: 'text', value: u.repo, maxlength: 140, 'aria-label': 'Repositório das atualizações (dono/nome)' });
        const kids = [
            h('div', { class: 'row' },
                h('label', { class: 'sw', title: 'Atualizar automaticamente' },
                    h('input', { type: 'checkbox', checked: u.auto, disabled: !u.enabled, 'aria-label': 'Atualizar automaticamente', onchange: e => act(() => call('update/auto', { on: e.target.checked })) }), h('span')),
                h('div', { class: 'grow' }, h('div', { class: 'name', text: 'Atualizar automaticamente' }),
                    h('div', { class: 'sub', text: u.auto ? 'A cada 6 horas o Sleuth confere os Releases do GitHub e instala versões novas assinadas, sem perguntar.' : 'Desligado: o Sleuth só confere quando você pedir.' })),
                h('span', { class: 'pill idle', text: 'Versão ' + u.running })),
        ];
        if (!u.enabled) kids.push(h('div', { class: 'sub', text: 'As atualizações estão desligadas neste modo de execução (o addon não foi iniciado pelo launcher, ou SLEUTH_UPDATES=0).' }));
        if (u.checking) kids.push(h('div', { class: 'sub', text: 'Verificando…' }));
        else if (u.lastCheckAt) kids.push(h('div', { class: 'sub', text: 'Última verificação: ' + ago(u.lastCheckAt) }));
        if (u.lastError) kids.push(h('div', { class: 'err', text: u.lastError }));
        if (u.blocked) kids.push(h('div', { class: 'err', text: u.blocked }));
        if (u.available) kids.push(h('div', { class: 'okmsg', text: `Nova versão ${u.available.version} disponível.` + (u.auto ? ' Instalando…' : '') }), u.available.notes ? h('div', { class: 'sub', text: u.available.notes }) : null);
        if (u.pending) kids.push(h('div', { class: 'okmsg', text: `Versão ${u.pending} instalada. ` + (u.supervised ? 'O addon reinicia sozinho quando estiver ocioso.' : 'Reinicie o addon para aplicar.') }));
        kids.push(h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', { class: 'primary', disabled: busy || !u.enabled || u.checking, onclick: () => act(() => call('update/check', { install: !u.auto })) }, u.checking ? 'Verificando…' : (u.auto ? 'Verificar agora' : 'Verificar e instalar')),
            u.canRollback ? h('button', { class: 'danger', disabled: busy, onclick: () => { if (confirmRollback) { confirmRollback = false; act(() => call('update/rollback')); } else { confirmRollback = true; say('Toque em “Voltar à versão anterior” de novo para confirmar. A versão atual não será reinstalada sozinha.', true); } } }, 'Voltar à versão anterior') : null));
        kids.push(h('div', { class: 'row', style: 'margin-top:8px' },
            h('label', { class: 'field grow' }, 'Origem das atualizações (GitHub, dono/nome)', repoInput),
            h('button', { disabled: busy, onclick: () => act(() => call('update/repo', { repo: repoInput.value })) }, 'Salvar origem')));
        if (u.history.length) kids.push(h('div', { class: 'sub', text: 'Instaladas: ' + u.history.map(x => `${x.version} (${ago(x.at)})`).join(' · ') }));
        el.replaceChildren(...kids);
    }

    // ── Sobre o addon ──
    async function loadAbout() {
        if (aboutBusy) return;
        aboutBusy = true; renderAbout();
        try { ABOUT = await call('about'); ABOUT.error = ''; } catch (e) { ABOUT = { ...(ABOUT || {}), error: e.message || 'Não consegui ler as informações do addon' }; }
        aboutBusy = false; renderAbout();
    }
    function renderAbout() {
        const el = $('#about'), A = ABOUT;
        const refresh = h('button', { type: 'button', class: 'small', disabled: aboutBusy, onclick: loadAbout }, aboutBusy ? 'Lendo…' : 'Atualizar');
        if (!A || (!A.version && A.error)) { el.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'sub', text: A && A.error ? A.error : 'Lendo as informações…' }), refresh)); return; }
        const list = items => h('ul', { class: 'bullets' }, ...items.map(t => h('li', { text: t })));
        const R = A.runtime;
        el.replaceChildren(
            ...(A.error ? [h('div', { class: 'err', text: A.error })] : []),
            h('div', { class: 'card' },
                h('div', { class: 'row' }, h('div', { class: 'name grow', text: `${A.name} ${A.version}` }), refresh),
                h('div', { class: 'sub', text: A.description }),
                h('div', { class: 'sub', text: `Identificador: ${A.id} · Autor: ${A.author}` }),
                h('div', { class: 'sub', text: `${R.mode} · Node ${R.node} · ${R.platform} · processo ${R.pid} · ligado há ${R.uptime < 3600 ? Math.max(1, Math.round(R.uptime / 60)) + ' min' : Math.round(R.uptime / 3600) + ' h'}` })),

            h('h3', { text: 'O que ele faz' }), list(A.does),
            h('h3', { text: 'O que ele não faz' }), list(A.doesNot),

            h('h3', { text: 'Onde estão os arquivos dele' }),
            h('div', { class: 'card' }, ...A.paths.map(p => h('div', { class: 'kv' },
                h('div', { class: 'name', text: p.label }),
                h('div', { class: 'path', text: p.path }),
                h('div', { class: 'sub', text: p.what }),
                h('div', { class: 'sub', text: p.exists ? `${bytes(p.bytes)} · ${p.files} arquivo${p.files === 1 ? '' : 's'}${p.partial ? ' (contagem parcial: a pasta é grande)' : ''}` : 'Ainda não existe' })))),

            h('h3', { text: 'O que ele já baixou' }),
            h('div', { class: 'card' }, ...A.downloaded.map(d => h('div', { class: 'kv' },
                h('div', { class: 'row' }, h('span', { class: 'name', text: d.what }), h('span', { class: 'pill ' + (d.state === 'Baixado' ? 'ok' : 'idle'), text: d.state + (d.bytes ? ' · ' + bytes(d.bytes) : '') })),
                h('div', { class: 'sub', text: d.note + (d.at ? ' Última alteração: ' + ago(d.at) + '.' : '') })))),

            h('h3', { text: 'Com quem ele pode falar (sites das fontes)' }),
            h('div', { class: 'card' }, ...A.sites.map(s => h('div', { class: 'hostline' },
                h('span', { class: 'name', text: s.label }), h('span', { class: 'pill ' + (s.on ? 'ok' : 'idle'), text: s.on ? 'ligada' : 'desligada' }),
                ...s.hosts.map(x => h('span', { class: 'h', text: x })), ...s.mine.map(x => h('span', { class: 'h', text: x + ' (seu)' }))))),
            h('p', { text: 'Fora os sites acima, ele só fala com open-slum.org (monitor de espelhos), itorrents.org/.net (arquivos .torrent), com o servidor de download do Playwright (ao baixar o navegador) e com os servidores onde os arquivos estão de fato (ao conferir um link).' }),

            h('h3', { text: `Endereços que ele acessou desde que foi ligado (${A.accessed.length})` }),
            h('div', { class: 'card' }, ...(A.accessed.length ? A.accessed.map(a => h('div', { class: 'hostline' },
                h('span', { class: 'h', text: a.host }),
                h('span', { class: 'sub', text: `${a.count} acesso${a.count === 1 ? '' : 's'}${a.fails ? `, ${a.fails} com falha` : ''} · último: ${a.last} · ${ago(a.at)}` }),
                h('span', { class: 'sub', style: 'flex-basis:100%', text: a.why }))) : [h('div', { class: 'sub', text: 'Nenhum acesso ainda. Faça uma busca ou um teste.' })])),
            h('p', { text: A.note }),

            h('h3', { text: 'O que ele usa no seu computador' }), list(A.local),
            h('h3', { text: 'Como remover' }), h('p', { text: A.removal }));
    }

    function summaries(browserPill) {
        const all = [...S.sources, ...S.custom], on = all.filter(s => s.enabled).length;
        const set = (id, t) => { const e = $('#sum-' + id); if (e) e.textContent = t; };
        set('fontes', `${on} de ${all.length} ligadas`);
        const n = ['zlibrary', 'mobilism', 'annas'].filter(k => S.creds[k]).length;
        set('contas', n ? `${n} de 3 configurada${n > 1 ? 's' : ''}` : 'nenhuma conta');
        if (browserPill) set('navegador', browserPill);
        const u = S.update;
        set('atualizacoes', !u || !u.enabled ? 'desligadas' : u.pending ? 'reinicie para aplicar' : u.available ? 'nova versão ' + u.available.version : u.auto ? 'automáticas' : 'manuais');
        set('sobre', 'versão ' + S.version);
    }

    function render() {
        if (!S) return;
        const active = document.activeElement;
        if (active && active.tagName === 'INPUT' && active.type !== 'checkbox' && active.value) { if (!busy) return; }
        top();
        $('#sources').replaceChildren(...[...S.sources, ...S.custom].map(sourceRow));
        addForm(); slumView(); credsView(); updateView(); summaries(browserView(S.browserInfo));
    }

    async function start() {
        for (const head of document.querySelectorAll('.cat-head')) head.addEventListener('click', () => { const key = head.closest('.cat').dataset.cat; setCat(key, !CATS[key]); });
        applyCats();
        try { S = await call('state'); S.browserInfo = await call('browser'); render(); if (CATS.sobre) loadAbout(); } catch (e) { say(e.message || 'Não consegui falar com o Sleuth', true); }
        setInterval(async () => { if (!S || busy) return; try { const b = await call('browser'); S.browserInfo = b; const st = await call('state'); st.browserInfo = b; S = st; if (!(document.activeElement && document.activeElement.tagName === 'INPUT')) render(); } catch { } }, 2500);
    }
    start();
})();
