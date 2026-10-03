// 编辑器控制器：与 DOM 无关。持有文档、选区、撤销/重做栈、修订计数器，
// 以及输入法组合（IME）状态机。DOM 事件由视图层适配后转发到这里。

import {
  createDoc, cloneDoc, textLength, insertTextInto, deleteRange, markDeleted,
  splitParagraph, insertParagraphs, setBold, allBold, insertionAttrs,
  acceptRevision, rejectRevision, mapThroughRemovals,
} from './model.js';
import { listRevisions } from './derive.js';
import { sanitizeHtml, textToParagraphs } from './sanitize.js';

const collapsed = (o) => ({ anchor: o, head: o });
const rangeOf = (sel) => [Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head)];

export class Editor {
  // view: { render(state) }。state 见 getState()。
  constructor(view) {
    this.view = view;
    this.doc = createDoc();
    this.sel = collapsed(0);
    this.trackChanges = false;
    this.typingBold = false;
    this.undoStack = [];
    this.redoStack = [];
    this.revCounter = 1;
    this.composing = null;      // { sel } 组合会话
    this._mergeType = null;     // 'insert' | 'delete' | null：可合并的连续输入
    this._runRevId = null;      // 当前输入合并段使用的修订 id
    this.onrender = null;
  }

  // ---- 状态与渲染 -------------------------------------------------------

