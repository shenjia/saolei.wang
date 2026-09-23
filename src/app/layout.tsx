import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { MessageBadge } from "@/components/MessageBadge";
import { UserCardPopover } from "@/components/UserCardPopover";
import { ToastHost } from "@/components/Toast";

export const metadata: Metadata = {
  title: "扫雷网 Saolei.wang",
  description: "扫雷网——扫雷玩家的家园，录像排行、成绩认证、雷界快讯",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
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
                  <Link href="/ranking">排行榜</Link>
                </li>
                <li>
                  <Link href="/video">录像</Link>
                </li>
                <li>
                  <Link href="/bbs">论坛</Link>
                </li>
                <li>
                  <Link href="/titles">军衔</Link>
                </li>
                {session ? (
                  <>
                    <li>
                      <Link href="/video/upload">上传</Link>
                    </li>
                    {isManager(session.role) && (
                      <li>
                        <Link href="/video/review">审核</Link>
                      </li>
                    )}
                    <li>
                      <MessageBadge />
                    </li>
                    <li>
                      <Link href="/account">{session.username}</Link>
                    </li>
                    <li>
                      <a href="/api/auth/logout">退出</a>
                    </li>
                  </>
                ) : (
                  <li>
                    <Link href="/account/login">登录</Link>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>
        {children}
        <ToastHost />
        <UserCardPopover />
        <div id="footer">
          <div className="wrapper">
            <p>
              <Link href="/page/help">新手上路</Link> · <Link href="/page/guide">教程</Link> ·{" "}
              <Link href="/page/download">软件下载</Link> · <Link href="/page/world">世界排行</Link> ·{" "}
              <Link href="/hero">雷神殿</Link> · <Link href="/team">管理团队</Link> ·{" "}
              <Link href="/page/about">关于本站</Link> · <Link href="/page/history">更新历史</Link> ·{" "}
              <Link href="/page/donate">提供赞助</Link>
            </p>
            <p>Copyright &copy; {new Date().getFullYear()} Saolei.wang</p>
            <a href="http://www.miibeian.gov.cn" target="_blank">
              陕ICP备08100290号
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
