// model.js — 纯数据文档模型，不依赖 DOM。
//
// 文档 = 若干段落(Paragraph)，段落 = 有序的字符(Char)。
// 每个字符：
//   id    稳定标识，DOM 节点与模型字符靠它一一对应（跨段操作、撤销后仍可定位）
//   ch    单字符字符串（Array.from 按码点切分，代理对安全）
//   bold  是否加粗
//   ins   插入修订 id（null 表示该字符在基线中已存在）
//   del   删除修订 id（非 null 表示该字符已被“删除修订”标记，仍留在文档里）
//
// 修订(Revision)：
//   type 'insert'：charIds 为本次插入产生的字符 id 列表
//   type 'delete'：chips 记录每个被删字符在删除发生时的物理位置；
//                  moved 仅跨段删除时存在，保存被合并走的各段落完整字符 id 顺序，
//                  拒绝时据此确定性地重建段落骨架。

let counter = 0;
function uid(prefix) {
  counter += 1;
  return `${prefix}${counter}`;
}
// 测试里需要确定性 id 时可注入计数；正常使用无需关心。
export function resetIdCounter(n = 0) {
  counter = n;
}

export const toChars = (text) => Array.from(String(text));

export function makeChar(ch, { bold = false, ins = null, del = null } = {}) {
  return { id: uid('c'), ch, bold, ins, del };
}

export function makeRevision(type) {
  return { id: uid('r'), type, ts: Date.now(), chips: [], charIds: [], moved: null };
}

export class DocumentModel {
  constructor() {
    this.paragraphs = [this._blankPara()];
    this.revisions = new Map();
  }

  _blankPara() {
    return { id: uid('p'), chars: [] };
  }

  // ---------- 基础查询 ----------

  aliveCount(para) {
    let n = 0;
    for (const c of para.chars) if (!c.del) n++;
    return n;
  }

  // 逻辑下标 -> 物理下标。
  // 语义：数过前 logical 个存活字符后的插入位置；若其后紧邻被删字符（删除聚簇），
  // 插入点跨过该聚簇，保证新字符在存活序列中的位置正确。
  // 例（A B̶ C̶ D̶ E）：
  //   logical 0 -> 0；logical 1（A|E 之间）-> 4（聚簇后、E 前）；logical 2 -> 5。
  physicalIndex(para, logical) {
    let aliveSeen = 0;
    let i = 0;
    for (; i < para.chars.length; i++) {
      if (!para.chars[i].del) {
        if (aliveSeen === logical) break; // 遇到第 logical+1 个存活字符：停在它前面
        aliveSeen++;
      }
    }
    // 此时 i 位于第 logical 个存活字符之后、第 logical+1 个存活字符（可能）之前；
    // 若二者之间夹着被删字符，插入点移到聚簇之后（即下一个存活字符之前）。
    while (i < para.chars.length && para.chars[i].del) i++;
    return i;
  }

  // 物理下标 -> 逻辑偏移（该位置之前的存活字符数）。
  logicalIndex(para, physical) {
    let n = 0;
    for (let i = 0; i < physical && i < para.chars.length; i++) {
      if (!para.chars[i].del) n++;
    }
    return n;
  }

  charById(id) {
    for (const p of this.paragraphs) {
      for (const c of p.chars) if (c.id === id) return c;
    }
    return null;
  }

  paraIndexOfCharId(id) {
    for (let pi = 0; pi < this.paragraphs.length; pi++) {
      if (this.paragraphs[pi].chars.some((c) => c.id === id)) return pi;
    }
    return -1;
  }

  aliveText(para) {
    let s = '';
    for (const c of para.chars) if (!c.del) s += c.ch;
    return s;
  }

  // ---------- 原始变更 ----------

  // 在 (para, logicalIndex) 处插入纯文本；返回新建字符。
  insertText(para, logicalIndex, text, bold, revId) {
    const made = toChars(text).map((ch) => makeChar(ch, { bold, ins: revId }));
    const at = this.physicalIndex(this.paragraphs[para], logicalIndex);
    this.paragraphs[para].chars.splice(at, 0, ...made);
    return made;
  }

  // 无修订插入（组合临时文本、测试辅助）。临时字符 ins 为 '__composition__'，
  // 提交时由编辑器改写为真正的修订 id。
  insertTransient(para, logicalIndex, text, bold) {
    const made = toChars(text).map((ch) => makeChar(ch, { bold, ins: '__composition__' }));
    const at = this.physicalIndex(this.paragraphs[para], logicalIndex);
    this.paragraphs[para].chars.splice(at, 0, ...made);
    return made;
  }

  // 按 id 物理移除字符，返回 {pi, idx, char} 或 null。
  detachCharById(id) {
    const pi = this.paraIndexOfCharId(id);
    if (pi < 0) return null;
    const para = this.paragraphs[pi];
    const idx = para.chars.findIndex((c) => c.id === id);
    const [char] = para.chars.splice(idx, 1);
    return { pi, idx, char };
  }

