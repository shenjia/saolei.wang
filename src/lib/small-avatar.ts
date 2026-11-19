// 头像多档尺寸 URL 解析（2026-11-10 张老师需求：全站图片 WebP 化省流量）
//
// ⚠️ 本文件必须保持「零 Node 依赖」的纯函数——它被 Cells.tsx 引用，而 Cells.tsx
// 会被客户端组件（BvRankingFeed 等）间接引用；sharp 等服务端工具一律放
// small-avatar-gen.ts（生成逻辑），否则原生模块会被打进浏览器 bundle 直接 500。
//
// 尺寸档位（覆盖 retina 2x）：
//   small 20px  → 排行页 13px、论坛列表 16px
//   mid   160px → 顶栏 28/30px、用户卡片/VS 页 72px
//   big   360px → 每日之星 144px、个人主页 162px
// 新头像三生效入口 + 批处理脚本都会把三档一次生成齐。
//
// URL 约定：
// - 新版上传 /uploads/avatar/xxx.jpg → /uploads/avatar/{size}/xxx.webp
// - 旧站照片墙（avatar="1"，实体 /images/player/{id}.jpg）→ /images/player/{size}/{id}.webp
// - OAuth 外链（http…）无法本地预处理，返回 null（前端用原图）
// - 缺档时前端 onError 回退原图，业务不中断

export const SMALL_AVATAR_PX = 20;
export const MID_AVATAR_PX = 160;
export const BIG_AVATAR_PX = 360;

export type AvatarSize = "small" | "mid" | "big";

export const AVATAR_SIZE_PX: Record<AvatarSize, number> = {
  small: SMALL_AVATAR_PX,
  mid: MID_AVATAR_PX,
  big: BIG_AVATAR_PX,
};

/** 兼容旧名（排行页在用）：小图 URL */
export function smallAvatarUrlFor(avatar: string, uid: number): string | null {
  return avatarUrlFor(avatar, uid, "small");
}

/** 头像三类来源中，只有本地文件能做多档尺寸；返回该档 WebP URL，不适用返回 null */
export function avatarUrlFor(avatar: string, uid: number, size: AvatarSize): string | null {
  // 新版上传：/uploads/avatar/xxx.jpg → /uploads/avatar/{size}/xxx.webp
  if (avatar.startsWith("/uploads/avatar/")) {
    const base = avatar.slice("/uploads/avatar/".length);
    return `/uploads/avatar/${size}/${base.replace(/\.[^.]+$/, "")}.webp`;
  }
  // 旧站照片墙：avatar === "1"，实体 /images/player/{id}.jpg
  // → /images/player/{size}/{id}.webp
  if (avatar === "1") {
    return `/images/player/${size}/${uid}.webp`;
  }
  return null; // OAuth 外链 / 无头像：不适用
}
