import type { Metadata } from "next";
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
                          <Link href={`/user/${session.uid}`}>个人主页</Link>
                        </li>
                        <li>
                          <Link href="/video/upload">上传录像</Link>
                        </li>
                        <li>
                          <Link href="/account">账户管理</Link>
                        </li>
                        <li>
                          <a href="/api/auth/logout">退出登录</a>
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
            <p className="footer-nav">
              <Link href="/page/about">关于本站</Link> ·{" "}
              <Link href="/page/history">更新历史</Link> ·{" "}
              <Link href="/team">管理团队</Link> ·{" "}
              <Link href="/page/donate">提供赞助</Link>
            </p>
            <p className="footer-meta">
              Copyright &copy; {new Date().getFullYear()} Saolei.wang ·{" "}
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
