// 后台筛选工具条（2026-09-24）
// 服务端渲染列表 + URL 承载筛选状态（可分享、可后退），组件只负责把控件变化写回 URL。
// 任何筛选变化都重置 page=1，避免「筛完停在第 7 页空白」。
// 2026-11-11（张老师需求）：search 字段支持 width（加长）与 suggest——输入后防抖拉
// /api/admin/user-search-suggest 出「姓名/账号/昵称/录像标识包含 xx 的玩家」类型推荐下拉
// （交互对齐前台 VideoSearch：防抖 250ms、键盘上下选、回车确认、点击外部收起），
// 选中按该类型筛选（URL 追加 qtype）；玩家管理列表据此补 昵称/录像标识 列。

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

export interface FilterField {
  name: string;
  type: "search" | "select" | "date";
  placeholder?: string;
  prefix?: string;
  options?: [string, string][];
  width?: string;
  /** 搜索推荐（2026-11-11）：输入后出「姓名/账号/昵称/标识包含 xx」类型下拉，选中按类型筛选 */
  suggest?: boolean;
}

/** 推荐项：key=搜索类型（all=不限类型），count=命中人数（0 不显示），samples=前 3 个样本 */
interface SuggestItem {
  key: string;
  label: string;
  count: number;
  samples: string[];
}

export function AdminFilters({
  fields,
  right,
}: {
  fields: FilterField[];
  /** 右侧附加内容（如导出/批量按钮，服务端渲染的节点也可传） */
  right?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const searchField = fields.find((f) => f.type === "search");
  const suggestOn = !!searchField?.suggest;
  const qKey = searchField?.name ?? "q";
  const [q, setQ] = useState(params.get(qKey) ?? "");

  const push = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  };

  // ---------- 搜索推荐下拉（2026-11-11） ----------
  const [items, setItems] = useState<SuggestItem[] | null>(null);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const seqRef = useRef(0); // 竞态：仅最后一次请求生效
  // 用户是否实际输入过：带 q 进页时输入框有回显值，不应自动弹推荐（前台 VideoSearch 同款）
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!suggestOn) return;
    const kw = q.trim();
    if (!dirtyRef.current || !kw) {
      seqRef.current++; // 使在途请求失效
      setItems(null);
      return;
    }
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/user-search-suggest?q=${encodeURIComponent(kw)}`);
        if (!res.ok) return;
        const { items: list } = (await res.json()) as { items: SuggestItem[] };
        if (seq !== seqRef.current) return;
        setItems(list);
        setActive(0);
      } catch {
        /* 网络异常静默：回车提交仍可用 */
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [q, suggestOn]);

  // 点击外部收起下拉
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setItems(null);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  /** 选中推荐项：按该类型筛选（all=不限类型，删 qtype） */
  function pickSuggest(it: SuggestItem) {
    setItems(null);
    push({ [qKey]: q.trim(), qtype: it.key === "all" ? undefined : it.key });
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!items || items.length === 0) return; // 无下拉：回车走 form submit（全字段搜索）
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) pickSuggest(it);
      else push({ [qKey]: q.trim(), qtype: undefined });
    } else if (e.key === "Escape") {
      setItems(null);
    }
  }

  return (
    <form
      className="admin_filterbar"
      onSubmit={(e) => {
        e.preventDefault();
        if (searchField) push({ [searchField.name]: q.trim(), qtype: undefined }); // 查询按钮=不限类型
      }}
    >
      {fields.map((f) => {
        if (f.type === "search") {
          const isMain = f === searchField;
          return (
            <span key={f.name} className="admin_search_wrap" ref={isMain ? wrapRef : undefined}>
              <input
                className="admin_input search"
                type="search"
                placeholder={f.placeholder ?? "搜索…"}
                value={q}
                style={f.width ? { width: f.width } : undefined}
                onChange={(e) => {
                  dirtyRef.current = true;
                  setQ(e.target.value);
                }}
                onKeyDown={isMain && suggestOn ? onSearchKeyDown : undefined}
                autoComplete="off"
              />
              {isMain && suggestOn && items !== null && (
                <ul className="admin_suggest">
                  {items.length === 0 ? (
                    <li className="admin_suggest_empty">没有匹配的玩家</li>
                  ) : (
                    items.map((it, i) => (
                      <li key={it.key} className={i === active ? "active" : undefined}>
                        <button type="button" onMouseEnter={() => setActive(i)} onClick={() => pickSuggest(it)}>
                          <em>{it.label}</em>
                          <span>
                            {[it.count > 0 ? `${it.count} 人` : "", it.samples.join("、")].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </span>
          );
        }
        if (f.type === "date") {
          return (
            <span key={f.name} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              {f.prefix && <span className="label">{f.prefix}</span>}
              <input
                className="admin_input"
                type="date"
                style={{ width: 138 }}
                value={params.get(f.name) ?? ""}
                onChange={(e) => push({ [f.name]: e.target.value })}
              />
            </span>
          );
        }
        return (
          <select
            key={f.name}
            className="admin_select"
            title={f.prefix}
            value={params.get(f.name) ?? ""}
            onChange={(e) => push({ [f.name]: e.target.value })}
          >
            {(f.options ?? []).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        );
      })}

      <button type="submit" className="admin_btn primary" disabled={pending}>
        {pending ? "查询中…" : "查询"}
      </button>
      {(params.toString() !== "" || q !== "") && (
        <button
          type="button"
          className="admin_btn"
          onClick={() => {
            setQ("");
            setItems(null);
            startTransition(() => router.push(pathname));
          }}
        >
          清空
        </button>
      )}

      {right && <span className="spacer" />}
      {right}
    </form>
  );
}
