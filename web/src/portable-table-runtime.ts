export const portableTableRuntime = String.raw`(() => {
  for (const table of document.querySelectorAll('table')) {
    Array.from(table.tHead?.rows[0]?.cells || []).forEach((header, index) => {
      header.querySelectorAll('.column-resizer').forEach(button => button.remove());
      header.style.position = 'relative'; header.style.paddingRight = '24px';
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'column-resizer';
      button.title = '拖动调整列宽；双击自适应内容';
      button.setAttribute('aria-label','调整 ' + header.textContent.trim() + ' 列宽');
      const apply = width => {
        for (const row of table.rows) {
          const cell = row.cells[index]; if (!cell) continue;
          Object.assign(cell.style,{width:width+'px',minWidth:width+'px',maxWidth:width+'px'});
        }
      };
      const fit = () => {
        const context = document.createElement('canvas').getContext('2d');
        if (!context) return;
        let width = 80;
        for (const row of table.rows) {
          const cell = row.cells[index]; if (!cell) continue;
          const style = getComputedStyle(cell); context.font = style.font;
          for (const line of cell.textContent.split(/\r?\n/)) width = Math.max(width,context.measureText(line).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 22);
        }
        apply(Math.min(3000,Math.ceil(width)));
      };
      let start;
      button.onpointerdown = event => { start={x:event.clientX,width:header.getBoundingClientRect().width}; };
      button.onpointermove = event => { if(start&&Math.abs(event.clientX-start.x)>=3){if(!button.hasPointerCapture(event.pointerId))button.setPointerCapture(event.pointerId);apply(Math.max(80,Math.min(3000,start.width+event.clientX-start.x)));} };
      button.onpointerup = button.onpointercancel = () => { start=undefined; };
      button.ondblclick = fit;
      button.onkeydown = event => { if(event.key==='Enter'){event.preventDefault();fit();} };
      header.append(button);
    });
  }
})();`;

export const portableTableStyles = `.column-resizer{position:absolute;top:0;bottom:0;right:0;width:9px;padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;cursor:col-resize;touch-action:none}.column-resizer::after{content:"";position:absolute;top:20%;bottom:20%;left:4px;width:1px;background:transparent}th:hover>.column-resizer::after,.column-resizer:focus-visible::after{background:var(--cyan,#2ad4e0)}`;
