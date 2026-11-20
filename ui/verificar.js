// Confirmação de acesso: o addon controla um navegador escondido; esta página mostra o que ele vê (quadros JPEG) e repassa cliques e teclas.
(() => {
    const $ = s => document.querySelector(s);
    const call = (path, body) => Bridge.service(path, body === undefined ? {} : body);
    const say = (text, bad) => { const m = $('#msg'); m.replaceChildren(); if (text) { const d = document.createElement('div'); d.className = bad ? 'err' : 'okmsg'; d.textContent = text; m.append(d); } };
    let site = '', running = false, full = false, area = null, generation = 0;
    const img = document.createElement('img'); img.alt = 'O que o navegador do Sleuth está vendo'; img.draggable = false;

    async function loadSites() {
        let info;
        try { info = await call('verify/sites'); } catch (e) { say(e.message || 'Não consegui falar com o Sleuth', true); return; }
        const box = $('#sites'); box.replaceChildren();
        if (!info.browser.available) {
            const p = document.createElement('p'); p.textContent = info.browser.driver ? 'O navegador do Sleuth ainda não está instalado. Baixe-o uma vez (cerca de 150 MB) para poder confirmar o acesso.' : 'Esta instalação do Sleuth não traz o navegador. Reinstale o pacote mais recente do Sleuth ou use a versão em contêiner (Docker).';
            box.append(p);
            if (info.browser.driver) {
                const b = document.createElement('button'); b.className = 'primary'; b.type = 'button';
                const running = info.browser.installing && info.browser.installing.running;
                b.textContent = running ? 'Baixando… ' + (info.browser.installing.log || '') : 'Baixar o navegador';
                b.disabled = !!running;
                b.addEventListener('click', async () => { b.disabled = true; try { await call('browser/install'); } catch (e) { say(e.message, true); } setTimeout(loadSites, 1500); });
                box.append(b);
                if (running) setTimeout(loadSites, 2500);
            }
            return;
        }
        for (const s of info.sites) {
            const b = document.createElement('button'); b.type = 'button'; b.className = s.needs ? 'primary' : '';
            b.textContent = (s.needs ? 'Confirmar ' : 'Abrir ') + s.name;
            b.addEventListener('click', () => begin(s.id, s.name));
            box.append(b);
        }
        const auto = new URLSearchParams(location.search).get('site');
        if (auto && !running) begin(auto, auto);
    }

    async function begin(id, name) {
        if (running) return;
        say(''); site = id; running = true; generation++;
        const mine = generation;
        $('#sites').hidden = true; $('#done').hidden = true; $('#stage-box').hidden = false;
        $('#stage').replaceChildren(Object.assign(document.createElement('div'), { className: 'wait', textContent: 'Abrindo ' + name + '… isso pode levar alguns segundos.' }));
        try { await call('verify/start', { site: id }); } catch (e) { finish(false, e.message || 'Não consegui abrir o site'); return; }
        let misses = 0;
        while (running && mine === generation) {
            let f;
            try { f = await call('verify/frame', { full }); } catch (e) { if (++misses > 3) { finish(false, e.message || 'A conexão com o Sleuth caiu'); return; } await sleep(800); continue; }
            misses = 0;
            if (f.error) { finish(false, f.error); return; }
            if (f.solved) { finish(true, f.confirmed ? 'Confirmado! O Sleuth lembrou a confirmação.' : 'O site liberou, mas ainda não consegui conferir. Tente buscar de novo.'); return; }
            if (f.closed) { finish(false, 'A página fechou. Abra de novo se precisar.'); return; }
            if (f.open && f.image) {
                area = f.area; img.src = f.image;
                if (!img.parentNode) $('#stage').replaceChildren(img);
                $('#hint').textContent = f.state === 'captcha' ? 'O site mostrou a verificação. Toque na caixa ou na imagem para responder.' : 'Carregando… se nada mudar em alguns segundos, toque na imagem.';
            }
            await sleep(f.open ? 700 : 500);
        }
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function finish(ok, text) {
        running = false; generation++;
        call('verify/stop').catch(() => {});
        $('#stage-box').hidden = true; $('#sites').hidden = false;
        img.remove();
        if (ok) { $('#donetext').textContent = text; $('#done').hidden = false; say(''); } else say(text, true);
        loadSites();
    }

    img.addEventListener('click', e => {
        if (!area) return;
        const r = img.getBoundingClientRect();
        const x = area.x + ((e.clientX - r.left) / r.width) * area.width, y = area.y + ((e.clientY - r.top) / r.height) * area.height;
        call('verify/input', { event: { type: 'click', x: Math.round(x), y: Math.round(y) } }).catch(() => {});
    });
    $('#send').addEventListener('click', () => { const t = $('#typed').value; if (t) call('verify/input', { event: { type: 'type', text: t } }).catch(() => {}); $('#typed').value = ''; });
    $('#typed').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#send').click(); call('verify/input', { event: { type: 'key', key: 'Enter' } }).catch(() => {}); } });
    $('#enter').addEventListener('click', () => call('verify/input', { event: { type: 'key', key: 'Enter' } }).catch(() => {}));
    $('#up').addEventListener('click', () => call('verify/input', { event: { type: 'scroll', dy: -400 } }).catch(() => {}));
    $('#down').addEventListener('click', () => call('verify/input', { event: { type: 'scroll', dy: 400 } }).catch(() => {}));
    $('#full').addEventListener('click', e => { full = !full; e.currentTarget.setAttribute('aria-pressed', String(full)); e.currentTarget.textContent = full ? 'Ver só a verificação' : 'Ver a página inteira'; });
    $('#reload').addEventListener('click', () => call('verify/reload').catch(() => {}));
    $('#cancel').addEventListener('click', () => finish(false, 'Cancelado.'));
    $('#back').addEventListener('click', () => Bridge.home().catch(() => {}));
    loadSites();
})();
