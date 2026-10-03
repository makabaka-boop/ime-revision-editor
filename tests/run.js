// 测试：node tests/run.js
// 覆盖：模型操作、HTML 粘贴净化、中文 IME 组合输入事件序列、
// 跨段选择/删除、粘贴、撤销/重做顺序、接受/拒绝修订后的光标映射、
// 以及模型 <-> DOM 选区双向映射（使用简易假 DOM）。

import {
  createDoc, cloneDoc, span, paragraph, textLength, plainText, normalize,
  locate, offsetOf, insertTextInto, deleteRange, markDeleted, splitParagraph,
  insertParagraphs, setBold, allBold, insertionAttrs,
  acceptRevision, rejectRevision, mapThroughRemovals,
} from '../src/model.js';
import { finalParagraphs, exportHtml, exportText, listRevisions } from '../src/derive.js';
import { sanitizeHtml, textToParagraphs, decodeEntities } from '../src/sanitize.js';
import { Editor } from '../src/editor.js';
import { DomView, domPositionFromModelOffset, modelOffsetFromDomPosition } from '../src/domview.js';

// ---------- 微型测试框架 ----------

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.error(`FAIL ${name}\n     ${e.message}`);
  }
}

function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n     期望: ${b}\n     实际: ${a}`);
}

function ok(cond, msg = '断言失败') {
  if (!cond) throw new Error(msg);
}

// 结构不变量：≥1 段、span 非空、相邻 span 不重复属性、光标在界内。
function assertValid(ed) {
  const doc = ed.doc;
  ok(doc.paragraphs.length >= 1, '至少一个段落');
  for (const p of doc.paragraphs) {
    for (let i = 0; i < p.spans.length; i++) {
      ok(p.spans[i].text.length > 0, 'span 非空');
      if (i > 0) {
        const a = p.spans[i - 1];
        const b = p.spans[i];
        ok(!(a.bold === b.bold && a.ins === b.ins && a.del === b.del), '相邻 span 属性不同');
      }
    }
  }
  const len = textLength(doc);
  ok(ed.sel.anchor >= 0 && ed.sel.anchor <= len, 'anchor 在界内');
  ok(ed.sel.head >= 0 && ed.sel.head <= len, 'head 在界内');
}

// ---------- 控制器测试辅助 ----------

class MockView {
  constructor() { this.states = []; }
  render(state) { this.states.push(state); }
  get last() { return this.states[this.states.length - 1]; }
}

function newEditor() {
  const view = new MockView();
  const ed = new Editor(view);
  ed.render();
  return ed;
}

// 模拟普通键盘输入：beforeinput(prevent) -> input（被忽略）。
function type(ed, text) {
  for (const ch of text) {
    const r = ed.handleBeforeInput({ inputType: 'insertText', data: ch, isComposing: false });
    ok(r.preventDefault, 'insertText 应 preventDefault');
    ed.handleInput({ inputType: 'insertText', data: ch, isComposing: false });
  }
}

function pressEnter(ed) {
  ed.handleBeforeInput({ inputType: 'insertParagraph', data: null, isComposing: false });
}

function backspace(ed) {
  ed.handleBeforeInput({ inputType: 'deleteContentBackward', data: null, isComposing: false });
}

function docText(ed) {
  return plainText(ed.doc);
}

// ---------- 模型测试 ----------

test('locate/offsetOf 在所有偏移上互逆（含空段与多 span）', () => {
  const doc = {
    paragraphs: [
      paragraph([span('AB'), span('CD', { bold: true })]),
      paragraph([]),
      paragraph([span('EFG', { ins: 7 })]),
    ],
  };
  const len = textLength(doc); // 4 + 1 + 0 + 1 + 3 = 9
  eq(len, 9);
  for (let o = 0; o <= len; o++) {
    const loc = locate(doc, o);
    eq(offsetOf(doc, loc.para, loc.span, loc.char), o, `偏移 ${o} 往返`);
  }
  // 换行偏移归入前一段末尾
  eq(locate(doc, 4), { para: 0, span: 1, char: 2 });
  eq(locate(doc, 5), { para: 1, span: 0, char: 0 }); // 空段
  eq(locate(doc, 6), { para: 2, span: 0, char: 0 });
});

test('insertTextInto：同属性合并、异属性拆分', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AB', {});
  insertTextInto(doc, 1, 'x', {});
  eq(doc.paragraphs[0].spans, [span('AxB')]);
  insertTextInto(doc, 1, 'B', { bold: true });
  eq(doc.paragraphs[0].spans, [span('A'), span('B', { bold: true }), span('xB')]);
});

test('deleteRange：段内与跨段', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AAA', {});
  splitParagraph(doc, 3);
  insertTextInto(doc, 4, 'BBB', {});
  splitParagraph(doc, 7);
  insertTextInto(doc, 8, 'CCC', {});
  eq(plainText(doc), 'AAA\nBBB\nCCC');
  deleteRange(doc, 1, 9); // 从 p0[1] 到 p2[1]
  eq(plainText(doc), 'ACC');
  eq(doc.paragraphs.length, 1);
});

test('markDeleted：文字标 del、换行标 delBreak、未接受插入直接移除', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AAA', {});
  splitParagraph(doc, 3);
  insertTextInto(doc, 4, 'BBB', {});
  splitParagraph(doc, 7);
  insertTextInto(doc, 8, 'CCC', {});
  markDeleted(doc, 1, 9, 42);
  const [p0, p1, p2] = doc.paragraphs;
  eq(p0.spans, [span('A'), span('AA', { del: 42 })]);
  eq(p0.delBreak, 42);
  eq(p1.spans, [span('BBB', { del: 42 })]);
  eq(p1.delBreak, 42);
  eq(p2.spans, [span('C', { del: 42 }), span('CC')]);
  // 未接受的插入文字被删除时直接移除
  const doc2 = createDoc();
  insertTextInto(doc2, 0, 'xy', { ins: 5 });
  insertTextInto(doc2, 2, 'z', {});
  markDeleted(doc2, 0, 3, 9);
  eq(doc2.paragraphs[0].spans, [span('z', { del: 9 })]);
});

test('splitParagraph：修订模式下新段落带 ins 标记', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'ABCD', {});
  splitParagraph(doc, 2, 7);
  eq(doc.paragraphs.length, 2);
  eq(doc.paragraphs[0].ins, null);
  eq(doc.paragraphs[1].ins, 7);
  eq(plainText(doc), 'AB\nCD');
});

test('acceptRevision：插入转正、删除移除、换行合并，removals 正确', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AB', { ins: 1 });
  insertTextInto(doc, 2, 'CD', {});
  insertTextInto(doc, 4, 'EF', { del: 2 });
  splitParagraph(doc, 6);
  doc.paragraphs[0].delBreak = 2;
  insertTextInto(doc, 7, 'GH', {});
  // 接受修订 2（删除 'EF' 与换行）
  const removals = acceptRevision(doc, 2);
  eq(plainText(doc), 'ABCDGH');
  eq(doc.paragraphs.length, 1);
  eq(removals, [{ start: 4, end: 6 }, { start: 6, end: 7 }]);
  // 接受修订 1（插入转正）
  acceptRevision(doc, 1);
  eq(doc.paragraphs[0].spans.every((s) => s.ins == null), true);
  eq(plainText(doc), 'ABCDGH');
});

test('rejectRevision：插入移除（含插入的段落并回）、删除恢复', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AB', {});
  splitParagraph(doc, 2, 5); // 第二段是修订 5 的插入
  insertTextInto(doc, 3, 'CD', { ins: 5 });
  insertTextInto(doc, 5, 'EF', { del: 6 });
  eq(plainText(doc), 'AB\nCDEF');
  const removals = rejectRevision(doc, 5);
  eq(plainText(doc), 'ABEF');
  eq(doc.paragraphs.length, 1);
  eq(removals, [{ start: 2, end: 3 }, { start: 3, end: 5 }]); // 换行 + 'CD'
  rejectRevision(doc, 6);
  eq(doc.paragraphs[0].spans.every((s) => s.del == null), true);
});

test('mapThroughRemovals：区间内折叠、区间后平移、边界一致', () => {
  const rem = [{ start: 2, end: 5 }, { start: 8, end: 9 }];
  eq(mapThroughRemovals(0, rem), 0);
  eq(mapThroughRemovals(2, rem), 2);
  eq(mapThroughRemovals(3, rem), 2); // 区间内 -> 区间起点
  eq(mapThroughRemovals(5, rem), 2);
  eq(mapThroughRemovals(7, rem), 4);
  eq(mapThroughRemovals(9, rem), 5);
  eq(mapThroughRemovals(12, rem), 8);
});

test('setBold / allBold', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'hello world', {});
  setBold(doc, 0, 5, true);
  eq(allBold(doc, 0, 5), true);
  eq(allBold(doc, 0, 6), false);
  eq(doc.paragraphs[0].spans, [span('hello', { bold: true }), span(' world')]);
  setBold(doc, 0, 5, false);
  eq(doc.paragraphs[0].spans, [span('hello world')]);
});

test('insertParagraphs：段中插入多段并保留右半部分', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'XY', {});
  const inserted = insertParagraphs(doc, 1, [
    { spans: [{ text: 'a', bold: true }] },
    { spans: [{ text: 'b', bold: false }] },
  ], { ins: 3 });
  eq(inserted, 3); // 'a' + 'b' + 1 个换行
  eq(plainText(doc), 'Xa\nbY');
  eq(doc.paragraphs[0].spans, [span('X'), span('a', { bold: true, ins: 3 })]);
  eq(doc.paragraphs[1].ins, 3);
  eq(doc.paragraphs[1].spans, [span('b', { ins: 3 }), span('Y')]);
});

test('insertionAttrs：延续左侧未接受的插入', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'ab', { ins: 4 });
  eq(insertionAttrs(doc, 2, { bold: false }), { bold: false, ins: 4 });
  eq(insertionAttrs(doc, 2, { bold: false, trackRevId: 9 }), { bold: false, ins: 9 });
  insertTextInto(doc, 2, 'cd', {});
  eq(insertionAttrs(doc, 4, { bold: false }), { bold: false, ins: null });
});

// ---------- 净化测试 ----------

test('textToParagraphs：\\n、\\r\\n、空行', () => {
  eq(textToParagraphs('a\nb\r\nc\r'), [
    { spans: [{ text: 'a', bold: false }] },
    { spans: [{ text: 'b', bold: false }] },
    { spans: [{ text: 'c', bold: false }] },
    { spans: [] },
  ]);
});

test('sanitizeHtml：段落与加粗', () => {
  eq(sanitizeHtml('<p>Hello <b>wor</b>ld</p><p>二<strong>号</strong></p>'), [
    { spans: [{ text: 'Hello ', bold: false }, { text: 'wor', bold: true }, { text: 'ld', bold: false }] },
    { spans: [{ text: '二', bold: false }, { text: '号', bold: true }] },
  ]);
});

test('sanitizeHtml：script/事件属性/样式不会进入文档', () => {
  const out = sanitizeHtml(
    '<p onclick="x()">a</p><script>alert(1)</script>' +
    '<p><img src=x onerror="alert(2)">b</p>' +
    '<style>body{display:none}</style><p>c</p>'
  );
  eq(out, [
    { spans: [{ text: 'a', bold: false }] },
    { spans: [{ text: 'b', bold: false }] },
    { spans: [{ text: 'c', bold: false }] },
  ]);
  const all = JSON.stringify(out);
  ok(!all.includes('alert'), '不含脚本内容');
  ok(!all.includes('onerror') && !all.includes('onclick'), '不含事件属性');
  ok(!all.includes('<'), '不含任何标记');
});

test('sanitizeHtml：实体解码为纯文本而非标记', () => {
  eq(sanitizeHtml('<p>a &lt;b&gt; c &amp; d&#65;</p>'), [
    { spans: [{ text: 'a <b> c & dA', bold: false }] },
  ]);
  eq(decodeEntities('&quot;&#x4F60;&nbsp;x'), '"你 x');
});

test('sanitizeHtml：孤立 < 当作文本，自闭合 skip 标签不吞掉后续内容', () => {
  eq(sanitizeHtml('<p>1 < 2 and 3 > 2</p>'), [
    { spans: [{ text: '1 < 2 and 3 > 2', bold: false }] },
  ]);
  eq(sanitizeHtml('<meta charset="utf-8"/><p>ok</p>'), [
    { spans: [{ text: 'ok', bold: false }] },
  ]);
});

// ---------- 派生视图测试 ----------

test('finalParagraphs / exportHtml / listRevisions 来自同一模型', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, 'AB', { ins: 1 });
  insertTextInto(doc, 2, 'CD', {});
  insertTextInto(doc, 4, 'EF', { del: 2 });
  setBold(doc, 0, 2, true);
  eq(finalParagraphs(doc), [
    { spans: [{ text: 'AB', bold: true }, { text: 'CD', bold: false }] },
  ]);
  eq(exportHtml(doc), '<p><strong>AB</strong>CD</p>');
  eq(exportText(doc), 'ABCD');
  eq(listRevisions(doc), [
    { id: 1, kind: 'insert', text: 'AB', paragraphs: [0] },
    { id: 2, kind: 'delete', text: 'EF', paragraphs: [0] },
  ]);
});

test('exportHtml 转义特殊字符', () => {
  const doc = createDoc();
  insertTextInto(doc, 0, '<b> & "x"', {});
  eq(exportHtml(doc), '<p>&lt;b&gt; &amp; &quot;x&quot;</p>');
});

// ---------- 控制器：输入与撤销 ----------

test('连续输入合并为一笔撤销事务；撤销/重做恢复', () => {
  const ed = newEditor();
  type(ed, 'abc');
  eq(docText(ed), 'abc');
  eq(ed.undoStack.length, 1, '三次击键合并为一笔');
  ed.undo();
  eq(docText(ed), '');
  eq(ed.sel, { anchor: 0, head: 0 });
  ed.redo();
  eq(docText(ed), 'abc');
  eq(ed.sel, { anchor: 3, head: 3 });
  assertValid(ed);
});

test('移动光标打断输入合并', () => {
  const ed = newEditor();
  type(ed, 'ab');
  ed.setSelection({ anchor: 0, head: 0 });
  type(ed, 'c');
  eq(ed.undoStack.length, 2);
  eq(docText(ed), 'cab');
});

test('选区替换输入', () => {
  const ed = newEditor();
  type(ed, 'hello');
  ed.setSelection({ anchor: 1, head: 4 });
  type(ed, 'X');
  eq(docText(ed), 'hXo');
  eq(ed.sel, { anchor: 2, head: 2 });
});

// ---------- 控制器：IME 组合 ----------

test('中文组合输入：组合期间不记录，结束时一笔事务，补发事件不重复记录', () => {
  const ed = newEditor();
  const undoBefore = ed.undoStack.length;
  const rendersBefore = ed.view.states.length;

  ed.compositionStart();
  // 拼音过程：n -> ni -> ni h -> ni ha -> ni hao
  for (const s of ['n', 'ni', 'ni h', 'ni ha', 'ni hao']) {
    const r = ed.handleBeforeInput({ inputType: 'insertCompositionText', data: s, isComposing: true });
    ok(!r.preventDefault, '组合中的 beforeinput 应放行以显示临时内容');
    ed.handleInput({ inputType: 'insertCompositionText', data: s, isComposing: true });
    eq(docText(ed), '', '组合期间模型不变');
    eq(ed.undoStack.length, undoBefore, '组合期间不产生撤销记录');
  }
  eq(ed.view.states.length, rendersBefore, '组合期间控制器不重渲染（临时内容归浏览器管）');

  ed.compositionEnd('你好');
  eq(docText(ed), '你好');
  eq(ed.undoStack.length, undoBefore + 1, '组合结束恰好提交一笔事务');
  eq(ed.sel, { anchor: 2, head: 2 });

  // 浏览器在 compositionend 后补发的 input / beforeinput 不得再记一遍
  ed.handleInput({ inputType: 'insertCompositionText', data: '你好', isComposing: false });
  eq(docText(ed), '你好');
  eq(ed.undoStack.length, undoBefore + 1);

  ed.undo();
  eq(docText(ed), '');
  ed.redo();
  eq(docText(ed), '你好');
  assertValid(ed);
});

test('两次中文组合各成一笔；修订模式下每次组合一条插入修订', () => {
  const ed = newEditor();
  ed.setTrackChanges(true);
  ed.compositionStart();
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'ni', isComposing: true });
  ed.compositionEnd('你');
  ed.handleInput({ inputType: 'insertCompositionText', data: '你', isComposing: false });
  ed.compositionStart();
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'hao', isComposing: true });
  ed.compositionEnd('好');
  eq(docText(ed), '你好');
  eq(ed.undoStack.length, 2);
  const revs = listRevisions(ed.doc);
  eq(revs.length, 2);
  eq(revs[0], { id: revs[0].id, kind: 'insert', text: '你', paragraphs: [0] });
  eq(revs[1].text, '好');
  ed.undo();
  eq(docText(ed), '你');
  ed.undo();
  eq(docText(ed), '');
  assertValid(ed);
});

test('组合取消（空 data）不产生事务', () => {
  const ed = newEditor();
  type(ed, 'a');
  const undoBefore = ed.undoStack.length;
  ed.compositionStart();
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'x', isComposing: true });
  ed.compositionEnd('');
  eq(docText(ed), 'a');
  eq(ed.undoStack.length, undoBefore);
});

test('组合替换选区', () => {
  const ed = newEditor();
  type(ed, 'abcdef');
  ed.setSelection({ anchor: 2, head: 4 });
  ed.compositionStart();
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'zh', isComposing: true });
  ed.compositionEnd('中');
  eq(docText(ed), 'ab中ef');
  eq(ed.sel, { anchor: 3, head: 3 });
  ed.undo();
  eq(docText(ed), 'abcdef');
});

// ---------- 控制器：跨段选择与删除 ----------

test('跨段选择删除（非修订）：段落合并，光标在接合点', () => {
  const ed = newEditor();
  ed.paste({ text: 'AAA\nBBB\nCCC' });
  eq(docText(ed), 'AAA\nBBB\nCCC');
  ed.setSelection({ anchor: 1, head: 9 }); // p0[1] -> p2[1]
  ed.deleteSelection();
  eq(docText(ed), 'ACC');
  eq(ed.doc.paragraphs.length, 1);
  eq(ed.sel, { anchor: 1, head: 1 });
  ed.undo();
  eq(docText(ed), 'AAA\nBBB\nCCC');
  assertValid(ed);
});

test('跨段删除（修订模式）：标记 del/delBreak，阅读视图已合并', () => {
  const ed = newEditor();
  ed.paste({ text: 'AAA\nBBB\nCCC' });
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 1, head: 9 });
  ed.deleteSelection();
  eq(docText(ed), 'AAA\nBBB\nCCC', '模型保留原文');
  eq(exportText(ed.doc), 'ACC', '阅读视图为删除后的样子');
  const revs = listRevisions(ed.doc);
  eq(revs.length, 1);
  eq(revs[0].kind, 'delete');
  // 接受 -> 真正合并
  ed.acceptRevision(revs[0].id);
  eq(docText(ed), 'ACC');
  eq(ed.doc.paragraphs.length, 1);
  eq(ed.sel, { anchor: 1, head: 1 }, '光标映射到接合点');
  ed.undo();
  // 拒绝 -> 恢复原样
  const revs2 = listRevisions(ed.doc);
  ed.rejectRevision(revs2[0].id);
  eq(docText(ed), 'AAA\nBBB\nCCC');
  eq(ed.doc.paragraphs.length, 3);
  assertValid(ed);
});

test('markDeleted：跨段删除覆盖未接受的插入段落时直接并段', () => {
  const ed = newEditor();
  type(ed, 'AB');                    // 普通文字
  ed.setTrackChanges(true);
  pressEnter(ed);                    // 换行 = 修订 r1（para.ins）
  type(ed, 'CD');                    // 插入文字 = 修订 r2
  eq(docText(ed), 'AB\nCD');
  // 全选并修订删除
  ed.setSelection({ anchor: 0, head: textLength(ed.doc) });
  ed.deleteSelection();              // 修订 r3
  eq(ed.doc.paragraphs.length, 1, '插入的段落被直接并回');
  eq(ed.doc.paragraphs[0].spans, [span('AB', { del: listRevisions(ed.doc)[0].id })],
    '普通文字标记删除，未接受的插入文字直接移除');
  eq(exportText(ed.doc), '', '阅读视图为空');
  const [rev] = listRevisions(ed.doc);
  ed.rejectRevision(rev.id);
  eq(docText(ed), 'AB');
  eq(ed.doc.paragraphs.length, 1);
  assertValid(ed);
});

test('段首退格（非修订）合并段落；修订模式标记换行删除', () => {
  const ed = newEditor();
  type(ed, 'AB');
  pressEnter(ed);
  type(ed, 'CD');
  eq(docText(ed), 'AB\nCD');
  ed.setSelection({ anchor: 3, head: 3 }); // 第二段段首
  backspace(ed);
  eq(docText(ed), 'ABCD');
  eq(ed.sel, { anchor: 2, head: 2 });

  const ed2 = newEditor();
  type(ed2, 'AB');
  pressEnter(ed2);
  type(ed2, 'CD');
  ed2.setTrackChanges(true);
  ed2.setSelection({ anchor: 3, head: 3 });
  backspace(ed2);
  eq(docText(ed2), 'AB\nCD', '换行仍在模型中');
  eq(exportText(ed2.doc), 'ABCD', '阅读视图已合并');
  eq(ed2.doc.paragraphs[0].delBreak != null, true);
  const [rev] = listRevisions(ed2.doc);
  ed2.rejectRevision(rev.id);
  eq(exportText(ed2.doc), 'AB\nCD');
  assertValid(ed2);
});

// ---------- 控制器：粘贴 ----------

test('粘贴纯文本：拆段、一笔事务、光标落在粘贴内容之后', () => {
  const ed = newEditor();
  type(ed, 'XY');
  ed.setSelection({ anchor: 1, head: 1 });
  const undoBefore = ed.undoStack.length;
  ed.paste({ text: 'a\nb\nc' });
  eq(docText(ed), 'Xa\nb\ncY');
  eq(ed.doc.paragraphs.length, 3);
  eq(ed.undoStack.length, undoBefore + 1, '粘贴是一笔事务');
  eq(ed.sel, { anchor: 6, head: 6 }, '光标在粘贴内容末尾'); // X0 a1 \n2 b3 \n4 c5 |Y6
  // 粘贴后继续输入位置正确
  type(ed, '!');
  eq(docText(ed), 'Xa\nb\nc!Y');
  ed.undo(); // 撤销 '!'
  ed.undo(); // 撤销粘贴
  eq(docText(ed), 'XY');
  assertValid(ed);
});

test('粘贴替换选区', () => {
  const ed = newEditor();
  type(ed, 'hello world');
  ed.setSelection({ anchor: 0, head: 5 });
  ed.paste({ text: '你好' });
  eq(docText(ed), '你好 world');
  eq(ed.sel, { anchor: 2, head: 2 });
});

test('粘贴 HTML：只保留段落/文字/加粗，脚本不进文档', () => {
  const ed = newEditor();
  ed.paste({
    html: '<p>Hello <b>粗</b>体</p><script>alert(1)</script><p><img src=x onerror=alert(2)>二</p>',
    text: 'Hello 粗体\n二',
  });
  eq(docText(ed), 'Hello 粗体\n二');
  eq(ed.doc.paragraphs[0].spans, [
    span('Hello '),
    span('粗', { bold: true }),
    span('体'),
  ]);
  ok(!JSON.stringify(ed.doc).includes('alert'), '文档不含脚本');
  ok(!exportHtml(ed.doc).includes('onerror'), '导出不带事件属性');
  eq(exportHtml(ed.doc), '<p>Hello <strong>粗</strong>体</p>\n<p>二</p>');
  assertValid(ed);
});

test('修订模式下粘贴：插入内容标为一条修订', () => {
  const ed = newEditor();
  type(ed, 'AB');
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 1, head: 1 });
  ed.paste({ text: 'x\ny' });
  eq(docText(ed), 'Ax\nyB');
  const revs = listRevisions(ed.doc);
  eq(revs.length, 1);
  eq(revs[0].kind, 'insert');
  ed.rejectRevision(revs[0].id);
  eq(docText(ed), 'AB');
  eq(ed.doc.paragraphs.length, 1);
  assertValid(ed);
});

// ---------- 控制器：修订接受/拒绝与光标 ----------

test('接受删除：光标按移除区间平移；落在被删区内则折叠到起点', () => {
  const ed = newEditor();
  type(ed, 'hello world');
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 0, head: 5 });
  ed.deleteSelection(); // 'hello' 标记删除
  ed.setSelection({ anchor: 11, head: 11 }); // 文档末尾
  const [rev] = listRevisions(ed.doc);
  ed.acceptRevision(rev.id);
  eq(docText(ed), ' world');
  eq(ed.sel, { anchor: 6, head: 6 }, '光标前移 5');

  // 光标在被删区域内
  const ed2 = newEditor();
  type(ed2, 'hello world');
  ed2.setTrackChanges(true);
  ed2.setSelection({ anchor: 0, head: 5 });
  ed2.deleteSelection();
  ed2.setSelection({ anchor: 3, head: 3 });
  const [rev2] = listRevisions(ed2.doc);
  ed2.acceptRevision(rev2.id);
  eq(ed2.sel, { anchor: 0, head: 0 }, '折叠到移除起点');
  assertValid(ed2);
});

test('拒绝插入：插入文字移除，光标折叠；拒绝后段落结构有效', () => {
  const ed = newEditor();
  type(ed, 'X');
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 0, head: 0 });
  type(ed, 'abc'); // 修订：在 X 前插入 abc
  eq(docText(ed), 'abcX');
  ed.setSelection({ anchor: 2, head: 2 }); // 插入文字内部
  const [rev] = listRevisions(ed.doc);
  ed.rejectRevision(rev.id);
  eq(docText(ed), 'X');
  eq(ed.sel, { anchor: 0, head: 0 });
  assertValid(ed);
});

test('接受/拒绝全部：一笔事务，撤销可整体还原', () => {
  const ed = newEditor();
  type(ed, 'AB');
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 1, head: 1 });
  type(ed, '新');
  ed.setSelection({ anchor: 0, head: 1 });
  ed.deleteSelection();
  eq(listRevisions(ed.doc).length, 2);
  const undoBefore = ed.undoStack.length;
  ed.acceptAll();
  eq(ed.undoStack.length, undoBefore + 1, '接受全部是一笔事务');
  eq(docText(ed), '新B');
  eq(listRevisions(ed.doc).length, 0);
  ed.undo();
  eq(listRevisions(ed.doc).length, 2);
  ed.rejectAll();
  eq(docText(ed), 'AB');
  assertValid(ed);
});

// ---------- 控制器：撤销/重做顺序 ----------

test('混合操作序列的撤销/重做严格逆序', () => {
  const ed = newEditor();
  // 在每次变更操作之前（含选区调整之后）记录快照，
  // 使快照恰好等于撤销该操作时恢复的状态。
  const snaps = [];
  const snap = () => snaps.push(JSON.stringify({ doc: ed.doc, sel: ed.sel }));

  snap();                            // S0
  type(ed, 'Hello');                 // 事务 1（合并）
  snap();                            // S1
  pressEnter(ed);                    // 事务 2
  snap();                            // S2
  type(ed, 'World');                 // 事务 3
  ed.setTrackChanges(true);
  ed.setSelection({ anchor: 6, head: 11 });
  snap();                            // S3（删除前，含选区）
  ed.deleteSelection();              // 事务 4：修订删除 'World'
  snap();                            // S4
  ed.paste({ text: 'A\nB' });        // 事务 5：修订粘贴
  snap();                            // S5
  ed.compositionStart();             // 事务 6：修订组合输入
  ed.handleBeforeInput({ inputType: 'insertCompositionText', data: 'zhong', isComposing: true });
  ed.compositionEnd('中');
  ed.handleInput({ inputType: 'insertCompositionText', data: '中', isComposing: false });
  const finalSnap = JSON.stringify({ doc: ed.doc, sel: ed.sel }); // S6

  eq(ed.undoStack.length, 6, '共 6 笔事务');

  // 逐步撤销，每一步都必须等于当初的快照
  for (let i = snaps.length - 1; i >= 0; i--) {
    ed.undo();
    eq(JSON.stringify({ doc: ed.doc, sel: ed.sel }), snaps[i], `撤销到快照 ${i}`);
    assertValid(ed);
  }
  // 逐步重做，严格正序还原
  for (let i = 1; i < snaps.length; i++) {
    ed.redo();
    eq(JSON.stringify({ doc: ed.doc, sel: ed.sel }), snaps[i], `重做到快照 ${i}`);
    assertValid(ed);
  }
  ed.redo();
  eq(JSON.stringify({ doc: ed.doc, sel: ed.sel }), finalSnap, '重做到最终状态');
  assertValid(ed);
});

test('撤销后新操作清空重做栈', () => {
  const ed = newEditor();
  type(ed, 'a');
  pressEnter(ed);
  ed.undo();
  type(ed, 'b');
  eq(ed.redoStack.length, 0);
  eq(docText(ed), 'ab');
});

test('beforeinput 路由：historyUndo/historyRedo 与未知类型', () => {
  const ed = newEditor();
  type(ed, 'ab');
  ed.handleBeforeInput({ inputType: 'historyUndo', data: null, isComposing: false });
  eq(docText(ed), '');
  ed.handleBeforeInput({ inputType: 'historyRedo', data: null, isComposing: false });
  eq(docText(ed), 'ab');
  const r = ed.handleBeforeInput({ inputType: 'formatBold', data: null, isComposing: false });
  ok(r.preventDefault, '未知类型被阻止');
  eq(docText(ed), 'ab', '未知类型不改变文档');
});

// ---------- DOM 选区映射（假 DOM） ----------

class FText {
  constructor(d) { this.nodeType = 3; this.data = d; this.childNodes = []; this.parentNode = null; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = v; }
}
class FEl {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = doc;
    this.className = '';
  }
  appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; }
}
class FDoc {
  createElement(t) { return new FEl(t, this); }
  createTextNode(d) { return new FText(d); }
}

function renderToFake(doc, sel = { anchor: 0, head: 0 }) {
  const fdoc = new FDoc();
  const root = fdoc.createElement('div');
  const view = new DomView(root);
  view.render({ doc, sel });
  return root;
}

test('DomView 渲染结构：strong/rev-ins/rev-del/br', () => {
  const doc = {
    paragraphs: [
      paragraph([span('AB'), span('CD', { bold: true })]),
      paragraph([]),
      paragraph([span('EF', { ins: 1 }), span('GH', { del: 2 })]),
    ],
  };
  const root = renderToFake(doc);
  eq(root.children.length, 3);
  eq(root.children[0].children[0].tagName, 'STRONG');
  eq(root.children[1].children[0].tagName, 'BR', '空段落渲染 <br>');
  eq(root.children[2].children[0].tagName, 'SPAN');
  eq(root.children[2].children[0].className, 'rev-ins');
  eq(root.children[2].children[1].tagName, 'DEL');
});

test('模型偏移 -> DOM -> 模型偏移：所有偏移往返一致', () => {
  const doc = {
    paragraphs: [
      paragraph([span('AB'), span('CD', { bold: true })]),
      paragraph([]),
      paragraph([span('EF', { ins: 1 }), span('GH', { del: 2 })]),
    ],
  };
  const root = renderToFake(doc);
  const len = textLength(doc); // 4+1+0+1+4 = 10
  for (let o = 0; o <= len; o++) {
    const pos = domPositionFromModelOffset(root, o);
    eq(modelOffsetFromDomPosition(root, pos.node, pos.offset), o, `偏移 ${o} 经 DOM 往返`);
  }
});

test('DOM 位置 -> 模型偏移：跨段选择锚点/焦点', () => {
  const doc = {
    paragraphs: [
      paragraph([span('AAA')]),
      paragraph([span('BBB')]),
      paragraph([span('CCC')]),
    ],
  };
  const root = renderToFake(doc);
  const textOf = (p) => root.children[p].childNodes[0];
  // 锚点在 p0 字符 1，焦点在 p2 字符 2（p0:0-2, \n:3, p1:4-6, \n:7, p2:8-10）
  const anchor = modelOffsetFromDomPosition(root, textOf(0), 1);
  const head = modelOffsetFromDomPosition(root, textOf(2), 2);
  eq(anchor, 1);
  eq(head, 10);
  // 跨段删除该选区
  const ed = newEditor();
  ed.paste({ text: 'AAA\nBBB\nCCC' });
  ed.setSelection({ anchor, head });
  ed.deleteSelection();
  eq(docText(ed), 'AC');
});

test('拆段/并段后 DOM 映射仍指向正确字符', () => {
  const ed = newEditor();
  type(ed, 'ABCD');
  ed.setSelection({ anchor: 2, head: 2 });
  pressEnter(ed); // 拆段：AB|CD -> AB\nCD，光标 3
  eq(ed.sel, { anchor: 3, head: 3 });
  const root = renderToFake(ed.doc, ed.sel);
  const pos = domPositionFromModelOffset(root, ed.sel.anchor);
  eq(pos.node.parentNode.tagName, 'P');
  eq(modelOffsetFromDomPosition(root, pos.node, pos.offset), 3);
  // 并段（撤销拆段）后光标 2，仍指向 C 前
  ed.undo();
  eq(ed.sel, { anchor: 2, head: 2 });
  const root2 = renderToFake(ed.doc, ed.sel);
  const pos2 = domPositionFromModelOffset(root2, ed.sel.anchor);
  eq(modelOffsetFromDomPosition(root2, pos2.node, pos2.offset), 2);
});

// ---------- 汇总 ----------

console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error('失败用例: ' + failures.join(' | '));
  process.exit(1);
}
