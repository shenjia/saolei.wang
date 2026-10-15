// 账户管理首页（2026-10-15 张老师改版：原「账号中心 · 我的资料」）
// 主栏：账户管理标题 + 操作按钮行（修改资料 / 修改密码 / 绑定邮箱）
//   + 只读「我的资料」总览表（沿用原内容）。
// 侧栏：竖版玩家卡片——头像（点击直接弹上传，交互与个人主页 SelfAvatar 一致：
//   文件选择 → 方形裁剪 → AI 审核，待审显「审核中」气泡）→ 登录名（user_auth.username，
//   老用户显老用户名、新用户显注册邮箱）→ 中文名（链接进个人主页）→ 军衔。

import { existsSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { SelfAvatar } from "@/components/SelfAvatar";
import { AVATAR_REVIEW_STATUS, resolveAvatarUrl } from "@/lib/avatar";

export const dynamic = "force-dynamic";
export const metadata = { title: "账户管理" };

export default async function AccountManagePage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const uid = BigInt(session.uid);
  const [detail, auth, latestAvatar] = await Promise.all([
    getUserDetail(session.uid),
    // 登录名 + 邮箱绑定状态：绑定入口按张老师指定放登录名后面（2026-10-15）
    prisma.userAuth.findUnique({
      where: { id: uid },
      select: { username: true, email: true, emailVerified: true },
    }),
    // 有无待审头像（SelfAvatar 的 pending 气泡）
    prisma.avatarReview.findFirst({
      where: { user: uid },
      orderBy: { id: "desc" },
      select: { status: true },
    }),
  ]);
  if (!detail) redirect("/account/login");
  const { user, info } = detail;

  const rows: [string, string][] = [
    ["中文名", user.chineseName],
    ["英文名", user.englishName],
    ["爱好", info?.interest ?? ""],
    ["QQ", info?.qq ?? ""],
    ["昵称", info?.nickname ?? ""],
    ["鼠标", info?.mouse ?? ""],
    ["鼠标垫", info?.pad ?? ""],
  ];

  // 头像优先级与个人主页一致：新版上传 → OAuth 外链 → 本地照片墙 → 默认图
  const photo = resolveAvatarUrl(
    user.avatar,
    existsSync(path.join(process.cwd(), "public", "images", "player", `${session.uid}.jpg`))
      ? `/images/player/${session.uid}.jpg`
      : "/images/common/avatar.png",
  );
  const avatarPending = latestAvatar?.status === AVATAR_REVIEW_STATUS.PENDING;

  return (
    <div id="page" className="two_columns">
      <ul id="account_manage">
        <li className="main">
          <div className="box">
            <h1>账户管理</h1>
            <div className="manage_actions">
              <Link href="/account/profile" className="button active">
                修改资料
              </Link>
              <Link href="/account/password" className="button active">
                修改密码
              </Link>
            </div>
            <hr />
            <h2>我的资料</h2>
            <table className="form" cellPadding={0} cellSpacing={0}>
              <tbody>
                {rows.map(([label, value]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </li>
        <li className="sidebar">
          <div className="box account_card">
            <SelfAvatar src={photo} alt={user.chineseName} pending={avatarPending} />
            <p className="login_name" title={`登录名：${auth?.username ?? ""}`}>
              {auth?.username ?? ""}
              {auth && Number(auth.emailVerified) === 0 && (
                <Link href="/account/email" className="button small bind_email_btn">
                  绑定邮箱
                </Link>
              )}
            </p>
            {auth && Number(auth.emailVerified) > 0 && <p className="email_bound_ok">已绑定 {auth.email}</p>}
            <h2>
              <Link href={`/user/${user.id}`}>{user.chineseName}</Link>
            </h2>
            <p className="title_line">{detail.title}</p>
          </div>
        </li>
      </ul>
    </div>
  );
}
