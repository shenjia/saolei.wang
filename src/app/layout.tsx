import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { getSession } from "@/lib/auth";
import { getHeaderUser } from "@/lib/usercard";
import { LoginLink } from "@/components/LoginLink";
import { LoginModal } from "@/components/LoginModal";
import { MessageBadge } from "@/components/MessageBadge";
import { ScrollReset } from "@/components/ScrollReset";
import { ToastHost } from "@/components/Toast";

/* 用户菜单矢量图标（2026-09-26 张老师要求）：14px 线性风格，
   currentColor 随链接色变（灰 → hover 绿），与排行榜搜索放大镜同款笔画 */
function MenuSvg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="um_icon"
      viewBox="0 0 14 14"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const metadata: Metadata = {
  title: "扫雷网 Saolei.wang",
  description: "扫雷网——扫雷玩家的家园，录像排行、成绩认证、雷界快讯",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  const me = session ? await getHeaderUser(session.uid) : null;
  const displayName = me?.chineseName || session?.username || "";
  const avatarUrl = me?.avatarUrl || "/images/player/no.jpg";
  return (
    <html lang="zh-CN">
      <head>
        <link rel="stylesheet" href="/styles/legacy-2013.css" />
      </head>
      <body>
        <div id="header">
          <div className="wrapper">
            <div className="logo">
              <Link href="/">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="logo_icon" src="/icon.svg" alt="" width={26} height={26} />
                <h1>扫雷网</h1>
                <h2>Saolei.wang</h2>
              </Link>
            </div>
            <div className="nav">
              <ul id="header_nav">
                <li>
                  <Link href="/">首页</Link>
                </li>
                <li>
                  <Link href="/ranking">排行</Link>
                </li>
                <li>
                  <Link href="/video">录像</Link>
                </li>
                <li>
                  <Link href="/bbs">论坛</Link>
                </li>
                <li>
                  <Link href="/page/guide">教程</Link>
                </li>
                <li>
                  <Link href="/titles">军衔</Link>
                </li>
                <li>
                  <Link href="/page/download">下载</Link>
                </li>
                {session ? (
                  <>
                    <li>
                      <MessageBadge />
                    </li>
                    <li className="popMenu user_menu">
                      <Link href={`/user/${session.uid}`} className="um_trigger">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="um_avatar" src={avatarUrl} alt="" />
                        <span className="um_name">{displayName}</span>
                      </Link>
                      <ul className="menu">
                        <li>
                          <Link href={`/user/${session.uid}`}>
                            <MenuSvg>
                              {/* 个人主页：小人 */}
                              <circle cx="7" cy="4.2" r="2.4" />
                              <path d="M2.4 12.2c0.6-2.6 2.4-3.8 4.6-3.8s4 1.2 4.6 3.8" />
                            </MenuSvg>
                            个人主页
                          </Link>
                        </li>
                        <li>
                          <Link href="/video/upload">
                            <MenuSvg>
                              {/* 上传录像：向上箭头 + 底线 */}
                              <path d="M7 10.5V3.5M4 6l3-2.8 3 2.8" />
                              <path d="M2.5 12h9" />
                            </MenuSvg>
                            上传录像
                          </Link>
                        </li>
                        <li>
                          <Link href="/account">
                            <MenuSvg>
                              {/* 账户管理：齿轮（简化六齿） */}
                              <circle cx="7" cy="7" r="2.1" />
                              <path d="M7 1.8v1.8M7 10.4v1.8M2.24 4.4l1.56 0.9M10.2 8.7l1.56 0.9M2.24 9.6l1.56-0.9M10.2 5.3l1.56-0.9" />
                            </MenuSvg>
                            账户管理
                          </Link>
                        </li>
                        <li>
                          <a href="/api/auth/logout">
                            <MenuSvg>
                              {/* 退出登录：门框 + 出口箭头 */}
                              <path d="M6 12H3.2C2.8 12 2.5 11.7 2.5 11.3V2.7C2.5 2.3 2.8 2 3.2 2H6" />
                              <path d="M9 4.2L11.8 7 9 9.8M4.8 7h7" />
                            </MenuSvg>
                            退出登录
                          </a>
                        </li>
                      </ul>
                    </li>
                  </>
                ) : (
                  <li>
                    <LoginLink>登录</LoginLink>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
        {children}
        {!session && <LoginModal />}
        <ToastHost />
        <Suspense fallback={null}>
          <ScrollReset />
        </Suspense>
        <div id="footer">
          <div className="wrapper">
            <p className="footer-meta">
              Copyright &copy; {new Date().getFullYear()} 扫雷网Saolei.wang
            </p>
            <p className="footer-nav">
              <Link href="/page/about">关于本站</Link> ·{" "}
              <Link href="/page/history">更新历史</Link> ·{" "}
              <Link href="/team">管理团队</Link> ·{" "}
              <Link href="/page/donate">提供赞助</Link> ·{" "}
              <a href="http://www.miibeian.gov.cn" target="_blank" rel="noopener noreferrer">
                陕ICP备08100290号
              </a>
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}
