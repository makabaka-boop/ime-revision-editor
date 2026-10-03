// render.js — 阅读视图、修订表、导出全部从同一个 DocumentModel 生成。
//
// 三种显示模式：
//   tracked  显示修订标记（插入带下划线、删除带删除线）
//   final    采纳视图：隐藏被删文字，插入文字按普通文字显示
//   original 原始视图：隐藏插入文字，被删文字照常显示
//
// 输出 HTML 时所有字符文本都经转义，模型里不可能夹带可执行标记
// （粘贴入口也已把 HTML 纯文本化）。

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function visibleChars(para, mode) {
  return para.chars.filter((c) => {
    if (c.del && mode === 'final') return false;
    if (c.ins && mode === 'original') return false;
    return true;
  });
}

// ---------- 纯文本 ----------

export function modelToPlain(model, mode = 'tracked') {
  return model.paragraphs
    .map((p) => visibleChars(p, mode).map((c) => c.ch).join(''))
    .join('\n');
}

// ---------- Markdown 导出（仅段落、文字、**加粗**） ----------

export function modelToMarkdown(model, mode = 'final') {
  return model.paragraphs
    .map((p) => {
      let out = '';
      let bold = false;
      for (const c of visibleChars(p, mode)) {
        if (c.bold !== bold) {
          out += '**';
          bold = c.bold;
        }
        out += c.ch.replace(/([*\\`\[\]])/g, '\\$1');
      }
      if (bold) out += '**';
      return out;
    })
    .join('\n\n');
}

// ---------- HTML（阅读视图直接 innerHTML 此字符串） ----------

// 嵌套层次（外->内）：del > ins > strong；状态变化时反序关闭、正序打开。
const LAYERS = [
  { key: 'del', tag: 'del', cls: 'rev-del' },
  { key: 'ins', tag: 'ins', cls: 'rev-ins' },
  { key: 'bold', tag: 'strong', cls: '' },
];

function stateOf(c, mode) {
  return {
    del: mode === 'tracked' && !!c.del,
    ins: mode === 'tracked' && !!c.ins,
    bold: !!c.bold,
  };
}

export function modelToHtml(model, mode = 'tracked') {
  return model.paragraphs
    .map((p) => {
      const chars = visibleChars(p, mode);
      let html = '';
      let cur = { del: false, ins: false, bold: false };
      const syncTo = (next) => {
        for (let i = LAYERS.length - 1; i >= 0; i--) {
          const L = LAYERS[i];
          if (cur[L.key] && !next[L.key]) html += `</${L.tag}>`;
        }
        for (const L of LAYERS) {
          if (!cur[L.key] && next[L.key]) {
            html += `<${L.tag}${L.cls ? ` class="${L.cls}"` : ``}>`;
          }
        }
        cur = { ...next };
      };
      for (const c of chars) syncTo(stateOf(c, mode)), (html += escapeHtml(c.ch));
      syncTo({ del: false, ins: false, bold: false });
      return `<p>${html || '<br>'}</p>`;
    })
    .join('\n');
}

// ---------- 修订表（同样由模型生成） ----------

export function revisionsList(model) {
  return [...model.revisions.values()].map((rev) => {
    if (rev.type === 'insert') {
      const text = rev.charIds
        .map((id) => model.charById(id))
        .filter(Boolean)
        .map((c) => c.ch)
        .join('');
      return { id: rev.id, type: 'insert', text, description: `插入 “${text}”` };
    }
    // 跨段信息以修订记录的 moved 快照为准（接受/合并后当前段落数已变）。
    const paraIdxSet = new Set(rev.chips.map((chip) => chip.para));
    const groups = new Map();
    for (const chip of rev.chips) {
      const c = model.charById(chip.charId);
      if (!c) continue;
      const pi = chip.para;
      groups.set(pi, (groups.get(pi) || '') + c.ch);
    }
    const parts = [...groups.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([pi, t]) => `第${pi + 1}段“${t}”`);
    const text = [...groups.values()].join('');
    const crossParagraph = !!rev.moved || paraIdxSet.size > 1;
    const spans = crossParagraph ? `跨段删除 ${parts.join('、')}` : `删除 “${text}”`;
    return { id: rev.id, type: 'delete', text, crossParagraph, description: spans };
  });
}

export function revisionTableHtml(model) {
  const rows = revisionsList(model)
    .map(
      (r) =>
        `<tr data-rev="${escapeHtml(r.id)}">` +
        `<td>${r.type === 'insert' ? '插入' : '删除'}</td>` +
        `<td>${escapeHtml(r.description)}</td>` +
        `<td><button data-act="accept" data-rev="${escapeHtml(r.id)}">接受</button>` +
        `<button data-act="reject" data-rev="${escapeHtml(r.id)}">拒绝</button></td>` +
        `</tr>`
    )
    .join('');
  return `<table class="rev-table"><thead><tr><th>类型</th><th>内容</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- 统一导出 ----------

export function exportDoc(model, { format = 'json', mode = 'final' } = {}) {
  if (format === 'json') {
    return JSON.stringify(model.toJSON(), null, 2);
  }
  if (format === 'markdown' || format === 'md') return modelToMarkdown(model, mode);
  if (format === 'html') {
    return `<!doctype html><meta charset="utf-8">${modelToHtml(model, mode)}`;
  }
  if (format === 'text' || format === 'plain') return modelToPlain(model, mode);
  throw new Error(`unknown export format: ${format}`);
}
