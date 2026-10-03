# 段落 · 加粗 · 修订编辑器

只含**段落、纯文本、加粗**的浏览器编辑器，支持可接受/拒绝的**插入、删除修订**，
以及输入法组合、粘贴净化、事务化撤销/重做。

## 运行

```bash
npm start          # 或 python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 测试

```bash
npm test           # node tests/run.js，43 个用例
```

测试模拟：中文 IME 组合输入完整事件序列（`compositionstart` → 多个
`beforeinput(insertCompositionText)` + `input` → `compositionend` → 补发的 `input`）、
跨段选择与删除、纯文本/HTML 粘贴、混合操作的撤销/重做顺序、
接受/拒绝修订后的光标映射、模型 ↔ DOM 选区双向映射。

## 架构

| 文件 | 职责 |
| --- | --- |
| `src/model.js` | 纯文档模型：段落/文本片段/加粗/修订标记，线性偏移定位，插入、删除、拆段、并段、接受/拒绝修订（均返回 removals 用于光标映射） |
| `src/derive.js` | 从同一模型派生：阅读视图段落、修订表、导出 HTML/纯文本 |
| `src/sanitize.js` | 粘贴净化：纯文本分段；HTML → 段落+加粗子集（手写 tokenizer，输出纯数据，脚本/样式/事件属性不会进入文档） |
| `src/editor.js` | 控制器（DOM 无关）：事务与撤销/重做、修订计数、IME 组合状态机、`beforeinput`/`input`/粘贴事件路由 |
| `src/domview.js` | DOM 渲染 + 模型线性偏移 ↔ DOM `(node, offset)` 双向映射 |
| `src/app.js` | 页面装配：事件接线、阅读视图/修订表/导出面板 |

### 文档模型

```
Doc  = { paragraphs: [Para] }
Para = { spans: [Span], ins, delBreak }   // ins: 段前换行是插入修订；delBreak: 段后换行被删除修订标记
Span = { text, bold, ins, del }           // ins/del: 修订 id
```

位置是全文线性字符偏移（每段文本后计 1 个换行偏移）。被标记删除的文字保留在模型中
并计入偏移，编辑器以删除线显示；阅读视图与导出将其过滤。

### 关键设计

- **事务化撤销**：每次变更提交一个 `{doc, sel}` 快照；连续同类输入（打字/退格）
  合并为一笔；一次 IME 组合、一次粘贴、一次接受/拒绝全部各为一笔。
- **IME 组合**：`compositionstart` 记录起点的选区；组合期间的
  `beforeinput(insertCompositionText)` 一律放行（浏览器显示临时内容），控制器不记录；
  `compositionend` 重渲染清掉临时 DOM，并把最终结果作为**一笔**事务提交；
  随后的 `input` 事件一律忽略——同一次输入不会被记两遍。
- **修订与光标**：接受/拒绝只从线性文本中**移除**区间（被拒绝的插入、被接受的删除、
  相应的换行），返回升序 removals；光标经 `mapThroughRemovals` 映射，
  落在移除区间内的折叠到区间起点，之后的平移，段落结构始终有效。
- **粘贴安全**：HTML 经手写 tokenizer 净化为纯数据（`script/style` 等连内容丢弃，
  实体解码为文本），渲染一律走 `textContent`，导出做 HTML 转义——
  粘贴的 HTML 不可能成为可执行标记。
- **同源视图**：阅读视图、修订表、导出 HTML 全部由 `derive.js` 从同一模型生成。
