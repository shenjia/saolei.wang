"use client";

// 称号体系上下文（2026-10-17 Phase 5 双体系）
// layout（RSC）解析观看者偏好（user_info.title_pref）后注入；
// TitleBadge 等客户端组件按体系自行切换徽章/彩字渲染。
// thunderKingId：当前雷界第一人（旧体系「雷帝」实时判 TOP1，服务端算好随 context 下发）

import { createContext, useContext } from "react";
import type { TitleSystem } from "@/lib/title-system";

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
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 当前观看者的称号体系（未登录/未设置 → 'm' 军衔制） */
export function useTitleSystem(): TitleSystemCtx {
  return useContext(Ctx);
}
