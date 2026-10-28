"use client";

// 服务器负载面板（2026-10-28 张老师需求）：后台练习数据页延迟地图右侧，列出
// 全部权威服务实例（北京1/北京2/香港），每 3s 轮询 /api/admin/authority-status
// 刷新：是否可用（红绿点）、在线人数、进行局数、响应耗时、排空状态。

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

export function ServerStatusPanel() {
  const [rows, setRows] = useState<ServerRow[] | null>(null);
  const [at, setAt] = useState(0);
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

  return (
    <div
      style={{
        flex: 1,
        minWidth: 230,
        maxWidth: 320,
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
      {(rows ?? []).map((r) => (
        <div
          key={r.name}
          style={{
            marginTop: 8,
            padding: "6px 8px",
            border: "1px solid #3e3d32",
            borderRadius: 5,
            background: "#1e1f1c",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#e24b4a", fontSize: 12 }}>⚑</span>
            <b>{r.name}</b>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                flexShrink: 0,
                background: r.ok ? "#a6e22e" : "#e24b4a",
              }}
              aria-label={r.ok ? "可用" : "不可用"}
            />
            {r.ok ? (
              <span style={{ color: "#75715e", fontSize: 12, marginLeft: "auto" }}>{r.rtt}ms</span>
            ) : (
              <span style={{ color: "#e24b4a", fontSize: 12, marginLeft: "auto" }}>不可用</span>
            )}
          </div>
          {r.ok && (
            <div style={{ display: "flex", gap: 12, marginTop: 3, color: "#b1b1a4" }}>
              <span>
                在线 <b style={{ color: "#a6e22e" }}>{r.connections}</b> 人
              </span>
              <span>
                进行 <b style={{ color: "#fdc61d" }}>{r.active}</b> 局
              </span>
              {r.draining && (
                <span style={{ color: "#f79646" }} title="发布等待排空中，拒绝新局">
                  排空中
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      {rows !== null && rows.length === 0 && (
        <div style={{ marginTop: 8, color: "#e24b4a" }}>全部实例不可达</div>
      )}
      <div style={{ marginTop: 8, color: "#75715e", fontSize: 12 }}>
        在线＝当前 WS 连接数 · 进行＝有活连接的对局
      </div>
    </div>
  );
}