  getState() {
    return {
      doc: this.doc,
      sel: this.sel,
      trackChanges: this.trackChanges,
      typingBold: this.typingBold,
      revisions: listRevisions(this.doc),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  render() {
    const state = this.getState();
    this.view.render(state);
    if (this.onrender) this.onrender(state);
  }

  _clampOffset(o) {
    return Math.max(0, Math.min(o, textLength(this.doc)));
  }

  // 外部（DOM selectionchange）上报选区。与当前相同则忽略，
  // 否则视为用户主动移动光标：打断输入合并。
  setSelection(sel) {
    const anchor = this._clampOffset(sel.anchor);
    const head = this._clampOffset(sel.head);
    if (anchor === this.sel.anchor && head === this.sel.head) return;
    this.sel = { anchor, head };
    this._mergeType = null;
    this._runRevId = null;
  }

  // ---- 事务与历史 ---------------------------------------------------------

  _newRev() {
    return this.revCounter++;
  }

  // mergeType 相同且连续的提交合并为同一笔可撤销事务。
  _commit(doc, sel, mergeType = null) {
    if (mergeType === null || mergeType !== this._mergeType) {
      this.undoStack.push({ doc: this.doc, sel: this.sel });
    }
    this._mergeType = mergeType;
    if (mergeType !== 'insert' && mergeType !== 'delete') this._runRevId = null;
    this.redoStack.length = 0;
    this.doc = doc;
    this.sel = { anchor: this._clampOffset(sel.anchor), head: this._clampOffset(sel.head) };
    this.render();
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ doc: this.doc, sel: this.sel });
    this.doc = s.doc;
    this.sel = { anchor: this._clampOffset(s.sel.anchor), head: this._clampOffset(s.sel.head) };
    this._mergeType = null;
    this._runRevId = null;
    this.render();
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ doc: this.doc, sel: this.sel });
    this.doc = s.doc;
    this.sel = { anchor: this._clampOffset(s.sel.anchor), head: this._clampOffset(s.sel.head) };
    this._mergeType = null;
    this._runRevId = null;
    this.render();
  }

  // ---- 编辑操作 -----------------------------------------------------------

  // 在 [from, to) 上应用“若有选区先删除”的逻辑，返回删除后的文档与插入点。
  _deleteSelectionIfAny(doc, from, to) {
    if (from === to) return doc;
    if (this.trackChanges) markDeleted(doc, from, to, this._newRev());
    else deleteRange(doc, from, to);
    return doc;
  }

  insertText(text) {
    if (!text || this.composing) return;
    const [from, to] = rangeOf(this.sel);
    const doc = cloneDoc(this.doc);
    this._deleteSelectionIfAny(doc, from, to);
    let revId = null;
    if (this.trackChanges) {
      revId = this._mergeType === 'insert' && this._runRevId != null
        ? this._runRevId
        : this._newRev();
      this._runRevId = revId;
    }
    const attrs = insertionAttrs(doc, from, { bold: this.typingBold, trackRevId: revId });
    insertTextInto(doc, from, text, attrs);
    this._commit(doc, collapsed(from + text.length), 'insert');
  }

  _applyDelete(from, to, mergeType) {
    if (from >= to) return;
    const doc = cloneDoc(this.doc);
    if (this.trackChanges) {
      const revId = mergeType === 'delete' && this._mergeType === 'delete' && this._runRevId != null
        ? this._runRevId
        : this._newRev();
      this._runRevId = revId;
      markDeleted(doc, from, to, revId);
    } else {
      deleteRange(doc, from, to);
    }
    this._commit(doc, collapsed(from), mergeType);
  }

  deleteBackward() {
    const [from, to] = rangeOf(this.sel);
    const f = from === to ? from - 1 : from;
    if (f < 0) return;
    this._applyDelete(f, to, 'delete');
  }

  deleteForward() {
    const [from, to] = rangeOf(this.sel);
    const t = from === to ? to + 1 : to;
    if (t > textLength(this.doc)) return;
    this._applyDelete(from, t, 'delete');
  }

  deleteSelection() {
    const [from, to] = rangeOf(this.sel);
    this._applyDelete(from, to, null);
  }

  insertParagraph() {
    const [from, to] = rangeOf(this.sel);
    const doc = cloneDoc(this.doc);
    this._deleteSelectionIfAny(doc, from, to);
    splitParagraph(doc, from, this.trackChanges ? this._newRev() : null);
    this._commit(doc, collapsed(from + 1), null);
  }

  toggleBold() {
    const [from, to] = rangeOf(this.sel);
    if (from === to) {
      this.typingBold = !this.typingBold;
      this.render();
      return;
    }
    const bold = !allBold(this.doc, from, to);
    const doc = cloneDoc(this.doc);
    setBold(doc, from, to, bold);
    this.typingBold = bold;
    this._commit(doc, { ...this.sel }, null);
  }

  setTrackChanges(on) {
    this.trackChanges = !!on;
    this._mergeType = null;
    this._runRevId = null;
    this.render();
  }

  // 粘贴：纯文本或净化后的 HTML，一笔事务。
  paste({ text = '', html = null } = {}) {
    const paras = html != null ? sanitizeHtml(html) : textToParagraphs(text);
    const [from, to] = rangeOf(this.sel);
    const doc = cloneDoc(this.doc);
    this._deleteSelectionIfAny(doc, from, to);
    const ins = this.trackChanges ? this._newRev() : null;
    const inserted = insertParagraphs(doc, from, paras, { ins });
    this._commit(doc, collapsed(from + inserted), null);
  }

  // ---- 修订接受 / 拒绝 ------------------------------------------------------

  _applyRevisionOp(op, revId) {
    const doc = cloneDoc(this.doc);
    const removals = op(doc, revId);
    const sel = {
      anchor: mapThroughRemovals(this.sel.anchor, removals),
      head: mapThroughRemovals(this.sel.head, removals),
    };
    this._commit(doc, sel, null);
  }

  acceptRevision(revId) {
    if (!listRevisions(this.doc).some((r) => r.id === revId)) return;
    this._applyRevisionOp(acceptRevision, revId);
  }

  rejectRevision(revId) {
    if (!listRevisions(this.doc).some((r) => r.id === revId)) return;
    this._applyRevisionOp(rejectRevision, revId);
  }

  acceptAll() {
    const ids = listRevisions(this.doc).map((r) => r.id);
    if (!ids.length) return;
    const doc = cloneDoc(this.doc);
    let sel = { ...this.sel };
    for (const id of ids) {
      const removals = acceptRevision(doc, id);
      sel = {
        anchor: mapThroughRemovals(sel.anchor, removals),
        head: mapThroughRemovals(sel.head, removals),
      };
    }
    this._commit(doc, sel, null);
  }

  rejectAll() {
    const ids = listRevisions(this.doc).map((r) => r.id);
    if (!ids.length) return;
    const doc = cloneDoc(this.doc);
    let sel = { ...this.sel };
    for (const id of ids) {
      const removals = rejectRevision(doc, id);
      sel = {
        anchor: mapThroughRemovals(sel.anchor, removals),
        head: mapThroughRemovals(sel.head, removals),
      };
    }
    this._commit(doc, sel, null);
  }

  // ---- 输入法组合（IME） -----------------------------------------------------
  // 组合期间浏览器直接往 DOM 里写临时内容，控制器不记录；
  // compositionend 时把最终结果作为一笔可撤销事务提交，
  // 随后浏览器补发的 input 事件被忽略，保证同一次输入不会记两遍。

  compositionStart() {
    if (this.composing) return;
    this.composing = { sel: { ...this.sel } };
  }

  compositionEnd(data) {
    if (!this.composing) return;
    const sel = this.composing.sel;
    this.composing = null;
    this._mergeType = null;
    this._runRevId = null;
    if (!data) {
      this.render(); // 重渲染以清除浏览器留下的临时 DOM
      return;
    }
    const [from, to] = rangeOf(sel);
    const doc = cloneDoc(this.doc);
    this._deleteSelectionIfAny(doc, from, to);
    const revId = this.trackChanges ? this._newRev() : null;
    const attrs = insertionAttrs(doc, from, { bold: this.typingBold, trackRevId: revId });
    insertTextInto(doc, from, data, attrs);
    this.sel = collapsed(from); // 撤销应回到组合前的选区
    this._commit(doc, collapsed(from + data.length), null);
  }

  // ---- 事件路由（由视图层调用） ---------------------------------------------
  // 返回 { preventDefault } 告知视图是否阻止浏览器默认行为。

  handleBeforeInput(e) {
    const t = e.inputType;
    // 组合期间的 insertCompositionText：放行让浏览器显示临时内容，不记录。
    if (this.composing || e.isComposing || t === 'insertCompositionText') {
      return { preventDefault: false };
    }
    switch (t) {
      case 'insertText':
        if (e.data != null && e.data.includes('\n')) this.paste({ text: e.data });
        else this.insertText(e.data ?? '');
        return { preventDefault: true };
      case 'insertParagraph':
      case 'insertLineBreak':
        this.insertParagraph();
        return { preventDefault: true };
      case 'deleteContentBackward':
        this.deleteBackward();
        return { preventDefault: true };
      case 'deleteContentForward':
        this.deleteForward();
        return { preventDefault: true };
      case 'deleteByCut':
        this.deleteSelection();
        return { preventDefault: true };
      case 'historyUndo':
        this.undo();
        return { preventDefault: true };
      case 'historyRedo':
        this.redo();
        return { preventDefault: true };
      default:
        // insertFromPaste / insertFromDrop 由 paste 事件处理；
        // 其余（格式化、替换等）一律阻止，保护模型。
        return { preventDefault: true };
    }
  }

  // 所有编辑都已在 beforeinput / compositionend 中应用；
  // input 事件一律忽略，避免同一次输入被记两遍。
  handleInput() {}
}
