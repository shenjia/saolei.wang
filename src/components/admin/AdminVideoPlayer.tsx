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
  onClose,
  onWatched,
}: {
  target: AdminPlayerTarget | null;
  /** 保留既有调用方签名；关闭由 Flop Player 的 X / Esc / 暗区统一处理 */
  onClose: () => void;
  /** markWatched 落库成功后回调（列表即时把该行按钮置「已看」，2026-10-27） */
  onWatched?: (id: number) => void;
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
    /* ⚠️ 带时间戳穿透缓存（2026-10-27，347943 案）：站内生成的 evf 可能被服务端
       原地修补（时间倒流钳制），而 nginx 对 /videos/ 下发 30d 缓存——审核播放必须
       拿到磁盘上的当前版本，不能用浏览器里的陈旧副本。后台量小，全量穿透可接受。 */
    playFlop(`/videos${target.filepath}?t=${Date.now()}`);
    // 打开审核播放即记「已观看」，上报成功回调列表即时刷新「已看」态；
    // 失败不打扰播放（刷新页面后 watched 仍以库内为准）。
    const watched = target.id;
    void postOp("video.markWatched", { id: watched })
      .then((res) => {
        if (res.ok) onWatched?.(watched);
      })
      .catch(() => undefined);
  }, [mounted, target, onWatched]);

  // 首次打开后 iframe 常驻，后续 target 变化直接复用； flop 自带未就绪补播队列。
  if (!mounted) return null;
  return createPortal(<FlopPlayer />, document.body);
}
