// 页面装配：事件接线 + 阅读视图 / 修订表 / 导出面板（全部从同一模型生成）。

import { Editor } from './editor.js';
import { DomView, domPositionFromModelOffset, modelOffsetFromDomPosition } from './domview.js';
import { finalParagraphs, exportHtml } from './derive.js';

const editorEl = document.getElementById('editor');
const readingEl = document.getElementById('reading');
const revisionsEl = document.getElementById('revisions');
const exportEl = document.getElementById('export');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnBold = document.getElementById('btn-bold');
const chkTrack = document.getElementById('chk-track');
const btnAcceptAll = document.getElementById('btn-accept-all');
const btnRejectAll = document.getElementById('btn-reject-all');

let syncingSelection = false;

const view = new DomView(editorEl, (sel) => {
  const a = domPositionFromModelOffset(editorEl, sel.anchor);
  const h = domPositionFromModelOffset(editorEl, sel.head);
  const s = window.getSelection();
  syncingSelection = true;
  try {
    s.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
  } catch {
    /* 忽略个别浏览器对边界位置的拒绝 */
  }
  setTimeout(() => { syncingSelection = false; }, 0);
});

const ed = new Editor(view);

// ---- 编辑器 DOM 事件 -> 控制器 ----

editorEl.addEventListener('beforeinput', (e) => {
  const r = ed.handleBeforeInput({
    inputType: e.inputType,
    data: e.data,
    isComposing: e.isComposing,
  });
  if (r.preventDefault) e.preventDefault();
});

editorEl.addEventListener('input', () => ed.handleInput());

editorEl.addEventListener('compositionstart', () => ed.compositionStart());
editorEl.addEventListener('compositionend', (e) => ed.compositionEnd(e.data ?? ''));

editorEl.addEventListener('paste', (e) => {
  e.preventDefault();
  const html = e.clipboardData.getData('text/html');
  const text = e.clipboardData.getData('text/plain');
  ed.paste({ html: html || null, text });
});

document.addEventListener('selectionchange', () => {
  if (syncingSelection || ed.composing) return;
  const s = window.getSelection();
  if (!s.anchorNode || !editorEl.contains(s.anchorNode) || !editorEl.contains(s.focusNode)) return;
  ed.setSelection({
    anchor: modelOffsetFromDomPosition(editorEl, s.anchorNode, s.anchorOffset),
    head: modelOffsetFromDomPosition(editorEl, s.focusNode, s.focusOffset),
  });
});

editorEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    ed.toggleBold();
  }
});

// ---- 工具栏 ----

btnUndo.addEventListener('click', () => ed.undo());
btnRedo.addEventListener('click', () => ed.redo());
btnBold.addEventListener('click', () => ed.toggleBold());
chkTrack.addEventListener('change', () => ed.setTrackChanges(chkTrack.checked));
btnAcceptAll.addEventListener('click', () => ed.acceptAll());
btnRejectAll.addEventListener('click', () => ed.rejectAll());

// ---- 面板（阅读视图 / 修订表 / 导出，均从同一模型派生） ----

function renderPanels(state) {
  readingEl.textContent = '';
  for (const p of finalParagraphs(state.doc)) {
    const pel = document.createElement('p');
    let hasText = false;
    for (const s of p.spans) {
      if (!s.text) continue;
      hasText = true;
      if (s.bold) {
        const st = document.createElement('strong');
        st.textContent = s.text;
        pel.appendChild(st);
      } else {
        pel.appendChild(document.createTextNode(s.text));
      }
    }
    if (!hasText) pel.appendChild(document.createElement('br'));
    readingEl.appendChild(pel);
  }

  revisionsEl.textContent = '';
  if (!state.revisions.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '无修订';
    revisionsEl.appendChild(li);
  }
  for (const r of state.revisions) {
    const li = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = `badge ${r.kind}`;
    badge.textContent = r.kind === 'insert' ? '插入' : '删除';
    const preview = document.createElement('span');
    preview.className = 'preview';
    const text = r.text.length > 24 ? r.text.slice(0, 24) + '…' : r.text;
    preview.textContent = ` “${text}”`;
    const accept = document.createElement('button');
    accept.textContent = '接受';
    accept.addEventListener('click', () => ed.acceptRevision(r.id));
    const reject = document.createElement('button');
    reject.textContent = '拒绝';
    reject.addEventListener('click', () => ed.rejectRevision(r.id));
    li.append(badge, preview, accept, reject);
    revisionsEl.appendChild(li);
  }

  exportEl.value = exportHtml(state.doc);
  btnUndo.disabled = !state.canUndo;
  btnRedo.disabled = !state.canRedo;
  btnBold.classList.toggle('active', state.typingBold);
  chkTrack.checked = state.trackChanges;
}

ed.onrender = renderPanels;
ed.render();
