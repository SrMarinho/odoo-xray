// Extração pura: elemento sob o cursor -> {model, field, type, widget, ...} | null
// Fonte: addons/web/static/src/views/fields/field.xml:5 põe data-tooltip-info
// no div raiz de todo widget de campo, quando odoo.debug está ligado.
function xrayExtract(el) {
  const node = el && el.closest && el.closest('[data-tooltip-info]');
  if (!node) return null;

  let info;
  try {
    info = JSON.parse(node.getAttribute('data-tooltip-info'));
  } catch (e) {
    return null; // JSON quebrado não deve derrubar o hover
  }

  const field = info.field || {};
  if (!info.resModel || !field.name) return null;

  return {
    model: info.resModel,
    field: field.name,
    label: field.label || null,
    type: field.type || null,
    widget: field.widget || null,
    required: !!field.required,
    readonly: !!field.readonly,
    node,
  };
}
