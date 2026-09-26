// BBS 所见即所得编辑器（2026-09-25 张老师确认方案）
// 数据层仍是 UBB：载入 ubbToEditorHtml(UBB) → contenteditable 画布真身呈现 → 提交 serializeEditor(ed) 序列化回 UBB。
// 存量帖零迁移、服务端 ubb() 渲染管线零改动（lib/bbs.ts）。
// 交互移植 2008 版 BBS/Edit_Box.asp + Face.asp + Mine.asp：工具栏按钮、弹层面板、摆雷（小键盘 + 大键盘数字行）。

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { WX_FACES, FACE_BY_KEY, FACE_KEY_BY_SLOT } from "@/lib/faces";

/** 扫雷符号 → 图片名（同 lib/bbs.ts MINE_MAP） */
const MINE_MAP: Record<string, string> = {
  " ": "Blank",
  ".": "Black",
  Q: "Block",
  "!": "Flag",
  "?": "Mark",
  "-": "Num",
  "+": "IsMine",
  "*": "Mine",
};

/** 小键盘 keyCode → 摆雷符号（2008 版 KeyDown 映射） */
const KEYPAD: Record<number, string> = {
  96: " ", 110: "Q", 97: "1", 98: "2", 99: "3", 100: "4", 101: "5",
  102: "6", 103: "7", 104: "8", 106: "*", 105: "!", 111: "?", 109: "-", 107: "+",
};
/** 大键盘数字行 → 摆雷符号（2026-09-26 张老师要求：大键盘也能触发）。
 *  规则 = 键帽印什么出什么：0-8 出数字（0=凹陷空格同小键盘）、9 沿用小键盘 9=旗；
 *  Shift 组合 * ! ? 与 + - 也各自对应（小键盘的 / . 特殊映射仅小键盘有效，大键盘不设） */
const MAINROW: Record<string, string> = {
  "0": " ", "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "!",
  "*": "*", "!": "!", "?": "?", "+": "+", "-": "-", "=": "-",
};
/** Shift+数字的美式键盘换算（部分环境 e.key 不带 Shift 变体、仍是数字本身，此处统一折算成符号再查表） */
const SHIFT_DIGITS: Record<string, string> = {
  "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** UBB → 画布 HTML（规则同服务端 ubb()；带 data-face/data-mine 便于回序列化） */
export function ubbToEditorHtml(raw: string): string {
  let t = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\[&nbsp;\]/gi, "[ ]")
    .replace(/&nbsp;/gi, "\u00a0");
  t = escapeHtml(t);
  t = t
    .replace(/\[Title\]/gi, '<span class="Title">').replace(/\[\/Title\]/gi, "</span>")
    .replace(/\[Sign\]/gi, '<span class="Sign">').replace(/\[\/Sign\]/gi, "</span>")
    .replace(/\[Signest\]/gi, '<span class="Signest">').replace(/\[\/Signest\]/gi, "</span>")
    .replace(/\[b\]/gi, "<strong>").replace(/\[\/b\]/gi, "</strong>")
    .replace(/\[quote\]/gi, "<blockquote>").replace(/\[\/quote\]/gi, "</blockquote>");
  t = t.replace(/\[img\]([^\[\]]+?)\[\/img\]/gi, '<img src="$1">');
  t = t.replace(/\[url\s+([^\[\]\s]+?)\]([^\[\]]*?)\[\/url\]/gi, '<a href="$1">$2</a>');
  // 表情（编码规则见 lib/faces.ts）：旧数字码 / 新语义 key 码 / Nn 过渡码（归一化为 key，round-trip 升级）
  t = t.replace(/\[face\]([^\[\]]{1,20}?)\[\/face\]/gi, (m, code: string) => {
    const lower = code.toLowerCase();
    const byKey = FACE_BY_KEY.get(lower);
    if (byKey) {
      return `<img src="/images/face-wx/${byKey.slot}.png" data-face="${byKey.key}">`;
    }
    const legacy = lower.match(/^(\d{1,2})n$/);
    if (legacy) {
      const slot = Math.min(30, Math.max(1, parseInt(legacy[1], 10)));
      const key = FACE_KEY_BY_SLOT.get(slot);
      if (key) return `<img src="/images/face-wx/${slot}.png" data-face="${key}">`;
      return m;
    }
    if (/^\d{1,2}$/.test(lower)) {
      const id = Math.min(30, Math.max(1, parseInt(lower, 10)));
      return `<img src="/images/face/${id}.gif" data-face="${id}">`;
    }
    return m; // 未知码保留原文（与服务端 ubb() 透传一致）
  });
  const keys = ["0", "1", "2", "3", "4", "5", "6", "7", "8", ...Object.keys(MINE_MAP)];
  for (const k of keys) {
    const name = k >= "0" && k <= "8" ? k : MINE_MAP[k];
    t = t.split(`[${k}]`).join(`<img src="/images/mine/${name.toLowerCase()}.gif" data-mine="${k}">`);
  }
  t = t.replace(/\t/g, "\u00a0\u00a0\u00a0\u00a0");
  return t.split("\n").map((line) => {
    const imgs = line.match(/<img[^>]*>/g) ?? [];
    const rest = line.replace(/<img[^>]*>/g, "");
    const mineOnly = imgs.length > 0 && imgs.every((x) => x.includes("data-mine=")) && /^\s*$/.test(rest);
    return `<div class="line${mineOnly ? " mine-line" : ""}">${line}</div>`;
  }).join("");
}

