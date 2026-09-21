let mappings = [];

function renderMappings() {
  const el = document.getElementById('mappings');
  el.innerHTML = '';
  mappings.forEach((m, i) => {
    const div = document.createElement('div');
    div.className = 'pair';
    div.style.display = 'flex';
    div.style.gap = '8px';
    div.innerHTML =
      '<code style="flex:1">' + m.container + '</code>' +
      '<code style="flex:1">' + m.host + '</code>' +
      '<button data-i="' + i + '">remover</button>';
    div.querySelector('button').addEventListener('click', () => {
      mappings.splice(i, 1);
      renderMappings();
    });
    el.appendChild(div);
  });
}

document.getElementById('addMapping').addEventListener('click', () => {
  const c = document.getElementById('newContainer').value.trim();
  const h = document.getElementById('newHost').value.trim();
  if (!c || !h) return;
  mappings.push({ container: c, host: h });
  document.getElementById('newContainer').value = '';
  document.getElementById('newHost').value = '';
  renderMappings();
});

document.getElementById('save').addEventListener('click', () => {
  const data = {
    enabled: document.getElementById('enabled').checked,
    editorTemplate: document.getElementById('editorTemplate').value || 'vscode://file/{file}:{line}',
    mappings,
  };
  chrome.storage.sync.set(data, () => {
    const status = document.getElementById('status');
    status.textContent = 'Salvo.';
    setTimeout(() => (status.textContent = ''), 1500);
  });
});

chrome.storage.sync.get(['enabled', 'editorTemplate', 'mappings'], (v) => {
  document.getElementById('enabled').checked = v.enabled !== false;
  document.getElementById('editorTemplate').value = v.editorTemplate || 'vscode://file/{file}:{line}';
  mappings = Array.isArray(v.mappings) ? v.mappings : [];
  renderMappings();
});
