/** @odoo-module **/

import { patch } from '@web/core/utils/patch';
import { session } from '@web/session';
import { Field } from '@web/views/fields/field';
import { FormLabel } from '@web/views/form/form_label';
import { ListRenderer } from '@web/views/list/list_renderer';

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
