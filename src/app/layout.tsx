import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import "./pull-to-refresh.css";
import { getSession } from "@/lib/auth";
import { getHeaderUser } from "@/lib/usercard";
import { LoginLink } from "@/components/LoginLink";
import { LoginModal } from "@/components/LoginModal";
import { MessageBadge } from "@/components/MessageBadge";
import { IconAdmin, IconGear, IconLogout, IconPerson, IconUpload } from "@/components/MenuIcons";
import { MobileNav } from "@/components/MobileNav";
import { DefaultAvatar } from "@/components/DefaultAvatar";
import { ScrollReset } from "@/components/ScrollReset";
import { PullToRefresh } from "@/components/PullToRefresh";
import { SystemText } from "@/components/SystemText";
import { ToastHost } from "@/components/Toast";
import { InlineScript } from "@/components/InlineScript";
import { ConfirmHost, ImageLightboxHost } from "@/components/Confirm";
import TrackPageView from "@/components/TrackPageView";
import { isManager } from "@/lib/config";
import { TitleSystemProvider } from "@/components/TitleSystemProvider";
import { resolveTitleSystem, getThunderKingId } from "@/lib/title-system";
import { getOpenmsLink } from "@/lib/openms";
import { OpenmsConsentModal } from "@/components/OpenmsConsentModal";
import { BotChallengeGate } from "@/components/BotChallengeGate";
import { VsNavLink } from "@/components/VsNewHint";

