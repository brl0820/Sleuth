// Manifest do addon. O CONTRACT é o que o app aprova na instalação (permissões, páginas, recursos): a atualização automática só vale
// enquanto ele não mudar; se mudar, a pessoa precisa instalar o pacote novo.
import crypto from 'node:crypto';
import { ADDON_ID, MIN_HOST_VERSION } from './host.js';

export const CONTRACT = {
    manifest_version: 1,
    id: ADDON_ID,
    host: { min: MIN_HOST_VERSION },
    resources: ['sources'],
    types: ['book', 'audiobook'],
    permissions: ['service'],
    contributes: {
        settings: [{ id: 'painel', title: 'Sleuth', entry: 'ui/painel.html' }],
        pages: [{ id: 'verificar', title: 'Confirmar acesso', subtitle: 'Sleuth', icon: 'shield', navigation: 'none', entry: 'ui/verificar.html' }],
    },
};

export const manifest = (version, extra = {}) => ({
    ...CONTRACT,
    name: 'Sleuth',
    version,
    author: 'Sleuth',
    description: 'Busca livros e audiolivros em vários sites e entrega os links; o app baixa o arquivo direto para o seu aparelho.',
    catalogs: [],
    ...extra,
});

const canonical = v => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}` : JSON.stringify(v));
export const contractHash = () => crypto.createHash('sha256').update(canonical(CONTRACT)).digest('hex');
