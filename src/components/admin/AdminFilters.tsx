// 后台筛选工具条（2026-09-24）
// 服务端渲染列表 + URL 承载筛选状态（可分享、可后退），组件只负责把控件变化写回 URL。
// 任何筛选变化都重置 page=1，避免「筛完停在第 7 页空白」。

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

export interface FilterField {
  name: string;
  type: "search" | "select" | "date";
  placeholder?: string;
  prefix?: string;
  options?: [string, string][];
  width?: string;
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
  const [q, setQ] = useState(params.get(searchField?.name ?? "q") ?? "");

  const push = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") next.delete(k);
      else next.set(k, v);
    }
    next.delete("page");
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
  };

  return (
    <form
      className="admin_filterbar"
      onSubmit={(e) => {
        e.preventDefault();
        if (searchField) push({ [searchField.name]: q.trim() });
      }}
    >
      {fields.map((f) => {
        if (f.type === "search") {
          return (
            <input
              key={f.name}
              className="admin_input search"
              type="search"
              placeholder={f.placeholder ?? "搜索…"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
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
