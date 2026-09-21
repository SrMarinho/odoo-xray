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

const assert = require('assert');

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
