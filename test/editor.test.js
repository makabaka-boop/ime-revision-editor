// editor.test.js — 输入法组合、事件去重、跨段删除、粘贴、撤销顺序、接受/拒绝。
import { describe, it, eq, ok, notOk } from './framework.js';
import { Editor, Selection } from '../src/editor.js';
import { DocumentModel, resetIdCounter } from '../src/model.js';
import { FakeHost, makeEditor, aliveText, seed } from './helpers.js';

const mk = () => {
  resetIdCounter(0);
  return makeEditor(new DocumentModel());
};
const caret = (editor, p, o) => {
  editor.setSelection(Selection.collapsed(p, o));
  editor.host.caret(p, o);
};
const range = (host, ap, ao, fp, fo) => host.range(ap, ao, fp, fo);

describe('基础输入与撤销', () => {
  it('键入产生插入修订，撤销/重做恢复模型与光标', () => {
    const { editor, host } = mk();
    host.type('甲');
    eq(aliveText(editor), '甲');
    caret(editor, 0, 1);
    host.type('乙');
    eq(aliveText(editor), '甲乙');
    eq(editor.undoStack.length, 2);

    host.undo();
    eq(aliveText(editor), '甲');
    eq(editor.selection.anchor, { para: 0, offset: 1 }, '撤销后光标回到插入点');
    host.undo();
    eq(aliveText(editor), '');
    eq(editor.selection.anchor, { para: 0, offset: 0 });
    host.redo();
    eq(aliveText(editor), '甲');
  });

  it('input 事件次数再多也不重复记账', () => {
    const { editor, host } = mk();
    host.type('字');
    const revsBefore = editor.model.revisions.size;
    // 同一字符的额外 input 事件（浏览器抖动）不得新增修订/字符
    editor.input('insertText', '字');
    editor.input('insertText', '字');
    eq(aliveText(editor), '字');
    eq(editor.model.revisions.size, revsBefore);
  });
});

describe('中文输入法组合', () => {
  it('组合期间显示临时内容，但只产生一笔可撤销事务', () => {
    const { editor, host } = mk();
    const stackBefore = editor.undoStack.length;
    host.composition(['n', 'ni', 'ni ', 'ni h', 'ni ha', 'ni hao', '你好'], '你好');
    eq(aliveText(editor), '你好');
    eq(editor.undoStack.length, stackBefore + 1, '整次组合仅一笔事务');
    eq(editor.model.revisions.size, 1);
    const rev = [...editor.model.revisions.values()][0];
    eq(rev.type, 'insert');
    eq(rev.charIds.length, 2);
    // 临时字符已全部转正，不存在 __composition__ 残留
    ok(!editor.model.paragraphs[0].chars.some((c) => c.ins === '__composition__'));
  });

  it('Chrome compositionend 后补发 insertText 不会把同一次输入记两遍', () => {
    const { editor, host } = mk();
    host.composition(['p', 'pi', '脾'], '脾', { trailingChrome: true });
    eq(aliveText(editor), '脾', '补发事件被吞掉');
    eq(editor.model.revisions.size, 1);
    eq(editor.undoStack.length, 1);
    // 撤销一次即回到组合前
    host.undo();
    eq(aliveText(editor), '');
  });

  it('抑制标记是一次性的：组合后用户另行输入相同字符不会被误吞', () => {
    const { editor, host } = mk();
    host.composition(['n', 'ni', '你'], '你', { trailingChrome: true });
    eq(aliveText(editor), '你');
    // 用户把光标移回段首再输入相同字符（补发事件的位置不匹配 -> 正常插入）
    host.caret(0, 0);
    host.beforeInput('insertText', '你');
    eq(aliveText(editor), '你你');
    eq(editor.model.revisions.size, 2);
  });

  it('Firefox 风格（无补发事件）同样只有一笔事务', () => {
    const { editor, host } = mk();
    host.composition(['s', 'sh', '上'], '上', { trailingChrome: false });
    eq(aliveText(editor), '上');
    eq(editor.undoStack.length, 1);
    host.undo();
    eq(aliveText(editor), '');
  });

  it('空组合（取消输入）不入撤销栈', () => {
    const { editor, host } = mk();
    const before = editor.undoStack.length;
    host.composition(['x', 'xi'], '');
    eq(aliveText(editor), '');
    eq(editor.undoStack.length, before);
  });

  it('在有选区时开始组合：删除选区与最终插入合并为一笔组合事务', () => {
    const { editor, host } = mk();
    host.type('甲乙丙丁');
    // 让基线落定（接受操作本身是事务，之后记录栈高度）。
    for (const id of [...editor.model.revisions.keys()]) editor.accept(id);
    const baseStack = editor.undoStack.length;
    range(host, 0, 1, 0, 3); // 选中“乙丙”
    editor.setSelection(host.getSelection());
    host.composition(['z', '子'], '子', { trailingChrome: true });
    eq(aliveText(editor), '甲子丁');
    eq(editor.undoStack.length, baseStack + 1, '删除+插入合并为一笔组合事务');
    host.undo();
    eq(aliveText(editor), '甲乙丙丁', '一笔撤销同时恢复删除与插入');
  });
});

