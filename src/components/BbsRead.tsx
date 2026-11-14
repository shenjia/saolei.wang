// 论坛已读标记（2026-09-26 张老师要求）：点击过的主题在列表页标题变灰
// 2026-11-14 升级：记录从「裸 id」升级为「id:点击时刻的 lastReplyTime 快照」——
// 渲染时帖子 lastReplyTime 超过快照值即视为未读（复亮）。至此口径为：
// 点过且其后没有新回复 → 暗灰；点过但来了新回复 → 恢复亮灰（未读）。
// 论坛列表页（BbsFeed）与首页论坛新贴（BbsLatest）共用本模块，口径一致。
// 兼容迁移：旧格式逗号分隔裸 id 读取时按 time=0 迁移（视为永久已读，老行为不变）。
// localStorage 键 bbs_read 存逗号分隔的 id:time 片段（只保留最近 MAX_READ 条防膨胀）
// 读取用 useSyncExternalStore：SSR/水合期返回空集（无水合警告，模式同 LoginPanel
// 的记住用户名）；写入后派发自定义事件刷新同标签页内的列表行（storage 事件只跨标签页）

"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { BbsPostItem } from "@/lib/bbs";

const LS_KEY = "bbs_read";
/** 最多保留的已读记录数，超出丢最旧（最早读的先忘） */
const MAX_READ = 2000;

/** 解析 bbs_read 存储串 → id → 点击时刻 lastReplyTime（秒；旧版裸 id 记录 = 0） */
function parseRaw(raw: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const part of raw.split(",")) {
    const m = part.match(/^(\d+):(\d+)$/);
    if (m) {
      out.set(parseInt(m[1], 10), parseInt(m[2], 10));
      continue;
    }
    // 旧格式裸 id（2026-11-14 前）：迁移为 time=0（永久已读，老行为不变）
    const n = parseInt(part, 10);
    if (n > 0) out.set(n, 0);
  }
  return out;
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener("bbs-read-change", onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener("bbs-read-change", onChange);
  };
}

/** 已读快照集：key = 帖子 id，value = 点击时刻的 lastReplyTime（秒） */
export type BbsReadMap = Map<number, number>;

export function useBbsReadMap(): BbsReadMap {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return localStorage.getItem(LS_KEY) ?? "";
      } catch {
        return "";
      }
    },
    () => ""
  );
  return useMemo(() => parseRaw(raw), [raw]);
}

/** 是否「已读且读后无新回复」（暗灰判定）：lastReplyTime 超过点击时刻快照 = 有新回复，视同未读复亮 */
export function isBbsRead(readMap: BbsReadMap, id: number, lastReplyTime: number): boolean {
  const t = readMap.get(id);
  return t !== undefined && lastReplyTime <= t;
}

/** 已读后标题保持亮灰不变的帖子（2026-10-23 张老师：取消高亮后口径统一）——
 *  公告（board=0）与精华（isNice）已读后标题降至亮灰 #bbbbbb，不随已读降暗灰，
 *  与原「公告/高亮帖已读」规则同语义，仅换载体类名 */
export function isBbsKeep(p: Pick<BbsPostItem, "board" | "isNice">): boolean {
  return p.board === 0 || p.isNice;
}

/** 标记已读：记录点击时刻的 lastReplyTime 快照，写 localStorage 并通知同页订阅者；
 *  异常（隐私模式等）静默降级。同帖重复点击按更晚的 lastReplyTime 覆盖（刷新 recency） */
export function markBbsRead(id: number, lastReplyTime: number): void {
  try {
    const map = parseRaw(localStorage.getItem(LS_KEY) ?? "");
    if ((map.get(id) ?? -1) >= lastReplyTime) return; // 已有同刻或更新的记录，无需写
    map.delete(id); // 先删再插，保持 Map 插入序 = 最近读在后（淘汰从头丢最旧）
    map.set(id, lastReplyTime);
    if (map.size > MAX_READ) {
      const excess = map.size - MAX_READ;
      let dropped = 0;
      for (const k of map.keys()) {
        map.delete(k);
        if (++dropped >= excess) break;
      }
    }
    localStorage.setItem(
      LS_KEY,
      [...map].map(([k, v]) => `${k}:${v}`).join(",")
    );
    window.dispatchEvent(new Event("bbs-read-change"));
  } catch {
    // localStorage 不可用：仅灰显失效，不影响其他功能
  }
}

/** 详情页挂载即记录已读（带 lastReplyTime 快照）——覆盖从首页动态/外链直达详情页的场景 */
export function BbsReadMark({ id, lastReplyTime }: { id: number; lastReplyTime: number }) {
  useEffect(() => {
    markBbsRead(id, lastReplyTime);
  }, [id, lastReplyTime]);
  return null;
}
