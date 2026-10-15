// 邮箱验证落地页：用户点击邮件链接回到站内，校验 token 并置 email_verified。
// token 30 分钟有效、一次性（验证成功即清空）；须当前登录账号与 token 归属一致。
// 2026-10-15 修复：未登录点击链接时 token 会随 307 丢失、登录页又不认 ?next=，
// 导致「点了邮件链接却永远验证不成功」——现在 token 随 next 带进登录回跳；
// 失败页区分「已过期」与「无效」，过期提示直接引导重发。

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "邮箱验证" };

export default async function EmailVerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  const { token } = await searchParams;
  if (!session) {
    // token 原样带进登录回跳（仅本页 32 位 hex，无注入面；登录页只放行站内路径）
    const back = token ? `/account/email/verify?token=${encodeURIComponent(token)}` : "/account/email";
    redirect(`/account/login?next=${encodeURIComponent(back)}`);
  }

  let ok = false;
  let expired = false;
  let email = "";

  if (token && token.length === 32) {
    const auth = await prisma.userAuth.findUnique({ where: { emailToken: token } });
    if (auth && auth.id === BigInt(session.uid) && auth.email) {
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (now - auth.updateTime <= 30 * 60) {
        await prisma.userAuth.update({
          where: { id: auth.id },
          data: { emailVerified: now, emailToken: null, updateTime: now },
        });
        ok = true;
        email = auth.email;
      } else {
        expired = true;
      }
    }
  }

  return (
    <div id="page" className="main">
      <div className="box" style={{ padding: "24px 20px", textAlign: "center" }}>
        {ok ? (
          <>
            <h1 style={{ marginBottom: 10 }}>邮箱验证成功</h1>
            <p style={{ color: "#75715e", lineHeight: "22px" }}>
              账号已绑定邮箱 <b style={{ color: "#f8f8f2" }}>{email}</b>，今后忘记密码可通过邮箱自助找回。
            </p>
            <p style={{ marginTop: 16 }}>
              <Link href="/account" className="button active">
                返回账号中心
              </Link>
            </p>
          </>
        ) : (
          <>
            <h1 style={{ marginBottom: 10 }}>{expired ? "验证链接已过期" : "验证失败"}</h1>
            <p style={{ color: "#75715e", lineHeight: "22px" }}>
              {expired
                ? "验证链接超过 30 分钟有效期已失效。请回到账号中心重新发送验证邮件。"
                : "验证链接无效或已过期（30 分钟内有效）。请回到账号中心重新发送验证邮件。"}
            </p>
            <p style={{ marginTop: 16 }}>
              <Link href="/account/email" className="button active">
                重新绑定
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
