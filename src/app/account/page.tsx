// 账户管理首页（2026-10-15 张老师四轮定稿：原「账号中心 · 我的资料」）
// 主栏：标题行（左「账户管理」h1 + 右「修改资料/修改密码」小按钮同行）→
//   头像单独一行（可点更换）→ 一张连续资料表（账户名/中文名/英文名与
//   爱好、QQ 等同格式分栏，无小标题无分割线）。
// 侧栏：标准 UserPanel 玩家卡片（与录像详情页/论坛主题页右栏同款）。
// （2026-10-16 张老师：侧栏原「数据统计」盒已去掉，只留玩家卡片。）

import { existsSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getUserDetail } from "@/lib/queries";
import { prisma } from "@/lib/db";
import { SelfAvatar } from "@/components/SelfAvatar";
import { UserPanel } from "@/components/UserCard";
import { AVATAR_REVIEW_STATUS, resolveAvatarUrl } from "@/lib/avatar";

export const dynamic = "force-dynamic";
export const metadata = { title: "账户管理" };

/** 账户名是否为邮箱（2026-10-15 张老师：非邮箱时才显示「绑定邮箱」入口） */
function isEmail(s: string): boolean {
  return s.includes("@");
}

export default async function AccountManagePage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const uid = BigInt(session.uid);
  const [detail, auth, latestAvatar, me] = await Promise.all([
    getUserDetail(session.uid),
    // 账户名 + 邮箱绑定状态：绑定入口跟在账户名后面（2026-10-15）
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
    prisma.user.findUnique({ where: { id: uid }, select: { avatar: true } }),
  ]);
  if (!detail) redirect("/account/login");
  const { user, info } = detail;

  const rows: [string, string][] = [
    ["爱好", info?.interest ?? ""],
    ["QQ", info?.qq ?? ""],
    ["昵称", info?.nickname ?? ""],
    ["鼠标", info?.mouse ?? ""],
    ["鼠标垫", info?.pad ?? ""],
  ];

  const accountName = auth?.username ?? session.username ?? "";
  const needBindEmail = !!auth && !isEmail(accountName);

  // 头像优先级与个人主页一致：新版上传 → OAuth 外链 → 本地照片墙 → 默认图
  const photo = resolveAvatarUrl(
    me?.avatar ?? "",
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
            <div className="manage_head">
              <h1>账户管理</h1>
              <div className="manage_actions">
                <Link href="/account/profile" className="button small">
                  修改资料
                </Link>
                <Link href="/account/password" className="button small">
                  修改密码
                </Link>
              </div>
            </div>
            <hr />

            {/* 头像单独一列居左（可点更换），右侧一张连续资料表（账户名/中文名/英文名
                与爱好、QQ 等同格式分栏，无小标题无分割线，2026-10-15 五轮张老师定稿） */}
            <div className="account_identity">
              <div className="account_avatar_cell">
                <SelfAvatar src={photo} alt={user.chineseName} pending={avatarPending} />
              </div>
              <table className="form" cellPadding={0} cellSpacing={0}>
                <tbody>
                  <tr>
                    <th>账户名</th>
                    <td>
                      <div>
                        {accountName}
                        {needBindEmail && (
                          <Link href="/account/email" className="bind_email_btn">
                            绑定邮箱
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <th>中文名</th>
                    <td>
                      <div>{user.chineseName}</div>
                    </td>
                  </tr>
                  <tr>
                    <th>英文名</th>
                    <td>
                      <div>{user.englishName}</div>
                    </td>
                  </tr>
                  {rows.map(([label, value]) => (
                    <tr key={label}>
                      <th>{label}</th>
                      <td>
                        <div>{value}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </li>
        <li className="sidebar">
          {/* hideRadar：卡片下只放玩家卡片，不放实力雷达/数据统计（2026-10-16 张老师定） */}
          <UserPanel userId={session.uid} cardId="account_user_card" hideRadar />
        </li>
      </ul>
    </div>
  );
}
