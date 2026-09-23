// Extração pura: elemento sob o cursor -> {model, field, type, widget, ...} | null
//
// Odoo 19 espalha o tooltip técnico de forma inconsistente entre widgets
// (verificado ao vivo, não é o que a doc/template sugere à primeira leitura):
//   - addons/web/static/src/views/fields/field.js `get tooltip()` só passa
//     {field, fieldInfo} pra getTooltipInfo() — quando o WIDGET tem
//     data-tooltip-info, nunca carrega resModel. E em campos simples (char
//     etc.) o widget não tem o atributo nenhum, só o label.
//   - addons/web/static/src/views/form/form_label.js é quem manda o pacote
//     completo (com resModel) sempre, mas só no badge "?" (<sup
//     data-tooltip-info>) dentro do <label>, que é IRMÃO do widget — nunca
//     ancestral/descendente dele.
// Por isso: sobe do alvo até 6 níveis procurando esse badge num ancestral
// comum. Se o alvo também tiver seu próprio data-tooltip-info (ex.
// statusbar), usa como base e só completa o resModel que falta; senão usa
// o do badge como fonte inteira.
function xrayFindBadgeInfo(startEl) {
  let node = startEl, level = 0;
  while (node && level < 6) {
    const sup = node.matches && node.matches('sup[data-tooltip-info]')
      ? node
      : (node.querySelector && node.querySelector('sup[data-tooltip-info]'));
    if (sup) {
      try {
        return JSON.parse(sup.getAttribute('data-tooltip-info'));
      } catch (e) { /* segue procurando */ }
    }
    node = node.parentElement;
    level++;
  }
  return null;
}

function xrayExtract(el) {
  if (!el) return null;

  const marked = el.closest?.('[data-xray-node]');
  if (marked) {
    let identity = null;
    try { identity = JSON.parse(marked.getAttribute('data-xray-node') || 'null'); } catch (_) { /* ignore invalid marker */ }
    if (!identity?.model) return null;
    return {
      model: marked.getAttribute('data-xray-model') || identity.model,
      field: marked.getAttribute('data-xray-field') || identity.field || null,
      tag: identity.tag || (identity.field ? 'field' : null),
      name: identity.name || identity.field || null,
      label: identity.label || null,
      type: marked.getAttribute('data-xray-type'),
      widget: marked.getAttribute('data-xray-widget'),
      viewId: Number(marked.getAttribute('data-xray-view-id')) || null,
      identity, node: marked,
    };
  }

  // Odoo renders field names even without the companion addon. The model is
  // present in record routes such as /odoo/res.partner/1; other routes can
  // still supply it via the native technical tooltip below.
  const widget = el.closest?.('.o_field_widget[name], .o_list_view td[name], button[name][type="object"]');
  const routeModel = decodeURIComponent((globalThis.location?.pathname || '').match(/^\/odoo\/([a-z][a-z0-9_.]+)(?:\/|$)/)?.[1] || '');
  if (widget && routeModel) {
    const field = widget.getAttribute('name');
    if (field) {
      const button = widget.matches('button[type="object"]');
      return { model: routeModel, field: button ? null : field, name: field,
        tag: button ? 'button' : 'field', type: null, widget: null, node: widget };
    }
  }

  const direct = el.closest && el.closest('[data-tooltip-info]');
  let info = null;
  if (direct) {
    try {
      info = JSON.parse(direct.getAttribute('data-tooltip-info'));
    } catch (e) { /* JSON quebrado não deve derrubar o hover */ }
  }

  if (!info || !info.resModel) {
    const badgeInfo = xrayFindBadgeInfo(el);
    if (badgeInfo) info = info ? { ...info, resModel: info.resModel || badgeInfo.resModel } : badgeInfo;
  }
  if (!info) return null;

  const field = info.field || {};
  if (!info.resModel || !field.name) return null;

  return {
    model: info.resModel,
    field: field.name,
    name: field.name,
    tag: 'field',
    label: field.label || null,
    type: field.type || null,
    widget: field.widget || null,
    required: !!field.required,
    readonly: !!field.readonly,
    node: direct || el,
  };
}
