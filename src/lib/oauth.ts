// 微信 / QQ OAuth 实现
// - 微信：开放平台「网站应用」扫码登录（snsapi_login），code → access_token + openid/unionid
// - QQ：QQ 互联 OAuth2.0，code → access_token → openid → 用户信息
// - dev mock：未配置 AppID 时返回固定测试身份，供本地开发联调绑定/注册分支

import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import type { OauthTicket } from "@/lib/auth";

const STATE_COOKIE = "saolei_oauth_state";
// 弹窗登录标记（2026-10-25 企鹅图标弹窗交互）：入口 ?popup=1 时种下，
// 回调消费后改输出「关窗 + 主窗跳转」页而非 302
const POPUP_COOKIE = "saolei_oauth_popup";

export function siteUrl(): string {
  return process.env.SITE_URL ?? "http://localhost:3000";
}

// ---------- state 防 CSRF ----------

export async function issueState(): Promise<string> {
  const state = randomBytes(16).toString("hex");
  const jar = await cookies();
  jar.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
    secure: process.env.NODE_ENV === "production",
  });
  return state;
}

export async function checkState(state: string | null): Promise<boolean> {
  const jar = await cookies();
  const saved = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE);
  return !!state && !!saved && state === saved;
}

// ---------- 弹窗登录标记 ----------

// 入口路由调用：popup 时种标记；非弹窗入口顺手清掉残留标记
// （用户开过弹窗没走完流程又去点普通入口时，防止普通登录被误关窗）。
// next：授权成功后主窗口的回跳地址（如账户管理页发起的绑定 → /account），
// 直接编码进 cookie 值（格式 "1" 或 "1<next>"），仅放行站内路径。
export async function markPopup(popup: boolean, next?: string): Promise<void> {
  const jar = await cookies();
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "";
  if (popup) {
    jar.set(POPUP_COOKIE, `1${safeNext}`, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
      secure: process.env.NODE_ENV === "production",
    });
  } else {
    jar.delete(POPUP_COOKIE);
  }
}

// 回调路由调用：读取并清除标记。popup=false 表示非弹窗流程
export async function consumePopup(): Promise<{ popup: boolean; next: string }> {
  const jar = await cookies();
  const v = jar.get(POPUP_COOKIE)?.value ?? "";
  if (v) jar.delete(POPUP_COOKIE);
  const popup = v.startsWith("1");
  return { popup, next: popup ? v.slice(1) : "" };
}

// 弹窗内的收尾页：把最终去向交给主窗口后自闭；无 opener（直接打开/移动端新标签页）时自跳
export function popupClosePage(target: string): string {
  const t = JSON.stringify(target);
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>QQ 登录</title></head>` +
    `<body style="background:#272822;color:#b1b1a4;font:13px/1.8 sans-serif;text-align:center;padding-top:80px">` +
    `<p id="tip">正在完成登录…</p>` +
    `<script>var t=${t};` +
    `if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();` +
    `document.getElementById("tip").textContent="登录完成，本窗口将自动关闭";}` +
    `else{location.replace(t);}</script>` +
    `</body></html>`
  );
}

// ---------- 配置与 mock ----------

export function wechatConfigured(): boolean {
  return !!(process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET);
}

export function qqConfigured(): boolean {
  return !!(process.env.QQ_APP_ID && process.env.QQ_APP_KEY);
}

// dev mock 身份：mock 页按钮的 code 为 mock_wechat / mock_wechat_2 / mock_qq_3 等
// 编号变体用于测试多个不同身份（绑定 / 注册 / 直接登录分支）
function mockTicket(provider: "wechat" | "qq", code: string): OauthTicket {
  const prefix = `mock_${provider}`;
  if (!code.startsWith(prefix)) throw new Error("非法的 mock code");
  const suffix = code.slice(prefix.length); // "" | "_2" | "_3" ...
  const n = suffix === "" ? "001" : suffix.slice(1).padStart(3, "0");
  return {
    provider,
    openid: `${prefix}_openid_${n}`,
    unionid: provider === "wechat" ? `${prefix}_unionid_${n}` : "",
    nickname: `${provider === "wechat" ? "微信" : "QQ"}测试用户${suffix || ""}`,
    avatar: "",
  };
}

// ---------- 微信 ----------

export function wechatQrUrl(state: string): string {
  const redirectUri = encodeURIComponent(`${siteUrl()}/api/auth/wechat/callback`);
  return (
    `https://open.weixin.qq.com/connect/qrconnect?appid=${process.env.WECHAT_APP_ID}` +
    `&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`
  );
}

