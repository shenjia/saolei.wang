// BBS 所见即所得编辑器（2026-09-25 张老师确认方案）
// 数据层仍是 UBB：载入 ubbToEditorHtml(UBB) → contenteditable 画布真身呈现 → 提交 serializeEditor(ed) 序列化回 UBB。
// 存量帖零迁移、服务端 ubb() 渲染管线零改动（lib/bbs.ts）。
// 交互移植 2008 版 BBS/Edit_Box.asp + Face.asp + Mine.asp：工具栏按钮、弹层面板、小键盘摆雷。

"use client";

import { useEffect, useRef, useState, useCallback } from "react";

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
  t = t.replace(/\[face\](\d{1,2})(n?)\[\/face\]/gi, (_, n: string, sfx: string) => {
    const id = Math.min(29, parseInt(n, 10));
    const dir = sfx ? "face-wx" : "face";
    const ext = sfx ? ".png" : ".gif";
    return `<img src="/images/${dir}/${id}${ext}" data-face="${id}${sfx}">`;
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
      if (c === "Title") out += `[Title]${inner()}[/Title]`;
      else if (c === "Sign") out += `[Sign]${inner()}[/Sign]`;
      else if (c === "Signest") out += `[Signest]${inner()}[/Signest]`;
      else out += inner();
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
  return serializeInline(ed.childNodes).replace(/\n+$/, "");
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
    onInput();
  };

  const wrapSelection = (tag: string, cls: string | null) => {
    const ed = edRef.current!;
    ed.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const frag = r.extractContents();
    const el = tag === "span" ? (() => { const s = document.createElement("span"); s.className = cls!; return s; })() : document.createElement(tag);
    el.appendChild(frag);
    r.insertNode(el);
    const after = document.createRange();
    after.setStartAfter(el);
    after.collapse(true);
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

  const makeFaceImg = (id: number, ver: "v1" | "v2") => {
    const im = document.createElement("img");
    im.src = ver === "v2" ? `/images/face-wx/${id}.png` : `/images/face/${id}.gif`;
    im.dataset.face = `${id}${ver === "v2" ? "n" : ""}`;
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
      const map: Record<string, [string, string | null]> = {
        Title: ["span", "Title"], Sign: ["span", "Sign"], Signest: ["span", "Signest"], b: ["strong", null],
      };
      const [tag, cls] = map[btn.dataset.tag!] ?? ["span", null];
      wrapSelection(tag, cls);
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
    if (popRef.current.kind === "mines" && KEYPAD[e.keyCode]) {
      e.preventDefault();
      insertNodeAtCaret(makeMineImg(KEYPAD[e.keyCode]));
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

  /** 点击面板外收起 */
  useEffect(() => {
    if (!pop) return;
    const h = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement;
      if (!t.closest(".wpop") && !t.closest(".wbtn")) closePop();
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
        {full && toolbarBtn("title", "标题", { act: "wrap", tag: "Title", cls: "t-title" })}
        {full && toolbarBtn("sign", "醒目", { act: "wrap", tag: "Sign", cls: "t-sign" })}
        {full && toolbarBtn("signest", "加亮", { act: "wrap", tag: "Signest", cls: "t-signest" })}
        {full && toolbarBtn("b", "加粗", { act: "wrap", tag: "b", cls: "t-b" })}
        {full && toolbarBtn("link", "🔗 链接", { act: "link" })}
        {toolbarBtn("img", "🖼️ 贴图", { act: "pop", pop: "imgs" })}
        {toolbarBtn("faces", "表情", { act: "pop", pop: "faces" })}
        {toolbarBtn("mines", <><img className="bico" src="/images/mine/Mine.gif" alt="" />摆雷</>, { act: "pop", pop: "mines" })}

        {pop === "faces" && (
          <div className="wpop faces">
            <div className="wpop_sw">
              <button type="button" className={`wbtn wbtn_sw${faceVer === "v2" ? " on" : ""}`} data-fv="v2" onClick={() => { faceVerRef.current = "v2"; setFaceVer("v2"); }}>新版</button>{" "}
              <button type="button" className={`wbtn wbtn_sw${faceVer === "v1" ? " on" : ""}`} data-fv="v1" onClick={() => { faceVerRef.current = "v1"; setFaceVer("v1"); }}>旧版</button>
            </div>
            <div className="wpop_grid">
              {Array.from({ length: 30 }, (_, i) => i + 1).map((i) => (
                <img
                  key={i}
                  src={faceVer === "v2" ? `/images/face-wx/${i}.png` : `/images/face/${i}.gif`}
                  alt=""
                  onClick={() => { insertNodeAtCaret(makeFaceImg(i, faceVerRef.current)); closePop(); }}
                />
              ))}
            </div>
            <div className="wpop_tip">点击插入表情（新版 = 微信原版，旧版 = QQ 动态）</div>
          </div>
        )}
        {pop === "mines" && (
          <div className="wpop mines">
            <div className="wpop_grid">
              {[
                [".", "Black", "分割使用"],
                [" ", "Blank", "小键盘[0]"],
                ["Q", "Block", "小键盘[.]"],
                ["1", "1", "小键盘[1]"],
                ["2", "2", "小键盘[2]"],
                ["3", "3", "小键盘[3]"],
                ["4", "4", "小键盘[4]"],
                ["5", "5", "小键盘[5]"],
                ["6", "6", "小键盘[6]"],
                ["7", "7", "小键盘[7]"],
                ["8", "8", "小键盘[8]"],
                ["*", "Mine", "小键盘[*]"],
                ["+", "IsMine", "小键盘[+]"],
                ["!", "Flag", "小键盘[9]"],
                ["?", "Mark", "小键盘[/]"],
                ["-", "Num", "小键盘[-]"],
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
            <div className="wpop_tip">面板开启时可用小键盘直接摆雷</div>
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
