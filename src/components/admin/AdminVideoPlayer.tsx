"use client";

// 管理后台 · 待审队列全屏回放播放器（2026-10-19 张老师需求：点列表「时间」弹层看录像）
//
// 形态：fixed 全屏层（z-index 1500，压过 admin 壳 500）＝遮罩 + 居中棋盘 + 控制条。
// 引擎与解析复用 VideoReplay 生态（parseReplayData/runReplay，flop 官方口径状态机），
// 与详情页原地回放同一套语义；解析失败/404 走 flop 播放器兜底（同详情页策略）。
// 棋盘不依赖页面 Board 组件（后台列表无 board 串）：解析产物 data.board 自带整盘，
// 本组件直接渲染 td 表（className 口径与 Board 完全一致：b0-b8/bf/bb）。
//
// 结构：外层 AdminVideoPlayer 只做 portal + key 重挂载；内层 PlayerBody 每次打开
// 新录像都是全新实例（状态在挂载期初始化，切换目标零残留）。

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FlopSprites } from "../FlopSprites";
import { FlopPlayer, playFlop } from "../FlopPlayer";
import { parseReplayData, runReplay, type ReplayData, type ReplayStats } from "../VideoReplay";
import type { VideoLevel } from "@/lib/config";

type Status = "idle" | "loading" | "playing" | "paused" | "ended";

export interface AdminPlayerTarget {
  id: number;
  level: VideoLevel;
  /** video_info.filepath（/2026/01/05/xxx.mvf 形态） */
  filepath: string;
  /** 库内权威用时 ms（进度条总长） */
  realTime: number;
  /** 玩家名（标题展示） */
  player: string;
}

const LEVEL_NAMES: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };

