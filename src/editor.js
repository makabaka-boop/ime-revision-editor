// editor.js — 编辑器核心：事务/撤销栈、输入法组合状态机、事件去重、修订操作。
//
// 不直接触碰真实 DOM，所有 DOM 交互通过 Host 接口：
//   host.getSelection() -> Selection | null
//   host.render(model, selection)
// 浏览器环境用 DomHost，测试用 FakeHost。
//
// 事件入口（由 Host 转译）：
//   compositionStart(sel)
//   beforeInput(inputType, data, sel, {composing}) -> boolean（true = Host 应 preventDefault）
//   input(...)（仅用于对账，绝不修改模型）
//   compositionEnd(data, sel)
//
// 去重原则：
//   1. 非组合期所有模型变更只发生在 beforeinput（Host 已 preventDefault，浏览器不会再改 DOM）；
//   2. 组合期间不 preventDefault，DOM 由浏览器原生更新，模型同步写“临时字符”，
//      不产生修订、不入撤销栈；
//   3. compositionend 时把临时字符一次性替换为正式插入修订——恰好一笔事务；
//      若组合开始时有选区，选区删除并入同一事务；
//   4. Chrome 系在 compositionend 之后还会补发 insertText(最终串)，按“位置+内容”吞掉一次；
//      input 事件从不修改模型，因此连续触发 beforeinput/input 不会把同一次输入记两遍。

import { DocumentModel, makeRevision, toChars } from './model.js';

export class Selection {
  constructor(anchor, focus) {
    this.anchor = anchor;
    this.focus = focus;
  }
  static collapsed(para, offset) {
    const p = { para, offset };
    return new Selection({ ...p }, { ...p });
  }
  get collapsed() {
    return this.anchor.para === this.focus.para && this.anchor.offset === this.focus.offset;
  }
  // 方向规整后的起、终点（不改变 anchor/focus 本身）。
  get start() {
    const a = this.anchor;
    const f = this.focus;
    if (a.para < f.para || (a.para === f.para && a.offset <= f.offset)) return a;
    return f;
  }
  get end() {
    const a = this.anchor;
    const f = this.focus;
    if (a.para < f.para || (a.para === f.para && a.offset <= f.offset)) return f;
    return a;
  }
  clone() {
    return new Selection({ ...this.anchor }, { ...this.focus });
  }
  isEqual(o) {
    return (
      !!o &&
      this.anchor.para === o.anchor.para &&
      this.anchor.offset === o.anchor.offset &&
      this.focus.para === o.focus.para &&
      this.focus.offset === o.focus.offset
    );
  }
}

export class Editor {
  constructor(host, model = new DocumentModel()) {
    this.host = host;
    this.model = model;
    this.selection = Selection.collapsed(0, 0);
    this.undoStack = [];
    this.redoStack = [];
    this.composing = false;
    this._compAnchor = null; // 组合开始时的逻辑位置
    this._compRange = null; // 组合开始时若有选区：待删除的范围
    this._compCharIds = []; // 当前模型中的临时字符
    this._suppress = null; // compositionend 后待吞掉的重复 insertText
    this.inputEventCount = 0; // 对账用：input 事件从不驱动模型
    this.historyLimit = 200;
    host.attachEditor(this);
  }

  // ---------- 渲染 ----------

  render() {
    this.selection = this.clampSelection(this.selection);
    this.host.render(this.model, this.selection);
  }

  clampSelection(sel) {
    const s = sel.clone();
    s.anchor = this.model.clamp(s.anchor);
    s.focus = this.model.clamp(s.focus);
    return s;
  }

  // ---------- 事务（快照式撤销） ----------

  transact(label, fn, overrideBefore = null) {
    const before = overrideBefore ? overrideBefore.snap : JSON.parse(JSON.stringify(this.model.toJSON()));
    const beforeSel = overrideBefore ? overrideBefore.sel.clone() : this.selection.clone();
    const result = fn();
    const afterSel = result && result.selection ? result.selection : this.selection;
    this.selection = this.clampSelection(afterSel);
    const after = JSON.parse(JSON.stringify(this.model.toJSON()));
    this.undoStack.push({ label, before, beforeSel, after, afterSel: this.selection.clone() });
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.host.render(this.model, this.selection);
    return result;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.model = DocumentModel.fromJSON(entry.before);
    this.selection = this.clampSelection(entry.beforeSel.clone());
    this.redoStack.push(entry);
    this._cancelComposition();
    this.host.render(this.model, this.selection);
    return true;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.model = DocumentModel.fromJSON(entry.after);
    this.selection = this.clampSelection(entry.afterSel.clone());
    this.undoStack.push(entry);
    this._cancelComposition();
    this.host.render(this.model, this.selection);
    return true;
  }

