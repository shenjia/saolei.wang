// 扫码后未绑定任何账号：认领老账号 或 注册新账号
// 依赖 OAuth 临时票据（10 分钟有效），无票据回登录页重新扫码

import { redirect } from "next/navigation";
import { getSession, getOauthTicket } from "@/lib/auth";
import OauthForm from "./OauthForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "完成登录 - 扫雷网" };

export default async function OauthPage() {
  if (await getSession()) redirect("/");
  const ticket = await getOauthTicket();
  if (!ticket) redirect("/account/login");

  const providerName = ticket.provider === "wechat" ? "微信" : "QQ";
  return (
    <div id="page" className="main">
      <OauthForm providerName={providerName} nickname={ticket.nickname} />
    </div>
  );
}
