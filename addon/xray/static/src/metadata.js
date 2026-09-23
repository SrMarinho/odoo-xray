/** @odoo-module **/

import { patch } from '@web/core/utils/patch';
import { session } from '@web/session';
import { Field } from '@web/views/fields/field';
import { FormLabel } from '@web/views/form/form_label';
import { FormCompiler } from '@web/views/form/form_compiler';
import { InnerGroup, OuterGroup } from '@web/views/form/form_group/form_group';
import { ListRenderer } from '@web/views/list/list_renderer';
import { Notebook } from '@web/core/notebook/notebook';

const XRAY_ATTRIBUTES = ['data-xray-view-id', 'data-xray-node'];

function nodeMetadata(el) {
    if (!session.xray_enabled) return {};
    return Object.fromEntries(XRAY_ATTRIBUTES
        .filter((name) => el.hasAttribute(name))
        .map((name) => [name, el.getAttribute(name)]));
}

function attachMetadata(compiled, el, component = false) {
    const value = nodeMetadata(el);
    if (component && Object.keys(value).length) {
        compiled.setAttribute('xrayMetadata', JSON.stringify(value));
    } else {
        for (const [name, content] of Object.entries(value)) compiled.setAttribute(name, content);
    }
    return compiled;
}

function metadata(record, fieldInfo, name) {
    if (!session.xray_enabled) return {};
    const attrs = fieldInfo?.attrs || {};
    return {
        'data-xray-model': record.resModel,
        'data-xray-field': name,
        'data-xray-type': record.fields[name]?.type || '',
        'data-xray-widget': fieldInfo?.widget || '',
        'data-xray-view-id': attrs['data-xray-view-id'] || '',
        'data-xray-node': attrs['data-xray-node'] || '',
    };
}

patch(Field.prototype, {
    get xrayMetadata() { return metadata(this.props.record, this.props.fieldInfo, this.props.name); },
});
patch(FormLabel.prototype, {
    get xrayMetadata() { return metadata(this.props.record, this.props.fieldInfo, this.props.fieldName); },
});
patch(ListRenderer.prototype, {
    xrayCellMetadata(record, column) { return metadata(record, column, column.name); },
});

// Semantic form nodes become Owl components and otherwise lose custom XML
// attributes during compilation. Carry the signed node identity as one prop.
OuterGroup.props = [...OuterGroup.props, 'xrayMetadata?'];
InnerGroup.props = [...InnerGroup.props, 'xrayMetadata?'];
Notebook.props = { ...Notebook.props, xrayMetadata: { type: Object, optional: true } };

patch(FormCompiler.prototype, {
    compileForm(el, params) {
        return attachMetadata(super.compileForm(el, params), el);
    },
    compileGroup(el, params) {
        return attachMetadata(super.compileGroup(el, params), el, true);
    },
    compileHeader(el, params) {
        return attachMetadata(super.compileHeader(el, params), el);
    },
    compileNotebook(el, params) {
        const compiled = attachMetadata(super.compileNotebook(el, params), el, true);
        const pages = [...el.children].filter((child) => child.tagName.toLowerCase() === 'page');
        const slots = [...compiled.children];
        pages.forEach((page, index) => {
            const value = nodeMetadata(page);
            if (slots[index] && Object.keys(value).length) {
                slots[index].setAttribute('xrayMetadata', JSON.stringify(value));
            }
        });
        return compiled;
    },
    compileSeparator(el, params) {
        return attachMetadata(super.compileSeparator(el, params), el);
    },
    compileSheet(el, params) {
        return attachMetadata(super.compileSheet(el, params), el);
    },
});