  _cancelComposition() {
    this.composing = false;
    this._compAnchor = null;
    this._compPre = null;
    this._compCharIds = [];
    this._suppress = null;
  }

  // ---------- 输入法组合状态机 ----------

  compositionStart(sel) {
    if (this.composing) return;
    const s = sel || this.host.getSelection() || this.selection;
    // 组合前快照：整次组合（可能的选区删除 + 全部临时更新 + 最终提交）
    // 共享同一个 undo 条目，因此一次中文输入至多对应一笔可撤销事务。
    const preSnap = JSON.parse(JSON.stringify(this.model.toJSON()));
    const preSel = s.clone();
    let anchor = { para: s.start.para, offset: s.start.offset };
    if (!s.collapsed) {
      // 立即在模型上做选区删除（记修订），但不渲染——组合期间不重建 DOM。
      const range = new Selection({ ...s.start }, { ...s.end });
      const rev = this._newRevision('delete');
      const res = this.model.deleteRange(range.anchor, range.focus, rev);
      for (const p of res.pruned) {
        const insRev = this.model.revisions.get(p.revId);
        if (insRev) {
          insRev.charIds = insRev.charIds.filter((id) => id !== p.id);
          if (insRev.type === 'insert' && insRev.charIds.length === 0) {
            this.model.revisions.delete(insRev.id);
          }
        }
      }
      if (rev.chips.length === 0 && !rev.moved) this.model.revisions.delete(rev.id);
      anchor = { para: res.para, offset: res.offset };
    }
    this.composing = true;
    this._compAnchor = anchor;
    this._compPre = { snap: preSnap, sel: preSel };
    this._compDeleted = !s.collapsed;
    this._compCharIds = [];
  }

  // 组合过程中：浏览器已在 DOM 显示临时内容；模型里同步一份临时字符供映射，
  // 不产生修订、不入栈、不重建 DOM（重建会打断 IME）。
  compositionUpdate(data) {
    if (!this.composing) return;
    for (const id of [...this._compCharIds]) this.model.detachCharById(id);
    this._compCharIds = [];
    const text = data ?? '';
    if (text) {
      const bold = this._boldAt(this._compAnchor);
      const made = this.model.insertTransient(this._compAnchor.para, this._compAnchor.offset, text, bold);
      this._compCharIds = made.map((c) => c.id);
    }
    this.selection = Selection.collapsed(
      this._compAnchor.para,
      this._compAnchor.offset + toChars(text).length
    );
  }

  compositionEnd(data, sel) {
    if (!this.composing) {
      if (data) this.insertText(data, sel);
      return;
    }
    const finalText = data ?? this._currentTransientText();
    const anchor = { ...this._compAnchor };
    const pre = this._compPre;
    const transientIds = [...this._compCharIds];
    const hadDelete = this._compDeleted;
    this.composing = false;
    this._compAnchor = null;
    this._compPre = null;
    this._compDeleted = false;
    this._compCharIds = [];

    // 空组合且没有选区删除（例如按 Esc 取消）：没有任何可撤销的变化。
    if (!finalText && !hadDelete) {
      for (const id of transientIds) this.model.detachCharById(id);
      this.selection = this.clampSelection(Selection.collapsed(anchor.para, anchor.offset));
      this.host.render(this.model, this.selection);
      return;
    }

    // 一次性提交：清掉临时字符（DOM 中的临时内容也由本次渲染整体替换），
    // 再写入正式插入修订。配合组合前快照，整次组合恰好一笔可撤销事务。
    this.transact(
      'composition-insert',
      () => {
        for (const id of transientIds) this.model.detachCharById(id);
        let selection;
        if (finalText) {
          const rev = this._newRevision('insert');
          const bold = this._boldAt(anchor);
          const made = this.model.insertText(anchor.para, anchor.offset, finalText, bold, rev.id);
          rev.charIds = made.map((c) => c.id);
          selection = Selection.collapsed(anchor.para, anchor.offset + toChars(finalText).length);
          // Chrome 系 compositionend 后补发的 insertText：只对“紧接着的下一次
          // insertText”生效（位置+内容吻合才吞），用一次即失效；因此既不会重复记账，
          // 也不会误吞用户稍后敲出的相同内容（其位置在新串之后，不吻合）。
          this._suppress = { para: anchor.para, offset: anchor.offset, text: finalText };
        } else {
          selection = Selection.collapsed(anchor.para, anchor.offset);
        }
        return { selection };
      },
      pre
    );
  }

  _currentTransientText() {
    let s = '';
    for (const id of this._compCharIds) {
      const c = this.model.charById(id);
      if (c) s += c.ch;
    }
    return s;
  }

  // ---------- beforeinput / input ----------

