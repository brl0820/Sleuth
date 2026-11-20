// Ponte entre as páginas do addon (iframe isolado) e o app que as exibe. Protocolo "mlx" v1: mensagens {mlx:1, id, method, params}
// para o app, que responde {mlx:1, id, result|error}. A página não acessa a rede nem o app diretamente.
(() => {
    const ADDON_ID = 'sleuth.search';
    const pending = new Map();
    let seq = 0, lastHeight = 0;

    function applyTheme(ctx) {
        if (!ctx) return;
        const root = document.documentElement;
        root.dataset.theme = ctx.dark ? 'dark' : 'light';
        root.lang = ctx.lang || root.lang;
        for (const [k, v] of Object.entries(ctx.tokens || {})) if (/^--[a-z0-9-]+$/.test(k)) root.style.setProperty(k, String(v).slice(0, 100));
    }

    addEventListener('message', e => {
        const d = e.data;
        if (e.source !== parent || !d || typeof d !== 'object' || d.mlx !== 1) return;
        if (d.event === 'init') return applyTheme(d.data && d.data.context);
        if (d.event === 'theme') return applyTheme(d.data);
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        clearTimeout(p.timer);
        if (d.error) p.reject(Object.assign(new Error(d.error.message || 'Erro'), { code: d.error.code }));
        else p.resolve(d.result);
    });

    function call(method, params = {}, timeout = 20000) {
        return new Promise((resolve, reject) => {
            const id = ++seq;
            const timer = setTimeout(() => {
                pending.delete(id);
                parent.postMessage({ mlx: 1, cancel: id }, '*');
                reject(Object.assign(new Error('Tempo esgotado'), { code: 'timeout' }));
            }, timeout);
            pending.set(id, { resolve, reject, timer });
            parent.postMessage({ mlx: 1, id, method, params }, '*');
        });
    }

    const fit = () => {
        const h = Math.max(240, Math.ceil(document.documentElement.scrollHeight));
        if (Math.abs(h - lastHeight) > 4) { lastHeight = h; call('ui.resize', { height: Math.min(h, 20000) }).catch(() => {}); }
    };
    addEventListener('load', () => { new ResizeObserver(fit).observe(document.body); fit(); parent.postMessage({ mlx: 1, event: 'ready' }, '*'); });

    window.Bridge = {
        service: (path, body) => call('service.call', { path, method: body === undefined ? 'GET' : 'POST', body }),
        open: route => call('navigation.open', { path: route }),
        openPage: page => call('navigation.open', { path: `/x/${ADDON_ID}/${page}` }),
        home: () => call('navigation.open', { path: '/arquivos' }),
    };
})();
