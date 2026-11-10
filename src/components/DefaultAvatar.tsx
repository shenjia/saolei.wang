"use client";

// 军衔制默认头像（2026-11-11 张老师定）：无头像用户在军衔制下按性别显示军装剪影
// （男 /images/player/male.*、女 /images/player/female.*），
// 旧版称号（人神界体系）观看者仍看统一默认图 no.jpg（问号头像）。
//
// 加载策略与全站头像一致（2026-11-11 张老师定）：按展示位加载对应档 WebP
// （small 20 / mid 160 / big 360），档位缺失时 onError 回退原图 PNG（AvatarImg 链路）。
//
// 独立客户端组件的原因：默认头像跟随观看者称号体系（TitleSystemProvider 上下文，
// localStorage 可覆盖服务端值），与 TitleBadge 同一模式——SSR 按服务端体系渲染
// （默认军衔制），未登录 classic 用户 hydration 后即时切换；切换偏好后无需刷新。
// 页面缓存友好：服务端 HTML 不依赖观看者偏好差异，不需要按人失效任何缓存。

import { useTitleSystem } from "./TitleSystemProvider";
import { DEFAULT_AVATAR, defaultAvatarFor, defaultAvatarSizedFor } from "@/lib/avatar";
import type { AvatarSize } from "@/lib/small-avatar";
import { AvatarImg } from "./AvatarImg";

export function DefaultAvatar({
  sex,
  size = "mid",
  className,
  alt = "",
}: {
  /** 用户性别（1=男 0=女，user.sex 同口径） */
  sex: number;
  /** 展示档位：small 20px（列表）/ mid 160px（卡片·顶栏 72px 内）/ big 360px（144-162px 位） */
  size?: AvatarSize;
  className?: string;
  alt?: string;
}) {
  const { system } = useTitleSystem();
  if (system !== "m") {
    // 人神界（旧版称号）：问号头像，无档位（与历史行为一致）
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={DEFAULT_AVATAR} alt={alt} />;
  }
  // 军衔制：按展示位加载对应档 WebP，缺失回退原图（与上传头像同一回退语义）
  return (
    <AvatarImg
      src={defaultAvatarSizedFor(sex, size)}
      fallback={defaultAvatarFor(sex)}
      className={className ?? ""}
      alt={alt}
    />
  );
}
