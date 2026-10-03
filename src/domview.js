// DOM 视图：把模型渲染进 contenteditable，并在
// 模型线性偏移 <-> DOM (node, offset) 之间双向映射选区。

function nodeTextLength(node) {
  if (node.nodeType === 3) return node.data.length;
  let n = 0;
  for (let i = 0; i < node.childNodes.length; i++) n += nodeTextLength(node.childNodes[i]);
  return n;
}

function elementChildren(node) {
  const out = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    if (node.childNodes[i].nodeType === 1) out.push(node.childNodes[i]);
  }
  return out;
}

function paraStartOffset(root, p) {
  let pos = 0;
  for (const child of elementChildren(root)) {
    if (child === p) break;
    pos += nodeTextLength(child) + 1;
  }
  return pos;
}

function indexInParent(node) {
  const siblings = node.parentNode.childNodes;
  for (let i = 0; i < siblings.length; i++) if (siblings[i] === node) return i;
  return -1;
}

// (target, targetOffset) 在 container 文本内的相对偏移；找不到返回 -1。
function offsetWithin(container, target, targetOffset) {
  if (container === target) return targetOffset;
  let acc = 0;
  for (let i = 0; i < container.childNodes.length; i++) {
    const c = container.childNodes[i];
    if (c === target) return acc + targetOffset;
    if (c.nodeType === 1) {
      const r = offsetWithin(c, target, targetOffset);
      if (r >= 0) return acc + r;
    }
    acc += nodeTextLength(c);
  }
  return -1;
}

// DOM (node, offset) -> 模型线性偏移。
export function modelOffsetFromDomPosition(root, node, offset) {
  if (node.nodeType === 1) {
    if (node === root) {
      let pos = 0;
      const kids = elementChildren(root);
      for (let i = 0; i < offset && i < kids.length; i++) pos += nodeTextLength(kids[i]) + 1;
      return pos;
    }
    let base;
    if (node.tagName === 'P') {
      base = paraStartOffset(root, node);
    } else {
      base = modelOffsetFromDomPosition(root, node.parentNode, indexInParent(node));
    }
    for (let i = 0; i < offset && i < node.childNodes.length; i++) {
      base += nodeTextLength(node.childNodes[i]);
    }
    return base;
  }
  // 文本节点：向上找到所属 <p>。
  let p = node;
  while (p.parentNode && p.parentNode !== root) p = p.parentNode;
  if (!p.parentNode) return 0;
  const within = offsetWithin(p, node, offset);
  return paraStartOffset(root, p) + Math.max(0, within);
}

// 模型线性偏移 -> DOM { node, offset }。
export function domPositionFromModelOffset(root, offset) {
  let pos = 0;
  const kids = elementChildren(root);
  for (let i = 0; i < kids.length; i++) {
    const len = nodeTextLength(kids[i]);
    if (offset <= pos + len || i === kids.length - 1) {
      return positionIn(kids[i], Math.max(0, Math.min(offset - pos, len)));
    }
    pos += len + 1;
  }
  return { node: root, offset: 0 };
}

function positionIn(p, char) {
  if (nodeTextLength(p) === 0) return { node: p, offset: 0 }; // 空段落（内含 <br>）
  const walk = (n, c) => {
    if (n.nodeType === 3) return { node: n, offset: Math.min(c, n.data.length) };
    let acc = 0;
    for (let i = 0; i < n.childNodes.length; i++) {
      const child = n.childNodes[i];
      const l = nodeTextLength(child);
      if (c <= acc + l) return walk(child, c - acc);
      acc += l;
    }
    return { node: n, offset: n.childNodes.length };
  };
  return walk(p, char);
}

export class DomView {
  // applySelection(sel) 可选：把模型选区写回真实 DOM Selection。
  constructor(root, applySelection = null) {
    this.root = root;
    this.applySelection = applySelection;
  }

  render(state) {
    const root = this.root;
    const document = root.ownerDocument;
    root.textContent = '';
    for (const p of state.doc.paragraphs) {
      const pel = document.createElement('p');
      let hasText = false;
      for (const s of p.spans) {
        if (!s.text) continue;
        hasText = true;
        let el = document.createTextNode(s.text);
        if (s.bold) {
          const w = document.createElement('strong');
          w.appendChild(el);
          el = w;
        }
        if (s.ins != null) {
          const w = document.createElement('span');
          w.className = 'rev-ins';
          w.appendChild(el);
          el = w;
        }
        if (s.del != null) {
          const w = document.createElement('del');
          w.className = 'rev-del';
          w.appendChild(el);
          el = w;
        }
        pel.appendChild(el);
      }
      if (!hasText) pel.appendChild(document.createElement('br'));
      root.appendChild(pel);
    }
    if (this.applySelection) this.applySelection(state.sel);
  }
}
