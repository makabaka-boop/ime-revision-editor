// model.test.js — 文档模型层：插入/删除/跨段合并/接受拒绝/撤销快照。
import { describe, it, eq, ok } from './framework.js';
import { DocumentModel, makeRevision, resetIdCounter } from '../src/model.js';
import { Selection } from '../src/editor.js';

const fresh = () => {
  resetIdCounter(0);
  return new DocumentModel();
};
const rev = (m, type) => {
  const r = makeRevision(type);
  m.revisions.set(r.id, r);
  return r;
};
const text = (m) => m.paragraphs.map((p) => m.aliveText(p)).join('\n');
const sel = (p, o) => Selection.collapsed(p, o);

describe('模型基础', () => {
  it('插入字符并记录插入修订', () => {
    const m = fresh();
    const r = rev(m, 'insert');
    m.insertText(0, 0, '你好', false, r.id);
    r.charIds = m.paragraphs[0].chars.map((c) => c.id);
    eq(text(m), '你好');
    eq([...m.revisions.keys()], [r.id]);
    eq(m.paragraphs[0].chars.map((c) => c.ins), [r.id, r.id]);
  });

  it('删除只对基线字符打标记，对未接受插入字符物理移除', () => {
    const m = fresh();
    const ins = rev(m, 'insert');
    m.insertText(0, 0, 'AB', false, ins.id);
    ins.charIds = m.paragraphs[0].chars.map((c) => c.id);
    const d = rev(m, 'delete');
    m.deleteRange({ para: 0, offset: 0 }, { para: 0, offset: 2 }, d);
    eq(text(m), '');
    // 没有基线字符 -> 删除修订不应产生 chips
    eq(d.chips.length, 0);
    ok(d.moved === null);
  });

  it('删除基线字符保留在文档中并可拒绝恢复', () => {
    const m = fresh();
    // 直接构造基线：插入后接受
    const ins = rev(m, 'insert');
    m.insertText(0, 0, '你好世界', false, ins.id);
    ins.charIds = m.paragraphs[0].chars.map((c) => c.id);
    m.accept(ins.id);
    const d = rev(m, 'delete');
    m.deleteRange({ para: 0, offset: 1 }, { para: 0, offset: 3 }, d);
    eq(text(m), '你界');
    eq(m.paragraphs[0].chars.length, 4, '被删字符仍物理存在');
    m.reject(d.id);
    eq(text(m), '你好世界');
    eq(m.paragraphs.length, 1);
  });

  it('跨段删除合并段落，拒绝后按原物理位置恢复段落结构', () => {
    const m = fresh();
    const ins = rev(m, 'insert');
    m.insertText(0, 0, '一二', false, ins.id);
    m.splitPara(0, 2);
    m.insertText(1, 0, '三四', false, ins.id);
    m.splitPara(1, 2);
    m.insertText(2, 0, '五六', false, ins.id);
    ins.charIds = m.paragraphs.flatMap((p) => p.chars.map((c) => c.id));
    m.accept(ins.id);
    eq(text(m), '一二\n三四\n五六');

    const d = rev(m, 'delete');
    // 从第1段“一|二”之间删到第3段“五|六”之间
    m.deleteRange({ para: 0, offset: 1 }, { para: 2, offset: 1 }, d);
    eq(text(m), '一六');
    eq(m.paragraphs.length, 1, '三段合并为一段');

    m.reject(d.id);
    eq(text(m), '一二\n三四\n五六');
    eq(m.paragraphs.length, 3, '拒绝后恢复为三段');
    eq(m.aliveText(m.paragraphs[1]), '三四');
  });

  it('接受跨段删除后字符与空段被物理清理', () => {
    const m = fresh();
    const ins = rev(m, 'insert');
    m.insertText(0, 0, 'AB', false, ins.id);
    m.splitPara(0, 2);
    m.insertText(1, 0, 'CD', false, ins.id);
    ins.charIds = m.paragraphs.flatMap((p) => p.chars.map((c) => c.id));
    m.accept(ins.id);
    const d = rev(m, 'delete');
    m.deleteRange({ para: 0, offset: 1 }, { para: 1, offset: 1 }, d);
    eq(text(m), 'AD');
    m.accept(d.id);
    eq(text(m), 'AD');
    eq(m.paragraphs.length, 1);
    eq(m.paragraphs[0].chars.map((c) => c.ch), ['A', 'D']);
  });

  it('拒绝插入修订物理移除插入字符并清理产生的空段', () => {
    const m = fresh();
    const base = rev(m, 'insert');
    m.insertText(0, 0, '基线', false, base.id);
    base.charIds = m.paragraphs[0].chars.map((c) => c.id);
    m.accept(base.id);
    const ins = rev(m, 'insert');
    m.insertText(0, 2, '新增', false, ins.id);
    ins.charIds = m.paragraphs[0].chars.slice(2, 4).map((c) => c.id);
    eq(text(m), '基线新增');
    m.reject(ins.id);
    eq(text(m), '基线');
  });

  it('物理下标与逻辑下标在有删除字符时正确换算', () => {
    const m = fresh();
    const base = rev(m, 'insert');
    m.insertText(0, 0, 'ABCDE', false, base.id);
    base.charIds = m.paragraphs[0].chars.map((c) => c.id);
    m.accept(base.id);
    const d = rev(m, 'delete');
    m.deleteRange({ para: 0, offset: 1 }, { para: 0, offset: 4 }, d); // 删 BCD
    const p = m.paragraphs[0];
    // 物理：A B C D E；逻辑存活 A E
    eq(m.physicalIndex(p, 1), 4, '逻辑偏移1 -> 物理下标4（E 前）');
    eq(m.logicalIndex(p, 4), 1);
    eq(m.logicalIndex(p, 1), 1, 'B 之后的物理位置仍算逻辑1');
    eq(m.aliveCount(p), 2);
  });
});