describe('跨段选择与删除', () => {
  it('跨段 Backspace：合并段落，光标落在合并点，是一笔事务', () => {
    const { editor, host } = mk();
    host.type('甲乙');
    host.enter();
    host.type('丙丁');
    for (const id of [...editor.model.revisions.keys()]) editor.model.accept(id);
    eq(aliveText(editor), '甲乙\n丙丁');
    caret(editor, 1, 0);
    const stack = editor.undoStack.length;
    host.backspace();
    eq(aliveText(editor), '甲乙丙丁');
    eq(editor.model.paragraphs.length, 1);
    eq(editor.selection.anchor, { para: 0, offset: 2 });
    eq(editor.undoStack.length, stack + 1, '跨段合并是一笔事务');
    ok(![...editor.model.revisions.values()].some((r) => r.type === 'delete'), '无字符被删时不产生删除修订');
    host.undo();
    eq(aliveText(editor), '甲乙\n丙丁');
    eq(editor.model.paragraphs.length, 2);
    eq(editor.selection.anchor, { para: 1, offset: 0 });
  });

  it('跨段选区删除：基线字符标记删除，拒绝后恢复原段落结构', () => {
    const { editor, host } = mk();
    host.type('甲乙');
    host.enter();
    host.type('丙丁');
    for (const id of [...editor.model.revisions.keys()]) editor.model.accept(id);
    range(host, 0, 1, 1, 1); // 选中“乙\n丙”
    editor.setSelection(host.getSelection());
    host.beforeInput('deleteContent', null);
    eq(aliveText(editor), '甲丁');
    const d = [...editor.model.revisions.values()].find((r) => r.type === 'delete');
    ok(d, '基线字符被标记为删除修订');
    editor.reject(d.id);
    eq(aliveText(editor), '甲乙\n丙丁');
    eq(editor.model.paragraphs.length, 2);
    ok(editor.selection.anchor.para < 2, '光标仍有效');
  });

  it('跨多段选区删除后光标与模型-DOM镜像映射一致', () => {
    const { editor, host } = mk();
    seed(editor, host, ['一二', '三四', '五六']);
    range(host, 0, 1, 2, 1); // “一[二\n三四\n五]六”
    editor.setSelection(host.getSelection());
    host.beforeInput('deleteContent', null);
    eq(aliveText(editor), '一六');
    eq(editor.model.paragraphs.length, 1);
    // 物理顺序：一 二(del) 三(del) 四(del) 五(del) 六；逻辑存活 一|六
    // 逻辑偏移1 -> 物理下标5（六 前），反向仍为1。
    const rt = host.roundtrip(0, 1);
    eq(rt.back, 1);
    eq(rt.idx, 5);
    eq(editor.selection.anchor, { para: 0, offset: 1 });
  });

  it('撤销跨段删除恢复段落与光标位置', () => {
    const { editor, host } = mk();
    host.type('AB');
    host.enter();
    host.type('CD');
    for (const id of [...editor.model.revisions.keys()]) editor.model.accept(id);
    caret(editor, 1, 1);
    host.backspace(); // 删除 C（D前光标在1）
    // 上面：第二段偏移1按Backspace删 C
    eq(aliveText(editor), 'AB\nD');
    host.undo();
    eq(aliveText(editor), 'AB\nCD');
    eq(editor.model.paragraphs.length, 2);
    eq(editor.selection.anchor, { para: 1, offset: 1 });
  });

  it('删除未接受的插入字符：物理移除且不产生删除修订，插入修订同步裁剪', () => {
    const { editor, host } = mk();
    host.beforeInput('insertText', 'XYZ'); // 一整次输入 = 一个插入修订
    eq(editor.model.paragraphs[0].chars.length, 3);
    caret(editor, 0, 3);
    host.backspace();
    eq(aliveText(editor), 'XY');
    eq(editor.model.paragraphs[0].chars.length, 2, '字符被物理移除');
    notOk([...editor.model.revisions.values()].some((r) => r.type === 'delete'));
    const ins = [...editor.model.revisions.values()][0];
    eq(ins.charIds.length, 2);
    host.undo();
    eq(aliveText(editor), 'XYZ');
  });
});

