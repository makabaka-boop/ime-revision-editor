// dom-host.js — contenteditable 宿主：模型渲染成 DOM、DOM 选区映射回逻辑选区，
// 并把浏览器事件转译给 Editor。浏览器环境专用（document 存在时）。
//
// DOM 结构（每个模型字符一个 span，data-cid 与字符 id 一一对应）：
//   <div contenteditable>
//     <p data-pid="..."><span data-cid="...">字</span>...<br class="ph"></p>
//   </p>
// 逻辑偏移只数“存活字符”对应的 span（rev-del 的 span 与组合临时态不计数）。

import { Editor, Selection } from './editor.js';
import { modelToHtml, revisionTableHtml } from './render.js';

export class DomHost {
  constructor(root) {
    this.root = root;
    this.editor = null;
    this._rendering = false;
  }

  attachEditor(editor) {
    this.editor = editor;
    this._wire();
  }

  getSelection() {
    return readDomSelection(this.root, this.editor.model);
  }

  // 全量渲染：以字符 id 为键，保证渲染后选区仍指向“同一个字符”。
  render(model, selection) {
    this._rendering = true;
    try {
      for (let i = 0; i < this.root.children.length; i++) {
        const pEl = this.root.children[i];
        const p = model.paragraphs[i];
        if (!p) {
          this.root.removeChild(pEl);
          i--;
          continue;
        }
        this._renderPara(pEl, p);
        pEl.dataset.pid = p.id;
      }
      for (let i = this.root.children.length; i < model.paragraphs.length; i++) {
        const pEl = document.createElement('p');
        this._renderPara(pEl, model.paragraphs[i]);
        pEl.dataset.pid = model.paragraphs[i].id;
        this.root.appendChild(pEl);
      }
    } finally {
      this._rendering = false;
    }
    if (selection) writeDomSelection(this.root, model, selection);
  }

  // 全量协调一个段落的子节点，使其与模型物理字符数组逐一对应。
  // 关键点：组合期间浏览器可能插入不带 data-cid 的原生文本节点，
  // 以及浏览器自行加的 <br>；这些游离节点必须清掉，否则模型与 DOM 漂移。
  _renderPara(pEl, para) {
    const existing = new Map();
    for (const n of [...pEl.childNodes]) {
      if (n.nodeType === 1 && n.dataset && n.dataset.cid) existing.set(n.dataset.cid, n);
      else pEl.removeChild(n); // 游离文本节点（IME 残留）、多余 <br> 等
    }
    if (para.chars.length === 0) {
      pEl.textContent = '';
      const br = document.createElement('br');
      br.className = 'ph';
      pEl.appendChild(br);
      return;
    }
    // 按模型顺序就地排列/创建字符 span（正向协调，保持已有 DOM 节点以维持身份）。
    const wanted = para.chars;
    for (let i = 0; i < wanted.length; i++) {
      const c = wanted[i];
      let span = existing.get(c.id);
      if (!span) {
        span = document.createElement('span');
        span.dataset.cid = c.id;
      } else {
        existing.delete(c.id);
      }
      if (pEl.childNodes[i] !== span) pEl.insertBefore(span, pEl.childNodes[i] || null);
      this._styleChar(span, c);
      if (span.textContent !== c.ch) span.textContent = c.ch;
    }
    // 模型里已不存在的旧 span（撤销/拒绝后）移除。
    for (const old of [...existing.values()]) {
      if (old.parentElement === pEl) pEl.removeChild(old);
    }
  }

  _styleChar(span, c) {
    span.className = '';
    const classes = [];
    if (c.bold) classes.push('c-bold');
    if (c.ins) classes.push('c-ins');
    if (c.del) classes.push('c-del');
    if (c.ins === '__composition__') classes.push('c-comp');
    span.className = classes.join(' ');
    span.dataset.rev = c.ins && c.ins !== '__composition__' ? c.ins : c.del || '';
  }

