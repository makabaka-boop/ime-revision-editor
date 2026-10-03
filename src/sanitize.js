// 粘贴净化。输出永远是纯数据（[{ spans: [{ text, bold }] }]），
// 渲染时通过 textContent 进入 DOM，因此粘贴的 HTML 不可能成为可执行标记。

// 这些标签连同内容一起丢弃。
const CONTAINER_SKIP = new Set([
  'script', 'style', 'head', 'title', 'textarea', 'template',
  'noscript', 'iframe', 'object', 'svg', 'math', 'head',
]);
// 加粗语义。
const BOLD_TAGS = new Set(['b', 'strong']);
// 段落边界。
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'tr', 'td', 'th', 'section', 'article', 'header', 'footer', 'hr',
]);
// 其余标签（img、a、span、meta……）只忽略标签本身，文本内容保留。

const TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[a-zA-Z][^>]*>|<![^>]*>|[^<]+|</g;

export function sanitizeHtml(html) {
  const paras = [{ spans: [] }];
  let bold = 0;
  let skip = 0;
  const cur = () => paras[paras.length - 1];
  const newPara = () => {
    if (cur().spans.length) paras.push({ spans: [] });
  };
  const pushText = (t) => {
    if (!t) return;
    const spans = cur().spans;
    const b = bold > 0;
    const last = spans[spans.length - 1];
    if (last && last.bold === b) last.text += t;
    else spans.push({ text: t, bold: b });
  };
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(html))) {
    const tok = m[0];
    if (tok.length > 1 && tok[0] === '<') {
      if (tok[1] === '!') continue; // 注释 / DOCTYPE / CDATA
      const tm = /^<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(tok);
      if (!tm) continue;
      const closing = tm[1] === '/';
      const selfClosing = /\/\s*>$/.test(tok);
      const tag = tm[2].toLowerCase();
      if (CONTAINER_SKIP.has(tag)) {
        if (closing) skip = Math.max(0, skip - 1);
        else if (!selfClosing) skip++;
        continue;
      }
      if (skip > 0) continue;
      if (BOLD_TAGS.has(tag)) {
        bold = Math.max(0, bold + (closing ? -1 : 1));
        continue;
      }
      if (BLOCK_TAGS.has(tag)) {
        newPara();
        continue;
      }
      // 其他标签：忽略。
    } else {
      if (skip > 0) continue;
      pushText(decodeEntities(tok));
    }
  }
  while (paras.length > 1 && !paras[paras.length - 1].spans.length) paras.pop();
  while (paras.length > 1 && !paras[0].spans.length) paras.shift();
  return paras;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return m;
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

// 纯文本粘贴：按换行拆段。
export function textToParagraphs(text) {
  return String(text)
    .split(/\r\n|\r|\n/)
    .map((line) => ({ spans: line ? [{ text: line, bold: false }] : [] }));
}
