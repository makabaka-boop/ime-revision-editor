// 文档模型：仅段落、纯文本、加粗标记，以及插入/删除修订。
//
//   Doc        = { paragraphs: [Para] }
//   Para       = { spans: [Span], ins: revId|null, delBreak: revId|null }
//     - ins:      本段落由其前的换行产生，该换行是一笔“插入”修订
//     - delBreak: 本段落之后的换行被一笔“删除”修订标记删除
//   Span       = { text, bold, ins: revId|null, del: revId|null }
//
// 位置约定：全文线性字符偏移，每段文本之后计 1 个换行偏移（最后一段除外）。
// 被标记删除（del）的文字仍保留在模型中并计入偏移，编辑器以删除线显示；
// 阅读视图与导出会将其过滤（见 derive.js）。

export function span(text, { bold = false, ins = null, del = null } = {}) {
  return { text, bold, ins, del };
}

export function paragraph(spans = [], { ins = null, delBreak = null } = {}) {
  return { spans, ins, delBreak };
}

export function createDoc() {
  return { paragraphs: [paragraph()] };
}

export function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

export function paraLen(p) {
  let n = 0;
  for (const s of p.spans) n += s.text.length;
  return n;
}

export function textLength(doc) {
  let n = 0;
  for (let i = 0; i < doc.paragraphs.length; i++) {
    n += paraLen(doc.paragraphs[i]);
    if (i < doc.paragraphs.length - 1) n += 1;
  }
  return n;
}

export function plainText(doc) {
  return doc.paragraphs.map((p) => p.spans.map((s) => s.text).join('')).join('\n');
}

// 规范化：合并相邻同属性 span、丢弃空 span、保证至少一个段落。
export function normalize(doc) {
  for (const p of doc.paragraphs) {
    const out = [];
    for (const s of p.spans) {
      if (!s.text) continue;
      const last = out[out.length - 1];
      if (last && last.bold === s.bold && last.ins === s.ins && last.del === s.del) {
        last.text += s.text;
      } else {
        out.push({ ...s });
      }
    }
    p.spans = out;
  }
  if (doc.paragraphs.length === 0) doc.paragraphs.push(paragraph());
  return doc;
}

// 线性偏移 -> { para, span, char }。段末（换行偏移）归入前一段末尾。
export function locate(doc, offset) {
  const len = textLength(doc);
  offset = Math.max(0, Math.min(offset, len));
  let pos = 0;
  for (let pi = 0; pi < doc.paragraphs.length; pi++) {
    const p = doc.paragraphs[pi];
    const plen = paraLen(p);
    if (offset <= pos + plen) {
      let sPos = pos;
      for (let si = 0; si < p.spans.length; si++) {
        const slen = p.spans[si].text.length;
        if (offset <= sPos + slen) return { para: pi, span: si, char: offset - sPos };
        sPos += slen;
      }
      return { para: pi, span: p.spans.length, char: 0 }; // 空段落
    }
    pos += plen + 1;
  }
  const li = doc.paragraphs.length - 1;
  return { para: li, span: doc.paragraphs[li].spans.length, char: 0 };
}

// { para, span, char } -> 线性偏移（locate 的逆运算）。
export function offsetOf(doc, para, spanIdx, char) {
  let pos = 0;
  for (let i = 0; i < para && i < doc.paragraphs.length; i++) {
    pos += paraLen(doc.paragraphs[i]) + 1;
  }
  const p = doc.paragraphs[para];
  if (p) for (let i = 0; i < spanIdx && i < p.spans.length; i++) pos += p.spans[i].text.length;
  return pos + char;
}

// 线性偏移 -> { para, char }，char 为段内字符偏移（供 splitSpans 等使用）。
export function locateInPara(doc, offset) {
  const loc = locate(doc, offset);
  const p = doc.paragraphs[loc.para];
  let char = loc.char;
  for (let i = 0; i < loc.span && i < p.spans.length; i++) char += p.spans[i].text.length;
  return { para: loc.para, char };
}