  _wire() {
    this.root.addEventListener('beforeinput', (e) => {
      const sel = this.getSelection();
      const composing = this.editor.composing || e.isComposing;
      const prevent = this.editor.beforeInput(e.inputType, e.data, sel, { composing });
      if (prevent) e.preventDefault();
      if (e.inputType === 'insertCompositionText') this._lastCompData = e.data;
    });

    this.root.addEventListener('input', (e) => {
      // input 仅用于对账，绝不修改模型（防重复记账的关键约束之一）。
      this.editor.input(e.inputType, e.data, null, { composing: e.isComposing });
      // 非组合期若浏览器绕过 beforeinput 改了 DOM，立即用模型校正。
      if (!e.isComposing && !this.editor.composing) {
        this.render(this.editor.model, this.editor.selection);
      }
    });

    // beforeinput 是组合更新的主入口（Chrome/Edge/Safari）。compositionupdate
    // 作为不支持 inputType=insertCompositionText 的环境（旧内核）的兜底；
    // 两者用 _lastCompData 去重，同一临时串只同步一次。
    this.root.addEventListener('compositionstart', () => {
      this._lastCompData = null;
      if (!this.editor.composing) this.editor.compositionStart(this.getSelection());
    });
    this.root.addEventListener('compositionupdate', (e) => {
      if (!this.editor.composing) this.editor.compositionStart(this.getSelection());
      if (this._lastCompData !== e.data) {
        this.editor.compositionUpdate(e.data);
        this._lastCompData = e.data;
      }
    });
    this.root.addEventListener('compositionend', (e) => {
      this.editor.compositionEnd(e.data, this.getSelection());
      this._lastCompData = null;
    });

    this.root.addEventListener('paste', (e) => {
      e.preventDefault(); // 永远不允许浏览器直接把 HTML 放进文档
      const dt = e.clipboardData;
      const textPlain = dt ? dt.getData('text/plain') : '';
      const textHtml = dt ? dt.getData('text/html') : '';
      this.editor.paste({ textPlain, textHtml }, this.getSelection());
    });

    document.addEventListener('selectionchange', () => {
      if (this._rendering || this.editor.composing) return; // 组合期间由浏览器持有真实光标
      if (!this._selectionInside()) return;
      const sel = this.getSelection();
      if (sel) this.editor.setSelection(sel);
    });

    this.root.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        this.editor.toggleBold(this.getSelection());
      } else if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) this.editor.redo();
        else this.editor.undo();
      }
    });
  }

  _selectionInside() {
    const sel = window.getSelection();
    return sel && sel.rangeCount > 0 && this.root.contains(sel.anchorNode);
  }
}

// ---------- 选区映射 ----------

// 把一个 DOM 边界（node/offset）换算成段内逻辑偏移（只数存活字符 span）。
function boundaryFromNode(root, model, node, offset) {
  // 文本节点：每个字符 span 内只有一个码点；textOffset 0=字符前，否则视为字符后。
  let spanEl = null;
  let afterChar = false;
  if (node.nodeType === 3) {
    spanEl = node.parentElement;
    afterChar = offset > 0;
  } else {
    // 元素边界：node 是 <p>（或字符 span，浏览器一般只给 <p>）。
    if (node.dataset && node.dataset.cid) {
      spanEl = node;
      afterChar = offset > 0;
    }
  }

  // 向上定位所属 <p>。
  let pEl = spanEl;
  if (!pEl) pEl = node.nodeType === 1 && node.parentElement === root ? node : null;
  while (pEl && pEl.parentElement !== root) pEl = pEl.parentElement;
  if (!pEl) return null;
  const pi = [...root.children].indexOf(pEl);
  const para = model.paragraphs[pi];
  if (!para) return null;

  let logical = 0;
  if (spanEl && pEl.contains(spanEl)) {
    // 数到该 span；afterChar 决定是否计入它自身。
    for (const n of pEl.childNodes) {
      if (n === spanEl) {
        if (afterChar && isAliveSpan(n, model, pi)) logical++;
        break;
      }
      if (isAliveSpan(n, model, pi)) logical++;
    }
  } else {
    // 边界直接落在 <p> 上：offset 为子节点下标。
    for (let i = 0; i < offset && i < pEl.childNodes.length; i++) {
      if (isAliveSpan(pEl.childNodes[i], model, pi)) logical++;
    }
  }
  return { para: pi, offset: logical };
}

