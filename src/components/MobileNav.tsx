"use client";

// 移动版顶栏（≤768px）：三横线菜单按钮 → 下拉站内导航；
// 已登录时右侧显示头像 → 下拉个人菜单（个人主页/上传录像/账户管理/退出登录）。
// 桌面横向导航仍在 layout.tsx 渲染，由 CSS 按断点各自显隐（2026-09-26 张老师要求）。

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LoginLink } from "./LoginLink";
import { IconGear, IconLogout, IconPerson, IconUpload } from "./MenuIcons";

export interface MobileNavUser {
  uid: number;
  displayName: string;
  avatarUrl: string;
}

/** 站内主导航（与桌面 #header_nav 前七项一致） */
const SITE_LINKS: { href: string; label: string }[] = [
  { href: "/", label: "首页" },
  { href: "/ranking", label: "排行" },
  { href: "/video", label: "录像" },
  { href: "/bbs", label: "论坛" },
  { href: "/page/guide", label: "教程" },
  { href: "/titles", label: "军衔" },
  { href: "/page/download", label: "下载" },
];

function useOutsideClose(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return ref;
}

export function MobileNav({ user }: { user: MobileNavUser | null }) {
  const [siteOpen, setSiteOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const siteRef = useOutsideClose(() => setSiteOpen(false));
  const userRef = useOutsideClose(() => setUserOpen(false));
  // 路由切换后收起菜单：渲染期对比上次 pathname（软导航即视为已离开菜单，
  // 不用 useEffect——项目 react-hooks/set-state-in-effect 规则禁止 effect 内同步 setState）
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setSiteOpen(false);
    setUserOpen(false);
  }

  function toggleSite() {
    setUserOpen(false);
    setSiteOpen((v) => !v);
  }
  function toggleUser() {
    setSiteOpen(false);
    setUserOpen((v) => !v);
  }

  return (
    <div id="mobile_nav">
      <div className="mn_item" ref={siteRef}>
        <button
          type="button"
          className={"mn_burger" + (siteOpen ? " open" : "")}
          aria-label="菜单"
          aria-expanded={siteOpen}
          onClick={toggleSite}
        >
          <span />
        </button>
        {siteOpen && (
          <ul className="mn_menu">
            {SITE_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href}>{l.label}</Link>
              </li>
            ))}
            {!user && (
              <li>
                <LoginLink>登录</LoginLink>
              </li>
            )}
          </ul>
        )}
      </div>
      {user && (
        <div className="mn_item" ref={userRef}>
          <button
            type="button"
            className="mn_avatar_btn"
            aria-label="用户菜单"
            aria-expanded={userOpen}
            onClick={toggleUser}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="mn_avatar" src={user.avatarUrl} alt="" />
          </button>
          {userOpen && (
            <ul className="mn_menu mn_user_menu">
              <li>
                <Link href={`/user/${user.uid}`}>
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
                  账户管理
                </Link>
              </li>
              <li>
                <a href="/api/auth/logout">
                  <IconLogout />
                  退出登录
                </a>
              </li>
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