function sameMarks(a, b) {
  return a.bold === b.bold && a.ins === b.ins && a.del === b.del;
}

// 在 char 处把 spans 切成左右两半（char 为段内字符偏移）。
export function splitSpans(spans, char) {
  const left = [];
  const right = [];
  let pos = 0;
  for (const s of spans) {
    const len = s.text.length;
    if (char <= pos) right.push({ ...s });
    else if (char >= pos + len) left.push({ ...s });
    else {
      left.push({ ...s, text: s.text.slice(0, char - pos) });
      right.push({ ...s, text: s.text.slice(char - pos) });
    }
    pos += len;
  }
  return { left, right };
}

function splitSpansAt2(spans, i, j) {
  const a = splitSpans(spans, i);
  const b = splitSpans(a.right, j - i);
  return { left: a.left, mid: b.left, right: b.right };
}

// 在 offset 处插入文本，attrs = { bold, ins }。会尝试并入相邻同属性 span。
export function insertTextInto(doc, offset, text, attrs = {}) {
  if (!text) return doc;
  const loc = locate(doc, offset);
  const p = doc.paragraphs[loc.para];
  const newSpan = span(text, { bold: !!attrs.bold, ins: attrs.ins ?? null, del: attrs.del ?? null });
  if (p.spans.length === 0) {
    p.spans = [newSpan];
  } else {
    const si = Math.min(loc.span, p.spans.length - 1);
    const target = p.spans[si];
    const char = Math.min(loc.char, target.text.length);
    if (char === target.text.length && sameMarks(target, newSpan)) {
      target.text += text;
    } else if (char === 0 && si > 0 && sameMarks(p.spans[si - 1], newSpan)) {
      p.spans[si - 1].text += text;
    } else {
      const l = target.text.slice(0, char);
      const r = target.text.slice(char);
      const repl = [];
      if (l) repl.push({ ...target, text: l });
      repl.push(newSpan);
      if (r) repl.push({ ...target, text: r });
      p.spans.splice(si, 1, ...repl);
    }
  }
  return normalize(doc);
}

// 非修订删除：真正移除 [from, to)，跨段时合并段落。
export function deleteRange(doc, from, to) {
  if (from >= to) return doc;
  const a = locateInPara(doc, from);
  const b = locateInPara(doc, to);
  const paras = doc.paragraphs;
  if (a.para === b.para) {
    const p = paras[a.para];
    const { left, right } = splitSpansAt2(p.spans, a.char, b.char);
    p.spans = [...left, ...right];
  } else {
    const pa = paras[a.para];
    const pb = paras[b.para];
    const left = splitSpans(pa.spans, a.char).left;
    const right = splitSpans(pb.spans, b.char).right;
    pa.spans = [...left, ...right];
    pa.delBreak = pb.delBreak;
    paras.splice(a.para + 1, b.para - a.para);
  }
  return normalize(doc);
}

// 修订删除：范围内普通文字标记 del=revId，换行标记 delBreak=revId；
// 尚未被接受的插入内容（ins 文字、ins 段落）则直接移除。
export function markDeleted(doc, from, to, revId) {
  if (from >= to) return doc;
  const paras = doc.paragraphs;
  // 第一遍：范围内“换行本身是未接受的插入”的段落直接并回前一段，
  // 每并掉一个换行，to 前移 1。
  let pos = 0;
  let shift = 0;
  for (let i = 0; i < paras.length - 1; i++) {
    const p = paras[i];
    const breakOffset = pos + paraLen(p);
    const next = paras[i + 1];
    if (next.ins != null && breakOffset >= from && breakOffset < to) {
      p.spans = [...p.spans, ...next.spans];
      p.delBreak = next.delBreak;
      paras.splice(i + 1, 1);
      i--;
      shift++;
      continue; // pos 不变，仍指向本段起点
    }
    pos = breakOffset + 1;
  }
  to -= shift;
  // 第二遍：标记文字与换行。
  const a = locateInPara(doc, from);
  const b = locateInPara(doc, to);
  for (let pi = a.para; pi <= b.para; pi++) {
    const p = paras[pi];
    const s0 = pi === a.para ? a.char : 0;
    const s1 = pi === b.para ? b.char : paraLen(p);
    if (s1 > s0) {
      const { left, mid, right } = splitSpansAt2(p.spans, s0, s1);
      const kept = [];
      for (const s of mid) {
        if (s.ins != null) continue; // 未接受的插入被删除：直接移除
        kept.push(s.del != null ? s : { ...s, del: revId });
      }
      p.spans = [...left, ...kept, ...right];
    }
    if (pi < b.para && p.delBreak == null) p.delBreak = revId;
  }
  return normalize(doc);
}