describe('拆并段落后的映射', () => {
  it('Enter 拆段后继续输入、撤销顺序正确', () => {
    const { editor, host } = mk();
    host.type('甲');
    host.enter();
    host.type('乙');
    eq(aliveText(editor), '甲\n乙');
    eq(editor.selection.anchor, { para: 1, offset: 1 });
    host.undo(); // 撤“乙”
    eq(aliveText(editor), '甲\n');
    host.undo(); // 撤拆段
    eq(aliveText(editor), '甲');
    eq(editor.model.paragraphs.length, 1);
    eq(editor.selection.anchor, { para: 0, offset: 1 });
  });

  it('在删除修订字符附近拆段，渲染后镜像往返仍指向正确字符', () => {
    const { editor, host } = mk();
    seed(editor, host, '甲乙丙');
    range(host, 0, 1, 0, 2); // 删“乙”
    editor.setSelection(host.getSelection());
    host.beforeInput('deleteContent', null);
    // 物理：甲 乙(del) 丙；逻辑：甲丙，光标折叠在逻辑1
    eq(editor.selection.anchor, { para: 0, offset: 1 });
    host.setDomSelection(editor.selection);
    host.enter();
    // physicalIndex(逻辑1) 跨过删除聚簇：段0“甲 乙(del)”，段1“丙”
    eq(aliveText(editor), '甲\n丙');
    eq(editor.model.paragraphs[0].chars.map((c) => c.ch), ['甲', '乙']);
    eq(editor.model.paragraphs[1].chars.map((c) => c.ch), ['丙']);
    eq(host.roundtrip(0, 1).back, 1, '第一段逻辑1在删除字符乙之后');
    eq(host.roundtrip(1, 0).back, 0, '第二段段首逻辑0');
    const d = [...editor.model.revisions.values()].find((r) => r.type === 'delete');
    ok(d);
    editor.reject(d.id);
    eq(aliveText(editor), '甲乙\n丙');
  });
});

describe('粘贴', () => {
  it('粘贴纯文本多行为一笔插入修订并按段落拆分', () => {
    const { editor, host } = mk();
    host.type('开头');
    const stackAfterType = editor.undoStack.length; // 逐字符键入产生多笔
    caret(editor, 0, 2);
    host.paste({ textPlain: 'X\nY' });
    eq(aliveText(editor), '开头X\nY');
    eq(editor.model.paragraphs.length, 2);
    eq(editor.undoStack.length, stackAfterType + 1, '整次粘贴只新增一笔事务');
    eq(editor.selection.anchor, { para: 1, offset: 1 });
    host.undo();
    eq(aliveText(editor), '开头');
    eq(editor.model.paragraphs.length, 1);
  });

  it('粘贴的 HTML 不作为可执行标记进入文档', () => {
    const { editor, host } = mk();
    const evil =
      '<p onclick="steal()">安全文本</p><script>alert(1)</script><img src=x onerror="x()">';
    host.paste({ textPlain: '', textHtml: evil });
    const raw = aliveText(editor);
    ok(!raw.includes('<'), `输出不应含标签: ${raw}`);
    ok(!raw.includes('alert'));
    ok(raw.includes('安全文本'));
  });

  it('粘贴覆盖选区：删除与粘贴为一笔事务', () => {
    const { editor, host } = mk();
    host.type('甲乙丙');
    range(host, 0, 1, 0, 2);
    editor.setSelection(host.getSelection());
    host.paste({ textPlain: '子' });
    eq(aliveText(editor), '甲子丙');
  });
});