function serializeInline(nodes: ArrayLike<Node>): string {
  let out = "";
  for (const n of Array.from(nodes)) {
    if (n.nodeType === 3) {
      out += n.nodeValue ?? "";
      continue;
    }
    if (n.nodeType !== 1) continue;
    const el = n as HTMLElement;
    const tag = el.tagName;
    const inner = () => serializeInline(el.childNodes);
    if (tag === "BR") { out += "\n"; continue; }
    if (tag === "DIV" || tag === "P") { out += inner().replace(/\n$/, "") + "\n"; continue; }
    if (tag === "BLOCKQUOTE") { out += `[quote]${inner()}[/quote]`; continue; }
    if (tag === "SPAN") {
      const c = el.className;
      const s = inner();
      // 空样式壳不产出空标签（折叠光标开样式后未输入即离开的场景；同 STRONG 守卫）
      if (c === "Title" && s !== "") out += `[Title]${s}[/Title]`;
      else if (c === "Sign" && s !== "") out += `[Sign]${s}[/Sign]`;
      else if (c === "Signest" && s !== "") out += `[Signest]${s}[/Signest]`;
      else if (c !== "Title" && c !== "Sign" && c !== "Signest") out += s;
      continue;
    }
    if (tag === "STRONG" || tag === "B") { const s = inner(); if (s !== "") out += `[b]${s}[/b]`; continue; }
    if (tag === "EM" || tag === "I") { const s = inner(); if (s !== "") out += `[i]${s}[/i]`; continue; }
    if (tag === "U") { const s = inner(); if (s !== "") out += `[u]${s}[/u]`; continue; }
    if (tag === "A") { out += `[url ${el.getAttribute("href")}]${inner()}[/url]`; continue; }
    if (tag === "IMG") {
      const face = el.dataset.face;
      const mine = el.dataset.mine;
      if (face != null) out += `[face]${face}[/face]`;
      else if (mine != null) out += `[${mine}]`;
      else out += `[img]${el.getAttribute("src")}[/img]`;
      continue;
    }
    out += inner();
  }
  return out;
}

/** 画布 DOM → UBB（白名单序列化；未知节点拍平为文本） */
export function serializeEditor(ed: HTMLElement): string {
  let out = "";
  for (const n of Array.from(ed.childNodes)) {
    const isBlock = n.nodeType === 1 && /^(DIV|P|BLOCKQUOTE)$/.test((n as HTMLElement).tagName);
    const s = serializeInline([n]);
    if (s === "") continue;
    // Chrome contenteditable 首行常为裸节点（不在 div 内），按 Enter 后新行才是 div；
    // serializeInline 的 DIV 分支只补行尾换行，裸首行 + div 行会被拼进同一行
    // （2026-09-26 实踩：三行雷图发布变两行）——块级起行前若前文未换行，补一个换行
    if (isBlock && out !== "" && !out.endsWith("\n")) out += "\n";
    out += s;
  }
  return out.replace(/\n+$/, "");
}

