# Odoo X-Ray

Extensão Chrome (MV3): Alt+hover num campo do Odoo mostra modelo, campo, e
onde cada módulo que o declara está no disco — clique/Enter abre no VSCode.

Sem indexador, sem cache, sem helper local. O addon `xray` faz o Odoo
responder sobre si mesmo via `type(model).mro()` + `inspect`, que já é
ordenado por herança e sempre condiz com o código rodando. Ver
`~/.claude/plans/leia-o-plano-do-gentle-comet.md` pro raciocínio completo.

## Addon (`addon/xray/`)

Módulo Odoo genérico (`depends: ['base']`, `auto_install: True`), agnóstico
de projeto — não referencia nada do credsus nem qualquer outro monorepo.

**Instalar (dev):** montar `addon/` em `/mnt/extra-addons` — já é volume e já
está no `addons_path` de qualquer setup Odoo padrão. No credsus:

```yaml
# docker-compose.yml, service web.volumes
- ../odoo-xray/addon:/mnt/extra-addons
```

`auto_install` cuida do resto — instala sozinho em todo banco novo (inclusive
os que o `dbctl` cria por branch).

**Testar:**
```
docker exec <container> odoo -d <db> -u xray --test-enable --test-tags /xray --no-http --stop-after-init
```

## Extensão (`extension/`)

`chrome://extensions` → modo desenvolvedor → "carregar sem compactação" →
apontar pra `extension/`.

Nas opções: mapear os paths de container do Odoo (ex. `/mnt/odoo-cotacao`)
pros paths reais no seu disco, e o template do editor
(`vscode://file/{file}:{line}` por padrão).

Abrir o Odoo com `?debug=1`, segurar **Alt** e passar o mouse num campo.

## Testes

- `addon/xray/tests/test_xray.py` — `TransactionCase`, roda no Odoo.
- `extension/src/rewrite.test.js` — puro, `node rewrite.test.js`.
