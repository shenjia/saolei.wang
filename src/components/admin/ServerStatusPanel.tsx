"use client";

// 服务器负载面板（2026-10-28 张老师需求）：后台练习数据页，列出全部权威服务
// 实例，每 3s 轮询 /api/admin/authority-status 刷新。
// 2026-10-31 张老师需求：卡片改表格 + 可排序表头——默认按在线人数降序，表头
// 点击切换升/降序（视觉语言照前台录像列表表头 VideoRows 的 .sa 双三角）。
// 2026-11-01 张老师需求：①「进行」改「对局」，在线/对局合并一列（照录像列表
// 评论/点击的「N / M」双数字形态）；②延迟列弃后台探测值，改玩家实测
// （ranked_rtt_log 近 7 天按节点聚合）。
// 2026-11-01 二次（张老师定稿）：③隐藏状态列，状态色点移到服务器名前；
// ④在线/对局各独立一列，均显「x / y」双数字——在线 x＝当前在线连接数 /
// y＝累计去重连接人数；对局 x＝进行中对局数 / y＝累计开局面数（gamesServed）。
// 2026-11-01 三次（张老师定稿）：⑤累计值（y）一律暗灰，当前对局数金色（当前
// 在线保持绿）；⑥表头只显「在线」「对局」单词，点击按累计值排序，默认按累计
// 连接人数降序。

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
  connsUsers: number;
  gamesServed: number;
  rttAvg: number | null;
  rttN: number;
}

type SortKey = "name" | "connsUsers" | "gamesServed" | "rttAvg";
interface SortSpec {
  key: SortKey;
  dir: "asc" | "desc";
}
/** 各列默认方向：计数列降序（多在前），延迟列升序（快在前），名称列升序。
    在线/对局表头单词化（2026-11-01 三次），排序键=累计值 */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  name: "asc",
  connsUsers: "desc",
  gamesServed: "desc",
  rttAvg: "asc",
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
  const [sort, setSort] = useState<SortSpec>({ key: "connsUsers", dir: "desc" });
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

  // 排序键取值：数值列不可用行 -1 沉底，无延迟样本（null）在延迟列恒沉底
  const rank = (r: ServerRow): number => {
    if (sort.key === "name") return 0;
    if (sort.key === "rttAvg") return r.rttAvg !== null && r.ok ? r.rttAvg : -1;
    return r.ok ? (r[sort.key] as number) : -1;
  };
  const sorted = [...(rows ?? [])].sort((a, b) => {
    if (sort.key === "name") {
      return sort.dir === "asc" ? a.name.localeCompare(b.name, "zh") : b.name.localeCompare(a.name, "zh");
    }
    const d = rank(a) - rank(b);
    return sort.dir === "asc" ? d : -d;
  });

  /** 表头排序按钮（双数字列的两个数字各自独立排序入口） */
  const thInner = (key: SortKey, label: string, tip: string) => (
    <button
      type="button"
      className={`sv_sort${sort.key === key ? " on" : ""}`}
      onClick={() => clickSort(key)}
      title={tip}
    >
      {label}
      {sort.key === key && <SortArrows dir={sort.dir} />}
    </button>
  );

  /** 状态色点（2026-11-01 二次：状态列隐藏，色点移到服务器名前） */
  const dot = (r: ServerRow) => (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 5,
        verticalAlign: "middle",
        background: r.ok ? (r.draining ? "#f79646" : "#a6e22e") : "#e24b4a",
      }}
      aria-label={r.ok ? (r.draining ? "排空中" : "可用") : "不可用"}
      title={r.ok ? (r.draining ? "排空中（拒绝新局）" : "正常") : "不可用"}
    />
  );

  /** 「x / y」双数字单元格（2026-11-01 三次：当前在线绿、当前对局金、累计一律暗灰） */
  const pair = (r: ServerRow, now: number, nowColor: string, total: number) =>
    r.ok ? (
      <>
        <b style={{ color: nowColor }}>{now}</b>
        <span style={{ color: "#49483e" }}> / </span>
        <b style={{ color: "#75715e" }}>{total.toLocaleString("zh-CN")}</b>
      </>
    ) : (
      <span style={{ color: "#49483e" }}>—</span>
    );

  return (
    <div
      className="sv_panel"
      style={{
        flex: "0 0 400px",
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
            <th>{thInner("name", "服务器", "按服务器名称排列")}</th>
            {/* 在线/对局表头单词化（2026-11-01 三次），点击按累计值排序 */}
            <th className="c">{thInner("connsUsers", "在线", "按累计去重连接人数排列（多在前）")}</th>
            <th className="c">{thInner("gamesServed", "对局", "按累计开局面数排列（多在前）")}</th>
            <th className="c">{thInner("rttAvg", "平均延迟", "按玩家实测平均延迟排列（快在前；近 7 天采样）")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.name}>
              <td>
                {dot(r)}
                <b style={{ color: "#d6d6cc" }}>{r.name}</b>
              </td>
              <td className="c" title="x＝当前在线连接数 · y＝累计去重连接人数（重启不清零；点击表头按累计排序）">
                {pair(r, r.connections, "#a6e22e", r.connsUsers)}
              </td>
              <td className="c" title="x＝进行中对局数 · y＝累计开局面数（重启不清零；点击表头按累计排序）">
                {pair(r, r.active, "#fdc61d", r.gamesServed)}
              </td>
              <td className="c" title={r.ok && r.rttAvg !== null ? `近 7 天 ${r.rttN} 个玩家实测样本` : undefined}>
                {r.ok && r.rttAvg !== null ? `${r.rttAvg}ms` : <span style={{ color: "#49483e" }}>—</span>}
              </td>
            </tr>
          ))}
          {rows !== null && rows.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "#e24b4a", textAlign: "center" }}>
                全部实例不可达
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div style={{ marginTop: 8, color: "#75715e", fontSize: 12 }}>
        <span style={{ color: "#a6e22e" }}>●</span> 正常 ·{" "}
        <span style={{ color: "#f79646" }}>●</span> 排空 ·{" "}
        <span style={{ color: "#e24b4a" }}>●</span> 不可用 · 在线＝当前连接 / 累计人数（灰） ·
        对局＝进行中 / 累计局数（灰） · 平均延迟＝玩家实测近 7 天均值 · 点击表头按累计排序
      </div>
    </div>
  );
}
