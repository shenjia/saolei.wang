import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "扫雷网 Saolei.wang",
  description: "扫雷网——扫雷玩家的家园，录像排行、成绩认证、雷界动态",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
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
                  <Link href="/account/login">登录</Link>
                </li>
              </ul>
            </div>
          </div>
        </div>
        {children}
        <div id="footer">
          <div className="wrapper">
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
