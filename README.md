# Sleuth

Addon que **busca livros e audiolivros** em vários sites e entrega os links; quem baixa o arquivo é o app, direto para o seu aparelho (o Sleuth nunca guarda nem repassa o arquivo).

- **Fontes:** Library Genesis, Anna's Archive, Z-Library, Internet Archive, Project Gutenberg, OpenStax, LibreTexts, Memory of the World, RoyalLib, Mobilism, AudiobookBay, LibriVox, AudiobooksBee e catálogos OPDS que você adicionar.
- **Busca com andamento** fonte por fonte, ranking por consenso entre fontes, filtro por idioma e formato.
- **Links conferidos:** antes de entregar, confere (lendo 1 KB) se o link realmente entrega o arquivo; se um servidor está fora do ar, tenta outra edição do mesmo livro.
- **Espelhos e alternativas de download por fonte:** espelhos servem para *procurar* o livro; alternativas de download são outros caminhos para *baixar* o arquivo quando o link normal falha. Dá para ver, adicionar, remover e testar cada um.
- **Painel** com categorias recolhíveis: fontes (ligar/desligar e testar), contas opcionais, navegador em segundo plano, atualizações e uma seção "Sobre" que lista onde ficam os arquivos, o que foi baixado e com quem o addon fala.
- **Atualização automática** pelos Releases deste repositório, com pacotes assinados.

> **Aviso legal.** O Sleuth é uma ferramenta de busca: não hospeda, não copia e não distribui conteúdo, e não tem relação com os sites que consulta. Muitas dessas fontes dão acesso a obras protegidas por direitos autorais em alguns países. Você é o único responsável por usá-lo de acordo com as leis do lugar onde está.

## Compatibilidade

O Sleuth é um addon que fala o protocolo de addons "mlx" v1 (manifest, serviço HTTP em `127.0.0.1` e páginas de interface em iframe isolado). Foi feito e testado com o app **M-Library** 3.4.0 ou mais novo; as constantes do protocolo ficam em [`src/host.js`](src/host.js) e [`ui/bridge.js`](ui/bridge.js). Funciona nos apps de Windows, Linux e Android; na web não existem addons.

## Instalar

### Windows e Linux (um clique, sem Docker)
1. Baixe o `.maddon` da sua plataforma em **[Releases](../../releases/latest)** (`sleuth-<versão>-win32-x64.maddon` ou `linux-x64`).
2. No app: **Configurações → Addons → Instalar de um arquivo** e confirme o aviso.

O pacote leva o próprio Node e roda como processo separado, só em `127.0.0.1`, encerrado quando você desativa, remove o addon ou fecha o app. O Chromium (~150 MB, usado por Anna's Archive e Z-Library) é baixado uma vez, pela própria pessoa, no painel do Sleuth.

### Android, ou quem prefere Docker
O Android não executa programas baixados, então o addon precisa rodar como serviço num computador da rede:

```
docker compose up -d --build
```

O `compose.yaml` publica só em `127.0.0.1` (este computador). Para o celular alcançar o serviço, troque `ports` por `"17002:7002"` e `PUBLIC_URL` por `http://<IP deste computador>:17002`, **só numa rede de confiança**. Depois, no app, instale pelo endereço `http://<endereço>:17002/manifest.json`. A configuração inicial (fontes e contas) pode ser gerada em `http://localhost:17002/configure`; depois de instalado, tudo isso também se muda no painel.

## Atualização automática

O addon confere os Releases deste repositório a cada 6 horas (se o interruptor em **Atualizações** estiver ligado), baixa a versão nova, confere e **reinicia sozinho quando está ocioso**. Se a nova versão não subir, volta sozinho para a anterior.

Como a segurança é garantida:

- Cada release traz `update.json` (versão, SHA-256 e tamanho do zip de código) e `update.json.sig`, a **assinatura Ed25519** desse arquivo. A chave pública fica em [`src/update.js`](src/update.js); a privada fica só num Environment protegido do repositório (a publicação exige a aprovação do dono). Sem assinatura válida, nada é instalado.
- O hash do zip baixado é conferido contra o valor assinado, e o zip é extraído com proteção contra caminhos que escapam da pasta, entradas repetidas, links simbólicos e "bombas" de descompressão.
- **Nunca volta a uma versão igual ou menor** e nunca instala sozinho uma atualização que mude as permissões ou as páginas do addon, ou que exija um Node mais novo: nesses casos o painel avisa e você instala o `.maddon` novo.
- É possível desligar, conferir na hora, voltar à versão anterior ou trocar a origem (`dono/repositório`) no painel. `SLEUTH_UPDATES=0` desliga de vez. Uma versão que não ficar de pé por 30 segundos em duas partidas seguidas (por exemplo, se você fechar o app duas vezes logo depois de abrir) é marcada como ruim e ignorada; a versão seguinte volta a ser instalada normalmente.
- O único endereço contatado é o `github.com` (e os servidores de arquivos dele). Não é enviado nenhum dado seu além do que qualquer requisição HTTP revela (o endereço IP e o User-Agent `Sleuth-Updater`).

No Docker, a imagem sai com `SLEUTH_RESTART=1` e as versões instaladas ficam no volume `/data`. Numa execução manual (`npm start`), a versão nova é instalada, mas é preciso reiniciar.

## Dados e rede

Tudo o que o addon grava fica numa única pasta de dados (a que o app informa; em contêiner, `/data`; senão, `./data`):

| Arquivo | O quê |
|---|---|
| `sleuth.json` | fontes ligadas, espelhos, alternativas de download, fontes personalizadas e as suas contas (em Linux e Docker, só o dono lê: `0600`) |
| `browser-profile/`, `browsers/` | perfil e Chromium do navegador em segundo plano |
| `updates/` | versões instaladas pela atualização automática |

As contas só vão para o site correspondente. Veja a lista completa, com tamanhos e os endereços realmente acessados, na seção **Sobre este addon** do painel.

## Desenvolvimento

Requer Node 24 ou mais novo.

```
npm ci
npm test
npm start        # node launcher.js (a porta vem de PORT; HOST limita a interface)
```

Variáveis úteis: `PORT`, `HOST`, `PUBLIC_URL`, `DATA_DIR`, `SLEUTH_UPDATES=0`, `SLEUTH_RESTART=1`.

Estrutura: `launcher.js` escolhe qual código roda e volta a uma versão boa se a atualização falhar; `server.js` é o serviço; `src/` é o motor (`sources.js`), o atualizador (`update.js`, `zip.js`) e o resto; `ui/` são as páginas do painel.

### Publicar uma versão
1. Atualize `version` em `package.json` e o `CHANGELOG.md`.
2. Na primeira vez: `node scripts/keygen.mjs` (grava a chave privada **fora** do repositório e imprime a pública para `PUBLIC_KEYS` em `src/update.js`) e guarde uma cópia do `.pem` fora do computador. Em *Settings → Environments*, crie o Environment `release` com **Required reviewers** (você) e cadastre nele o secret `UPDATE_SIGNING_KEY` com o conteúdo do `.pem`.
3. `git tag vX.Y.Z && git push --tags`. O workflow testa, monta os `.maddon` (cada um com o Node da plataforma) e, depois da sua aprovação, assina o `update.json` e publica o release.

Para trocar a chave de assinatura sem deixar ninguém sem atualizar, publique uma versão que traga **as duas** chaves em `PUBLIC_KEYS`, assinada com a antiga, e só depois passe a assinar com a nova.

## Licença

[MIT](LICENSE).
