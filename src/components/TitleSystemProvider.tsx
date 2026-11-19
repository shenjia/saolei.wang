"use client";

// 称号体系上下文（2026-10-17 Phase 5 双体系；2026-10-18 张老师定：未登录也可切换）
// - 服务端：layout 按登录用户 user_info.title_pref 解析注入（默认 'm'）
// - 客户端：localStorage("title_pref") 覆盖——未登录玩家的偏好存本地设备；
//   登录玩家切换时双写（库 + localStorage），其他设备按库、本设备即时生效
// - TitleBadge 按最终体系渲染：'c' 且有 classic 备选 → 2008 版彩字，否则军衔徽章
// thunderKingId：当前雷界第一人（旧体系「雷帝」实时判 TOP1，服务端算好随 context 下发）
//
// localStorage 读取走 useSyncExternalStore：SSR/首次 hydration 用服务端值
// （无闪烁不一致警告），此后按本地存储值重渲染；setLocalTitleSystem 切换后
// dispatchEvent 通知全部订阅者（同页多处 TitleBadge 即时同步切换）。

import { createContext, useContext, useSyncExternalStore } from "react";
import type { TitleSystem } from "@/lib/title-system";

const LS_KEY = "title_pref";
const LS_EVENT = "title-pref-change";

function subscribe(cb: () => void): () => void {
  window.addEventListener(LS_EVENT, cb);
  window.addEventListener("storage", cb); // 多标签页同步
  return () => {
    window.removeEventListener(LS_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

function getSnapshot(): string | null {
  try {
    return window.localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

function getServerSnapshot(): string | null {
  return null; // SSR 不读 localStorage（hydration 与服务端一致）
}

export interface TitleSystemCtx {
  system: TitleSystem;
  /** 雷界第一人 user id（0=无人）——旧体系判「雷帝」用 */
  thunderKingId: number;
}

const Ctx = createContext<TitleSystemCtx>({ system: "m", thunderKingId: 0 });

export function TitleSystemProvider({
  value,
  children,
}: {
  value: TitleSystemCtx;
  children: React.ReactNode;
}) {
  // 本地覆盖优先（'c'/'m' 之外忽略）；无本地值时回落服务端值（登录用户库内偏好）
  const local = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const system: TitleSystem = local === "c" || local === "m" ? local : value.system;
  return <Ctx.Provider value={{ ...value, system }}>{children}</Ctx.Provider>;
}

/** 当前观看者的称号体系（未登录/未设置 → 'm' 军衔制） */
export function useTitleSystem(): TitleSystemCtx {
  return useContext(Ctx);
}

/** 客户端直改体系（TitlePrefSwitch 用）：写 localStorage 并广播，全部订阅处即时生效 */
export function setLocalTitleSystem(s: TitleSystem): void {
  try {
    window.localStorage.setItem(LS_KEY, s);
  } catch {
    /* 忽略存储失败 */
  }
  window.dispatchEvent(new Event(LS_EVENT));
}
