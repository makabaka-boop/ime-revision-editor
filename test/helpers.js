// 测试用宿主：维护一个极简 DOM 镜像（每段一个字符 id 数组），
// 镜像到“逻辑选区”的换算规则与 src/dom-host.js 完全一致，
// 用于验证“文档模型 <-> DOM 选区”映射。

import { Editor, Selection } from '../src/editor.js';

export class FakeHost {
  constructor() {
    this.editor = null;
    this.mirror = []; // [{chars: [charId|null(<br>占位)]}]
    this.domSelection = Selection.collapsed(0, 0);
    this.renders = 0;
    this.inputEvents = 0;
    this.preventDefaults = 0;
  }

  attachEditor(editor) {
    this.editor = editor;
  }

  getSelection() {
    return this.domSelection.clone();
  }

  setDomSelection(sel) {
    this.domSelection = sel.clone ? sel.clone() : new Selection({ ...sel.anchor }, { ...sel.focus });
  }

  caret(para, offset) {
    this.setDomSelection(Selection.collapsed(para, offset));
  }

  range(aPara, aOff, fPara, fOff) {
    this.setDomSelection(
      new Selection({ para: aPara, offset: aOff }, { para: fPara, offset: fOff })
    );
  }

  render(model, selection) {
    this.renders++;
    // 全量重建镜像：与真实渲染一样以字符 id 为内容。
    this.mirror = model.paragraphs.map((p) => ({
      id: p.id,
      chars: p.chars.length ? p.chars.map((c) => c.id) : [null], // null = <br> 占位
      deleted: new Set(p.chars.filter((c) => c.del || c.ins === '__composition__').map((c) => c.id)),
    }));
    if (selection) {
      // 渲染后浏览器选区被写回：用“逻辑位置 -> DOM 子节点下标”验证落位正确，
      // 再反向算回逻辑位置，确认往返一致。
      this.setDomSelection(selection);
    }
  }

  // 模拟 DomHost.boundaryFromNode 的换算：给定逻辑位置，给出镜像子节点下标，
  // 再从该下标反向得到逻辑位置（跨删除字符偏移的关键验证）。
  roundtrip(para, logical) {
    const block = this.mirror[para];
    if (!block) return null;
    const deleted = block.deleted;
    // 逻辑 -> 子节点下标：数过前 logical 个存活子节点，并跨过其后的删除聚簇，
    // 与 model.physicalIndex 的语义保持一致。
    let seen = 0;
    let idx = 0;
    for (; idx < block.chars.length; idx++) {
      const id = block.chars[idx];
      const alive = id !== null && !deleted.has(id);
      if (alive) {
        if (seen === logical) break; // 第 logical+1 个存活节点之前
        seen++;
      }
    }
    while (idx < block.chars.length && block.chars[idx] !== null && deleted.has(block.chars[idx])) {
      idx++;
    }
    // 子节点下标 -> 逻辑
    let back = 0;
    for (let i = 0; i < idx; i++) {
      const id = block.chars[i];
      if (id !== null && !deleted.has(id)) back++;
    }
    return { idx, back };
  }

  // ---- 事件模拟（与浏览器事件序一致） ----

  // 普通键入
  type(text) {
    for (const ch of Array.from(text)) this.beforeInput('insertText', ch);
  }

  beforeInput(inputType, data, opts = {}) {
    const prevent = this.editor.beforeInput(inputType, data, this.getSelection(), {
      composing: this.editor.composing,
      ...opts,
    });
    if (prevent) this.preventDefaults++;
    // input 事件总是随后触发（浏览器行为），编辑器绝不能因此二次记账。
    this.editor.input(inputType, data, null, { composing: this.editor.composing });
    this.inputEvents++;
    return prevent;
  }

  backspace() {
    return this.beforeInput('deleteContentBackward', null);
  }

  forwardDelete() {
    return this.beforeInput('deleteContentForward', null);
  }

  enter() {
    return this.beforeInput('insertParagraph', null);
  }

  paste({ textPlain = '', textHtml = '' }) {
    // 浏览器会先把粘贴内容当作 input；编辑器在 paste 事件里 preventDefault，
    // 这里模拟编辑器 paste() 直接接管。
    this.editor.paste({ textPlain, textHtml }, this.getSelection());
  }

  // 模拟一次中文拼音组合。
  // sequence: [{data}] 每次 compositionupdate / insertCompositionText 的临时串；
  // final: compositionend 的最终串；
  // trailingChrome: 是否补发 Chrome 风格 insertText(final)。
  composition(sequence, final, { trailingChrome = false } = {}) {
    this.editor.compositionStart(this.getSelection());
    for (const data of sequence) {
      // 浏览器真实顺序：beforeinput(insertCompositionText, composing=true) 不拦截 + input
      const prevent = this.editor.beforeInput('insertCompositionText', data, this.getSelection(), {
        composing: true,
      });
      this.editor.input('insertCompositionText', data, null, { composing: true });
      if (prevent) this.preventDefaults++;
      this.inputEvents++;
      // 浏览器把光标放到组合串末尾
      const s = this.editor.selection;
      this.setDomSelection(s);
    }
    this.editor.compositionEnd(final, this.getSelection());
    this.inputEvents++; // compositionend 本身不算 input；Chrome 补发的 beforeinput 见下
    this.setDomSelection(this.editor.selection);
    if (trailingChrome) {
      // Chrome: compositionend 之后又来一对 beforeinput/input(insertText, final)
      const prevent = this.editor.beforeInput('insertText', final, this.getSelection());
      if (prevent) this.preventDefaults++;
      this.editor.input('insertText', final, null);
      this.inputEvents++;
      this.setDomSelection(this.editor.selection);
    }
  }

  undo() {
    this.editor.undo();
    this.setDomSelection(this.editor.selection);
  }
  redo() {
    this.editor.redo();
    this.setDomSelection(this.editor.selection);
  }
}

export function makeEditor(model) {
  const host = new FakeHost();
  const editor = new Editor(host, model);
  editor.render();
  return { host, editor };
}

// 铺设基线文本：作为单个插入修订输入后立即接受，得到无修订标记的基线段落。
// lines 用 '\n' 分段。
export function seed(editor, host, lines) {
  const texts = Array.isArray(lines) ? lines : String(lines).split('\n');
  let first = true;
  for (const t of texts) {
    if (!first) host.enter();
    host.beforeInput('insertText', t);
    first = false;
  }
  for (const id of [...editor.model.revisions.keys()]) editor.model.accept(id);
  host.setDomSelection(editor.selection);
}

export function aliveText(editor) {
  return editor.model.paragraphs.map((p) => editor.model.aliveText(p)).join('\n');
}
