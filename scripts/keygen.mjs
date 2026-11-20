// Gera o par de chaves Ed25519 que assina as atualizações. A chave PRIVADA fica fora do repositório (e nunca é exibida);
// a pública (base64) vai para PUBLIC_KEYS em src/update.js.
//   node scripts/keygen.mjs [arquivo-da-chave-privada]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(os.homedir(), '.sleuth-signing', 'update-private.pem'));
const rel = path.relative(repo, out);
if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('A chave privada não pode ficar dentro do repositório.');
if (fs.existsSync(out)) throw new Error(`Já existe uma chave em ${out}. Apague-a de propósito se quiser trocar.`);

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log('Chave privada gravada em:', out);
console.log('Chave pública (cole em PUBLIC_KEYS, src/update.js):');
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
console.log('\nNo GitHub: Settings > Secrets and variables > Actions > New repository secret, nome UPDATE_SIGNING_KEY, valor = conteúdo desse arquivo.');
