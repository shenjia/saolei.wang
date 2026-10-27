import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { getSession } from "@/lib/auth";
import { getHeaderUser } from "@/lib/usercard";
import { LoginLink } from "@/components/LoginLink";
import { LoginModal } from "@/components/LoginModal";
import { MessageBadge } from "@/components/MessageBadge";
import { IconAdmin, IconGear, IconLogout, IconPerson, IconUpload } from "@/components/MenuIcons";
import { MobileNav } from "@/components/MobileNav";
import { ScrollReset } from "@/components/ScrollReset";
import { SystemText } from "@/components/SystemText";
import { ToastHost } from "@/components/Toast";
import { ConfirmHost, ImageLightboxHost } from "@/components/Confirm";
import TrackPageView from "@/components/TrackPageView";
import { isManager } from "@/lib/config";
import { TitleSystemProvider } from "@/components/TitleSystemProvider";
import { resolveTitleSystem, getThunderKingId } from "@/lib/title-system";

export const metadata: Metadata = {
  /* 站点标题模板（2026-10-15 张老师要求）：所有子页面统一「XXX | 扫雷网 Saolei.wang」 */
  title: {
    default: "扫雷网 Saolei.wang",
    template: "%s | 扫雷网 Saolei.wang",
  },
  description: "扫雷网——扫雷玩家的家园，录像排行、成绩认证、雷界快讯",
  /* iOS 无元素全屏 API（/online 全屏按钮在该环境走伪全屏退化）——
     唯一真隐藏 Safari 地址栏的途径：添加到主屏幕后以 standalone 打开 */
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "扫雷网",
  },
  /* Next 16 对 appleWebApp.capable 只生成标准化的 mobile-web-app-capable
     （2026-10-14 生产 HTML 实证），不生成 iOS legacy 的 apple- 版本；
     iOS 16.4–18 的 Safari 判「从主屏幕图标打开是否全屏」只认 legacy meta
     或 manifest 的 display:standalone——不补这颗，用户照引导添加主屏幕后
     依旧带地址栏（iOS 26 起系统默认即以 web app 打开，无需此条） */
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
  // 称号体系（2026-10-17 Phase 5）：跟随观看者——未登录/未设置固定军衔制；
  // 雷界第一人一并算好注入（旧体系「雷帝」渲染判定，缓存 60s）
  const [titleSystem, thunderKingId] = await Promise.all([
    resolveTitleSystem(session?.uid),
    getThunderKingId(),
  ]);
  const me = session ? await getHeaderUser(session.uid) : null;
  const displayName = me?.chineseName || session?.username || "";
  const avatarUrl = me?.avatarUrl || "/images/player/no.jpg";
  return (
    <html lang="zh-CN">
      <head>
        <link rel="stylesheet" href="/styles/legacy-2013.css" />
      </head>
      <body>
      {/* 称号体系上下文包裹全站（2026-10-18 提升：导航「军衔/称号」等 header 内文案也要跟随切换） */}
      <TitleSystemProvider value={{ system: titleSystem, thunderKingId }}>
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
                  <Link href="/online">练习</Link>
                </li>
                <li>
                  <Link href="/titles">
                    <SystemText />
                  </Link>
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
                            <IconPerson />
                            个人主页
                          </Link>
                        </li>
                        <li>
                          <Link href="/video/upload">
                            <IconUpload />
                            上传录像
                          </Link>
                        </li>
                        <li>
                          <Link href="/account">
                            <IconGear />
                            账户设置
                          </Link>
                        </li>
                        {isManager(session.role) && (
                          <li>
                            <Link href="/admin">
                              <IconAdmin />
                              管理后台
                            </Link>
                          </li>
                        )}
                        <li>
                          <a href="/api/auth/logout">
                            <IconLogout />
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
            {/* 半移动/移动版（≤960px）导航：三横线菜单 + 登录头像；桌面由 CSS 隐藏 */}
            <MobileNav
              user={
                session
                  ? { uid: session.uid, displayName, avatarUrl, role: session.role }
                  : null
              }
            />
          </div>
        </div>
        {children}
        {!session && <LoginModal />}
        <ToastHost />
        <ConfirmHost />
        {/* 论坛正文小图点击看大图（2026-10-27）：事件委托，全站生效（含 admin） */}
        <ImageLightboxHost />
        <Suspense fallback={null}>
          <ScrollReset />
        </Suspense>
        {/* 全站访问埋点（/admin 与 /api 由 track API 拒绝） */}
        <TrackPageView />
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
              <Link href="/page/api">开放API</Link> ·{" "}
              <a href="http://www.miibeian.gov.cn" target="_blank" rel="noopener noreferrer">
                陕ICP备19026089号-1
              </a>
            </p>
          </div>
        </div>
      </TitleSystemProvider>
      </body>
    </html>
  );
}