describe('接受/拒绝与光标', () => {
  it('接受删除后在清理段落时保持光标位置有效', () => {
    const { editor, host } = mk();
    host.type('AB');
    host.enter();
    host.type('CD');
    for (const id of [...editor.model.revisions.keys()]) editor.model.accept(id);
    range(host, 0, 1, 1, 2); // 删 B\nCD
    editor.setSelection(host.getSelection());
    host.beforeInput('deleteContent', null);
    eq(aliveText(editor), 'A');
    // 把光标放到被合并段的旧位置（结构变化前的越界点），接受后必须被收敛
    editor.setSelection(Selection.collapsed(1, 5));
    const d = [...editor.model.revisions.values()][0];
    editor.accept(d.id);
    ok(editor.selection.anchor.para === 0);
    ok(editor.selection.anchor.offset <= editor.model.aliveCount(editor.model.paragraphs[0]));
    eq(aliveText(editor), 'A');
  });

  it('拒绝、接受均为可撤销事务，撤销后修订回到表中', () => {
    const { editor, host } = mk();
    host.type('基线');
    for (const id of [...editor.model.revisions.keys()]) editor.model.accept(id);
    host.type('插入');
    const insIds = [...editor.model.revisions.keys()];
    const lastId = insIds[insIds.length - 1];
    editor.reject(lastId);
    eq(aliveText(editor), '基线插');
    eq(editor.model.revisions.has(lastId), false);
    editor.undo();
    eq(aliveText(editor), '基线插入');
    ok(editor.model.revisions.has(lastId));
    ok(editor.selection.anchor.offset <= aliveText(editor).length, '光标位置有效');
  });

  it('撤销/重做交替后光标与结构持续有效', () => {
    const { editor, host } = mk();
    host.type('1');
    host.enter();
    host.type('2');
    host.undo();
    host.undo();
    host.redo();
    host.redo();
    eq(aliveText(editor), '1\n2');
    eq(editor.selection.anchor, { para: 1, offset: 1 });
    host.undo();
    eq(editor.selection.anchor.para < editor.model.paragraphs.length, true);
  });
});

describe('加粗与导出同源', () => {
  it('加粗只标记 bold，不产生插入/删除修订', () => {
    const { editor, host } = mk();
    host.type('加粗文字');
    range(host, 0, 0, 0, 4);
    editor.setSelection(host.getSelection());
    editor.toggleBold();
    ok(editor.model.paragraphs[0].chars.every((c) => c.bold));
    notOk([...editor.model.revisions.values()].some((r) => r.type !== 'insert'));
    host.undo();
    ok(editor.model.paragraphs[0].chars.every((c) => !c.bold));
  });
});

describe('附加边界', () => {
  it('代理对（emoji）按码点切分，逻辑偏移不拆碎字符', async () => {
    const { toChars } = await import('../src/model.js');
    eq(toChars('😀你').length, 2);
    const { editor, host } = mk();
    host.beforeInput('insertText', '😀a');
    eq(aliveText(editor), '😀a');
    eq(editor.model.paragraphs[0].chars.length, 2);
    host.setDomSelection(editor.selection);
    host.backspace();
    eq(aliveText(editor), '😀');
  });

  it('拒绝跨段删除后可在恢复的段落中继续编辑，结构有效', () => {
    const { editor, host } = mk();
    seed(editor, host, ['AB', 'CD']);
    host.range(0, 1, 1, 1);
    editor.setSelection(host.getSelection());
    host.beforeInput('deleteContent', null);
    const d = [...editor.model.revisions.keys()][0];
    editor.reject(d);
    eq(editor.model.paragraphs.length, 2);
    host.caret(1, 2);
    host.beforeInput('insertText', 'X');
    eq(aliveText(editor), 'AB\nCDX');
  });

  it('接受插入修订后字符成为基线，三视图均显示', async () => {
    const { modelToPlain } = await import('../src/render.js');
    const { editor, host } = mk();
    host.beforeInput('insertText', '你好');
    eq(modelToPlain(editor.model, 'original'), '', '接受前原始视图不显示插入');
    const id = [...editor.model.revisions.keys()][0];
    editor.accept(id);
    eq(modelToPlain(editor.model, 'tracked'), '你好');
    eq(modelToPlain(editor.model, 'final'), '你好');
    eq(modelToPlain(editor.model, 'original'), '你好', '接受后成为基线');
  });

  it('重做栈在新事务后清空', () => {
    const { editor, host } = mk();
    host.type('a');
    host.type('b');
    host.undo();
    ok(editor.redoStack.length > 0);
    host.type('c');
    eq(editor.redoStack.length, 0);
  });
});
