# Segurança

Encontrou uma vulnerabilidade? **Não abra uma issue pública.** Use *Security → Report a vulnerability* (relato privado) neste repositório.

## O que vale a pena saber

- **Atualizações assinadas:** o addon só instala pacotes cujo `update.json` tem uma assinatura Ed25519 válida para uma das chaves públicas de `src/update.js`. Isso protege contra arquivos adulterados ou trocados no caminho (CDN, cache, um release editado à mão), **não** contra quem consegue rodar o workflow de release: o secret `UPDATE_SIGNING_KEY` pode ser usado por esse workflow. Por isso ele fica num *Environment* (`release`) com aprovação obrigatória do dono, e quem tem escrita no repositório não publica nada sozinho.
- **Chave comprometida ou perdida:** se a privada vazar, publique uma versão com a chave nova (e a antiga) em `PUBLIC_KEYS`, assinada com a antiga, e só depois revogue o secret. Se a privada for **perdida**, nenhum release novo será aceito e quem já instalou terá de reinstalar o `.maddon` à mão: guarde uma cópia da chave fora do computador.
- **Pacote `.maddon`:** roda como processo comum no computador, com os seus privilégios, como qualquer programa. Baixe só dos Releases deste repositório e confira o `SHA256SUMS`.
- **Rede local:** o serviço escuta só em `127.0.0.1` (pacote) e as buscas só seguem endereços públicos, conferidos a cada redirecionamento.
