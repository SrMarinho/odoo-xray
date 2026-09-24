// Owns page events. Rendering and data access are injected through the
// existing content-script boundaries, keeping browser event policy in one place.
class XrayInteractionController {
  constructor(root = document) {
    this.root = root;
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onShortcutClick = this.onShortcutClick.bind(this);
    this.onDirectClick = this.onDirectClick.bind(this);
  }

  start() {
    this.root.addEventListener('mousemove', this.onMouseMove, { passive: true });
    this.root.addEventListener('click', this.onShortcutClick, { capture: true });
    this.root.addEventListener('click', this.onDirectClick, true);
  }

  onMouseMove(event) {
    clearTimeout(xrayHoverTimer);
    if ((xrayTooltipEl && event.target === xrayTooltipEl.host) ||
        (xrayPanel && event.target === xrayPanel.host)) {
      clearTimeout(xrayHideTimer);
      return;
    }
    if (!xrayEnabled || !xrayActivationMatches(event)) { xrayHide(); return; }
    const target = event.target;
    xrayHoverTimer = setTimeout(() => this.inspectHover(target),
      xrayActivationMode === 'always' ? xrayHoverDelay : XRAY_DEBOUNCE_MS);
  }

  async inspectHover(target) {
    let info = xrayExtract(target);
    if (!info) { xrayHide(); return; }
    info = await xrayResolveInspection(info);
    const anchor = info.column || info.node?.matches('[data-xray-model]') ? info.node :
      target.closest('.o_field_widget, .o_form_label, [data-tooltip-info]') || info.node;
    clearTimeout(xrayHideTimer);
    if (xrayActivationMode === 'shortcut') {
      xrayAnchor = anchor;
      xrayHoverInfo = info.model && (info.identity || info.field || info.tag) ? info : null;
      xrayShowHighlight(anchor);
      return;
    }
    if (xrayAnchor === anchor && xrayTooltipEl?.host.classList.contains('xray-open')) return;
    xrayRenderBasic(info, anchor);
    if (!info.field) return;
    if (info.fieldModelError) { xrayRenderLocations(info, { error: info.fieldModelError }); return; }
    const result = await xrayLocateField(info.model, info.field);
    if (xrayAnchor !== anchor) return;
    xrayRenderLocations(info, result);
    xrayPositionTooltip();
  }

  onShortcutClick(event) {
    if (!xrayEnabled || xrayActivationMode !== 'shortcut' || !xrayActivationMatches(event)) return;
    if ((xrayTooltipEl && event.target === xrayTooltipEl.host) ||
        (xrayPanel && event.target === xrayPanel.host)) return;
    if (!xrayHoverInfo || !xrayAnchor?.isConnected) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    xrayShowViewPanel(xrayHoverInfo);
  }

  onDirectClick(event) {
    if (!xrayEnabled || xrayActivationMode === 'always' || !xrayActivationMatches(event)) return;
    if ((xrayTooltipEl && event.target === xrayTooltipEl.host) ||
        (xrayPanel && event.target === xrayPanel.host)) return;
    const info = xrayExtract(event.target);
    if (!info?.model || !(info.identity || info.field || info.tag)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    xrayResolveInspection(info).then(xrayShowViewPanel);
  }
}

const xrayInteractionController = new XrayInteractionController();
xrayInteractionController.start();
