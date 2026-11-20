// DOM harness geometry from the rendered pixel properties. Includes the clipping viewport and scroll offsets.
export function responsiveBoxes(f) {
  const frame = f.el('grid-frame'), grid = f.el('button-grid');
  const px = value => parseFloat(value) || 0;
  frame.rect = {left:0,top:0,width:px(frame.style.width),height:px(frame.style.height)};
  grid.rect = {left:-frame.scrollLeft,top:-frame.scrollTop,width:px(grid.style.width),height:px(grid.style.height)};
  function fill(surface) {
    for (const node of surface.children) {
      if (node.style['--kx'] === undefined) continue;
      node.rect = {left:surface.rect.left + px(node.style['--kx']),top:surface.rect.top + px(node.style['--ky']),width:px(node.style['--kw']),height:px(node.style['--kh'])};
      if (node.className === 'edit-remove') { node.rect = {...node.rect,left:node.rect.left-14,top:node.rect.top-14,width:44,height:44}; }
      if (node.className !== 'pages-widget') continue;
      const strip = node.children.find(child => child.className.startsWith('pages-strip'));
      const body = node.children.find(child => child.className === 'pages-body'), inner = body.children[0], h = strip ? 32 : 0; // T97: the Pages strip is 32px (it was 44px)
      if (strip) {
        strip.rect = {...node.rect,height:h};
        const owner = strip.children.find(child => child.className === 'pages-owner');
        const tabs = strip.children.find(child => child.className === 'pages-tabs') ?? strip;
        if (owner) {
          owner.rect = {left:node.rect.left,top:node.rect.top,width:86,height:h};
          owner.children[0].rect = {...owner.rect,width:44};
          tabs.rect = {...strip.rect,left:strip.rect.left+86,width:strip.rect.width-86};
        }
        tabs.children.forEach((tab,index)=>tab.rect={left:node.rect.left+(owner?86:0)+index*88-tabs.scrollLeft,top:node.rect.top,width:84,height:h});
      }
      body.rect = {left:node.rect.left,top:node.rect.top+h,width:node.rect.width,height:node.rect.height-h};
      inner.rect = {left:body.rect.left-body.scrollLeft,top:body.rect.top-body.scrollTop,width:px(inner.style.width),height:px(inner.style.height)};
      fill(inner);
    }
  }
  fill(grid);
  return grid;
}
export const treeFind = (node, match) => {for(const child of node.children??[]){if(match(child))return child;const result=treeFind(child,match);if(result)return result;}};
export const treeAll = (node, match, result=[]) => {for(const child of node.children??[]){if(match(child))result.push(child);treeAll(child,match,result);}return result;};
