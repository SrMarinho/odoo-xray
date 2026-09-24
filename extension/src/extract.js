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

// Where in the rendered form `node` sits: which x2many subview (if any),
// notebook page and group title contain it. Used to disambiguate a field or
// label that the arch declares more than once (e.g. the same field shown in
// two groups, or the same tag repeated across notebook pages).
function xrayNodeContext(node) {
  const subviewAncestor = node.parentElement?.closest?.('.o_field_widget[name]');
  const subview = subviewAncestor ? subviewAncestor.getAttribute('name') : null;
  const pane = node.closest?.('.tab-pane');
  let page = null;
  if (pane?.id) {
    const notebook = pane.closest('.o_notebook');
    const escaped = globalThis.CSS?.escape ? CSS.escape(pane.id) : pane.id;
    const link = notebook?.querySelector('[aria-controls="' + escaped + '"]');
    if (link) page = { name: link.getAttribute('name') || null, label: link.textContent.trim() };
  }
  const groupAncestor = node.closest?.('.o_inner_group, .o_group');
  const group = groupAncestor ?
    (groupAncestor.firstElementChild?.querySelector?.('.o_horizontal_separator')?.textContent.trim() || null) : null;
  return { subview, group, page };
}

// Index of `node` among every rendered occurrence of the same field/name in
// the same subview+page+group scope — the same disambiguation Odoo's own
// compiler has no name for, needed only when more than one candidate remains.
// Degrades to "unknown" rather than throwing when the DOM around `node`
// doesn't support querySelectorAll (e.g. a synthetic/test element).
function xrayOccurrence(node, selector, context) {
  const scope = node.ownerDocument?.querySelectorAll?.(selector);
  if (!scope) return { occurrence: null, occurrenceCount: null };
  const sameScope = [...scope].filter((candidate) => {
    const other = xrayNodeContext(candidate);
    return other.subview === context.subview && other.page?.name === context.page?.name &&
      other.group === context.group;
  });
  const index = sameScope.indexOf(node);
  return { occurrence: index === -1 ? null : index, occurrenceCount: sameScope.length };
}

function xrayExtract(el) {
  if (!el) return null;

  // Odoo 19 exposes stable XML IDs on desktop and mobile navigation entries.
  // Menus are ir.ui.menu records, not nodes from the current view arch.
  const menu = el.closest?.('.o_main_navbar [data-menu-xmlid], .o_app_menu_sidebar [data-menu-xmlid]');
  if (menu) {
    const xmlId = menu.getAttribute('data-menu-xmlid');
    const section = menu.getAttribute('data-section') ||
      menu.querySelector?.('[data-section]')?.getAttribute('data-section');
    if (xmlId) return {
      model: 'ir.ui.menu', field: null, tag: 'menu', name: xmlId,
      label: menu.textContent.trim(), menuXmlId: xmlId,
      menuId: /^\d+$/.test(section || '') ? Number(section) : null,
      node: menu,
    };
  }

  // Headers use data-name; unwidgeted body cells use name. Resolve them
  // before a marker on the containing x2many can swallow the whole column.
  const cell = el.closest?.('.o_list_view th[data-name], .o_list_view td[name]');
  const cellMarker = el.closest?.('[data-xray-node]');
  if (cell && (!cellMarker || !cell.contains(cellMarker))) {
    const field = cell.getAttribute('data-name') || cell.getAttribute('name');
    const route = decodeURIComponent((globalThis.location?.pathname || '').match(/^\/odoo\/([a-z][a-z0-9_.-]+)(?:\/|$)/)?.[1] || '');
    if (field && route) {
      const context = xrayNodeContext(cell);
      // Rows repeat records, not XML declarations: don't use row count as
      // evidence to disambiguate occurrences in the architecture.
      return { model: route, field, name: field, tag: 'field', node: cell,
        context, column: true, occurrence: null, occurrenceCount: null };
    }
  }

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

  const routeModel = decodeURIComponent((globalThis.location?.pathname || '').match(/^\/odoo\/([a-z][a-z0-9_.-]+)(?:\/|$)/)?.[1] || '');

  // Odoo renders field names even without the companion addon. The model is
  // present in record routes such as /odoo/res.partner/1; other routes can
  // still supply it via the native technical tooltip below.
  const widget = el.closest?.('.o_field_widget[name], .o_list_view td[name], button[name]');
  if (widget && routeModel) {
    const field = widget.getAttribute('name');
    if (field) {
      const button = widget.matches('button[name]');
      const tag = button ? 'button' : 'field';
      const context = xrayNodeContext(widget);
      const occurrence = xrayOccurrence(widget, '.o_field_widget[name="' + field + '"], button[name="' + field + '"]', context);
      return { model: routeModel, field: button ? null : field, name: field,
        tag, type: null, widget: null, node: widget, context, ...occurrence };
    }
  }

  // Labels point to their widget by input id. Resolve this before structural
  // containers so a label inside a group keeps describing its own field.
  const label = el.closest?.('label.o_form_label[for]');
  if (label && routeModel) {
    const input = label.ownerDocument?.getElementById(label.getAttribute('for'));
    const labelWidget = input?.closest('.o_field_widget[name]');
    const field = labelWidget?.getAttribute('name');
    if (field) {
      const context = xrayNodeContext(labelWidget);
      const occurrence = xrayOccurrence(labelWidget, '.o_field_widget[name="' + field + '"]', context);
      return { model: routeModel, field, name: field, tag: 'field',
        label: label.textContent.trim(), type: null, widget: null, node: label, context, ...occurrence };
    }
  }

  // Group titles and tabs are real view nodes, but Odoo's compiler removes
  // their XML attributes. Their rendered structure is stable in Odoo 19.
  const separator = el.closest?.('.o_horizontal_separator');
  if (separator && routeModel) {
    const group = separator.parentElement?.parentElement;
    const isGroupTitle = group?.matches('.o_inner_group, .o_group') &&
      group.firstElementChild === separator.parentElement;
    return { model: routeModel, field: null, name: null,
      tag: isGroupTitle ? 'group' : 'separator', label: separator.textContent.trim(),
      node: separator };
  }

  const tab = el.closest?.('.o_notebook a.nav-link[role="tab"]');
  if (tab && routeModel) return { model: routeModel, field: null,
    name: tab.getAttribute('name'), tag: 'page', label: tab.textContent.trim(), node: tab,
    context: xrayNodeContext(tab) };

  const heading = el.closest?.('h1, h2, h3, h4, h5, h6');
  if (heading && routeModel) return { model: routeModel, field: null,
    name: null, tag: heading.tagName.toLowerCase(), label: heading.textContent.trim(), node: heading };

  const group = el.closest?.('.o_inner_group, .o_group');
  if (group && routeModel) {
    const title = group.firstElementChild?.matches('.o_cell') ? null :
      group.firstElementChild?.querySelector('.o_horizontal_separator')?.textContent.trim() || null;
    const context = xrayNodeContext(group.parentElement || group);
    return { model: routeModel, field: null, name: null, tag: 'group', label: title, node: group, context };
  }

  const notebook = el.closest?.('.o_notebook');
  if (notebook && routeModel) return { model: routeModel, field: null,
    name: null, tag: 'notebook', label: null, node: notebook };

  const sheet = el.closest?.('.o_form_sheet');
  if (sheet && routeModel) return { model: routeModel, field: null,
    name: null, tag: 'sheet', label: null, node: sheet };

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