  // 折叠区间内的删除：
  //   - 基线字符（无 ins）打删除标记（可拒绝恢复）；
  //   - 未接受的插入字符（有 ins）物理移除，并从其插入修订的 charIds 中剔除；
  //   - 跨段时合并段落；只有确实标记了基线字符时才记录 moved 快照供拒绝重建。
  // 返回 {para, offset, pruned:[{revId, id}]}。
  deleteRange(anchor, focus, rev) {
    let a = this._norm(anchor);
    let f = this._norm(focus);
    if (a.para > f.para || (a.para === f.para && a.offset > f.offset)) {
      [a, f] = [f, a];
    }
    const pruned = [];
    const collect = (pi, lo, hi) => {
      const para = this.paragraphs[pi];
      const baseline = [];
      const inserted = [];
      let logical = 0;
      for (let i = 0; i < para.chars.length; i++) {
        const c = para.chars[i];
        if (c.del) continue;
        if (logical >= lo && logical < hi) {
          (c.ins ? inserted : baseline).push({ c, i });
        }
        logical++;
      }
      // 倒序物理移除待接受的插入字符。
      for (let k = inserted.length - 1; k >= 0; k--) {
        const { c, i } = inserted[k];
        para.chars.splice(i, 1);
        pruned.push({ revId: c.ins, id: c.id });
      }
      for (const { c, i } of baseline) {
        rev.chips.push({ charId: c.id, para: pi, index: i });
        c.del = rev.id;
      }
    };

    if (a.para === f.para) {
      collect(a.para, a.offset, f.offset);
    } else {
      const anchorPi = a.para;
      collect(anchorPi, a.offset, this.aliveCount(this.paragraphs[anchorPi]));
      collect(f.para, 0, f.offset);
      for (let pi = anchorPi + 1; pi < f.para; pi++) {
        collect(pi, 0, this.aliveCount(this.paragraphs[pi]));
      }
      if (rev.chips.length > 0) {
        // 合并前快照：每个被并走段落的完整物理字符顺序，供拒绝时确定性重建。
        rev.moved = {
          after: anchorPi,
          lists: this.paragraphs
            .slice(anchorPi + 1, f.para + 1)
            .map((p) => p.chars.map((c) => c.id)),
        };
      }
      // 合并后的物理排布（保证逻辑光标偏移与“存活字符之间”一一对应）：
      //   锚段存活前缀 | 被删字符聚簇（按原物理顺序） | 末段存活后缀
      // 光标 a.offset（锚段存活前缀长度）落在聚簇前；跨段选择、粘贴、拆段后，
      // 逻辑位置仍能映射到正确的存活字符。
      const anchor = this.paragraphs[anchorPi];
      const anchorAlivePrefix = [];
      const deletedCluster = [];
      const tailAliveSuffix = [];
      for (const c of anchor.chars) {
        if (c.del) deletedCluster.push(c);
        else anchorAlivePrefix.push(c);
      }
      for (let pi = anchorPi + 1; pi <= f.para; pi++) {
        const p = this.paragraphs[pi];
        for (const c of p.chars) {
          if (c.del) deletedCluster.push(c);
          else tailAliveSuffix.push(c);
        }
        p.chars.length = 0;
      }
      anchor.chars = [...anchorAlivePrefix, ...deletedCluster, ...tailAliveSuffix];
      this.paragraphs.splice(anchorPi + 1, f.para - anchorPi);
    }
    return { para: a.para, offset: a.offset, pruned };
  }

  // 在逻辑位置拆段（Enter）。physicalIndex 已保证切分点跨过删除聚簇、
  // 落在下一个存活字符之前；删除字符因此随其“前一个存活字符”留在前段，
  // 拒绝删除后原文段落结构仍可恢复。
  splitPara(para, logicalIndex) {
    const p = this.paragraphs[para];
    const at = this.physicalIndex(p, logicalIndex);
    const tail = p.chars.splice(at, p.chars.length - at);
    const np = this._blankPara();
    np.chars = tail;
    this.paragraphs.splice(para + 1, 0, np);
    return para + 1;
  }

  _norm(pos) {
    let { para, offset } = pos;
    para = Math.max(0, Math.min(para, this.paragraphs.length - 1));
    const max = this.aliveCount(this.paragraphs[para]);
    offset = Math.max(0, Math.min(offset, max));
    return { para, offset };
  }

  // 把逻辑位置约束为当前文档中的有效位置（结构变更后调用）。
  clamp(pos) {
    return this._norm(pos);
  }

  // ---------- 接受 / 拒绝 ----------

