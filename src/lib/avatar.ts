// 头像 URL 统一解析（2026-09-24，配合「点击上传头像 + AI 审核」新功能）
//
// user.avatar（Char(255)）取值约定——历史遗留 + 新版上传混用：
//   "/uploads/avatar/xxx.jpg" → 新版用户上传，AI 审核通过后写入（本功能新增）
//   "http..."                 → 微信/QQ OAuth 外链头像
//   "1" / "0" / ""            → 旧站迁移标记位，实体照片另在 /images/player/{id}.jpg
//
// 默认图历史上各页不一致（信息卡片用 /images/player/no.jpg、个人页用
// /images/common/avatar.png），这里由调用方传 fallback 原样保留，不做视觉改动。

/** 新版上传头像的存储路径前缀（相对 public/） */
export const AVATAR_UPLOAD_PREFIX = "/uploads/avatar/";

/** 头像审核状态：0 驳回 / 10 待审 / 20 通过 */
export const AVATAR_REVIEW_STATUS = {
  REJECTED: 0,
  PENDING: 10,
  APPROVED: 20,
} as const;

export const AVATAR_STATUS_NAMES: Record<number, string> = {
  [AVATAR_REVIEW_STATUS.REJECTED]: "已驳回",
  [AVATAR_REVIEW_STATUS.PENDING]: "待审核",
  [AVATAR_REVIEW_STATUS.APPROVED]: "已通过",
};

/** AI 初审分类的中文名（管理后台展示用） */
export const AVATAR_CATEGORY_NAMES: Record<string, string> = {
  ok: "正常",
  porn: "色情低俗",
  politics: "涉政敏感",
  nonreal: "非真人照片",
};

/** 是否为新版上传的头像路径 */
export function isUploadedAvatar(avatar: string): boolean {
  return avatar.startsWith(AVATAR_UPLOAD_PREFIX);
}

/**
 * 解析 user.avatar 得到可展示的头像 URL。
 * @param avatar   user.avatar 原始值
 * @param fallback 旧站标记位（"1"/"0"/""）时使用的兜底图，由调用方按页面历史习惯给
 */
export function resolveAvatarUrl(avatar: string, fallback: string): string {
  if (isUploadedAvatar(avatar)) return avatar;
  if (avatar.startsWith("http")) return avatar;
  return fallback;
}