  // 返回 true 表示 Host 应 preventDefault（即模型已全权处理，浏览器不要再改 DOM）。
  beforeInput(inputType, data, sel, { composing = false } = {}) {
    const s = sel || this.host.getSelection();

    if (inputType === 'insertCompositionText' || inputType === 'deleteCompositionText' || composing) {
      // 某些环境只发 beforeinput 不发 compositionstart；此处兜底开启组合。
      if (!this.composing) this.compositionStart(s);
      // 组合期间不拦截，浏览器原生更新 DOM；模型只做临时同步。
      this.compositionUpdate(data);
      return false;
    }

    switch (inputType) {
      case 'insertText':
      case 'insertReplacementText':
        if (this._consumeSuppressedInsert(data, s)) return true; // 吞掉组合补发
        if (data) this.insertText(data, s);
        return true;
      case 'insertParagraph':
      case 'insertLineSeparator':
      case 'insertLineBreak':
        this.split(s);
        return true;
      case 'deleteContentBackward':
      case 'deleteContentForward':
      case 'deleteContent':
      case 'deleteByCut':
      case 'deleteWordBackward':
      case 'deleteWordForward':
        this.delete(inputType, s);
        return true;
      default:
        // 其余 inputType 保守拦截，杜绝未跟踪的 DOM 变更进入文档。
        return true;
    }
  }

  // input 事件永不修改模型——变更已在 beforeinput（或 compositionend）落账。
  input() {
    this.inputEventCount += 1;
  }

  _consumeSuppressedInsert(data, sel) {
    const sup = this._suppress;
    if (!sup) return false;
    this._suppress = null;
    const at = sel ? (sel.collapsed ? sel.anchor : sel.start) : null;
    if (
      at &&
      data === sup.text &&
      at.para === sup.para &&
      at.offset === sup.offset + toChars(data).length
    ) {
      return true; // 确为组合补发，丢弃
    }
    return false; // 不符则放行正常插入
  }

  // ---------- 公共编辑操作（各自一笔事务） ----------

  insertText(text, sel) {
    const s = sel || this.host.getSelection() || this.selection;
    const range = s.collapsed ? null : new Selection({ ...s.start }, { ...s.end });
    const compAnchor = s.collapsed ? { ...s.anchor } : { ...s.start };
    this.transact('insert', () => {
      const pos = range ? this._rawDelete(range) : compAnchor;
      const rev = this._newRevision('insert');
      const bold = this._boldAt(pos);
      const made = this.model.insertText(pos.para, pos.offset, text, bold, rev.id);
      rev.charIds = made.map((c) => c.id);
      return { selection: Selection.collapsed(pos.para, pos.offset + toChars(text).length) };
    });
  }

  delete(inputType = 'deleteContentBackward', sel) {
    const s = sel || this.host.getSelection() || this.selection;
    let range;
    if (s.collapsed) {
      const other = this._extendForDelete(s.anchor, inputType);
      if (!other) return;
      range = new Selection({ ...other }, { ...s.anchor });
    } else {
      range = new Selection({ ...s.start }, { ...s.end });
    }
    this.transact('delete', () => {
      const cursor = this._rawDelete(range);
      return { selection: Selection.collapsed(cursor.para, cursor.offset) };
    });
  }

  split(sel) {
    const s = sel || this.host.getSelection() || this.selection;
    const range = s.collapsed ? null : new Selection({ ...s.start }, { ...s.end });
    const pos0 = s.collapsed ? { ...s.anchor } : { ...s.start };
    this.transact('split', () => {
      const pos = range ? this._rawDelete(range) : pos0;
      const newPi = this.model.splitPara(pos.para, pos.offset);
      return { selection: Selection.collapsed(newPi, 0) };
    });
  }

  // 粘贴：HTML 只取文本，绝不作为标记进入文档；多行按段落拆；整笔一个事务。
  paste({ textPlain = '', textHtml = '' } = {}, sel) {
    let text = textPlain;
    if (!text && textHtml) text = htmlToPlainText(textHtml);
    text = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
    if (!text) return;
    const s = sel || this.host.getSelection() || this.selection;
    const range = s.collapsed ? null : new Selection({ ...s.start }, { ...s.end });
    const pos0 = s.collapsed ? { ...s.anchor } : { ...s.start };
    this.transact('paste', () => {
      let pos = range ? this._rawDelete(range) : pos0;
      const rev = this._newRevision('insert');
      const bold = this._boldAt(pos);
      const lines = text.split('\n');
      let para = pos.para;
      let offset = pos.offset;
      lines.forEach((line, i) => {
        if (i > 0) {
          this.model.splitPara(para, offset);
          para += 1;
          offset = 0;
        }
        const made = this.model.insertText(para, offset, line, bold, rev.id);
        rev.charIds.push(...made.map((c) => c.id));
        offset += toChars(line).length;
      });
      return { selection: Selection.collapsed(para, offset) };
    });
  }

