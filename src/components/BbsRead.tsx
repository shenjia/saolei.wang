// 论坛已读标记（2026-09-26 张老师要求）：点击过的主题在列表页标题变灰
// localStorage 键 bbs_read 存逗号分隔的帖子 id（只保留最近 MAX_READ 条防膨胀）
// 读取用 useSyncExternalStore：SSR/水合期返回空集（无水合警告，模式同 LoginPanel
// 的记住用户名）；写入后派发自定义事件刷新同标签页内的列表行（storage 事件只跨标签页）

"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";

const LS_KEY = "bbs_read";
/** 最多保留的已读 id 数，超出丢最旧（最早读的先忘） */
const MAX_READ = 2000;

function parseIds(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = parseInt(part, 10);
    if (n > 0) out.push(n);
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

/** 已读帖子 id 集合（Set.has 查询 O(1)；快照是字符串，memo 不怕每次新建 Set） */
export function useBbsReadSet(): Set<number> {
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
  return useMemo(() => new Set(parseIds(raw)), [raw]);
}

/** 标记已读：写 localStorage 并通知同页订阅者；异常（隐私模式等）静默降级 */
export function markBbsRead(id: number): void {
  try {
    const ids = parseIds(localStorage.getItem(LS_KEY) ?? "");
    if (ids.includes(id)) return;
    ids.push(id);
    if (ids.length > MAX_READ) ids.splice(0, ids.length - MAX_READ);
    localStorage.setItem(LS_KEY, ids.join(","));
    window.dispatchEvent(new Event("bbs-read-change"));
  } catch {
    // localStorage 不可用：仅灰显失效，不影响其他功能
  }
}

/** 详情页挂载即记录已读——覆盖从首页动态/外链直达详情页的场景 */
export function BbsReadMark({ id }: { id: number }) {
  useEffect(() => {
    markBbsRead(id);
  }, [id]);
  return null;
}