function isAliveSpan(node, model, pi) {
  if (!node || node.nodeType !== 1 || !node.dataset || !node.dataset.cid) return false;
  const para = model.paragraphs[pi];
  const c = para && para.chars.find((x) => x.id === node.dataset.cid);
  return !!c && !c.del && c.ins !== '__composition__';
}

function readDomSelection(root, model) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const a = boundaryFromNode(root, model, sel.anchorNode, sel.anchorOffset);
  const f = boundaryFromNode(root, model, sel.focusNode, sel.focusOffset);
  if (!a || !f) return null;
  return new Selection(a, f);
}

// 逻辑位置 -> DOM 子节点下标（与 model.physicalIndex 同语义：跨过删除聚簇）。
function childIndexAt(pEl, model, pi, logical) {
  let seen = 0;
  let i = 0;
  for (; i < pEl.childNodes.length; i++) {
    if (isAliveSpan(pEl.childNodes[i], model, pi)) {
      if (seen === logical) break; // 第 logical+1 个存活字符之前
      seen++;
    }
  }
  // 跨过第 logical 个存活字符之后紧邻的删除字符聚簇（含 <br> 之前的 c-del span）。
  while (i < pEl.childNodes.length && pEl.childNodes[i].nodeType === 1 && !isAliveSpan(pEl.childNodes[i], model, pi) && pEl.childNodes[i].dataset && pEl.childNodes[i].dataset.cid) {
    i++;
  }
  return i;
}

function writeDomSelection(root, model, selection) {
  const put = (pos) => {
    const pEl = root.children[pos.para];
    if (!pEl) return;
    const idx = childIndexAt(pEl, model, pos.para, pos.offset);
    const range = document.createRange();
    if (pEl.childNodes.length === 0) range.setStart(pEl, 0);
    else range.setStart(pEl, Math.min(idx, pEl.childNodes.length));
    range.collapse(true);
    return range;
  };
  const domSel = window.getSelection();
  if (!domSel) return;
  // 用方向规整的起/点构造 Range，再按 anchor/focus 的实际方向决定选区方向。
  const range = document.createRange();
  const startPos = selection.start;
  const endPos = selection.end;
  const rs = put(startPos);
  const re = put(endPos);
  if (!rs || !re) return;
  range.setStart(rs.startContainer, rs.startOffset);
  range.setEnd(re.startContainer, re.startOffset);
  domSel.removeAllRanges();
  domSel.addRange(range);
}

// ---------- 一键装配 UI ----------

export function mount({ editEl, readEl, tableEl, model, onUpdate } = {}) {
  editEl.setAttribute('contenteditable', 'true');
  editEl.spellcheck = false;
  const host = new DomHost(editEl);
  const editor = new Editor(host, model);

  const refresh = () => {
    if (readEl) readEl.innerHTML = modelToHtml(editor.model, 'tracked');
    if (tableEl) tableEl.innerHTML = revisionTableHtml(editor.model);
    if (onUpdate) onUpdate(editor);
  };
  // 编辑器每次事务后调用 host.render；在这里顺带刷新阅读视图/修订表，
  // 保证三者永远由同一次模型变更驱动。
  const hostRender = host.render.bind(host);
  host.render = (m, sel) => {
    hostRender(m, sel);
    refresh();
  };
  editor.render();

  if (tableEl) {
    tableEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.dataset.rev;
      if (btn.dataset.act === 'accept') editor.accept(id);
      else editor.reject(id);
    });
  }
  return { host, editor, refresh };
}
