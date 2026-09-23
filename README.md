# Odoo X-Ray

Extensão Chrome/Firefox para Odoo 19: Alt+hover destaca campos renderizados
e mostra sua origem. Alt+click abre o inspetor sem executar a ação do Odoo.
Links de arquivo abrem no VS Code na linha correta. O fluxo principal usa as
APIs padrão do Odoo e uma ponte local; nenhum módulo X-Ray precisa ser
instalado no banco ou injetado no projeto Odoo.

O host local lê os arquivos Python nos diretórios configurados em Options e
encontra declarações de campo e método por análise de sintaxe. A extensão
consulta `fields_get` e `ir.ui.view` pela sessão do navegador. Na inspeção
sem addon, as views exibidas são candidatas que mencionam o elemento; a API
padrão não informa a sequência exata de alterações da herança nem fornece
um vínculo seguro entre cada elemento DOM e sua linha XML.

## Addon (`addon/xray/`)

Módulo legado opcional (`auto_install: False`) para inspeção detalhada da
herança XML. O fluxo padrão não depende dele. Não referencia nenhum projeto
específico.

**Instalar (dev):** montar `addon/` em `/mnt/extra-addons` — já é volume e já
está no `addons_path` de qualquer setup Odoo padrão. No credsus:

```yaml
# docker-compose.yml, service web.volumes
- ../odoo-xray/addon:/mnt/extra-addons
```

Instale somente se desejar o histórico exato da herança XML. A extensão
funciona sem essa instalação.

**Atualizar uma instalação existente:** reiniciar o processo Odoo para
carregar o código Python, atualizar o módulo `xray` (`-u xray -d <db>`),
recarregar a extensão e atualizar a página. O upgrade registra os assets
que identificam campos, botões, grupos, abas, separadores e HTML sem depender
dos tooltips de debug.

**Testar em banco separado:**
```
docker exec <container> odoo -d <db_teste> -i xray --test-enable --test-tags /xray --http-port=18069 --stop-after-init
```

## Extensão (`extension/`)

`chrome://extensions` → modo desenvolvedor → "carregar sem compactação" →
apontar pra `extension/`.

### Firefox (Linux)

Use Firefox 140 ou mais recente. Gere o diretório próprio do Firefox:

```sh
python3 tools/build_firefox.py
```

Em `about:debugging#/runtime/this-firefox`, clique em **Carregar extensão
temporária** e selecione `dist/firefox/manifest.json`. A pasta `extension/`
é para Brave/Chrome. Repita o build após atualizar os arquivos do projeto.
Em `about:addons`, abra as preferências do Odoo X-Ray para configurar os
mapeamentos container → host. Autorize o acesso ao site do Odoo se o Firefox
solicitar essa permissão.

Para habilitar o fallback que abre o arquivo e a linha no VS Code:

```sh
python3 native/install-firefox.py
```

Esse instalador registra `com.odoo_xray.editor` para o ID fixo
`odoo-xray@srmarinho`, preservando os registros do Chrome/Brave. Destina-se ao
Firefox instalado diretamente no Linux; Firefox em Flatpak/Snap pode precisar
de integração adicional com o host. O protocolo `vscode://` continua sendo
tentado primeiro.

A instalação temporária é removida ao reiniciar o Firefox. Para distribuir
uma instalação permanente no Firefox padrão, o pacote precisa de assinatura
da Mozilla. O projeto ainda não está publicado no catálogo de extensões.

Validação e empacotamento local:

```sh
npx web-ext lint --source-dir dist/firefox
npx web-ext build --source-dir dist/firefox --artifacts-dir /tmp/odoo-xray-firefox
```

O ZIP gerado é um pacote sem assinatura; o build não publica a extensão.

### Configuração e uso

Nas opções: mapear os paths de container do Odoo (ex. `/mnt/odoo-cotacao`)
pros paths reais no seu disco, e o template do editor
(`vscode://file/{file}:{line}` por padrão).

Para Brave/Chrome, execute novamente `./native/install.sh ID_DA_EXTENSAO`
após atualizar o projeto: o host passa a localizar arquivos Python. O
mapeamento em Options deve apontar para a raiz do código no host. No Firefox,
execute novamente `python3 native/install-firefox.py`.

Abrir o Odoo normalmente, segurar **Alt** e passar o mouse no elemento. O
contorno fica preso ao elemento renderizado. Use **Alt+click** para abrir o
inspetor diretamente; o clique comum continua com o comportamento do Odoo.
Também há metadados nas células de listas, inclusive valores sem widget. O
extrator antigo continua disponível para addons anteriores, que precisam de
`?debug=1`.

### Origem nas views

No tooltip, **Ver origem na view** abre um painel com as views que mencionam
o elemento. O módulo opcional ainda pode produzir marcadores para grupos,
abas e outros elementos, mas a extensão não depende deles. Em botões
`type="object"`, o painel busca as declarações do método Python no código
local configurado.

Sem addon, o painel lista as views acessíveis que mencionam o elemento e
mostra a cadeia de herança declarada. O caminho `arch_fs` aparece como
referência; a extensão não inventa uma linha de XML. A localização Python
é calculada a partir dos arquivos presentes nos diretórios locais mapeados.

O acesso às views continua sujeito às permissões padrão do Odoo.

### Fallback nativo do VS Code (Brave/Linux)

O clique agenda o fallback no service worker e tenta primeiro `vscode://`.
Após 900 ms, o worker usa Native Messaging sem depender de a aba continuar
ativa. Para registrar o host local, copie o ID mostrado em
`brave://extensions` ou `chrome://extensions` e execute:

```sh
./native/install.sh ID_DA_EXTENSAO
```

Se a extensão estiver instalada em mais de um navegador, passe todos os IDs
na mesma execução, separados por espaço.

Depois, recarregue a extensão e a página do Odoo. O host usa a URL interna do
VS Code Flatpak para ativar o arquivo na linha correta; no VS Code nativo, usa
`--reuse-window --goto`. O instalador reinicia a ponte a cada atualização e
preserva o ambiente da sessão gráfica para conseguir focar a janela. Como o
Brave Flatpak bloqueia Native Messaging externo, o instalador também inicia
uma ponte restrita a `127.0.0.1:17654`, autorizada apenas para os IDs informados.

## Testes

- `addon/xray/tests/test_xray.py` — `TransactionCase`, roda no Odoo.
- `addon/xray/tests/test_views.py` — herança, permissões, identidade e linhas XML.
- `extension/src/rewrite.test.js` — puro, `node rewrite.test.js`.
- `extension/src/inspect.test.js` — extrator/RPC reais, `node extension/src/inspect.test.js`.
- `extension/src/background.test.js` — valida agendamento e mensagem do fallback.
- `native/test_open_in_vscode.py` — protocolo, comandos do editor e erros do host.
- `extension/tests/browser.cjs` — Playwright contra Odoo real, sem debug.
  Requer Playwright acessível pelo Node e um banco isolado já instalado:

```sh
XRAY_TEST_URL=http://localhost:18069 XRAY_TEST_DB=xray_test_local \
  node extension/tests/browser.cjs
```

Use `XRAY_TEST_PASSWORD` para senha diferente de `admin` e `CHROME_PATH`
para selecionar um Chromium local. Esse teste simula a API da extensão e
intercepta a abertura do editor; não inicia o VS Code.
