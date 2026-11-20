// Servidor HTTP mínimo do addon (sem dependências). Rotas: /manifest.json, /configure, /ui/*, /health e /c/<config>/... (as mesmas
// rotas com a configuração do usuário no endereço, em JSON base64url de até 8 KB).
import http from 'node:http';
import fs from 'node:fs';
import nodePath from 'node:path';

const UI_TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', woff2: 'font/woff2', json: 'application/json; charset=utf-8' };
const UI_PATH = /^\/ui\/((?:[a-z0-9_-]+\/)*[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(html|js|css|svg|png|jpg|webp|woff2|json))$/;
export function serveUi(uiDir, path, res) {
    const m = UI_PATH.exec(path);
    if (!m || path.includes('..')) return false;
    const file = nodePath.resolve(uiDir, m[1]);
    if (!file.startsWith(nodePath.resolve(uiDir) + nodePath.sep)) return false;
    let buf; try { buf = fs.readFileSync(file); } catch (e) { return false; }
    res.writeHead(200, { 'Content-Type': UI_TYPES[m[2]], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }).end(buf);
    return true;
}

export const encodeConfig = value => Buffer.from(JSON.stringify(value || {})).toString('base64url');
export function decodeConfig(text) {
    if (!text) return {};
    try { if (text.length > 8192) return {}; const v = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function json(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body));
}
export const readJson = (req, max = 65536) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > max) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
});

export function configurePage({ title, description, fields, config, internalUrl, notes = '' }) {
    const data = JSON.stringify({ fields, config, internalUrl }).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--bg:#fff3e0;--ink:#30291f;--mut:#65594b;--acc:#1e5a4c;--card:#fff;--line:#e4d8c3}@media(prefers-color-scheme:dark){:root{--bg:#211d19;--ink:#fff3df;--mut:#d0c1aa;--acc:#8dd4bd;--card:#2d2721;--line:#5d5041}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:32px 20px 64px}h1{margin:0 0 6px;font-size:30px}p{color:var(--mut)}
fieldset{border:1px solid var(--line);border-radius:12px;background:var(--card);margin:18px 0;padding:14px 18px}legend{font-weight:650;padding:0 6px}label{display:block;margin:8px 0}.opt{display:flex;gap:10px;align-items:center;min-height:36px}
select,option{background:var(--card);color:var(--ink)}select{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:inherit}h2.grp{margin:34px 0 -6px;font-size:20px}input[type=number],input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:inherit}.help{font-size:13px;color:var(--mut)}
.out{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;word-break:break-all;font:14px ui-monospace,monospace}button{padding:10px 18px;border-radius:8px;border:0;background:var(--acc);color:var(--bg);font:inherit;font-weight:650;cursor:pointer}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(description)}</p><form id="f"></form>${notes}
<h2>Endereço para instalar</h2><p>Copie este endereço e cole em <b>Addons → Instalar</b> no app. Para mudar a configuração, gere outro endereço e instale de novo.</p>
<div class="out" id="out"></div><p><button id="copy" type="button">Copiar endereço</button></p></main>
<script type="application/json" id="d">${data}</script><script>
const d=JSON.parse(document.getElementById('d').textContent),f=document.getElementById('f'),out=document.getElementById('out');
const cur=d.config||{};
let grp='';for(const x of d.fields){if(x.group&&x.group!==grp){grp=x.group;const h=document.createElement('h2');h.className='grp';h.textContent=grp;f.append(h)}const fs=document.createElement('fieldset');fs.innerHTML='<legend></legend>';fs.firstChild.textContent=x.label;
 if(x.type==='checks'){const sel=new Set(cur[x.name]||x.options.filter(o=>o.default!==false).map(o=>o.value));for(const o of x.options){const l=document.createElement('label');l.className='opt';const i=document.createElement('input');i.type='checkbox';i.dataset.f=x.name;i.value=o.value;i.checked=sel.has(o.value);i.dataset.labels=o.labels?JSON.stringify(o.labels):'';const sp=document.createElement('span');sp.textContent=o.label;l.append(i,sp);fs.append(l)}}
 else if(x.type==='select'){const sel=document.createElement('select');sel.dataset.f=x.name;for(const o of x.options){const e=document.createElement('option');e.value=o.value;e.textContent=o.label;sel.append(e)}sel.value=cur[x.name]||x.options[0].value;fs.append(sel)}
 else if(x.type==='toggle'){const l=document.createElement('label');l.className='opt';const i=document.createElement('input');i.type='checkbox';i.dataset.f=x.name;i.dataset.t='toggle';i.checked=cur[x.name]!==undefined?!!cur[x.name]:x.default!==false;l.append(i,document.createTextNode(x.help||''));fs.append(l)}
 else{const i=document.createElement('input');i.type=x.type==='password'?'password':x.type==='number'?'number':'text';if(x.type==='number'){if(x.min!==undefined)i.min=x.min;if(x.max!==undefined)i.max=x.max;i.step=1}i.dataset.f=x.name;i.value=cur[x.name]||'';i.autocomplete='off';fs.append(i)}
 if(x.help&&x.type!=='toggle'){const h=document.createElement('div');h.className='help';h.textContent=x.help;fs.append(h)} f.append(fs)}
function build(){const c={};for(const el of f.querySelectorAll('[data-f]')){const n=el.dataset.f;if(el.type==='checkbox'&&el.dataset.t==='toggle')c[n]=el.checked;else if(el.type==='checkbox'){(c[n]=c[n]||[]);if(el.checked)c[n].push(el.value)}else if(el.type==='number'){if(el.value!=='')c[n]=Number(el.value)}else if(el.value.trim())c[n]=el.value.trim()}
 const b=btoa(unescape(encodeURIComponent(JSON.stringify(c)))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');out.textContent=d.internalUrl+'/c/'+b+'/manifest.json'}
function relabel(){const sel=f.querySelector('select[data-f=language]');const lang=sel&&sel.value==='en'?'en':'pt';for(const i of f.querySelectorAll('input[data-labels]')){if(!i.dataset.labels)continue;const l=JSON.parse(i.dataset.labels);if(l[lang])i.nextSibling.textContent=l[lang]}}
f.addEventListener('input',build);f.addEventListener('change',()=>{relabel();build()});relabel();build();
document.getElementById('copy').onclick=()=>navigator.clipboard.writeText(out.textContent).then(()=>{document.getElementById('copy').textContent='Copiado'});
</script></body></html>`;
}

export function startAddon(addon) {
    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }).end(); return; }
            const url = new URL(req.url, 'http://addon');
            let path = url.pathname, config = {};
            const m = /^\/c\/([A-Za-z0-9_-]{0,8192})(\/.*)$/.exec(path);
            if (m) { config = decodeConfig(m[1]); path = m[2]; }
            if (path === '/health') { res.writeHead(200).end('ok'); return; }
            if (path === '/manifest.json') return json(res, 200, await addon.manifest(config));
            if (addon.uiDir && path.startsWith('/ui/') && req.method === 'GET') { if (serveUi(addon.uiDir, path, res)) return; return json(res, 404, { error: 'Not found' }); }
            if (path === '/configure') { const html = await addon.configure(config); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html); return; }
            if (await addon.handle({ req, res, url, path, config, query: url.searchParams })) return;
            json(res, 404, { error: 'Not found' });
        } catch (e) { if (!res.headersSent) json(res, 500, { error: String(e && e.message || e) }); else res.end(); }
    });
    const host = process.env.HOST || '0.0.0.0';
    server.listen(addon.port, host, () => console.log(`${addon.name || 'addon'} listening on ${host}:${addon.port}`));
    return server;
}