export async function generateMetadata(): Promise<Metadata> {
  return {
    /* 站点标题模板（2026-10-15 张老师要求）：所有子页面统一「XXX | 扫雷网 Saolei.wang」 */
    title: {
      default: "扫雷网 Saolei.wang",
      template: "%s | 扫雷网 Saolei.wang",
    },
    description: "扫雷网——扫雷玩家的家园，录像排行、成绩认证、雷界快讯",
    /* favicon 按环境切换（2026-11-11 张老师要求）：本地 dev（localhost/dev.saolei.wang，
       两者同为本机 launchd 的 next dev:3100，NODE_ENV=development）用绿色徽章版，
       生产（蓝绿双槽 next start，NODE_ENV=production）保持原版黑徽章。
       原文件约定图标（src/app/icon.svg / favicon.ico）无法按环境切换，已移至 public/
       改由 metadata.icons 控制；Safari 不支持 SVG favicon，补 32px PNG 兜底。 */
    icons:
      process.env.NODE_ENV === "development"
        ? {
            icon: [
              { url: "/icons/icon-dev-32.png", sizes: "32x32", type: "image/png" },
              { url: "/icons/icon-dev.svg", type: "image/svg+xml" },
            ],
          }
        : {
            icon: [
              { url: "/icon.svg", type: "image/svg+xml" },
              { url: "/favicon.ico", sizes: "any" },
            ],
          },
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
}

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
  // 开源扫雷网同步征求（2026-11-07）：绑定且未表态才弹提醒条（主键点查，未绑定用户 null 零成本）
  const openmsLink = session ? await getOpenmsLink(session.uid) : null;
  return (
    <html lang="zh-CN">
      <head>
        {/* 手机「桌面版网站」视口钉定（2026-10-28 张老师实测：新版 Chrome Android 桌面
            模式不再强制 980 虚拟视口——顶栏汉堡实证其视口为窗口宽 ~390-850，媒体查询
            永远命不中桌面断点，全形态单列）。判定「桌面 UA + 手机小屏（短边 <500）」
            时把 viewport 钉到 width=980：页面按 980 桌面版式渲染、整页缩放、可捏合
            放大细看。桌面浏览器本就无视 viewport meta（对 PC 零影响）；移动模式 UA
            带 Mobi/Android 直接跳过维持响应式；平板短边 ≥500 不动（两列 878 也放不下
            700-900 的折叠屏内屏，留给 769~960 单列带）。⚠️ Next 16 的 viewport meta
            是 hydration 后异步插入的（Probe 实证 readyState=complete 时仍只有本脚本
            建的那颗，其后 device-width 才落地并以后位胜出）——必须用 MutationObserver
            盯 <head>，任何时刻出现的 viewport meta 都钉成 980，不能只靠
            DOMContentLoaded 一锤子买卖。 */}
        <InlineScript
          html={`(function(){try{if(/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent))return;if(Math.min(screen.width,screen.height)>=500)return;var pin=function(){var m=document.querySelectorAll('meta[name="viewport"]'),c=0;for(var i=0;i<m.length;i++){if(m[i].getAttribute("content")!=="width=980")m[i].setAttribute("content","width=980");c++}return c};if(!pin()){var n=document.createElement("meta");n.setAttribute("name","viewport");n.setAttribute("content","width=980");(document.head||document.documentElement).appendChild(n)}var mo=new MutationObserver(function(){pin()});mo.observe(document.head||document.documentElement,{childList:true,subtree:true});if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",pin)}catch(e){}})();`}
        />
        <link rel="stylesheet" href="/styles/legacy-2013.css" />
      </head>
      <body>
      {/* 称号体系上下文包裹全站（2026-10-18 提升：导航「军衔/称号」等 header 内文案也要跟随切换） */}
      <TitleSystemProvider value={{ system: titleSystem, thunderKingId }}>
        <div id="header">
          <div className="wrapper">
            <div className="logo">
              <Link prefetch={false} href="/">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="logo_icon" src="/icon.svg" alt="" width={26} height={26} />
                <h1>扫雷网</h1>
                <h2>Saolei.wang</h2>
              </Link>
            </div>
            <div className="nav">
              <ul id="header_nav">
                <li>
                  <Link prefetch={false} href="/">首页</Link>
                </li>
                <li>
                  <Link prefetch={false} href="/ranking">排行</Link>
                </li>
                <li>
                  <Link prefetch={false} href="/video">录像</Link>
                </li>
                <li>
                  <Link prefetch={false} href="/online">练习</Link>
                </li>
                {/* 对决入口（2026-11-11）：登录态才显示（/vs 页本身有登录门槛）。
                    新功能绿字（2026-11-12 00:00 张老师改版）：未看过对决页的用户
                    「对决」默认 active 绿，hover 一次计入 localStorage 后不再变绿，
                    2026-11-19 上线满一周整体下线——详见 VsNewHint.tsx */}
                {session && (
                  <li>
                    <VsNavLink />
                  </li>
                )}
                <li>
                  <Link prefetch={false} href="/bbs">论坛</Link>
                </li>
                <li>
                  <Link prefetch={false} href="/page/guide">教程</Link>
                </li>
                <li>
                  <Link prefetch={false} href="/titles">
                    <SystemText />
                  </Link>
                </li>
                <li>
                  <Link prefetch={false} href="/records">纪录</Link>
                </li>
                <li>
                  <Link prefetch={false} href="/page/download">下载</Link>
                </li>
                {session ? (
                  <>
                    <li>
                      <MessageBadge />
                    </li>
                    <li className="popMenu user_menu">
                      <Link prefetch={false} href={`/user/${session.uid}`} className="um_trigger">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {/* 无头像：军衔制下按性别给军装默认头像（顶栏 28-30px 位走 mid 档），旧版称号仍 no.jpg（2026-11-11） */}
                        {me?.avatarIsDefault ? (
                          <DefaultAvatar sex={me.sex} size="mid" className="um_avatar" />
                        ) : (
                          <img className="um_avatar" src={avatarUrl} alt="" />
                        )}
                        <span className="um_name">{displayName}</span>
                        {/* 顶栏人名是自己，不挂玩家名气泡（2026-10-29 张老师要求） */}
                      </Link>
                      <ul className="menu">
                        <li>
                          <Link prefetch={false} href={`/user/${session.uid}`}>
                            <IconPerson />
                            个人主页
                          </Link>
                        </li>
                        <li>
                          <Link prefetch={false} href="/video/upload">
                            <IconUpload />
                            上传录像
                          </Link>
                        </li>
                        <li>
                          <Link prefetch={false} href="/account">
                            <IconGear />
                            账户设置
                          </Link>
                        </li>
                        {isManager(session.role) && (
                          <li>
                            <Link prefetch={false} href="/admin">
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
                  ? {
                      uid: session.uid,
                      displayName,
                      avatarUrl,
                      avatarSex: me?.sex ?? 0,
                      avatarIsDefault: !!me?.avatarIsDefault,
                      role: session.role,
                    }
                  : null
              }
            />
          </div>
        </div>
        {children}
        {openmsLink && openmsLink.consent === 0 && <OpenmsConsentModal />}
        {!session && <LoginModal />}
        {!session && <BotChallengeGate />}
        <ToastHost />
        <ConfirmHost />
        {/* 论坛正文小图点击看大图（2026-10-27）：事件委托，全站生效（含 admin） */}
        <ImageLightboxHost />
        <Suspense fallback={null}>
          <ScrollReset />
        </Suspense>
        {/* iOS 主屏幕 Web App（standalone）没有系统下拉刷新，全站补一份手势模拟；
            普通 Safari 自动跳过，详见组件注释。纯 effect，无 DOM 输出 */}
        <PullToRefresh />
        {/* 全站访问埋点（/admin 与 /api 由 track API 拒绝） */}
        <TrackPageView />
        <div id="footer">
          <div className="wrapper">
            <p className="footer-meta">
              Copyright &copy; {new Date().getFullYear()} 扫雷网Saolei.wang
            </p>
            <p className="footer-nav">
              <Link prefetch={false} href="/page/about">关于本站</Link> ·{" "}
              <Link prefetch={false} href="/page/history">更新历史</Link> ·{" "}
              <Link prefetch={false} href="/team">管理团队</Link> ·{" "}
              <Link prefetch={false} href="/page/donate">提供赞助</Link> ·{" "}
              <Link prefetch={false} href="/page/api">开放API</Link> ·{" "}
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