// 在 offset 处拆段。revId 非空时，新段落标记为该修订产生的插入。
export function splitParagraph(doc, offset, revId = null) {
  const loc = locateInPara(doc, offset);
  const p = doc.paragraphs[loc.para];
  const { left, right } = splitSpans(p.spans, loc.char);
  const p1 = paragraph(left, { ins: p.ins, delBreak: null });
  const p2 = paragraph(right, { ins: revId, delBreak: p.delBreak });
  doc.paragraphs.splice(loc.para, 1, p1, p2);
  return normalize(doc);
}

// 在 offset 处插入若干段落（粘贴用）。paras: [{ spans: [{ text, bold }] }]。
// attrs.ins 非空时，插入的文字与换行都标记为该修订。返回插入内容占用的偏移长度。
export function insertParagraphs(doc, offset, paras, attrs = {}) {
  if (!paras.length) paras = [{ spans: [] }];
  const loc = locateInPara(doc, offset);
  const p = doc.paragraphs[loc.para];
  const { left, right } = splitSpans(p.spans, loc.char);
  const ins = attrs.ins ?? null;
  const mk = (spans) => spans.filter((s) => s.text).map((s) => span(s.text, { bold: !!s.bold, ins }));
  const newParas = [paragraph([...left, ...mk(paras[0].spans)], { ins: p.ins })];
  for (let i = 1; i < paras.length; i++) {
    newParas.push(paragraph(mk(paras[i].spans), { ins }));
  }
  const lastNew = newParas[newParas.length - 1];
  lastNew.spans.push(...right);
  lastNew.delBreak = p.delBreak;
  doc.paragraphs.splice(loc.para, 1, ...newParas);
  normalize(doc);
  let inserted = paras.length - 1;
  for (const pa of paras) for (const s of pa.spans) inserted += s.text.length;
  return inserted;
}

export function setBold(doc, from, to, bold) {
  const a = locateInPara(doc, from);
  const b = locateInPara(doc, to);
  for (let pi = a.para; pi <= b.para; pi++) {
    const p = doc.paragraphs[pi];
    const s0 = pi === a.para ? a.char : 0;
    const s1 = pi === b.para ? b.char : paraLen(p);
    if (s1 <= s0) continue;
    const { left, mid, right } = splitSpansAt2(p.spans, s0, s1);
    p.spans = [...left, ...mid.map((s) => ({ ...s, bold })), ...right];
  }
  return normalize(doc);
}

export function allBold(doc, from, to) {
  const a = locateInPara(doc, from);
  const b = locateInPara(doc, to);
  for (let pi = a.para; pi <= b.para; pi++) {
    const p = doc.paragraphs[pi];
    const s0 = pi === a.para ? a.char : 0;
    const s1 = pi === b.para ? b.char : paraLen(p);
    if (s1 <= s0) continue;
    const { mid } = splitSpansAt2(p.spans, s0, s1);
    for (const s of mid) if (s.text && !s.bold) return false;
  }
  return true;
}

