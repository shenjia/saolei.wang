"use client";

// 全站人名气泡第二行（2026-11-05 张老师要求：气泡在「#ID 姓名 英文名」下加最近活跃状态）。
// 客户端懒加载方案：PlayerTip 全站 31 处调用点零改动自动获得第二行；
// 同页所有 ActLine 在挂载后 40ms 内合并成一次 /api/user/activity 批量请求，
// 结果进模块级 cache（跨组件/跨页内存复用）。排行榜榜内走服务端直传（act prop），
// 不经过本组件，不产生额外请求。

import { useEffect, useState } from "react";

interface Act {
  act: number;
  tip: string;
}

const cache = new Map<number, Act>();
const subs = new Map<number, Set<(a: Act) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;

function subscribe(uid: number, cb: (a: Act) => void): () => void {
  let set = subs.get(uid);
  if (!set) {
    set = new Set();
    subs.set(uid, set);
  }
  set.add(cb);
  if (!timer) timer = setTimeout(flush, 40); // 收集窗口：同页组件同批
  return () => {
    set.delete(cb);
    if (!set.size) subs.delete(uid);
  };
}

async function flush() {
  timer = null;
  const ids = [...subs.keys()];
  if (!ids.length) return;
  try {
    const res = await fetch(`/api/user/activity?ids=${ids.join(",")}`, { cache: "no-store" });
    if (!res.ok) return; // 失败静默：第二行属增强信息，下次挂载重试
    const data = (await res.json()) as Record<string, Act>;
    for (const [k, v] of Object.entries(data)) {
      const uid = Number(k);
      if (!Number.isFinite(uid) || !v || typeof v.act !== "number" || !v.tip) continue;
      cache.set(uid, v);
      subs.get(uid)?.forEach((cb) => cb(v));
      subs.delete(uid);
    }
  } catch {
    /* 网络异常静默 */
  }
}

/** 气泡第二行：`（已2月未登录）` 等，颜色类名 act_N 与排行榜标记同套 */
export function ActLine({ uid }: { uid: number }) {
  const [info, setInfo] = useState<Act | null>(() => cache.get(uid) ?? null);
  useEffect(() => {
    if (uid <= 0) return; // 外部玩家/缺省 id 不显示
    const c = cache.get(uid);
    if (c) {
      setInfo(c);
      return;
    }
    return subscribe(uid, setInfo);
  }, [uid]);
  if (!info) return null;
  return (
    <span className={`pt_act act_${info.act}`}>（{info.tip}）</span>
  );
}
