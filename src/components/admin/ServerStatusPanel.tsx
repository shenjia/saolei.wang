"use client";

// 服务器负载面板（2026-10-28 张老师需求）：后台练习数据页，列出全部权威服务
// 实例，每 3s 轮询 /api/admin/authority-status 刷新。
// 2026-10-31 张老师需求：卡片改表格 + 可排序表头——默认按在线人数降序，表头
// 点击切换升/降序（视觉语言照前台录像列表表头 VideoRows 的 .sa 双三角）。

import { useEffect, useRef, useState } from "react";

interface ServerRow {
  name: string;
  region: string;
  slot: string;
  ok: boolean;
  rtt: number;
  connections: number;
  active: number;
  games: number;
  draining: boolean;
}

type SortKey = "name" | "status" | "connections" | "active" | "rtt";
interface SortSpec {
  key: SortKey;
  dir: "asc" | "desc";
}
/** 各列默认方向：数值列降序（多在前），名称/状态列升序 */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  name: "asc",
  status: "asc",
  connections: "desc",
  active: "desc",
  rtt: "desc",
};

/** 升降序双箭头（照抄 VideoRows.SortArrows 视觉：金色=当前方向） */
function SortArrows({ dir }: { dir: "asc" | "desc" }) {
  return (
    <span className="sa" aria-hidden="true">
      <i className={`up${dir === "asc" ? " on" : ""}`} />
      <i className={`down${dir === "desc" ? " on" : ""}`} />
    </span>
  );
}

export function ServerStatusPanel() {
  const [rows, setRows] = useState<ServerRow[] | null>(null);
  const [at, setAt] = useState(0);
  const [sort, setSort] = useState<SortSpec>({ key: "connections", dir: "desc" });
  const alive = useRef(true);
  const hadData = useRef(false);

  useEffect(() => {
    alive.current = true;
    const load = async () => {
      try {
        const res = await fetch("/api/admin/authority-status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { servers: ServerRow[] };
        if (!alive.current) return;
        hadData.current = true;
        setRows(j.servers);
        setAt(Date.now());
      } catch {
        /* 拉取失败保留上一次数据（行内 ok=false 已表达不可用）；首次失败置空
           数组让面板显示「全部不可用」而不是永远转圈 */
        if (alive.current && !hadData.current) setRows([]);
      }
    };
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      alive.current = false;
      window.clearInterval(t);
    };
  }, []);

  const clickSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  // 排序键取值：状态列按「正常0 < 排空1 < 不可用2」，其余数值列不可用行取 -1 沉底
  const rank = (r: ServerRow): number =>
    sort.key === "status"
      ? !r.ok
        ? 2
        : r.draining
          ? 1
          : 0
      : sort.key === "name"
        ? 0
        : sort.key === "rtt" && !r.ok
          ? -1
          : (r[sort.key] as number);
  const sorted = [...(rows ?? [])].sort((a, b) => {
    if (sort.key === "name") {
      return sort.dir === "asc" ? a.name.localeCompare(b.name, "zh") : b.name.localeCompare(a.name, "zh");
    }
    const d = rank(a) - rank(b);
    return sort.dir === "asc" ? d : -d;
  });

  const th = (key: SortKey, label: string, tip: string, extra?: object) => (
    <th {...extra}>
      <button
        type="button"
        className={`sv_sort${sort.key === key ? " on" : ""}`}
        onClick={() => clickSort(key)}
        title={tip}
      >
        {label}
        {sort.key === key && <SortArrows dir={sort.dir} />}
      </button>
    </th>
  );

  return (
    <div
      className="sv_panel"
      style={{
        flex: "0 0 316px",
        border: "1px solid #3e3d32",
        borderRadius: 6,
        background: "#272822",
        padding: "10px 12px",
        fontSize: 13,
        lineHeight: 1.5,
        color: "#f8f8f2",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <b style={{ fontSize: 14 }}>服务器负载</b>
        <span style={{ color: "#75715e", fontSize: 12 }}>
          {rows ? `每 3 秒刷新 · ${at ? new Date(at).toLocaleTimeString("zh-CN", { hour12: false }) : ""}` : "获取中…"}
        </span>
      </div>
      <table className="sv_table">
        <thead>
          <tr>
            {th("name", "服务器", "按服务器名称排列")}
            {th("status", "状态", "按状态排列（正常→排空→不可用）")}
            {th("connections", "在线", "按在线人数排列（多在前）", { className: "c" })}
            {th("active", "进行", "按进行局数排列（多在前）", { className: "c" })}
            {th("rtt", "延迟", "按响应延迟排列（快在前）", { className: "c" })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.name}>
              <td>
                <b style={{ color: "#d6d6cc" }}>{r.name}</b>
              </td>
              <td>
                <span
                  style={{
                    display: "inline-block",
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    marginRight: 4,
                    background: r.ok ? (r.draining ? "#f79646" : "#a6e22e") : "#e24b4a",
                  }}
                  aria-label={r.ok ? (r.draining ? "排空中" : "可用") : "不可用"}
                />
                {r.ok ? (
                  r.draining ? (
                    <span style={{ color: "#f79646" }} title="发布等待排空中，拒绝新局">
                      排空
                    </span>
                  ) : (
                    <span style={{ color: "#75715e" }}>正常</span>
                  )
                ) : (
                  <span style={{ color: "#e24b4a" }}>不可用</span>
                )}
              </td>
              <td className="c">
                {r.ok ? <b style={{ color: "#a6e22e" }}>{r.connections}</b> : <span style={{ color: "#49483e" }}>—</span>}
              </td>
              <td className="c">
                {r.ok ? <b style={{ color: "#fdc61d" }}>{r.active}</b> : <span style={{ color: "#49483e" }}>—</span>}
              </td>
              <td className="c">{r.ok ? `${r.rtt}ms` : <span style={{ color: "#49483e" }}>—</span>}</td>
            </tr>
          ))}
          {rows !== null && rows.length === 0 && (
            <tr>
              <td colSpan={5} style={{ color: "#e24b4a", textAlign: "center" }}>
                全部实例不可达
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div style={{ marginTop: 8, color: "#75715e", fontSize: 12 }}>
        在线＝当前 WS 连接数 · 进行＝有活连接的对局 · 点击表头切换排序
      </div>
    </div>
  );
}