async function exchangeWechat(code: string): Promise<OauthTicket> {
  const tokenRes = await fetch(
    `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${process.env.WECHAT_APP_ID}` +
      `&secret=${process.env.WECHAT_APP_SECRET}&code=${code}&grant_type=authorization_code`,
    { cache: "no-store" }
  ).then((r) => r.json());
  if (!tokenRes.openid) throw new Error(`微信 token 换取失败: ${JSON.stringify(tokenRes)}`);

  const info = await fetch(
    `https://api.weixin.qq.com/sns/userinfo?access_token=${tokenRes.access_token}&openid=${tokenRes.openid}`,
    { cache: "no-store" }
  ).then((r) => r.json());

  return {
    provider: "wechat",
    openid: tokenRes.openid,
    unionid: tokenRes.unionid ?? "",
    nickname: info.nickname ?? "",
    avatar: info.headimgurl ?? "",
  };
}

// ---------- QQ ----------

export function qqAuthorizeUrl(state: string, display?: "pc"): string {
  const redirectUri = encodeURIComponent(`${siteUrl()}/api/auth/qq/callback`);
  return (
    `https://graph.qq.com/oauth2.0/authorize?response_type=code&client_id=${process.env.QQ_APP_ID}` +
    `&redirect_uri=${redirectUri}&state=${state}` +
    // display=pc：弹窗小版式授权页（graph.qq.com/oauth2.0/show?which=Login 那种紧凑窗口）
    (display ? `&display=${display}` : "")
  );
}

async function exchangeQq(code: string): Promise<OauthTicket> {
  const redirectUri = encodeURIComponent(`${siteUrl()}/api/auth/qq/callback`);
  const tokenRes = await fetch(
    `https://graph.qq.com/oauth2.0/token?grant_type=authorization_code&client_id=${process.env.QQ_APP_ID}` +
      `&client_secret=${process.env.QQ_APP_KEY}&code=${code}&redirect_uri=${redirectUri}&fmt=json`,
    { cache: "no-store" }
  ).then((r) => r.json());
  if (!tokenRes.access_token) throw new Error(`QQ token 换取失败: ${JSON.stringify(tokenRes)}`);

  const me = await fetch(
    `https://graph.qq.com/oauth2.0/me?access_token=${tokenRes.access_token}&fmt=json`,
    { cache: "no-store" }
  ).then((r) => r.json());
  if (!me.openid) throw new Error(`QQ openid 获取失败: ${JSON.stringify(me)}`);

  const info = await fetch(
    `https://graph.qq.com/user/get_user_info?access_token=${tokenRes.access_token}` +
      `&oauth_consumer_key=${process.env.QQ_APP_ID}&openid=${me.openid}`,
    { cache: "no-store" }
  ).then((r) => r.json());

  return {
    provider: "qq",
    openid: me.openid,
    unionid: "",
    nickname: info.nickname ?? "",
    avatar: info.figureurl_qq_2 ?? info.figureurl_qq_1 ?? "",
  };
}

// ---------- 统一入口 ----------

export async function exchangeCode(provider: "wechat" | "qq", code: string): Promise<OauthTicket> {
  // dev mock：未配置密钥时只接受 mock_ 前缀的 code，防止伪造
  if (provider === "wechat" && !wechatConfigured()) return mockTicket("wechat", code);
  if (provider === "qq" && !qqConfigured()) return mockTicket("qq", code);
  return provider === "wechat" ? exchangeWechat(code) : exchangeQq(code);
}
