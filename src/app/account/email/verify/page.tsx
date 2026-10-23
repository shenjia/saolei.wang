// 邮箱验证落地页：用户点击邮件链接回到站内，校验 token 并置 email_verified。
// token 24 小时有效、一次性（验证成功即清空）；须当前登录账号与 token 归属一致。
// 2026-10-15 修复：未登录点击链接时 token 会随 307 丢失、登录页又不认 ?next=，
// 导致「点了邮件链接却永远验证不成功」——现在 token 随 next 带进登录回跳。
// 2026-10-15 二轮（潘逸轩实测反馈）：失败页细分为四态——成功 / 已完成验证（幂等，
// 重复点击旧链接不再报失败）/ 链接属于其他账号（明确指认邮箱并引导换登录）/ 过期 / 无效。
// 2026-10-15 张老师拍板：验证成功 → 登录名同步换成邮箱（唯一性冲突则保旧名并提示）。
// 2026-10-23 张老师改口径：绑定成功 ⇔ 登录名换成邮箱，不允许「绑了邮箱但登录名不变」
// 的半成功态——验证时发现邮箱已被他人占用为登录名 → 整个绑定失败（清草稿），提示换邮箱。
// 同时消除旧 taken 分支的隐患：不置 email_verified 就不会出现两账号同持同一已验证邮箱、
// 密码找回 findFirst 随机命中的问题。

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { sendSystemMessage } from "@/lib/message";

export const dynamic = "force-dynamic";
export const metadata = { title: "邮箱验证" };

const N = (v: bigint | number | null | undefined): number => Number(v ?? 0);

// 与 api/account/email 的 TOKEN_TTL 保持一致（24 小时）
const TOKEN_TTL = 24 * 60 * 60;

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
  let taken = false; // 2026-10-23：邮箱在验证时刻已被他人占用为登录名 → 绑定整体失败
  let wrongAccount = false; // token 存在但归属其他账号（2026-10-15：潘逸轩用 B 账号点 A 账号的链接只看到「验证失败」，不明就里）
  let alreadyVerified = false; // 本账号已完成验证却再点旧链接（邮件/webview 二次加载同款困惑）
  let ownerEmail = "";
  let email = "";

  if (token && token.length === 32) {
    const auth = await prisma.userAuth.findUnique({ where: { emailToken: token } });
    if (auth) {
      if (auth.id === BigInt(session.uid) && auth.email) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        if (now - auth.updateTime <= TOKEN_TTL) {
          // 登录名同步换成邮箱：占坑检查在验证时刻重做（发信与点击之间可能有人新注册占坑）
          // 2026-10-23 张老师口径：占坑成立 → 整个绑定失败，清掉草稿（含 email 字段）让用户换邮箱重来
          const clash = await prisma.userAuth.findUnique({ where: { username: auth.email } });
          if (!clash || clash.id === auth.id) {
            await prisma.userAuth.update({
              where: { id: auth.id },
              data: { username: auth.email, emailVerified: now, emailToken: null, updateTime: now },
            });
            ok = true;
            email = auth.email;
            // 2026-10-23 张老师要求：绑定成功后系统自动发一条通知，告知登录名已换为邮箱
            await sendSystemMessage(
              N(auth.id),
              `邮箱（${auth.email}）绑定已成功，今后请使用此邮箱作为用户名进行登录（原登录名已失效）`,
            );
          } else {
            // 绑定失败：不置 email_verified、不清 email 之外的任何状态、登录名不动；
            // 同时清草稿（email 置空 + token 作废），否则账号中心会一直显示「待验证」的失效邮箱
            await prisma.userAuth.update({
              where: { id: auth.id },
              data: { email: "", emailToken: null, updateTime: now },
            });
            taken = true;
            email = auth.email;
          }
        } else {
          expired = true;
        }
      } else {
        wrongAccount = true;
        ownerEmail = auth.email ?? "";
      }
    }
  }

  // 非成功且非归属错误时，看本账号是否其实已验证过（重复点击旧链接 / 邮件客户端二次加载）；
  // taken 失败态不算——本账号 email_verified 未置位，走这条只会得到「验证失败」
  if (!ok && !expired && !wrongAccount && !taken) {
    const me = await prisma.userAuth.findUnique({
      where: { id: BigInt(session.uid) },
      select: { email: true, emailVerified: true },
    });
    if (me && Number(me.emailVerified) > 0) {
      alreadyVerified = true;
      email = me.email ?? "";
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
            <p style={{ color: "#75715e", lineHeight: "22px", marginTop: 10 }}>
              登录名已同步更换为该邮箱，今后请使用 <b style={{ color: "#f8f8f2" }}>{email}</b> 登录。
            </p>
            <p style={{ marginTop: 16 }}>
              <Link href="/account" className="button active">
                返回账号中心
              </Link>
            </p>
          </>
        ) : alreadyVerified ? (
          <>
            <h1 style={{ marginBottom: 10 }}>邮箱已完成验证</h1>
            <p style={{ color: "#75715e", lineHeight: "22px" }}>
              账号邮箱 <b style={{ color: "#f8f8f2" }}>{email}</b> 已验证过，本链接无需重复点击。
            </p>
            <p style={{ marginTop: 16 }}>
              <Link href="/account" className="button active">
                返回账号中心
              </Link>
            </p>
          </>
        ) : wrongAccount ? (
          <>
            <h1 style={{ marginBottom: 10 }}>验证链接与当前账号不符</h1>
            <p style={{ color: "#75715e", lineHeight: "22px" }}>
              此验证链接属于绑定邮箱 <b style={{ color: "#f8f8f2" }}>{ownerEmail}</b> 的其他账号。请先退出并用该账号登录，再点击邮件中的链接。
            </p>
            <p style={{ marginTop: 16 }}>
              <Link href="/account/login" className="button active">
                去登录
              </Link>
            </p>
          </>
        ) : taken ? (
          <>
            <h1 style={{ marginBottom: 10 }}>邮箱绑定失败</h1>
            <p style={{ color: "#75715e", lineHeight: "22px" }}>
              邮箱 <b style={{ color: "#f8f8f2" }}>{email}</b> 已被其他账号占用为登录名，绑定未完成。
            </p>
            <p style={{ color: "#75715e", lineHeight: "22px", marginTop: 10 }}>
              发送验证邮件与点击链接之间，该邮箱可能被他人新注册占用。请换用其他邮箱重新绑定；您的账号与原登录名不受影响。
            </p>
            <p style={{ marginTop: 16 }}>
              <Link href="/account/email" className="button active">
                重新绑定
              </Link>
            </p>
          </>
        ) : (
          <>
            <h1 style={{ marginBottom: 10 }}>{expired ? "验证链接已过期" : "验证失败"}</h1>
            <p style={{ color: "#75715e", lineHeight: "22px" }}>
              {expired
                ? "验证链接超过 24 小时有效期已失效。请回到账号中心重新发送验证邮件。"
                : "验证链接无效或已过期（24 小时内有效）。请回到账号中心重新发送验证邮件。"}
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
