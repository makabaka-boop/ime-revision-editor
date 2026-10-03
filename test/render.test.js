// render.test.js — 阅读视图、修订表、导出均从同一模型生成且转义安全。
import { describe, it, eq, ok } from './framework.js';
import { DocumentModel, resetIdCounter } from '../src/model.js';
import { makeEditor, seed } from './helpers.js';
import {
  modelToHtml,
  modelToMarkdown,
  modelToPlain,
  revisionsList,
  exportDoc,
} from '../src/render.js';

const build = () => {
  resetIdCounter(0);
  return makeEditor(new DocumentModel()); // {host, editor}
};

describe('同源渲染', () => {
  it('tracked/final/original 三种阅读视图正确', () => {
    const { editor, host } = build();
    seed(editor, host, '甲乙丙');
    host.caret(0, 3);
    host.backspace(); // 删除“丙”
    host.caret(0, 2);
    host.type('丁'); // 末尾插入“丁”
    // 物理：甲 乙 丙(del) 丁(ins)
    eq(modelToPlain(editor.model, 'tracked'), '甲乙丙丁');
    eq(modelToPlain(editor.model, 'final'), '甲乙丁');
    eq(modelToPlain(editor.model, 'original'), '甲乙丙');
  });

  it('tracked HTML 含 ins 标记且文本转义', () => {
    const { editor, host } = build();
    host.type('<b>&');
    const html = modelToHtml(editor.model, 'tracked');
    ok(html.includes('<ins'));
    ok(html.includes('&lt;b&gt;&amp;'));
    const finalHtml = modelToHtml(editor.model, 'final');
    ok(finalHtml.includes('&lt;b&gt;&amp;'));
  });

  it('粗体导出 Markdown', () => {
    const { editor, host } = build();
    seed(editor, host, 'AB');
    host.range(0, 0, 0, 2);
    editor.setSelection(host.getSelection());
    editor.toggleBold();
    eq(modelToMarkdown(editor.model, 'final'), '**AB**');
    host.undo();
    eq(modelToMarkdown(editor.model, 'final'), 'AB');
  });

  it('修订表内容与模型一致；接受后表中消失', () => {
    const { editor, host } = build();
    seed(editor, host, '基线');
    host.caret(0, 2);
    host.beforeInput('insertText', '新'); // 在“线”前插入：基 新 线
    host.caret(0, 1);
    host.backspace(); // 删除基线“基”
    let list = revisionsList(editor.model);
    eq(list.length, 2);
    eq(list.map((r) => r.type).sort(), ['delete', 'insert']);
    const ins = list.find((r) => r.type === 'insert');
    editor.accept(ins.id);
    eq(revisionsList(editor.model).length, 1);
  });

  it('跨段删除在修订表中标记为跨段', () => {
    const { editor, host } = build();
    seed(editor, host, ['AB', 'CD']);
    host.range(0, 1, 1, 1);
    editor.setSelection(host.getSelection());
    host.beforeInput('deleteContent', null);
    const item = revisionsList(editor.model)[0];
    eq(item.crossParagraph, true);
    ok(item.description.includes('跨段'));
  });

  it('exportDoc 各格式来自同一模型；JSON 可往返', () => {
    const { editor, host } = build();
    host.type('XY');
    const json = exportDoc(editor.model, { format: 'json' });
    const restored = DocumentModel.fromJSON(JSON.parse(json));
    eq(restored.aliveText(restored.paragraphs[0]), 'XY');
    ok(exportDoc(editor.model, { format: 'html', mode: 'tracked' }).includes('<ins'));
    ok(exportDoc(editor.model, { format: 'text', mode: 'final' }).includes('XY'));
  });

  it('粘贴的恶意 HTML 经导出仍无标签与脚本', () => {
    const { editor, host } = build();
    host.paste({ textHtml: '<a href="javascript:x()">点击</a><script>x</script>' });
    const html = exportDoc(editor.model, { format: 'html' });
    ok(!/javascript:/i.test(html));
    ok(!/<script/i.test(html));
    ok(html.includes('点击'));
  });
});
