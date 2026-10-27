// 管理后台外壳（2026-09-24）
// · 服务端守卫：未登录跳登录页，普通玩家直接踢回首页（前端不可绕过）。
// · 全屏壳：admin.css 里用 body:has(.admin_shell) 隐藏主站 header/footer，
//   免去把根布局拆成路由组的大改（URL 与既有页面零变动）。
// · 待审录像数 / 待审头像数在这里各查一次，供侧栏红点角标与顶栏摘要用。

import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { USER_ROLE, VIDEO_STATUS } from "@/lib/config";
import { AVATAR_REVIEW_STATUS } from "@/lib/avatar";
import { getGroupBadges } from "@/lib/admin/usergroups";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { AdminTopSummary } from "@/components/admin/PendingCounts";
import { ConfirmHost } from "@/components/Confirm";
import "./admin.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理后台",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  // 论坛待审（2026-10-27 张老师要求：与录像/头像同款红点角标）——待审主题 + 待审回复合计；
  // 用户组 badge 信号（2026-10-27）：组人数 + 最新加入时刻，客户端与 localStorage 基线对比
  const [pending, avatarPending, bbsPending, cheatPending, currentUser, groupBadges] = await Promise.all([
    prisma.video.count({ where: { status: VIDEO_STATUS.NORMAL } }),
    prisma.avatarReview.count({ where: { status: AVATAR_REVIEW_STATUS.PENDING } }),
    Promise.all([
      prisma.bbsPost.count({ where: { status: 5 } }),
      prisma.bbsReply.count({ where: { status: 5 } }),
    ]).then(([a, b]) => a + b),
    // 反作弊待复核数（2026-10-27 处置分级：探测只禁排名，此处人工核实）
    prisma.cheatReport.count({ where: { resolved: 0 } }),
    prisma.user.findUnique({ where: { id: session.uid }, select: { chineseName: true } }),
    getGroupBadges(),
  ]);
  const roleTag =
    session.role === USER_ROLE.ADMINISTRATOR ? (
      <span className="admin_tag bad">超级管理员</span>
    ) : (
      <span className="admin_tag warn">管理员</span>
    );

  return (
    <div className="admin_shell">
      <AdminSidebar
        badges={{ pending, avatar: avatarPending, bbs: bbsPending, cheat: cheatPending }}
        groupBadges={{
          trusted: { count: groupBadges.trustedCount, maxJoin: groupBadges.trustedMaxJoin },
          lowtrust: { count: groupBadges.lowTrustCount, maxJoin: groupBadges.lowTrustMaxJoin },
        }}
        user={{
          uid: session.uid,
          name: currentUser?.chineseName || session.username,
          administrator: session.role === USER_ROLE.ADMINISTRATOR,
        }}
      />
      <div className="admin_body">
        <div className="admin_top">
          <h1>管理后台</h1>
          {/* 2026-10-27：摘要数字与侧栏 badge 同源——服务端首帧 + 客户端切页/轮询校准，
              修「共享 layout 不重跑导致外壳数字停在旧值」的问题（组件自带 .sub 样式） */}
          <AdminTopSummary initial={{ pending, avatar: avatarPending, bbs: bbsPending, cheat: cheatPending }} />
          <div className="right">
            {roleTag}
            <span>{session.username}</span>
            <a href={`/user/${session.uid}`} target="_blank" rel="noopener noreferrer">
              我的地盘
            </a>
            <a href="/api/auth/logout">退出登录</a>
          </div>
        </div>
        <div className="admin_main">{children}</div>
      </div>
      {/* 2026-10-27 张老师定：后台确认操作也用站内浮窗（此前的 window.confirm
          模态豁免到此为止——用户组四按钮率先接入，其余 op 渐进迁移） */}
      <ConfirmHost />
    </div>
  );
}
