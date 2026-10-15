// Runs without app dependencies in the exported HTML, including file:// pages.
export const traceExportRuntime = String.raw`(() => {
  const data = JSON.parse(document.getElementById('trace-data').textContent);
  const search = document.getElementById('trace-search');
  const count = document.getElementById('trace-count');
  const empty = document.getElementById('trace-empty');
  const clear = document.getElementById('trace-clear');
  const collapse = document.getElementById('trace-collapse');
  const expand = document.getElementById('trace-expand');
  const rows = Array.from(document.querySelectorAll('[data-trace-index]'));
  const collapsed = new Set(data.collapsed);
  const byKey = new Map(data.nodes.map(node => [node.key, node]));
  const toggleButtons = rows.map(row => row.querySelector('.fold-toggle'));

  const render = () => {
    const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = new Set();
    const retained = new Set();
    if (terms.length) {
      for (const node of data.nodes) {
        if (!terms.every(term => node.searchText.includes(term))) continue;
        matches.add(node.key);
        let ancestor = node;
        while (ancestor && !retained.has(ancestor.key)) {
          retained.add(ancestor.key);
          ancestor = byKey.get(ancestor.parentKey);
        }
      }
    }
    const hidden = new Set();
    let visible = 0;
    data.nodes.forEach((node, index) => {
      const parentHidden = hidden.has(node.parentKey) || collapsed.has(node.parentKey);
      if (parentHidden) hidden.add(node.key);
      const show = terms.length ? retained.has(node.key) : !parentHidden;
      rows[index].hidden = !show;
      rows[index].classList.toggle('is-context', !!terms.length && !matches.has(node.key));
      if (show) visible++;
      const button = toggleButtons[index];
      if (!button) return;
      const folded = !terms.length && collapsed.has(node.key);
      button.disabled = !!terms.length;
      button.textContent = folded ? '›' : '⌄';
      button.setAttribute('aria-expanded', String(!folded));
      button.setAttribute('aria-label', folded ? '展开子调用' : '折叠子调用');
    });
    collapse.disabled = expand.disabled = !!terms.length;
    clear.hidden = !search.value;
    empty.hidden = visible !== 0;
    count.textContent = terms.length
      ? '命中 ' + matches.size + ' / ' + data.nodes.length + ' · 保留父级路径'
      : visible + ' / ' + data.nodes.length + ' 个 Span';
  };
  search.value = data.keyword;
  search.addEventListener('input', render);
  clear.addEventListener('click', () => { search.value = ''; render(); search.focus(); });
  collapse.addEventListener('click', () => {
    data.nodes.filter(node => node.hasChildren).forEach(node => collapsed.add(node.key));
    render();
  });
  expand.addEventListener('click', () => { collapsed.clear(); render(); });
  toggleButtons.forEach((button, index) => {
    if (!button) return;
    button.addEventListener('click', () => {
      const key = data.nodes[index].key;
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      render();
    });
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault(); search.focus(); search.select();
    }
    if (event.key === 'Escape' && document.activeElement === search) {
      search.value = ''; render();
    }
  });
  render();
})();`;