// 计算在 offset 处继续输入时应采用的标记：
// 修订模式下用当前修订 id；否则延续左侧未接受的插入（若有）。
export function insertionAttrs(doc, offset, { bold = false, trackRevId = null } = {}) {
  if (trackRevId != null) return { bold, ins: trackRevId };
  const loc = locate(doc, offset);
  const p = doc.paragraphs[loc.para];
  let s = null;
  if (loc.char > 0 && loc.span < p.spans.length) s = p.spans[loc.span];
  else if (loc.span > 0) s = p.spans[loc.span - 1];
  return { bold, ins: s && s.ins != null ? s.ins : null };
}

// 接受修订：插入变为普通内容；被删文字真正移除；被删换行真正合并。
// 返回 removals（旧坐标系下被移除的区间，升序），用于映射光标。
export function acceptRevision(doc, revId) {
  const removals = [];
  const paras = doc.paragraphs;
  const staged = [];
  let offset = 0;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    let cur = offset;
    const spans = [];
    for (const s of p.spans) {
      if (s.del === revId) {
        removals.push({ start: cur, end: cur + s.text.length });
      } else {
        spans.push(s.ins === revId ? { ...s, ins: null } : s);
      }
      cur += s.text.length;
    }
    const np = paragraph(spans, {
      ins: p.ins === revId ? null : p.ins,
      delBreak: p.delBreak,
    });
    if (p.delBreak === revId && i < paras.length - 1) {
      removals.push({ start: cur, end: cur + 1 });
      np.delBreak = null;
      np._mergeNext = true;
    }
    staged.push(np);
    offset = cur + (i < paras.length - 1 ? 1 : 0);
  }
  doc.paragraphs = mergeStaged(staged);
  normalize(doc);
  removals.sort((x, y) => x.start - y.start); // mapThroughRemovals 要求升序
  return removals;
}

// 拒绝修订：插入内容移除（插入的段落并回前段）；删除标记清除。
// 返回 removals（旧坐标系），用于映射光标。
export function rejectRevision(doc, revId) {
  const removals = [];
  const paras = doc.paragraphs;
  const staged = [];
  let offset = 0;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    let cur = offset;
    const spans = [];
    for (const s of p.spans) {
      if (s.ins === revId) {
        removals.push({ start: cur, end: cur + s.text.length });
      } else {
        spans.push(s.del === revId ? { ...s, del: null } : s);
      }
      cur += s.text.length;
    }
    const np = paragraph(spans, {
      ins: p.ins === revId ? null : p.ins,
      delBreak: p.delBreak === revId ? null : p.delBreak,
    });
    if (p.ins === revId && i > 0) {
      removals.push({ start: offset - 1, end: offset }); // 段前换行
      np._mergePrev = true;
    }
    staged.push(np);
    offset = cur + (i < paras.length - 1 ? 1 : 0);
  }
  doc.paragraphs = mergeStaged(staged);
  normalize(doc);
  removals.sort((x, y) => x.start - y.start); // mapThroughRemovals 要求升序
  return removals;
}

function mergeStaged(staged) {
  const out = [];
  for (const np of staged) {
    const prev = out[out.length - 1];
    if (np._mergePrev && prev) {
      prev.spans = [...prev.spans, ...np.spans];
      prev.delBreak = np.delBreak;
      if (np._mergeNext) prev._mergeNext = true;
      continue;
    }
    if (prev && prev._mergeNext) {
      prev.spans = [...prev.spans, ...np.spans];
      prev.delBreak = np.delBreak;
      if (prev.ins == null) prev.ins = np.ins;
      delete prev._mergeNext;
      if (np._mergeNext) prev._mergeNext = true;
      continue;
    }
    out.push(np);
  }
  for (const p of out) {
    delete p._mergeNext;
    delete p._mergePrev;
  }
  if (out.length === 0) out.push(paragraph());
  return out;
}

// 把旧坐标系下的偏移映射到移除若干区间后的新坐标系。
// 落在被移除区间内的偏移折叠到区间起点。
export function mapThroughRemovals(offset, removals) {
  let shift = 0;
  for (const r of removals) {
    if (offset <= r.start) break;
    if (offset >= r.end) shift += r.end - r.start;
    else return r.start - shift;
  }
  return offset - shift;
}
