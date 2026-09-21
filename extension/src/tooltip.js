// CSS do tooltip, injetado num Shadow DOM — por isso vive num <style> JS em
// vez de manifest.json "css": o tema do Odoo não pode vazar pra dentro nem
// o inverso, e content_scripts.css não atravessa a fronteira do shadow root.
const XRAY_TOOLTIP_CSS = `
#xray-tooltip-host {
  position: fixed;
  z-index: 2147483647;
  display: none;
  font-family: monospace;
  font-size: 12px;
  pointer-events: auto;
}
.xray-box {
  background: #1e1e1e;
  color: #d4d4d4;
  border: 1px solid #454545;
  border-radius: 4px;
  padding: 6px 8px;
  min-width: 220px;
  max-width: 480px;
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
}
.xray-row { padding: 2px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.xray-title { font-weight: bold; color: #9cdcfe; }
.xray-loading, .xray-muted { color: #808080; font-style: italic; }
.xray-error { color: #f48771; }
.xray-loc { cursor: default; }
.xray-clickable { cursor: pointer; color: #4ec9b0; }
.xray-clickable:hover { text-decoration: underline; }
`;