  toggleBold(sel) {
    const s = sel || this.host.getSelection() || this.selection;
    if (s.collapsed) return; // 无选区不改文档；新输入按相邻字符继承粗体
    const range = new Selection({ ...s.start }, { ...s.end });
    this.transact('bold', () => {
      const chars = this._aliveCharsIn(range);
      const anyNonBold = chars.some((c) => !c.bold);
      for (const c of chars) c.bold = anyNonBold;
      return { selection: s.clone() };
    });
  }

  accept(revId) {
    if (!this.model.revisions.has(revId)) return;
    this.transact('accept', () => {
      this.model.accept(revId);
      return { selection: this.selection.clone() };
    });
  }

  reject(revId) {
    if (!this.model.revisions.has(revId)) return;
    this.transact('reject', () => {
      this.model.reject(revId);
      return { selection: this.selection.clone() };
    });
  }

  setSelection(sel) {
    this.selection = this.clampSelection(sel);
    this._suppress = null;
  }

  // ---------- 事务内原语（不自行开事务/渲染） ----------

  _newRevision(type) {
    const rev = makeRevision(type);
    this.model.revisions.set(rev.id, rev);
    return rev;
  }

  // 在当前事务状态上对范围执行删除；返回删除后光标 {para, offset}。
  _rawDelete(range) {
    const rev = this._newRevision('delete');
    const res = this.model.deleteRange(range.anchor, range.focus, rev);
    // 被物理移除的未接受插入字符：从其插入修订中剔除；空修订作废。
    for (const p of res.pruned) {
      const insRev = this.model.revisions.get(p.revId);
      if (!insRev) continue;
      insRev.charIds = insRev.charIds.filter((id) => id !== p.id);
      if (insRev.type === 'insert' && insRev.charIds.length === 0) {
        this.model.revisions.delete(insRev.id);
      }
    }
    if (rev.chips.length === 0 && !rev.moved) this.model.revisions.delete(rev.id);
    return { para: res.para, offset: res.offset };
  }

  _boldAt(pos) {
    const para = this.model.paragraphs[pos.para];
    if (!para) return false;
    const phys = this.model.physicalIndex(para, pos.offset);
    for (let i = phys - 1; i >= 0; i--) {
      if (!para.chars[i].del) return para.chars[i].bold;
    }
    for (let i = phys; i < para.chars.length; i++) {
      if (!para.chars[i].del) return para.chars[i].bold;
    }
    return false;
  }

  _extendForDelete(pos, inputType) {
    const forward = inputType === 'deleteContentForward' || inputType === 'deleteWordForward';
    const word = inputType === 'deleteWordBackward' || inputType === 'deleteWordForward';
    if (!forward) {
      if (pos.offset > 0) {
        let n = 1;
        if (word) {
          const t = this.model.aliveText(this.model.paragraphs[pos.para]).slice(0, pos.offset);
          const m = /[^\s]+\s*$/u.exec(t);
          if (m) n = toChars(m[0]).length;
        }
        return { para: pos.para, offset: Math.max(0, pos.offset - n) };
      }
      if (pos.para > 0) {
        return { para: pos.para - 1, offset: this.model.aliveCount(this.model.paragraphs[pos.para - 1]) };
      }
      return null;
    }
    const len = this.model.aliveCount(this.model.paragraphs[pos.para]);
    if (pos.offset < len) {
      let n = 1;
      if (word) {
        const t = this.model.aliveText(this.model.paragraphs[pos.para]).slice(pos.offset);
        const m = /^\s*\S+/u.exec(t);
        if (m) n = toChars(m[0]).length;
      }
      return { para: pos.para, offset: Math.min(len, pos.offset + n) };
    }
    if (pos.para < this.model.paragraphs.length - 1) return { para: pos.para + 1, offset: 0 };
    return null;
  }

  _aliveCharsIn(range) {
    const out = [];
    const a = range.start;
    const b = range.end;
    for (let pi = a.para; pi <= b.para; pi++) {
      const para = this.model.paragraphs[pi];
      let logical = 0;
      for (const c of para.chars) {
        if (c.del) continue;
        const afterStart = pi > a.para || logical >= a.offset;
        const beforeEnd = pi < b.para || logical < b.offset;
        if (afterStart && beforeEnd) out.push(c);
        logical++;
      }
    }
    return out;
  }
}

// HTML -> 纯文本：标签、脚本、事件属性一律不保留，输出不可能携带可执行标记。
export function htmlToPlainText(html, parser) {
  if (parser) return parser(html);
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body.textContent || '';
  }
  // 无 DOM 的测试环境：去标签降级。
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
