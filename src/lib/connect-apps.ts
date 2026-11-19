// /connect 授权页 · 可接入 APP 注册表（2026-11-12 元扫雷上传授权）
//
// APP 打开 https://saolei.wang/connect?app=<key> → 用户在网页登录态点「允许」→
// 签发 90 天 Bearer token（UserToken 表）→ 页面显示 token（复制粘贴进 APP）
// + 尝试 deep link 回跳 <scheme>://auth?token=... 自动唤起 APP 收取。
//
// scheme 白名单制（防抢注钓鱼）：只有本表登记的 app 才会自动回跳；
// 未登记的 app 走纯复制模式。元扫雷 APP 端需注册同款自定义 URL scheme。

export interface ConnectApp {
  /** ?app= 参数值 */
  key: string;
  /** 展示名 */
  name: string;
  /** 自定义 URL scheme（不含 ://）；空 = 无回跳，纯复制模式 */
  scheme: string;
  /** 授权后将获得的权限文案（页面对用户逐条展示） */
  permissions: string[];
  /** 授权 token 有效期（秒） */
  tokenTtl: number;
}

/** 元扫雷（张老师开发维护的扫雷客户端 APP，evf 录像产出端） */
const META_APP: ConnectApp = {
  key: "meta",
  name: "元扫雷",
  scheme: "metasweeper", // APP 端注册 metasweeper:// scheme（与下载包 Metasweeper 同名）；如改名同步改这里
  permissions: ["以您的身份向扫雷网上传录像"],
  tokenTtl: 90 * 24 * 3600,
};

export const CONNECT_APPS: ConnectApp[] = [META_APP];

export function findConnectApp(key: string | undefined): ConnectApp | null {
  if (!key) return null;
  return CONNECT_APPS.find((a) => a.key === key) ?? null;
}
