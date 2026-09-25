// Shared object-oriented boundaries for the extension. Files loaded later use
// this namespace instead of coupling themselves directly to browser APIs.
var OdooXray = globalThis.OdooXray || (globalThis.OdooXray = {});

OdooXray.SettingsSchema = class SettingsSchema {
  static defaults = Object.freeze({
    enabled: true, activationMode: 'shortcut', activationModifiers: Object.freeze(['alt']),
    hoverDelay: 700, editorTemplate: 'vscode://file/{file}:{line}', theme: 'modern',
    panelMode: 'overlay', panelSide: 'right', panelWidth: 520,
    tooltipPlacement: 'auto', tooltipHighlight: true, tooltipDensity: 'comfortable',
  });
  static panelModes = Object.freeze(['overlay', 'push', 'modal']);
  static panelSides = Object.freeze(['left', 'right']);
  static tooltipPlacements = Object.freeze(['auto', 'below', 'above']);
  static tooltipDensities = Object.freeze(['comfortable', 'compact']);
  static panelWidth = Object.freeze({ min: 360, max: 900 });

  normalize(raw = {}) {
    const type = this.constructor;
    const defaults = type.defaults;
    const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
      activationMode: oneOf(raw.activationMode, ['shortcut', 'always'], defaults.activationMode),
      activationModifiers: Array.isArray(raw.activationModifiers) && raw.activationModifiers.length ?
        raw.activationModifiers : [...defaults.activationModifiers],
      hoverDelay: Number.isInteger(raw.hoverDelay) ?
        Math.max(100, Math.min(5000, raw.hoverDelay)) : defaults.hoverDelay,
      editorTemplate: typeof raw.editorTemplate === 'string' && raw.editorTemplate ?
        raw.editorTemplate : defaults.editorTemplate,
      theme: typeof raw.theme === 'string' && raw.theme ? raw.theme : defaults.theme,
      panelMode: oneOf(raw.panelMode, type.panelModes, defaults.panelMode),
      panelSide: oneOf(raw.panelSide, type.panelSides, defaults.panelSide),
      panelWidth: Number.isFinite(raw.panelWidth) ?
        Math.max(type.panelWidth.min, Math.min(type.panelWidth.max, Math.round(raw.panelWidth))) : defaults.panelWidth,
      tooltipPlacement: oneOf(raw.tooltipPlacement, type.tooltipPlacements, defaults.tooltipPlacement),
      tooltipHighlight: typeof raw.tooltipHighlight === 'boolean' ? raw.tooltipHighlight : defaults.tooltipHighlight,
      tooltipDensity: oneOf(raw.tooltipDensity, type.tooltipDensities, defaults.tooltipDensity),
    };
  }
};

OdooXray.RequestValidator = class RequestValidator {
  constructor(runtimeId) { this.runtimeId = runtimeId; }

  allowsSender(sender) {
    if (sender.id !== this.runtimeId || !sender.tab?.url) return false;
    try {
      const url = new URL(sender.tab.url);
      return (url.protocol === 'http:' || url.protocol === 'https:') &&
        (url.pathname.startsWith('/web') || url.pathname === '/odoo' || url.pathname.startsWith('/odoo/'));
    } catch (_error) { return false; }
  }

  isOpen(message) {
    return message?.type === 'xray.openInEditor' && typeof message.file === 'string' &&
      message.file.startsWith('/') && !message.file.includes('\0') &&
      Number.isInteger(message.line) && message.line > 0;
  }

  isLookup(message) {
    const request = message?.request;
    if (message?.type !== 'xray.localRequest') return false;
    if (['locate_field', 'locate_method'].includes(request?.action)) {
      return typeof request.model === 'string' && typeof (request.field || request.method) === 'string';
    }
    if (request?.action === 'locate_view') {
      return typeof request.xml_id === 'string' && typeof request.arch_fs === 'string' &&
        typeof request.arch === 'string' && request.arch.length <= 1024 * 1024 &&
        Array.isArray(request.nodes) && request.nodes.length <= 64 &&
        request.nodes.every((node) => Number.isInteger(node) && node >= 0);
    }
    if (request?.action === 'locate_menu') {
      return typeof request.xml_id === 'string' && /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_.-]+$/.test(request.xml_id);
    }
    return request?.action === 'resolve_file' && typeof request.file === 'string' &&
      request.file.startsWith('/') && !request.file.includes('\0') && request.file.length <= 4096;
  }

  accepts(message, sender) {
    return this.allowsSender(sender) && (this.isOpen(message) || this.isLookup(message));
  }
};

OdooXray.LocalGateway = class LocalGateway {
  constructor(runtime, fetchImpl, options = {}) {
    this.runtime = runtime;
    // Browser fetch requires the WorkerGlobalScope receiver. Binding it here
    // prevents `this.fetch(...)` from using the gateway instance as `this`.
    this.fetch = fetchImpl.bind(globalThis);
    this.nativeHost = options.nativeHost || 'com.odoo_xray.editor';
    this.bridgeUrl = options.bridgeUrl || 'http://127.0.0.1:17654/open';
  }

  bridge(request) {
    return this.fetch(this.bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Odoo-XRay-Extension': this.runtime.id },
      body: JSON.stringify(request),
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok || !body.ok) throw new Error(body.error || 'ponte local recusou o pedido');
      return body;
    });
  }

  native(request, respond, previousError = '') {
    this.runtime.sendNativeMessage(this.nativeHost, request, (response) => {
      const nativeError = this.runtime.lastError?.message || response?.error;
      if (!nativeError && response?.ok) { respond(response); return; }
      respond({ error: [previousError, nativeError].filter(Boolean).join('; ') });
    });
  }

  send(request, respond) {
    this.runtime.sendNativeMessage(this.nativeHost, request, (response) => {
      const nativeError = this.runtime.lastError?.message || response?.error;
      if (!nativeError && response?.ok) { respond(response); return; }
      this.bridge(request).then(respond).catch((error) => respond({
        error: [nativeError, 'ponte local: ' + error.message].filter(Boolean).join('; '),
      }));
    });
  }

  lookup(request, respond) {
    this.bridge(request).then(respond).catch((error) => {
      this.native(request, respond, 'ponte local: ' + error.message);
    });
  }
};

OdooXray.BackgroundController = class BackgroundController {
  constructor({ runtime, storage, gateway, validator, schedule = setTimeout, fallbackDelay = 900 }) {
    Object.assign(this, { runtime, storage, gateway, validator, schedule, fallbackDelay });
  }
  start() { this.runtime.onMessage.addListener(this.handle.bind(this)); }
  handle(message, sender, respond) {
    if (!this.validator.accepts(message, sender)) {
      respond({ ok: false, error: 'pedido de abertura inválido' });
      return false;
    }
    if (this.validator.isLookup(message)) {
      this.storage.sync.get(['projectRoots', 'mappings'], (settings) => {
        const roots = Array.isArray(settings.projectRoots) ? settings.projectRoots :
          (settings.mappings || []).map((mapping) => mapping.host);
        this.gateway.lookup({ ...message.request, roots }, respond);
      });
      return true;
    }
    this.schedule(() => this.gateway.send({ action: 'open', file: message.file, line: message.line }, respond),
      this.fallbackDelay);
    return true;
  }
};
