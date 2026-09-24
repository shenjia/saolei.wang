// 管理后台外壳（2026-09-24）
// · 服务端守卫：未登录跳登录页，普通玩家直接踢回首页（前端不可绕过）。
// · 全屏壳：admin.css 里用 body:has(.admin_shell) 隐藏主站 header/footer，
//   免去把根布局拆成路由组的大改（URL 与既有页面零变动）。
// · 待审录像数在这里查一次，供侧栏红点角标用。

import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin/guard";
import { USER_ROLE, VIDEO_STATUS } from "@/lib/config";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import "./admin.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "管理后台 | 扫雷网",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();
  const pending = await prisma.video.count({ where: { status: VIDEO_STATUS.NORMAL } });
  const roleTag =
    session.role === USER_ROLE.ADMINISTRATOR ? (
      <span className="admin_tag bad">超级管理员</span>
    ) : (
      <span className="admin_tag warn">管理员</span>
    );

  return (
    <div className="admin_shell">
      <AdminSidebar badges={{ pending }} />
      <div className="admin_body">
        <div className="admin_top">
          <h1>管理后台</h1>
          <span className="sub">
            {pending > 0 ? `待审录像 ${pending} 条` : "待审队列已清空"}
          </span>
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
    </div>
  );
}
