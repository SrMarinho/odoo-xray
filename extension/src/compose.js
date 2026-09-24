// View composition with provenance. Port of Odoo 19 ir.ui.view._combine,
// _get_combined_archs and tools/template_inheritance.py, run on the browser's
// XML DOM: every element of the result knows which view created it and which
// views changed it afterwards. Events point to the preorder index of the
// responsible element inside that view's own arch.

const XRAY_PYTHON_ATTRIBUTES = new Set(['readonly', 'required', 'invisible', 'column_invisible', 't-if', 't-elif']);

function xrayElements(root) {
  return [root, ...root.getElementsByTagName('*')];
}

function xrayParseArch(arch) {
  const doc = new DOMParser().parseFromString(arch || '<data/>', 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('arch XML inválida');
  return doc.documentElement;
}

function xrayParentId(view) {
  return Array.isArray(view.inherit_id) ? view.inherit_id[0] : view.inherit_id || false;
}

// Views applied to build `loadedId`, in Odoo's order. `views` holds every view
// of the model plus the ancestors of the loaded one, as read by search_read.
function xrayHierarchy(loadedId, views) {
  const byId = new Map(views.map((view) => [view.id, view]));
  const chain = [];
  for (let view = byId.get(loadedId); view; view = byId.get(xrayParentId(view))) chain.push(view.id);
  if (!chain.length) throw new Error('view ' + loadedId + ' não encontrada');
  const root = byId.get(chain.at(-1));
  const usable = (view) => view.active !== false && !view.excluded;
  // _get_inheriting_views: the chain plus active extensions of the same model.
  const tree = new Set(chain.filter((id) => usable(byId.get(id))));
  const sorted = [...views].sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (let grown = true; grown;) {
    grown = false;
    for (const view of sorted) {
      const parent = byId.get(xrayParentId(view));
      if (!tree.has(view.id) && parent && tree.has(parent.id) && usable(view) &&
          view.mode === 'extension' && (view.model || '') === (parent.model || '')) {
        tree.add(view.id);
        grown = true;
      }
    }
  }
  const children = (view) => sorted.filter((child) => tree.has(child.id) &&
    xrayParentId(child) === view.id && (child.mode !== 'primary' || chain.includes(child.id)));
  const order = [];
  const queue = children(root).sort((a, b) => (a.mode > b.mode) - (a.mode < b.mode));
  while (queue.length) {
    const view = queue.shift();
    order.push(view);
    for (const child of children(view).reverse()) {
      if (child.mode === 'primary') queue.push(child);
      else queue.unshift(child);
    }
  }
  return { root, order };
}

// Odoo registers hasclass() as an XPath extension; browsers do not know it.
function xrayXPath(expr) {
  return expr.replace(/hasclass\(([^)]*)\)/g, (_match, args) => '(' + args.split(',')
    .map((arg) => arg.trim().replace(/^['"]|['"]$/g, ''))
    .map((cls) => "contains(concat(' ', normalize-space(@class), ' '), ' " + cls + " ')")
    .join(' and ') + ')');
}

function xrayLocateNode(root, spec) {
  if (spec.tagName === 'xpath') {
    const result = root.ownerDocument.evaluate(xrayXPath(spec.getAttribute('expr') || ''), root,
      null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    return result?.nodeType === 1 ? result : null;
  }
  const nodes = xrayElements(root).filter((node) => node.tagName === spec.tagName);
  if (spec.tagName === 'field') return nodes.find((node) => node.getAttribute('name') === spec.getAttribute('name')) || null;
  return nodes.find((node) => [...spec.attributes].every((attr) =>
    attr.name === 'position' || node.getAttribute(attr.name) === attr.value)) || null;
}

function xrayAttributeValue(node, child) {
  const name = child.getAttribute('name');
  if (!child.hasAttribute('add') && !child.hasAttribute('remove')) return child.textContent || '';
  let value = node.getAttribute(name) || '';
  const add = child.getAttribute('add') || '';
  const remove = child.getAttribute('remove') || '';
  let separator = child.getAttribute('separator');
  if (XRAY_PYTHON_ATTRIBUTES.has(name) || name.startsWith('decoration-')) {
    separator = (separator || '').trim();
    if (remove) {
      let whole = false;
      try { whole = new RegExp('^\\(*' + remove + '\\)*$').test(value); } catch (_error) { /* literal */ }
      if (whole) value = '';
      else {
        for (const pattern of ['(' + remove + ') ' + separator + ' ', ' ' + separator + ' (' + remove + ')',
          remove + ' ' + separator + ' ', ' ' + separator + ' ' + remove]) {
          const index = value.indexOf(pattern);
          if (index !== -1) { value = value.slice(0, index) + value.slice(index + pattern.length); break; }
        }
      }
    }
    if (add) value = value ? '(' + value + ') ' + separator + ' (' + add + ')' : add;
    return value;
  }
  if (separator === null) separator = ',';
  const split = (text) => (separator === ' ' ? text.split(/\s+/) : text.split(separator)).map((s) => s.trim());
  const removed = new Set(split(remove));
  return [...split(value).filter((v) => v && !removed.has(v)), ...split(add).filter(Boolean)]
    .join(separator === ' ' ? ' ' : separator);
}

// Returns { root, meta, warnings }. meta: Map(element -> {created, events}).
function xrayCompose(root, order) {
  const meta = new Map();
  const warnings = [];
  const doc = document.implementation.createDocument(null, null, null);
  const ref = (view, index, op, extra = {}) => ({ op, viewId: view.id, index, ...extra });

  // Insert a copy of `node` (from a view's arch) and record who created it.
  function adopt(node, view, indexes, via) {
    const copy = doc.importNode(node, true);
    const originals = xrayElements(node);
    xrayElements(copy).forEach((element, i) => meta.set(element,
      { created: ref(view, indexes.get(originals[i]), 'create', via ? { via } : {}), events: [] }));
    return copy;
  }
  function cloneTracked(node, event) {
    const copy = node.cloneNode(true);
    const originals = xrayElements(node);
    xrayElements(copy).forEach((element, i) => {
      const source = meta.get(originals[i]);
      meta.set(element, { created: source?.created, events: [...(source?.events || []), event] });
    });
    return copy;
  }

  const base = xrayParseArch(root.arch);
  const baseIndexes = new Map(xrayElements(base).map((element, i) => [element, i]));
  doc.appendChild(adopt(base, root, baseIndexes));

  for (const view of order) {
    let arch;
    try { arch = xrayParseArch(view.arch); } catch (error) {
      warnings.push({ viewId: view.id, message: error.message });
      continue;
    }
    const indexes = new Map(xrayElements(arch).map((element, i) => [element, i]));
    const specs = [arch];
    while (specs.length) {
      const spec = specs.shift();
      if (spec.tagName === 'data') { specs.push(...[...spec.children]); continue; }
      const node = xrayLocateNode(doc.documentElement, spec);
      if (!node) {
        warnings.push({ viewId: view.id, index: indexes.get(spec),
          message: 'Elemento não localizado: <' + spec.tagName + [...spec.attributes]
            .map((a) => ' ' + a.name + '="' + a.value + '"').join('') + '>' });
        continue;
      }
      const position = spec.getAttribute('position') || 'inside';
      const specIndex = indexes.get(spec);
      const event = ref(view, specIndex, position);
      // Children to insert: moved nodes keep their origin, others are created here.
      const contents = (via, target) => [...spec.children].map((child) => {
        if (child.getAttribute('position') !== 'move') {
          const copy = adopt(child, view, indexes, via);
          if (target) {
            for (const holder of [copy, ...copy.getElementsByTagName('*')]) {
              if ([...holder.childNodes].some((n) => n.nodeType === 3 && n.data === '$0')) {
                holder.textContent = '';
                holder.appendChild(cloneTracked(target, event));
              }
            }
          }
          return copy;
        }
        const moved = xrayLocateNode(doc.documentElement, child);
        if (!moved) {
          warnings.push({ viewId: view.id, index: indexes.get(child), message: 'Elemento movido não localizado' });
          return null;
        }
        moved.remove();
        meta.get(moved)?.events.push(ref(view, indexes.get(child), 'move'));
        return moved;
      }).filter(Boolean);

      if (position === 'replace' && (spec.getAttribute('mode') || 'outer') === 'outer') {
        const replaced = meta.get(node)?.created;
        const inserted = contents('replace', node);
        for (const element of inserted) {
          const info = meta.get(element);
          if (info && info.created?.viewId === view.id) info.replaced = replaced;
        }
        if (node === doc.documentElement) {
          if (inserted[0]) doc.replaceChild(inserted[0], node);
        } else {
          inserted.forEach((element) => node.parentNode.insertBefore(element, node));
          node.remove();
        }
      } else if (position === 'replace') {
        const inserted = contents('replace');
        node.replaceChildren(...inserted);
        meta.get(node)?.events.push(ref(view, specIndex, 'replace', { mode: 'inner' }));
      } else if (position === 'attributes') {
        const changes = {};
        for (const child of spec.getElementsByTagName('attribute')) {
          const name = child.getAttribute('name');
          const before = node.getAttribute(name);
          const value = xrayAttributeValue(node, child);
          if (value) node.setAttribute(name, value); else node.removeAttribute(name);
          if (before !== node.getAttribute(name)) changes[name] = { before, after: node.getAttribute(name) };
        }
        meta.get(node)?.events.push({ ...event, changes });
      } else if (['inside', 'after', 'before'].includes(position)) {
        const sentinel = doc.createElement('sentinel');
        if (position === 'inside') node.appendChild(sentinel);
        else if (position === 'after') node.after(sentinel);
        else node.before(sentinel);
        contents(position).forEach((element) => sentinel.before(element));
        sentinel.remove();
        if (position === 'inside') meta.get(node)?.events.push(event);
      } else {
        warnings.push({ viewId: view.id, index: specIndex, message: 'Posição desconhecida: ' + position });
      }
    }
  }
  return { root: doc.documentElement, meta, warnings };
}

// ---------------------------------------------------------------------------
// Matching the rendered element to arch nodes.

const XRAY_LABELLED = new Set(['group', 'page', 'separator']);

function xrayLabel(node) {
  return node.getAttribute('string') || null;
}

function xrayStep(node) {
  const key = node.getAttribute('name') || xrayLabel(node);
  return node.tagName + (key ? '[' + key + ']' : '');
}

function xraySignature(node) {
  const steps = [];
  for (let n = node; n?.nodeType === 1; n = n.parentNode) steps.unshift(xrayStep(n));
  return steps.join('/');
}

function xrayAlwaysInvisible(node) {
  for (let n = node; n?.nodeType === 1; n = n.parentNode) {
    if (['1', 'True', 'true'].includes(n.getAttribute('invisible'))) return true;
  }
  return false;
}

function xrayAncestors(node) {
  const result = [];
  for (let n = node.parentNode; n?.nodeType === 1; n = n.parentNode) result.push(n);
  return result;
}

// target: { tag, name, label, context: { page: {name,label}, group, subview }, occurrence, count }
// Returns { nodes, chosen, evidence }.
function xrayMatch(root, target) {
  const tag = /^h[1-6]$/.test(target.tag || '') ? target.tag : target.tag || 'field';
  let nodes = xrayElements(root).filter((node) => node.tagName === tag && !xrayAlwaysInvisible(node));
  const evidence = ['tag ' + tag];
  if (target.name) {
    nodes = nodes.filter((node) => node.getAttribute('name') === target.name);
    evidence.push('name ' + target.name);
  } else if (target.label && XRAY_LABELLED.has(tag)) {
    nodes = nodes.filter((node) => xrayLabel(node) === target.label);
    evidence.push('rótulo "' + target.label + '"');
  }
  const context = target.context || {};
  nodes = nodes.filter((node) => {
    const ancestors = xrayAncestors(node);
    const subview = ancestors.find((a) => a.tagName === 'field');
    if ((subview?.getAttribute('name') || null) !== (context.subview || null)) return false;
    if (context.page && !ancestors.some((a) => a.tagName === 'page' &&
        ((context.page.name && a.getAttribute('name') === context.page.name) || xrayLabel(a) === context.page.label))) return false;
    if (context.group && !ancestors.some((a) => a.tagName === 'group' && xrayLabel(a) === context.group)) return false;
    return true;
  });
  if (context.subview) evidence.push('dentro de ' + context.subview);
  if (context.page) evidence.push('aba "' + (context.page.label || context.page.name) + '"');
  if (context.group) evidence.push('grupo "' + context.group + '"');
  let chosen = nodes.length === 1 ? nodes[0] : null;
  if (!chosen && nodes.length > 1 && Number.isInteger(target.occurrence) && target.count === nodes.length) {
    chosen = nodes[target.occurrence];
    evidence.push('ocorrência ' + (target.occurrence + 1) + ' de ' + nodes.length);
  }
  return { nodes, chosen, evidence };
}

// Map a server (postprocessed) node to the composed node with the same
// structural path. Postprocessing may drop nodes (groups), so counts must agree.
function xrayCorrespond(serverRoot, serverNode, composedRoot) {
  const signature = xraySignature(serverNode);
  const same = (root) => xrayElements(root).filter((node) => node.tagName === serverNode.tagName && xraySignature(node) === signature);
  const server = same(serverRoot);
  const composed = same(composedRoot);
  if (composed.length === server.length) return { node: composed[server.indexOf(serverNode)], exact: true, nodes: composed };
  return { node: composed.length === 1 ? composed[0] : null, exact: false, nodes: composed };
}

// Full resolution for one rendered element.
// views: every view read (with `excluded` flags), serverArch: arch from get_views.
function xrayXPathLiteral(value) {
  if (!value.includes("'")) return "'" + value + "'";
  if (!value.includes('"')) return '"' + value + '"';
  return 'concat(' + value.split("'").map((part) => "'" + part + "'").join(', "\'", ') + ')';
}

function xrayXPathMatches(root, expression) {
  const result = root.ownerDocument.evaluate(expression, root.ownerDocument, null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i));
}

function xrayFieldXPathExpression(name, subview = null) {
  const field = "field[@name=" + xrayXPathLiteral(name) + ']';
  if (!subview?.field || !subview.tag) return '//' + field;
  return '//field[@name=' + xrayXPathLiteral(subview.field) + ']/' + subview.tag + '/' + field;
}

function xrayFieldXPath(root, node, serverRoot = null, serverNode = null) {
  if (node.tagName !== 'field') return null;
  const name = node.getAttribute('name');
  if (!name) return null;
  let subviewNode = node.parentElement;
  while (subviewNode && !['list', 'tree'].includes(subviewNode.tagName)) subviewNode = subviewNode.parentElement;
  let parentField = subviewNode?.parentElement;
  while (parentField && parentField.tagName !== 'field') parentField = parentField.parentElement;
  const expression = xrayFieldXPathExpression(name, parentField?.getAttribute('name') ? {
    field: parentField.getAttribute('name'), tag: subviewNode.tagName,
  } : null);
  const matches = xrayXPathMatches(root, expression);
  const serverMatches = serverRoot ? xrayXPathMatches(serverRoot, expression) : [];
  return { expression, strategy: 'attribute', matches: matches.length,
    server: !serverRoot ? 'unavailable' : serverNode && serverMatches.length === 1 &&
      serverMatches[0] === serverNode ? 'confirmed' : 'divergent' };
}

function xrayResolveOrigin({ loadedId, views, serverArch, target }) {
  const { root, order } = xrayHierarchy(loadedId, views);
  const composed = xrayCompose(root, order);
  const warnings = composed.warnings.map((w) => w.message + ' (view ' + w.viewId + ')');
  let certainty = composed.warnings.length ? 'provável' : 'exata';
  let candidates;
  let evidence;
  let serverRoot = null;
  const serverNodes = new Map();
  if (serverArch) {
    serverRoot = xrayParseArch(serverArch);
    const match = xrayMatch(serverRoot, target);
    evidence = match.evidence;
    if (!match.nodes.length) {
      return { certainty: 'desconhecida', applied: [root, ...order].map((v) => v.id), candidates: [], evidence,
        warnings: [...warnings, 'Elemento não encontrado na arquitetura retornada pelo servidor.'] };
    }
    const mapped = (match.chosen ? [match.chosen] : match.nodes).map((node) => {
      const correspondence = xrayCorrespond(serverRoot, node, composed.root);
      if (correspondence.exact && correspondence.node) serverNodes.set(correspondence.node, node);
      return correspondence;
    });
    if (!match.chosen) certainty = 'ambígua';
    if (mapped.some((m) => !m.exact)) {
      if (certainty === 'exata') certainty = 'provável';
      warnings.push('A arquitetura do servidor difere da composição das views (customização Python ou grupos).');
    }
    candidates = mapped.flatMap((m) => (m.node ? [m.node] : m.nodes));
  } else {
    const match = xrayMatch(composed.root, target);
    evidence = match.evidence;
    candidates = match.chosen ? [match.chosen] : match.nodes;
    certainty = match.chosen ? 'provável' : 'ambígua';
    warnings.push('Arquitetura do servidor indisponível; correspondência não conferida.');
  }
  candidates = [...new Set(candidates)];
  if (!candidates.length) {
    certainty = 'desconhecida';
    warnings.push('Elemento ausente da composição XML: provável criação por código Python.');
  } else if (candidates.length > 1) certainty = 'ambígua';
  return {
    certainty, evidence, warnings,
    applied: [root, ...order].map((view) => view.id),
    candidates: candidates.map((node) => ({
      signature: xraySignature(node),
      xpath: xrayFieldXPath(composed.root, node, serverRoot, serverNodes.get(node)),
      created: composed.meta.get(node)?.created || null,
      replaced: composed.meta.get(node)?.replaced || null,
      events: composed.meta.get(node)?.events || [],
    })),
  };
}
