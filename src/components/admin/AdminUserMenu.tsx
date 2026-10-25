// 移动端后台用户菜单：与 LOGO 同行，替代顶栏占空间的账号链接组。
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function AdminUserMenu({
  uid,
  name,
  administrator,
}: {
  uid: number;
  name: string;
  administrator: boolean;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="admin_usermenu">
      <button
        type="button"
        className="admin_usermenu_trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`当前用户：${name}，打开账号菜单`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`admin_tag ${administrator ? "bad" : "warn"}`}>
          {administrator ? "超级管理员" : "管理员"}
        </span>
        <span className="name">{name}</span>
        <svg viewBox="0 0 12 8" width="10" height="7" aria-hidden="true">
          <path d="m1 1.5 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <>
          <button
            type="button"
            className="admin_usermenu_backdrop"
            aria-label="关闭账号菜单"
            onClick={() => setOpen(false)}
          />
          <div className="admin_usermenu_pop" role="menu">
            <Link href={`/user/${uid}`} role="menuitem" onClick={() => setOpen(false)}>
              个人主页
            </Link>
            <a href="/api/auth/logout" role="menuitem">
              退出登录
            </a>
          </div>
        </>
      )}
    </div>
  );
}