/** 视觉字数：表情/雷图/图片各计 1，文字按字符（评论等限长场景用） */
export function visualLength(ed: HTMLElement): number {
  let n = ed.querySelectorAll("img").length;
  n += (ed.textContent ?? "").replace(/\s/g, "").length;
  return n;
}

interface PopState {
  kind: "faces" | "mines" | "imgs" | null;
}

/** 贴图上传压缩：长边 1600→640 逐档缩 × JPEG 质量 0.85→0.35 逐档降，直到 ≤200K */
async function compressToBudget(file: File, budget = 204800): Promise<{ blob: Blob; w: number; h: number; q: number }> {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const dims = [1600, 1280, 1024, 800, 640];
    const qs = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
    let last: { blob: Blob; w: number; h: number; q: number } | null = null;
    for (const dim of dims) {
      const scale = Math.min(1, dim / Math.max(im.width, im.height));
      const w = Math.max(1, Math.round(im.width * scale));
      const h = Math.max(1, Math.round(im.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#3b3a32"; // 透明区填面板底色再转 JPEG
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(im, 0, 0, w, h);
      for (const q of qs) {
        // toBlob 回调是 BlobCallback（Blob | null），不能直接把 Promise<Blob> 的 resolve
        // 传进去（参数型逆变不兼容）；全新 .next 目录的完整类型检查会拦（缓存复用时被跳过）
        const blob = await new Promise<Blob>((resolve) =>
          c.toBlob((b) => resolve(b!), "image/jpeg", q)
        );
        last = { blob, w, h, q };
        if (blob.size <= budget) return last;
      }
    }
    return last!;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface RichEditorProps {
  /** 初始 UBB（编辑旧帖传入） */
  initialContent?: string;
  /** 画布最小高度（发帖 300 / 回帖 200） */
  minHeight?: number;
  /** placeholder */
  placeholder?: string;
  /** 是否显示标题/醒目/加亮/加粗/链接全套（回帖与发帖一致；评论已不用富文本） */
  full?: boolean;
  /** 内容变化回调（UBB） */
  onChange?: (ubb: string) => void;
  /** toast 通知（复用站内 Toast） */
  notify?: (msg: string, type?: "success" | "error") => void;
}

export function RichEditor({
  initialContent = "",
  minHeight = 300,
  placeholder = "",
  full = true,
  onChange,
  notify,
}: RichEditorProps) {
  const edRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<PopState>({ kind: null });
  const faceVerRef = useRef<"v1" | "v2">("v2");
  const [pop, setPop] = useState<PopState["kind"]>(null);
  const [faceVer, setFaceVer] = useState<"v1" | "v2">("v2");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const emitChange = useCallback(() => {
    if (edRef.current && onChange) onChange(serializeEditor(edRef.current));
  }, [onChange]);

  /** 纯雷图行切 16px 紧行距（画布内即所见拼图） */
  const retagMineLines = useCallback(() => {
    const ed = edRef.current;
    if (!ed) return;
    for (const bl of Array.from(ed.children)) {
      if (!(bl instanceof HTMLElement) || bl.tagName !== "DIV") continue;
      let hasMine = false;
      let only = true;
      for (const n of Array.from(bl.childNodes)) {
        if (n.nodeType === 3) {
          if (!/^\s*$/.test(n.nodeValue ?? "")) only = false;
        } else if (n instanceof HTMLElement) {
          if (n.tagName === "BR") continue;
          if (n.tagName === "IMG" && n.dataset.mine != null) { hasMine = true; continue; }
          only = false;
        }
      }
      bl.classList.toggle("mine-line", hasMine && only);
    }
  }, []);

  useEffect(() => {
    const ed = edRef.current;
    if (!ed) return;
    ed.innerHTML = initialContent ? ubbToEditorHtml(initialContent) : "";
    retagMineLines();
    emitChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInput = () => {
    retagMineLines();
    emitChange();
  };

  const closePop = () => {
    popRef.current.kind = null;
    setPop(null);
  };

  /** 画布根下裸节点段（Chrome 首行默认不在 div 内）包进 <div class="line">，
      让摆雷首行也能命中 .mine-line 紧行距；仅在摆雷插入后调用，避开 IME 输入期 */
  const wrapBareLines = (keepAfter?: Node) => {
    const ed = edRef.current;
    if (!ed) return;
    let seg: Node[] = [];
    let touched = false;
    const flush = () => {
      if (!seg.length) return;
      const div = document.createElement("div");
      div.className = "line";
      ed.insertBefore(div, seg[0]);
      for (const n of seg) div.appendChild(n);
      seg = [];
      touched = true;
    };
    for (const n of Array.from(ed.childNodes)) {
      if (n.nodeType === 1 && /^(DIV|P|BLOCKQUOTE)$/.test((n as HTMLElement).tagName)) flush();
      else seg.push(n);
    }
    flush();
    if (touched && keepAfter && keepAfter.parentNode) {
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStartAfter(keepAfter);
      r.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  };

  const insertNodeAtCaret = (node: Node) => {
    const ed = edRef.current!;
    ed.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      ed.appendChild(node);
    } else {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(node);
      const after = document.createRange();
      after.setStartAfter(node);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    // 摆雷插入后归一化裸首行，保证纯雷图行紧贴（正文打字不受影响，IME 安全）
    if (node instanceof HTMLElement && node.dataset.mine != null) wrapBareLines(node);
    onInput();
  };

  /** 造格式元素：span.Title / span.Sign / strong（Signest 仅供存量渲染，不再产生） */
  const makeFmtEl = (tag: "span" | "strong", cls: string | null): HTMLElement => {
    if (tag === "span") {
      const s = document.createElement("span");
      s.className = cls!;
      return s;
    }
    return document.createElement("strong");
  };

  /** 清掉空格式壳（toggle/正文 操作可能留下无内容的 span/strong） */
  const pruneEmptyFmt = () => {
    const ed = edRef.current!;
    for (;;) {
      const empties = Array.from(
        ed.querySelectorAll("span.Title, span.Sign, span.Signest, strong, b")
      ).filter((el) => el.childNodes.length === 0);
      if (!empties.length) break;
      empties.forEach((el) => el.remove());
    }
  };

  /** 选区内所有非空文本是否都在某样式的祖先内（判定当前「开/关」，以及 extract 会丢哪些覆盖样式） */
  const covers = (r: Range, match: (el: HTMLElement) => boolean): boolean => {
    const ed = edRef.current!;
    let root: HTMLElement | null = r.commonAncestorContainer as HTMLElement | null;
    if (root && root.nodeType === 3) root = root.parentElement;
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let saw = false;
    while (walker.nextNode()) {
      const t = walker.currentNode as Text;
      if (!t.nodeValue) continue;
      if (!r.intersectsNode(t)) continue;
      saw = true;
      let p: HTMLElement | null = t.parentElement;
      let ok = false;
      while (p && p !== ed) {
        if (match(p)) { ok = true; break; }
        p = p.parentElement;
      }
      if (!ok) return false;
    }
    return saw;
  };

  /** 格式原子开关（2026-09-26 张老师定）：加亮/醒目/加粗互相独立，
   *  开 = 套用该样式，并保留选区已有的其他样式（修「点了加粗加亮/醒目就丢」bug）；
   *  关 = 只摘除该样式，其余不动；再点同按钮 = 关（toggle）。完成后选区保持，可连续操作。 */
  const toggleFormat = (tag: "span" | "strong", cls: string | null) => {
    const ed = edRef.current!;
    ed.focus();
    pruneEmptyFmt();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);

    const match = tag === "strong"
      ? (el: HTMLElement) => /^(STRONG|B)$/.test(el.tagName)
      : (el: HTMLElement) => el.tagName === "SPAN" && el.className === cls;

    // 光标折叠：在样式内 = 跳出到该样式之后（关）；不在 = 插入空样式节点承接后续输入（开）
    if (r.collapsed) {
      let p: HTMLElement | null = r.startContainer.nodeType === 3
        ? r.startContainer.parentElement
        : (r.startContainer as HTMLElement);
      while (p && p !== ed) {
        if (match(p)) {
          const after = document.createRange();
          after.setStartAfter(p);
          after.collapse(true);
          sel.removeAllRanges();
          sel.addRange(after);
          return;
        }
        p = p.parentElement;
      }
      const el = makeFmtEl(tag, cls);
      r.insertNode(el);
      const inner = document.createRange();
      inner.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(inner);
      onInput();
      return;
    }

    const isTitle = (el: HTMLElement) => el.tagName === "SPAN" && el.className === "Title";
    const isSign = (el: HTMLElement) => el.tagName === "SPAN" && el.className === "Sign";
    const isB = (el: HTMLElement) => /^(STRONG|B)$/.test(el.tagName);
    const wasOn = covers(r, match);

    // extract 会切开所有覆盖选区的祖先 → 记下需保留的其他样式，稍后统一重包（避免嵌套堆积）
    const keep: Array<["span" | "strong", string | null]> = [];
    if (!(tag === "span" && cls === "Title") && covers(r, isTitle)) keep.push(["span", "Title"]);
    if (!(tag === "span" && cls === "Sign") && covers(r, isSign)) keep.push(["span", "Sign"]);
    if (tag !== "strong" && covers(r, isB)) keep.push(["strong", null]);

    const frag = r.extractContents();
    // 片段内摘除全部同类样式壳（覆盖路径）+ 其他保留样式的壳（统一重包策略，杜绝嵌套堆积）
    const stripSel = tag === "strong" ? "strong,b" : `span.${cls}`;
    frag.querySelectorAll?.(stripSel).forEach((w) => {
      while (w.firstChild) w.parentNode?.insertBefore(w.firstChild, w);
      w.remove();
    });
    const keepSel = keep.map(([kt, kc]) => (kt === "strong" ? "strong,b" : `span.${kc}`)).join(",");
    if (keepSel) {
      frag.querySelectorAll?.(keepSel).forEach((w) => {
        while (w.firstChild) w.parentNode?.insertBefore(w.firstChild, w);
        w.remove();
      });
    }

    const box = document.createElement("div");
    box.appendChild(frag);
    if (!box.firstChild) return; // 选区无实际内容

    // 组装：开 = 新样式元素最内层；keep 从内到外逐层外包（每样式恰好一层）
    let el: HTMLElement | null = null;
    if (!wasOn) {
      el = makeFmtEl(tag, cls);
      while (box.firstChild) el.appendChild(box.firstChild);
    }
    for (const [kt, kc] of keep) {
      const outer = makeFmtEl(kt, kc);
      if (el) outer.appendChild(el);
      else while (box.firstChild) outer.appendChild(box.firstChild);
      el = outer;
    }

    // 插回并恢复选区（连续点击工具按钮的关键）
    let first: ChildNode, last: ChildNode;
    if (el) {
      r.insertNode(el);
      first = el;
      last = el;
    } else {
      const out = document.createDocumentFragment();
      first = box.firstChild!;
      last = box.lastChild!;
      while (box.firstChild) out.appendChild(box.firstChild);
      r.insertNode(out);
    }
    const after = document.createRange();
    after.setStartBefore(first);
    after.setEndAfter(last);
    sel.removeAllRanges();
    sel.addRange(after);
    onInput();
  };

  /** 正文：清除所选全部样式与链接（图片保留）。选区先向外扩张圈进被完全覆盖的格式容器 */
  const isFmt = (el: Element | null, ed: HTMLElement): el is HTMLElement =>
    !!el && el !== ed && /^(SPAN|STRONG|B|EM|I|U|A|BLOCKQUOTE)$/.test(el.tagName);

  const clearFormat = () => {
    const ed = edRef.current!;
    ed.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    let sp = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : (r.startContainer as HTMLElement);
    while (isFmt(sp, ed)) {
      const first = sp.firstChild;
      const okS = (r.startContainer === first && r.startOffset === 0) || (r.startContainer === sp && r.startOffset === 0);
      if (!okS) break;
      r.setStart(sp.parentNode!, Array.prototype.indexOf.call(sp.parentNode!.childNodes, sp));
      sp = sp.parentElement;
    }
    let ep = r.endContainer.nodeType === 3 ? r.endContainer.parentElement : (r.endContainer as HTMLElement);
    while (isFmt(ep, ed)) {
      const last = ep.lastChild;
      if (!last) break;
      const endLen = last.nodeType === 3 ? (last as Text).length : last.childNodes.length;
      const okE = (r.endContainer === last && r.endOffset === endLen) || (r.endContainer === ep && r.endOffset === ep.childNodes.length);
      if (!okE) break;
      r.setEnd(ep.parentNode!, Array.prototype.indexOf.call(ep.parentNode!.childNodes, ep) + 1);
      ep = ep.parentElement;
    }
    sel.removeAllRanges();
    sel.addRange(r);
    const frag = r.extractContents();
    frag.querySelectorAll?.("span,strong,b,em,i,u,a,blockquote").forEach((w) => {
      while (w.firstChild) w.parentNode?.insertBefore(w.firstChild, w);
      w.remove();
    });
    const holder = document.createElement("div");
    holder.appendChild(frag);
    const out = document.createDocumentFragment();
    while (holder.firstChild) out.appendChild(holder.firstChild);
    r.insertNode(out);
    onInput();
  };

  /** 插入表情图节点：新版存语义 key（data-face=key），旧版存数字（data-face=N，存量帖约定） */
  const makeFaceImg = (f: { slot: number; key: string }, ver: "v1" | "v2") => {
    const im = document.createElement("img");
    im.src = ver === "v2" ? `/images/face-wx/${f.slot}.png` : `/images/face/${f.slot}.gif`;
    im.dataset.face = ver === "v2" ? f.key : `${f.slot}`;
    return im;
  };

  const makeMineImg = (sym: string) => {
    const im = document.createElement("img");
    const name = sym >= "0" && sym <= "8" ? sym : MINE_MAP[sym];
    im.src = `/images/mine/${name.toLowerCase()}.gif`;
    im.dataset.mine = sym;
    return im;
  };

  const onToolbarClick = async (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".wbtn");
    if (!btn) return;
    e.preventDefault();
    const act = btn.dataset.act;
    if (act === "clear") { clearFormat(); closePop(); return; }
    if (act === "wrap") {
      // 原子开关（2026-09-26 张老师定）：三因子各自开/关互不影响；Signest 不再由工具产生
      const map: Record<string, ["span" | "strong", string | null]> = {
        Title: ["span", "Title"], Sign: ["span", "Sign"], b: ["strong", null],
      };
      const [tag, cls] = map[btn.dataset.tag!] ?? ["span", null];
      toggleFormat(tag, cls);
      closePop();
      return;
    }
    if (act === "link") {
      const link = prompt("请输入网页链接，例如：https://www.saolei.wang/", "https://");
      if (link && link !== "https://") {
        const a = document.createElement("a");
        a.href = link;
        a.textContent = link;
        insertNodeAtCaret(a);
      }
      return;
    }
    if (act === "pop") {
      const kind = btn.dataset.pop as PopState["kind"];
      if (popRef.current.kind === kind) { closePop(); return; }
      // 弹层与触发按钮左对齐（工具栏可能换行，取按钮实时 offsetLeft）
      (e.currentTarget as HTMLElement).style.setProperty("--pop-left", `${btn.offsetLeft}px`);
      popRef.current.kind = kind;
      setPop(kind);
      edRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (popRef.current.kind !== "mines") return;
    // 小键盘（keyCode 直接查表）
    if (KEYPAD[e.keyCode]) {
      e.preventDefault();
      insertNodeAtCaret(makeMineImg(KEYPAD[e.keyCode]));
      return;
    }
    // 大键盘数字行（e.key 字面值查表；Shift+数字在部分环境仍报数字，按美式布局折算成符号）
    let key = e.key.length === 1 ? e.key : "";
    if (key && e.shiftKey && SHIFT_DIGITS[key]) key = SHIFT_DIGITS[key];
    if (key && MAINROW[key]) {
      e.preventDefault();
      insertNodeAtCaret(makeMineImg(MAINROW[key]));
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    document.execCommand("insertText", false, text);
  };

  /** 贴图上传：压缩 → POST /api/upload/image → 回链插入 */
  const pickAndUpload = () => {
    fileRef.current?.click();
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      if (file.type === "image/gif") {
        if (file.size > 204800) {
          notify?.(`GIF 超过 200K（${Math.round(file.size / 1024)}K），请先手动压缩`, "error");
          return;
        }
        await insertUploaded(file, file.type);
        notify?.(`GIF ${Math.round(file.size / 1024)}K，无需压缩，已插入`, "success");
        return;
      }
      setUploading(true);
      const r = await compressToBudget(file);
      await insertUploaded(r.blob, "image/jpeg");
      notify?.(`已压缩 ${Math.round(file.size / 1024)}K → ${Math.round(r.blob.size / 1024)}K（${r.w}×${r.h}），已插入`, "success");
    } catch {
      notify?.("图片读取失败", "error");
    } finally {
      setUploading(false);
    }
  };

  const insertUploaded = async (blob: Blob, mime: string) => {
    const fd = new FormData();
    fd.append("file", blob, mime === "image/gif" ? "x.gif" : "x.jpg");
    const res = await fetch("/api/upload/image", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notify?.(data.error ?? "上传失败", "error");
      return;
    }
    const im = document.createElement("img");
    im.src = data.url;
    insertNodeAtCaret(im);
    closePop();
  };

  /** 点击面板外收起（2026-09-26 张老师定：摆雷面板常驻，仅手动点「摆雷」按钮才关——
   *  点击画布/页面其他处不收起，方便边敲键盘边看符号表） */
  useEffect(() => {
    if (!pop) return;
    const h = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement;
      if (t.closest(".wpop") || t.closest(".wbtn")) return;
      if (popRef.current.kind === "mines") return;
      closePop();
    };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [pop]);

  const toolbarBtn = (
    key: string,
    label: React.ReactNode,
    props: Record<string, string>
  ) => (
    <button key={key} type="button" className={`wbtn ${props.cls ?? ""}`} data-act={props.act} data-tag={props.tag} data-pop={props.pop}>
      {label}
    </button>
  );

  return (
    <div className="wys_wrap">
      <div className="wys_toolbar" onMouseDown={(e) => { if ((e.target as HTMLElement).closest(".wbtn")) e.preventDefault(); }} onClick={onToolbarClick}>
        {toolbarBtn("clear", "正文", { act: "clear" })}
        {/* 2026-09-26 张老师定：工具只有三个格式因子，用户自己组合——
            加亮=[Title]白 / 醒目=[Sign]黄 / 加粗=[b]；[Signest]（黄+粗）按钮已删，
            UBB 标签渲染端照旧支持存量帖；[Title] 全站同步去 bold（等于只加亮） */}
        {full && toolbarBtn("light", "加亮", { act: "wrap", tag: "Title", cls: "t-light" })}
        {full && toolbarBtn("sign", "醒目", { act: "wrap", tag: "Sign", cls: "t-sign" })}
        {full && toolbarBtn("b", "加粗", { act: "wrap", tag: "b", cls: "t-b" })}
        {full && toolbarBtn("link", "🔗 链接", { act: "link" })}
        {toolbarBtn("img", "🖼️ 贴图", { act: "pop", pop: "imgs" })}
        {toolbarBtn("faces", "表情", { act: "pop", pop: "faces" })}
        {toolbarBtn("mines", <><img className="bico" src="/images/mine/Mine.gif" alt="" />摆雷</>, { act: "pop", pop: "mines" })}

        {pop === "faces" && (
          <div className="wpop faces">
            <div className="wpop_grid">
              {WX_FACES.map((f) => (
                <img
                  key={f.slot}
                  src={faceVer === "v2" ? `/images/face-wx/${f.slot}.png` : `/images/face/${f.slot}.gif`}
                  alt={f.zh}
                  title={f.zh}
                  onClick={() => { insertNodeAtCaret(makeFaceImg(f, faceVerRef.current)); closePop(); }}
                />
              ))}
            </div>
            {/* 底部 TAB 筛选（2026-09-26 张老师定）：默认新版静态（微信），备选旧版动态（QQ） */}
            <div className="wpop_tabs">
              <button type="button" className={`wbtn wbtn_sw${faceVer === "v2" ? " on" : ""}`} data-fv="v2" onClick={() => { faceVerRef.current = "v2"; setFaceVer("v2"); }}>新版静态</button>
              <button type="button" className={`wbtn wbtn_sw${faceVer === "v1" ? " on" : ""}`} data-fv="v1" onClick={() => { faceVerRef.current = "v1"; setFaceVer("v1"); }}>旧版动态</button>
            </div>
          </div>
        )}
        {pop === "mines" && (
          <div className="wpop mines">
            {/* 4x4 方阵（2026-09-26 张老师定）：
                第一行「无按钮」：黑 / 空 / 问 / 雷（[-] = 凹陷底问号，[ ] = 凹陷空格）
                第二三行数字 1-8；第四行「有按钮」：空 / 旗 / 问 / 雷（同日张老师：旗、问对换） */}
            <div className="wpop_grid mine_pad">
              {[
                [".", "Black", "分割使用"],
                [" ", "Blank", "小键盘[0]"],
                ["-", "Num", "无按钮问号"],
                ["*", "Mine", "小键盘[*]"],
                ["1", "1", "小键盘[1]"],
                ["2", "2", "小键盘[2]"],
                ["3", "3", "小键盘[3]"],
                ["4", "4", "小键盘[4]"],
                ["5", "5", "小键盘[5]"],
                ["6", "6", "小键盘[6]"],
                ["7", "7", "小键盘[7]"],
                ["8", "8", "小键盘[8]"],
                ["Q", "Block", "小键盘[.]"],
                ["!", "Flag", "小键盘[9]"],
                ["?", "Mark", "小键盘[/]"],
                ["+", "IsMine", "小键盘[+]"],
              ].map(([sym, name, tip]) => (
                <img
                  key={sym}
                  src={`/images/mine/${name.toLowerCase()}.gif`}
                  alt=""
                  title={tip}
                  onClick={() => insertNodeAtCaret(makeMineImg(sym))}
                />
              ))}
            </div>
            <div className="wpop_tip">可用数字快捷键</div>
          </div>
        )}
        {pop === "imgs" && (
          <div className="wpop imgsup">
            <button type="button" className="wup_area" onClick={pickAndUpload} disabled={uploading}>
              {uploading ? "上传中…" : <>🖼️ <b>点击选择本地图片</b><br />自动压缩至 200K 内上传服务器</>}
            </button>
            <div className="wlink_row">
              <input
                placeholder="或输入图片链接 http(s)://"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (!v) return;
                  const im = document.createElement("img");
                  im.src = v;
                  insertNodeAtCaret(im);
                  closePop();
                }}
              />
              <button
                type="button"
                onClick={(e) => {
                  const input = (e.target as HTMLElement).parentElement?.querySelector("input");
                  const v = input?.value.trim();
                  if (!v) return;
                  const im = document.createElement("img");
                  im.src = v;
                  insertNodeAtCaret(im);
                  closePop();
                }}
              >
                插入
              </button>
            </div>
          </div>
        )}
      </div>
      <div
        ref={edRef}
        className="wys"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        data-ph={placeholder}
        style={{ minHeight }}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFileChange} />
    </div>
  );
}
