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

/**
 * 上传录像（首页侧栏按钮专用，2026-11-02 张老师指定）：绿色渐变上箭头 + 深灰托盘。
 * 源自 RRZE bicons upload.svg（张老师桌面 upload.svg），裁剪 viewBox 到 400×400 图形区、
 * 精简 Inkscape 元数据；箭头渐变 #99b000→#a9bc24、托盘 #4e505d 原样保留
 * （填充式图标自带配色，不走 IconSvg 的 currentColor 线性风格）。
 * 渐变 id 加随机后缀避免与页面内其他 SVG def 冲突。
 */
export function IconUploadTray() {
  return (
    <svg viewBox="188.9 324 400 400" width="24" height="24" aria-hidden="true">
      <defs>
        <linearGradient
          id="iconUploadTrayArrow"
          x1="351.10071"
          y1="669.16382"
          x2="438.79028"
          y2="425.67657"
          gradientUnits="userSpaceOnUse"
          gradientTransform="matrix(0.89894884,0,0,0.89894884,175.14851,158.3049)"
        >
          <stop offset="0" stopColor="#99b000" />
          <stop offset="1" stopColor="#a9bc24" />
        </linearGradient>
      </defs>
      <g transform="translate(-127.27922,-158.39191)">
        <path
          d="m 517.61139,481.20455 c -2.95343,0 -5.90681,1.96893 -9.8447,5.90682 L 370.73296,636.47703 c -7.87576,7.87574 -3.92883,20.22322 11.81362,19.68937 l 58.97728,0 0.30455,131.61337 c 0.0252,10.90789 8.93377,18.92798 19.84165,18.92798 l 111.56396,0 c 10.90788,0 19.55815,-8.02008 19.53707,-18.92798 l -0.30454,-131.61337 61.79325,0 c 15.75146,0 15.75146,-15.7515 11.8136,-19.68937 L 527.45605,487.11137 c -3.93786,-3.93789 -6.89127,-5.90682 -9.84466,-5.90682 z"
          fill="url(#iconUploadTrayArrow)"
        />
        <path
          d="m 360.8417,757.13703 c -10.76838,0 -19.4375,8.66913 -19.4375,19.4375 l 0,85.19726 c 0,0.3136 0.009,0.62568 0.0234,0.93555 -0.004,0.15661 -0.0234,0.3092 -0.0234,0.4668 0,9.99178 8.04338,18.03515 18.03516,18.03515 l 313.58984,0 0.21484,0 c 9.99178,0 18.03516,-8.04337 18.03516,-18.03515 0,-0.0363 -0.006,-0.0712 -0.006,-0.10742 2.1e-4,-0.0362 0.006,-0.0711 0.006,-0.10743 l 0,-87.57226 c 0,-10.11005 -8.13996,-18.25 -18.25,-18.25 -10.11004,0 -18.24805,8.13995 -18.24805,18.25 l 0,69.75 -274.50195,0 0,-68.5625 c 0,-10.76837 -8.66913,-19.4375 -19.4375,-19.4375 z"
          fill="#4e505d"
        />
      </g>
    </svg>
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

/** 管理后台：盾牌 + 对勾（2026-10-15 张老师选定的方案 B） */
export function IconAdmin() {
  return (
    <IconSvg>
      <path d="M7 1.8l4.2 1.6v3.4c0 2.8-1.8 4.4-4.2 5.4-2.4-1-4.2-2.6-4.2-5.4V3.4z" />
      <path d="M5 6.9l1.5 1.5 2.6-2.8" />
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
