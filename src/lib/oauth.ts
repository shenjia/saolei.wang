// 微信 / QQ OAuth 实现
// - 微信：开放平台「网站应用」扫码登录（snsapi_login），code → access_token + openid/unionid
// - QQ：QQ 互联 OAuth2.0，code → access_token → openid → 用户信息
// - dev mock：未配置 AppID 时返回固定测试身份，供本地开发联调绑定/注册分支

import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import type { OauthTicket } from "@/lib/auth";

const STATE_COOKIE = "saolei_oauth_state";

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

export function qqAuthorizeUrl(state: string): string {
  const redirectUri = encodeURIComponent(`${siteUrl()}/api/auth/qq/callback`);
  return (
    `https://graph.qq.com/oauth2.0/authorize?response_type=code&client_id=${process.env.QQ_APP_ID}` +
    `&redirect_uri=${redirectUri}&state=${state}`
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
