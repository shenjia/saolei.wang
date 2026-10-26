"use client";

// 管理后台 · 录像审核播放器
// 2026-10-26 起所有格式统一交给 Flop Player，不再先走前台自研解析/回放。
// 两个后台列表的所有直接播放入口都汇聚到本组件；每次 target 变化即重新起播，
// 同一录像关闭后再次点击也会生成新 target，可正常反复进入。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FlopPlayer, playFlop } from "../FlopPlayer";
import { postOp } from "./AdminAction";
import type { VideoLevel } from "@/lib/config";

export interface AdminPlayerTarget {
  id: number;
  level: VideoLevel;
  /** video_info.filepath（/2026/01/05/xxx.mvf 形态） */
  filepath: string;
  /** 库内权威用时 ms（列表展示保留；Flop Player 从文件读取播放数据） */
  realTime: number;
  /** 玩家名（列表展示保留） */
  player: string;
}

export function AdminVideoPlayer({
  target,
}: {
  target: AdminPlayerTarget | null;
  /** 保留既有调用方签名；关闭由 Flop Player 的 X / Esc / 暗区统一处理 */
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  /* rAF 异步置位，避免 effect 内同步 setState 级联渲染 */
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    // 等 iframe 挂载后再起播：页面刚打开就首点播放时，不能让请求早于
    // FlopPlayer 的 window.flop 初始化而丢失。
    if (!mounted || !target) return;
    playFlop(`/videos${target.filepath}`);
    // 打开审核播放即记「已观看」，上报失败不打扰播放。
    void postOp("video.markWatched", { id: target.id }).catch(() => undefined);
  }, [mounted, target]);

  // 首次打开后 iframe 常驻，后续 target 变化直接复用； flop 自带未就绪补播队列。
  if (!mounted) return null;
  return createPortal(<FlopPlayer />, document.body);
}
