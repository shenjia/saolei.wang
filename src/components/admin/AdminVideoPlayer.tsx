"use client";

// 管理后台 · 待审队列全屏回放播放器（2026-10-19 张老师需求：点列表「时间」弹层看录像）
//
// 2026-10-22 改版（张老师需求：后台审核播放器复用前台全屏播放器）：
// 弃自造弹窗（ban_overlay 深色卡片 + 手写棋盘表 + 简化控制条），改挂前台
// VideoReplay 的 ReplayFullscreen（standalone 模式）——练习页同款游戏窗
// （银框+LED 计数条+笑脸）、左侧数据统计面板、滚轮缩放、拖拽进度条，
// 前台 / 后台同一套播放器 UI 与引擎口径（flop 官方状态机）。
//
// 本组件职责收窄为「数据 + 兜底」：fetch 录像文件 → parseReplayData →
// fsData 交 ReplayFullscreen（就绪即自动开播，引擎直挂 FS 棋盘）；
// rmv / 解析失败 → flop 播放器兜底（同前台策略）；文件拉取失败 → 关层 + toast。
// 防盲审口径不变：播放器内看过即 markWatched（静默，失败不打扰）。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FlopSprites } from "../FlopSprites";
import { FlopPlayer, playFlop } from "../FlopPlayer";
import { parseReplayData, ReplayFullscreen, type ReplayData } from "../VideoReplay";
import { postOp } from "./AdminAction";
import { toast } from "@/components/Toast";
import type { VideoLevel } from "@/lib/config";

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
  /** 解析产物就绪后交 ReplayFullscreen（引擎就绪即自动开播） */
  const [data, setData] = useState<ReplayData | null>(null);
  const [flopUri, setFlopUri] = useState<string | null>(null);

  /* Esc 关闭（flop 兜底播放器自己也有 Esc；这里管 standalone 层） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* flop 兜底：iframe 就绪后播 */
  useEffect(() => {
    if (flopUri && window.flop) playFlop(flopUri);
  }, [flopUri]);

  /* 打开即加载文件（弹层本身就是「我要看这盘」的意图） */
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
        // 在播放器里看过即算「已观看」（2026-10-19 防盲审口径扩展）：
        // 静默上报，失败不打扰播放（下载过的本来就有 downloads 计数）
        void postOp("video.markWatched", { id: target.id }).catch(() => undefined);
      } catch {
        if (!alive) return;
        toast("录像文件加载失败（可能已缺失），请改用「文件」下载兜底", "error");
        onClose();
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  return (
    <>
      {/* standalone 全屏回放层（前台同一套 UI）；rmv/解析失败前先撑着空盘，
          flop 兜底触发时这层仍在（遮罩+标题），flop iframe（z 9999）盖其上播放 */}
      <ReplayFullscreen
        standalone
        level={target.level}
        boardId={target.id}
        boardStr={"b".repeat(dims(target.level))}
        fsData={data}
        onExit={onClose}
        header={
          <>
            <span className="vprfs_title">
              #{target.id} {target.player} · {LEVEL_NAMES[target.level] ?? target.level} ·{" "}
              {(target.realTime / 1000).toFixed(2)}s
            </span>
            <button type="button" className="admin_btn sm" onClick={onClose}>
              关闭 (Esc)
            </button>
          </>
        }
      />
      {flopUri && <FlopPlayer />}
    </>
  );
}

/** 级别 → 格子数（boardStr 长度；standalone 空盘骨架） */
function dims(level: string): number {
  const n = level === "beg" ? 8 * 8 : level === "int" ? 16 * 16 : 30 * 16;
  return n;
}
