// 小头像 URL 解析（2026-11-10 张老师需求：排行页 13px 头像改加载 20px WebP 省流量）
//
// ⚠️ 本文件必须保持「零 Node 依赖」的纯函数——它被 Cells.tsx 引用，而 Cells.tsx
// 会被客户端组件（BvRankingFeed 等）间接引用；sharp 等服务端工具一律放
// small-avatar-gen.ts（生成逻辑），否则原生模块会被打进浏览器 bundle 直接 500。
//
// 小图 URL 约定：
// - 新版上传 /uploads/avatar/xxx.jpg → /uploads/avatar/small/xxx.webp
// - 旧站照片墙（avatar="1"，实体 /images/player/{id}.jpg）→ /images/player/small/{id}.webp
// - OAuth 外链（http…）无法本地预处理，返回 null（前端用原图）
// - 缺 small/ 时前端 onError 回退原图，业务不中断

export const SMALL_AVATAR_PX = 20;

/** 头像三类来源中，只有本地文件能做小图；返回小图 URL，不适用返回 null */
export function smallAvatarUrlFor(avatar: string, uid: number): string | null {
  // 新版上传：/uploads/avatar/xxx.jpg → /uploads/avatar/small/xxx.webp
  if (avatar.startsWith("/uploads/avatar/")) {
    const base = avatar.slice("/uploads/avatar/".length);
    return `/uploads/avatar/small/${base.replace(/\.[^.]+$/, "")}.webp`;
  }
  // 旧站照片墙：avatar === "1"，实体 /images/player/{id}.jpg
  // → /images/player/small/{id}.webp
  if (avatar === "1") {
    return `/images/player/small/${uid}.webp`;
  }
  return null; // OAuth 外链 / 无头像：不适用
}