  // 接受插入：字符转为基线；接受删除：物理移除字符并清理空段。
  accept(revId) {
    const rev = this.revisions.get(revId);
    if (!rev) return null;
    const undo = { rev, kind: 'accept', unmarked: [], removed: [], parasRemoved: [] };
    if (rev.type === 'insert') {
      for (const id of rev.charIds) {
        const c = this.charById(id);
        if (c && c.ins === revId) {
          undo.unmarked.push(c);
          c.ins = null;
        }
      }
    } else {
      for (const chip of rev.chips) {
        const r = this.detachCharById(chip.charId);
        if (r) undo.removed.push(r);
      }
      for (let pi = this.paragraphs.length - 1; pi >= 0; pi--) {
        if (this.paragraphs[pi].chars.length === 0 && this.paragraphs.length > 1) {
          const [para] = this.paragraphs.splice(pi, 1);
          undo.parasRemoved.push({ pi, para });
        }
      }
    }
    this.revisions.delete(revId);
    return undo;
  }

  undoAccept(undo) {
    const { rev, unmarked, removed, parasRemoved } = undo;
    if (rev.type === 'insert') {
      for (const c of unmarked) c.ins = rev.id;
    } else {
      for (const { pi, para } of parasRemoved) this.paragraphs.splice(pi, 0, para);
      for (const r of removed) {
        const para = this.paragraphs[r.pi];
        r.char.del = rev.id;
        para.chars.splice(Math.min(r.idx, para.chars.length), 0, r.char);
      }
    }
    this.revisions.set(rev.id, rev);
  }

  // 拒绝插入：物理移除；拒绝删除：清除 del 标记，跨段删除按 moved 快照重建段落。
  reject(revId) {
    const rev = this.revisions.get(revId);
    if (!rev) return null;
    const undo = { rev, kind: 'reject', removed: [], restored: [], rebuilt: null };
    if (rev.type === 'insert') {
      for (const id of rev.charIds) {
        const r = this.detachCharById(id);
        if (r) undo.removed.push(r);
      }
      const parasRemoved = [];
      for (let pi = this.paragraphs.length - 1; pi >= 0; pi--) {
        if (this.paragraphs[pi].chars.length === 0 && this.paragraphs.length > 1) {
          const [para] = this.paragraphs.splice(pi, 1);
          parasRemoved.push({ pi, para });
        }
      }
      undo.parasRemoved = parasRemoved;
    } else {
      for (const chip of rev.chips) {
        const c = this.charById(chip.charId);
        if (c && c.del === revId) {
          c.del = null;
          undo.restored.push(c);
        }
      }
      if (rev.moved) {
        undo.rebuilt = this._rebuildMoved(rev.moved);
      }
    }
    this.revisions.delete(revId);
    return undo;
  }

  // 在 after 之后重建被合并的段落，把快照中的字符移回去。
  _rebuildMoved(moved) {
    const insertAt = Math.min(moved.after + 1, this.paragraphs.length);
    const anchorPara = Math.min(moved.after, this.paragraphs.length - 1);
    const paras = moved.lists.map(() => this._blankPara());
    this.paragraphs.splice(insertAt, 0, ...paras);
    const movedChars = [];
    moved.lists.forEach((ids, k) => {
      for (const id of ids) {
        const r = this.detachCharById(id);
        if (r) {
          paras[k].chars.push(r.char);
          movedChars.push(r.char);
        }
      }
    });
    return { anchorPara, insertAt, paras, movedChars };
  }

  undoReject(undo) {
    const { rev, removed, restored, rebuilt, parasRemoved = [] } = undo;
    if (rev.type === 'insert') {
      for (const { pi, para } of parasRemoved) this.paragraphs.splice(pi, 0, para);
      for (const r of removed) {
        this.paragraphs[r.pi].chars.splice(Math.min(r.idx, this.paragraphs[r.pi].chars.length), 0, r.char);
      }
    } else {
      if (rebuilt) {
        const { anchorPara, paras, movedChars } = rebuilt;
        // 重新合并：重建段中的字符按序放回锚点段末尾。
        for (const c of movedChars) {
          const pi = this.paraIndexOfCharId(c.id);
          if (pi >= 0) {
            const idx = this.paragraphs[pi].chars.indexOf(c);
            this.paragraphs[pi].chars.splice(idx, 1);
            this.paragraphs[anchorPara].chars.push(c);
          }
        }
        for (const p of paras) {
          const idx = this.paragraphs.indexOf(p);
          if (idx >= 0 && p.chars.length === 0) this.paragraphs.splice(idx, 1);
        }
      }
      for (const c of restored) c.del = rev.id;
    }
    this.revisions.set(rev.id, rev);
  }

  // ---------- 序列化 ----------

  toJSON() {
    return {
      paragraphs: this.paragraphs.map((p) => ({
        id: p.id,
        chars: p.chars.map((c) => ({ id: c.id, ch: c.ch, bold: c.bold, ins: c.ins, del: c.del })),
      })),
      revisions: [...this.revisions.values()],
    };
  }

  static fromJSON(data) {
    const m = new DocumentModel();
    m.paragraphs = data.paragraphs.map((p) => ({
      id: p.id,
      chars: p.chars.map((c) => ({ ...c })),
    }));
    if (!m.paragraphs.length) m.paragraphs = [m._blankPara()];
    m.revisions = new Map((data.revisions || []).map((r) => [r.id, r]));
    return m;
  }
}