export function AdminVideoPlayer({
  target,
  onClose,
}: {
  target: AdminPlayerTarget | null;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  /* rAF 异步置位（对齐 VideoReplay ReplayFullscreen 的写法）：绕开
     react-hooks/set-state-in-effect（同步 setState 级联渲染）拦截 */
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  if (!mounted || !target) return null;
  /* key=target.id：切换目标＝整层重挂载（内层状态与引擎零残留） */
  return createPortal(
    <>
      <FlopSprites />
      <PlayerBody key={target.id} target={target} onClose={onClose} />
    </>,
    document.body
  );
}

/* ---- 内层：单盘播放器主体（外层按 target.id 重挂载） ---- */

function PlayerBody({ target, onClose }: { target: AdminPlayerTarget; onClose: () => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [stats, setStats] = useState<ReplayStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [flopUri, setFlopUri] = useState<string | null>(null);
  /** 解析产物就绪后才渲染棋盘（board 串来自文件，不依赖列表数据） */
  const [data, setData] = useState<ReplayData | null>(null);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ReturnType<typeof runReplay> | null>(null);

  const close = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    onClose();
  }, [onClose]);

  /* Esc 关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  /* 卸载清理（关层/切目标时停引擎） */
  useEffect(
    () => () => {
      engineRef.current?.stop();
      engineRef.current = null;
    },
    []
  );

  /* flop 兜底：iframe 就绪后播 */
  useEffect(() => {
    if (flopUri && window.flop) playFlop(flopUri);
  }, [flopUri]);

  const start = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.restart();
      setStatus("playing");
      return;
    }
    const tbody = tbodyRef.current;
    const wrap = wrapRef.current;
    if (!wrap || !tbody || !data) return;
    engineRef.current = runReplay({
      wrap,
      tbody,
      rows: data.h,
      cols: data.w,
      data,
      onEnd: () => setStatus("ended"),
      onStats: setStats,
    });
    setStatus("playing");
  }, [data]);

  /* 打开即加载文件（弹层本身就是「我要看这盘」的意图）；解析产物就绪即待播。
     状态初始值在挂载期直接算（ext/flop 分流不进 effect——同步 setState 拦截） */
  const ext = (target.filepath.split(".").pop() || "").toLowerCase();
  const unsupportedExt = ext !== "avf" && ext !== "mvf" && ext !== "rmv";
  useEffect(() => {
    if (unsupportedExt) return;
    const uri = `/videos${target.filepath}`;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(uri);
        if (!res.ok) throw new Error(String(res.status));
        const parsed = parseReplayData(
          new Uint8Array(await res.arrayBuffer()),
          ext,
          Math.round(target.realTime / 10)
        );
        if (!alive) return;
        if (!parsed) {
          setFlopUri(uri);
          return;
        }
        setData(parsed);
      } catch {
        if (!alive) return;
        setNotice("录像文件加载失败（可能已缺失）");
        window.setTimeout(() => alive && setNotice(null), 3500);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  /* data 就绪且棋盘 DOM 已渲染 → 自动开播 */
  useEffect(() => {
    if (data && tbodyRef.current && !engineRef.current) start();
  }, [data, start]);

  const togglePlay = useCallback(() => {
    if (status === "playing") {
      engineRef.current?.pause();
      setStatus("paused");
    } else if (status === "paused") {
      engineRef.current?.resume();
      setStatus("playing");
    } else start();
  }, [status, start]);

  const pause = useCallback(() => {
    if (status === "playing") {
      engineRef.current?.pause();
      setStatus("paused");
    }
  }, [status]);

  const resume = useCallback(() => {
    if (status === "paused") {
      engineRef.current?.resume();
      setStatus("playing");
    }
  }, [status]);

  const seek = useCallback((csec: number) => {
    engineRef.current?.seek(csec);
  }, []);

  /* 棋盘单元格：'*'=雷→b（与 Board 的 replace 星号→b 同口径）；数字串直用 */
  const cells = data ? data.board.replace(/\*/g, "b").split("") : [];
  const w = data?.w ?? 0;
  const h = data?.h ?? 0;

  return (
    <div
      className="ban_overlay"
      style={{ zIndex: 1500 }}
      onClick={() => {
        if (status === "idle") close();
      }}
    >
      {flopUri && <FlopPlayer />}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          background: "rgba(39,40,34,0.96)",
          borderRadius: 14,
          padding: "18px 22px 16px",
          boxShadow:
            "inset 0 1px 0 rgba(248,248,242,.1), inset 0 0 0 1px rgba(248,248,242,.07), 0 32px 64px -16px rgba(0,0,0,.8)",
          maxHeight: "calc(100vh - 60px)",
          overflow: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
          <b style={{ color: "#f8f8f2", fontSize: 15 }}>
            #{target.id} {target.player}
          </b>
          <span style={{ color: "#75715e", fontSize: 12 }}>
            {LEVEL_NAMES[target.level] ?? target.level} · {(target.realTime / 1000).toFixed(2)}s
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="admin_btn sm" onClick={close}>
            关闭 (Esc)
          </button>
        </div>

        <div
          className={`play_board ${target.level === "exp" ? "zoom_exp" : target.level === "int" ? "zoom_int" : "zoom_beg"}`}
          title={status === "ended" ? "点击重播" : undefined}
          onClick={() => {
            if (status === "ended") togglePlay();
          }}
        >
          <div ref={wrapRef} style={{ position: "relative" }}>
            {data ? (
              <div className={`board ${target.level} size16`}>
                <table cellPadding={0} cellSpacing={0}>
                  <tbody ref={tbodyRef}>
                    {Array.from({ length: h }, (_, y) => (
                      <tr key={y}>
                        {Array.from({ length: w }, (_, x) => (
                          <td key={x} className={`b${cells[y * w + x] ?? "b"}`} />
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ color: "#939387", padding: "60px 80px", fontSize: 13 }}>
                {!flopUri ? "录像加载中…" : "正在打开 flop 播放器…"}
              </div>
            )}
            {notice && (
              <div
                className="replay_notice"
                role="alert"
                style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)" }}
              >
                {notice}
              </div>
            )}
          </div>
          {status !== "idle" && stats && (
            <div style={{ marginTop: 8 }}>
              <AdminReplayBar status={status} stats={stats} onPause={pause} onSeek={seek} onResume={resume} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 后台精简控制条（复用 .replay_bar 样式；点击进度条 seek） */
function AdminReplayBar({
  status,
  stats,
  onPause,
  onSeek,
  onResume,
}: {
  status: Status;
  stats: ReplayStats;
  onPause: () => void;
  onSeek: (csec: number) => void;
  onResume: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const total = stats.totalCsec;
  const pct = total > 0 ? Math.max(0, Math.min(1, stats.csec / total)) : 0;
  const playing = status === "playing";
  return (
    <div className="replay_bar" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="rb_btn"
        title={playing ? "暂停" : "播放"}
        onClick={(e) => {
          e.stopPropagation();
          if (playing) onPause();
          else onResume();
        }}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M7 4.8v14.4c0 .9 1 1.45 1.76.96l9.6-7.2a1.14 1.14 0 0 0 0-1.92l-9.6-7.2A1.14 1.14 0 0 0 7 4.8z" />
          </svg>
        )}
      </button>
      <div
        className="rb_track"
        ref={trackRef}
        onPointerDown={(e) => {
          e.stopPropagation();
          const rail = trackRef.current?.querySelector<HTMLElement>(".rb_rail");
          if (!rail || total <= 0) return;
          const r = rail.getBoundingClientRect();
          const ratio = r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
          onSeek(Math.round(ratio * total));
        }}
      >
        <div className="rb_rail">
          <div className="rb_fill" style={{ width: `${pct * 100}%` }} />
          <div className="rb_thumb" style={{ left: `${pct * 100}%` }} />
        </div>
      </div>
      <span className="rb_time">
        {(stats.csec / 100).toFixed(1)}s / {(total / 100).toFixed(1)}s
      </span>
    </div>
  );
}
