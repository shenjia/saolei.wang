// 顶栏用户菜单矢量图标（2026-09-26 张老师要求）：14px 线性风格，
// currentColor 随链接色变（灰 → hover 绿），与排行榜搜索放大镜同款笔画。
// 桌面横向导航（app/layout.tsx）与移动版下拉（MobileNav.tsx）共用。
import type { ReactNode } from "react";

function IconSvg({ children }: { children: ReactNode }) {
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

/** 个人主页：小人 */
export function IconPerson() {
  return (
    <IconSvg>
      <circle cx="7" cy="4.2" r="2.4" />
      <path d="M2.4 12.2c0.6-2.6 2.4-3.8 4.6-3.8s4 1.2 4.6 3.8" />
    </IconSvg>
  );
}

/** 上传录像：向上箭头 + 底线 */
export function IconUpload() {
  return (
    <IconSvg>
      <path d="M7 10.5V3.5M4 6l3-2.8 3 2.8" />
      <path d="M2.5 12h9" />
    </IconSvg>
  );
}

/** 账户管理：齿轮（简化六齿） */
export function IconGear() {
  return (
    <IconSvg>
      <circle cx="7" cy="7" r="2.1" />
      <path d="M7 1.8v1.8M7 10.4v1.8M2.24 4.4l1.56 0.9M10.2 8.7l1.56 0.9M2.24 9.6l1.56-0.9M10.2 5.3l1.56-0.9" />
    </IconSvg>
  );
}

/** 退出登录：门框 + 出口箭头 */
export function IconLogout() {
  return (
    <IconSvg>
      <path d="M6 12H3.2C2.8 12 2.5 11.7 2.5 11.3V2.7C2.5 2.3 2.8 2 3.2 2H6" />
      <path d="M9 4.2L11.8 7 9 9.8M4.8 7h7" />
    </IconSvg>
  );
}
