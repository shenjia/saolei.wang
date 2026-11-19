// APP 授权页（2026-11-12 元扫雷上传）：APP 打开本页（调起系统浏览器，
// 用户浏览器内已有登录态）→ 点「允许」→ 签发 90 天 Bearer token（token 明文
// 仅授权响应可见一次）→ 复制粘贴进 APP 设置，或 deep link 唤起 APP 自动收取。
// URL：/connect?app=meta（app 注册制见 lib/connect-apps.ts，scheme 白名单防抢注）
// 密码永远只在雷网自己的页面输入，第三方 APP 只接触短寿命 token。
//
// 设备授权流（2026-11-12，张老师方案）：/connect?app=meta&code=cs-…（APP 调
// /api/public/v1/connect/start 拿 code 后拼出）。用户点「允许」只置会话状态，
// token 由 APP 轮询 poll 拉取——本页无需展示令牌，点完「允许」显示
// 「请回到 APP」→ 每 3 秒自查 poll_status，APP 拉取成功后显示绑定完成。
// 异地发起警告：会话 client_ip 与页面访问 IP 不一致时提示（防钓鱼转发 code）。

import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { findConnectApp } from "@/lib/connect-apps";
import { findConnectSession } from "@/lib/connect-session";
import { ConnectAuthorize } from "@/components/ConnectAuthorize";
import { UserPanel } from "@/components/UserCard";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const app = findConnectApp(sp.app);
  return { title: app ? `授权${app.name}` : "应用授权" };
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const app = findConnectApp(sp.app);

  // 未登录 → 登录后带回跳（登录页 next 只放行站内路径，/connect?app=… 合法）
  const session = await getSession();
  const query = sp.app ? `app=${encodeURIComponent(sp.app)}` : "";
  const codeQuery = sp.code ? `&code=${encodeURIComponent(sp.code)}` : "";
  const loginNext = `/account/login?next=${encodeURIComponent(`/connect?${query}${codeQuery}`)}`;
  if (!session) redirect(loginNext);

  // 本站账户名（老账号无 user_auth 行回退中文名，与公开 API / openms 口径一致）
  const [auth, urow] = await Promise.all([
    prisma.userAuth.findUnique({ where: { id: session.uid }, select: { username: true } }),
    prisma.user.findUnique({ where: { id: session.uid }, select: { chineseName: true } }),
  ]);
  const myName = auth?.username ?? urow?.chineseName ?? "";

  // 设备授权流：查会话初始状态 + 异地发起检测（仅 status=0 待授权时展示警告）
  let deviceStatus: number | null = null;
  let ipMismatch = false;
  let invalidCode = false;
  if (sp.code) {
    if (!app) {
      invalidCode = true;
    } else {
      const row = await findConnectSession(sp.code);
      if (!row || row.appKey !== app.key) {
        invalidCode = true;
      } else {
        deviceStatus = row.status;
        if (row.status === 0 && row.clientIp) {
          const h = await headers();
          const pageIp =
            h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip")?.trim() ?? "";
          // 非同名即警告（不阻断）：同一台机器浏览器与插件轮询通常同出口 IP
          if (pageIp && pageIp !== row.clientIp) ipMismatch = true;
        }
      }
    }
  }

  return (
    <div id="page" className="two_columns">
      <ul id="account_connect">
        <li className="main">
          <div className="box">
            <div className="nav">
              <h1>应用授权</h1>
              <ul className="email_back">
                <li>
                  <Link href="/account">返回</Link>
                </li>
              </ul>
            </div>
            <hr />

            {invalidCode ? (
              <p className="error">
                授权请求不存在或已过期（10 分钟内有效），请回到 APP 内重新发起授权。
              </p>
            ) : app ? (
              <ConnectAuthorize
                app={app}
                username={myName}
                code={sp.code}
                deviceStatus={deviceStatus}
                ipMismatch={ipMismatch}
              />
            ) : (
              <p className="error">未知的授权目标应用（app 参数缺失或未登记），请从正规 APP 内发起授权。</p>
            )}
          </div>
        </li>
        <li className="sidebar">
          <UserPanel userId={session.uid} cardId="connect_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
