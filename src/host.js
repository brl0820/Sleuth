// Convenções do app que hospeda o addon (protocolo de addons "mlx" v1). Tudo o que depende do app fica aqui.
import path from 'node:path';

export const ADDON_ID = 'sleuth.search';
export const MIN_HOST_VERSION = '3.4.0';

export const DATA_ENV = 'M_LIBRARY_ADDON_DATA';
export const dataDir = () => process.env[DATA_ENV] || process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const runsAsPackage = () => !!process.env[DATA_ENV];
