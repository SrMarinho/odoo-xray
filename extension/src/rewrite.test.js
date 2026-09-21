// Teste manual: `node rewrite.test.js` dentro de extension/src.
// Sem framework — reimplementa a função pura (content.js depende de
// `window`/`chrome`, não dá pra importar direto em Node) e roda asserts.

function xrayRewritePath(containerPath, xrayMappings) {
  if (!containerPath) return { host: null, core: false, unmapped: true };
  let best = null;
  for (const m of xrayMappings) {
    if (containerPath.startsWith(m.container) && (!best || m.container.length > best.container.length)) {
      best = m;
    }
  }
  if (!best) return { host: null, core: true, unmapped: false };
  return { host: best.host + containerPath.slice(best.container.length), core: false, unmapped: false };
}

function xrayExtractFromInfo(info) {
  const field = info.field || {};
  if (!info.resModel || !field.name) return null;
  return { model: info.resModel, field: field.name, type: field.type || null };
}

// Réplica de xrayFindBadgeInfo/xrayExtract (extract.js) com nós fake em vez de
// DOM real — cobre o bug real achado ao vivo: no Odoo 19 o widget de um campo
// comum não carrega resModel (às vezes nem tooltip-info nenhum), só o badge
// "?" do <label>, que é IRMÃO do widget, achado subindo até um ancestral comum.
function fakeNode({ tag = 'DIV', info = null, children = [], parent = null } = {}) {
  const node = {
    tag,
    info,
    children,
    parent,
    matches(sel) { return sel === 'sup[data-tooltip-info]' && tag === 'SUP' && info; },
    querySelector(sel) {
      if (sel !== 'sup[data-tooltip-info]') return null;
      const stack = [...node.children];
      while (stack.length) {
        const n = stack.shift();
        if (n.tag === 'SUP' && n.info) return { getAttribute: () => JSON.stringify(n.info) };
        stack.push(...n.children);
      }
      return null;
    },
    get parentElement() { return node.parent; },
  };
  children.forEach((c) => { c.parent = node; });
  return node;
}

function xrayFindBadgeInfo(startEl) {
  let node = startEl, level = 0;
  while (node && level < 6) {
    const supAttr = node.matches('sup[data-tooltip-info]')
      ? { getAttribute: () => JSON.stringify(node.info) }
      : node.querySelector('sup[data-tooltip-info]');
    if (supAttr) {
      try { return JSON.parse(supAttr.getAttribute('data-tooltip-info')); } catch (e) { /* segue */ }
    }
    node = node.parentElement;
    level++;
  }
  return null;
}

const assert = require('assert');

// widget sem tooltip-info nenhum (char comum), badge 2 níveis acima (irmão)
const sup = fakeNode({ tag: 'SUP', info: { resModel: 'res.partner', field: { name: 'email' } } });
const label = fakeNode({ tag: 'LABEL', children: [sup] });
const widget = fakeNode({ tag: 'DIV' });
const row = fakeNode({ tag: 'DIV', children: [label, widget] }); // ancestral comum
assert.deepStrictEqual(xrayFindBadgeInfo(widget), { resModel: 'res.partner', field: { name: 'email' } });

// nada em 6 níveis -> null, não trava
const orphan = fakeNode({ tag: 'DIV' });
assert.strictEqual(xrayFindBadgeInfo(orphan), null);

const mappings = [
  { container: '/mnt/odoo-cotacao', host: '/home/x/credsus/odoo-cotacao' },
  { container: '/mnt/odoo-cotacao/odoo/addons/gw_base', host: '/home/x/gw_base_override' }, // prefixo mais específico
];

// prefixo mais longo ganha
let r = xrayRewritePath('/mnt/odoo-cotacao/odoo/addons/gw_base/models/res_users.py', mappings);
assert.strictEqual(r.host, '/home/x/gw_base_override/models/res_users.py');

// path core (sem mapeamento) -> sem link
r = xrayRewritePath('/usr/lib/python3/dist-packages/odoo/orm/models.py', mappings);
assert.strictEqual(r.host, null);
assert.strictEqual(r.core, true);

// path vazio -> unmapped, não quebra
r = xrayRewritePath(null, mappings);
assert.strictEqual(r.unmapped, true);

// extract: JSON válido com model+field
let info = xrayExtractFromInfo({ resModel: 'res.partner', field: { name: 'vat', type: 'char' } });
assert.deepStrictEqual(info, { model: 'res.partner', field: 'vat', type: 'char' });

// extract: faltando resModel ou field.name -> null
assert.strictEqual(xrayExtractFromInfo({ field: { name: 'vat' } }), null);
assert.strictEqual(xrayExtractFromInfo({ resModel: 'res.partner', field: {} }), null);

console.log('rewrite.test.js: OK');
