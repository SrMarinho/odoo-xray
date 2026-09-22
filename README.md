# Odoo X-Ray

Extensão Chrome (MV3) para Odoo 19: Alt+hover num campo mostra modelo, campo
e onde cada módulo o declara — clique/Enter abre no VS Code. Funciona sem
modo debug, para administradores do sistema (`base.group_system`).

O addon usa `type(model).mro()` + `inspect` para localizar código Python.
Para XML, acompanha as operações reais de herança do Odoo durante a
inspeção, sem persistir marcadores nem substituir o resolvedor de views.

## Addon (`addon/xray/`)

Módulo Odoo genérico (`depends: ['web']`, `auto_install: True`), agnóstico
de projeto — não referencia nada do credsus nem qualquer outro monorepo.

**Instalar (dev):** montar `addon/` em `/mnt/extra-addons` — já é volume e já
está no `addons_path` de qualquer setup Odoo padrão. No credsus:

```yaml
# docker-compose.yml, service web.volumes
- ../odoo-xray/addon:/mnt/extra-addons
```

`auto_install` cuida do resto — instala sozinho em todo banco novo (inclusive
os que o `dbctl` cria por branch).

**Atualizar uma instalação existente:** reiniciar o processo Odoo para
carregar o código Python, atualizar o módulo `xray` (`-u xray -d <db>`),
recarregar a extensão e atualizar a página. O upgrade registra os assets
que identificam campos e labels sem depender dos tooltips de debug.

**Testar em banco separado:**
```
docker exec <container> odoo -d <db_teste> -i xray --test-enable --test-tags /xray --http-port=18069 --stop-after-init
```

## Extensão (`extension/`)

`chrome://extensions` → modo desenvolvedor → "carregar sem compactação" →
apontar pra `extension/`.

Nas opções: mapear os paths de container do Odoo (ex. `/mnt/odoo-cotacao`)
pros paths reais no seu disco, e o template do editor
(`vscode://file/{file}:{line}` por padrão).

Abrir o Odoo normalmente, segurar **Alt** e passar o mouse num campo ou
label. Também há metadados nas células de listas, inclusive valores que
não usam um widget. O extrator antigo continua disponível para addons
anteriores, que precisam de `?debug=1`.

### Origem nas views

No tooltip, **Ver origem na view** abre um painel com a cadeia de views
aplicadas e o histórico do campo: criação, atributos, inserções,
substituições e movimentos. Campos repetidos e subviews inline são
identificados pelo caminho no XML, não somente pelo nome.

O painel abre o XML no editor quando o arquivo corresponde à definição
no banco. Views do Studio, arquivos ausentes ou XML divergente são
mostrados sem inventar uma linha. Alterações em tempo de execução por
código Python podem não ter uma origem XML rastreável. Se a view mudou
desde o carregamento da página, a extensão solicita recarregá-la.

As APIs verificam o grupo de administrador no servidor. O cache de
arquiteturas separa usuários administradores dos demais; a extensão
consulta novamente a proveniência a cada abertura do painel.

## Testes

- `addon/xray/tests/test_xray.py` — `TransactionCase`, roda no Odoo.
- `addon/xray/tests/test_views.py` — herança, permissões, identidade e linhas XML.
- `extension/src/rewrite.test.js` — puro, `node rewrite.test.js`.
- `extension/src/inspect.test.js` — extrator/RPC reais, `node extension/src/inspect.test.js`.
- `extension/tests/browser.cjs` — Playwright contra Odoo real, sem debug.
  Requer Playwright acessível pelo Node e um banco isolado já instalado:

```sh
XRAY_TEST_URL=http://localhost:18069 XRAY_TEST_DB=xray_test_local \
  node extension/tests/browser.cjs
```

Use `XRAY_TEST_PASSWORD` para senha diferente de `admin` e `CHROME_PATH`
para selecionar um Chromium local. Esse teste simula a API da extensão e
intercepta a abertura do editor; não inicia o VS Code.
