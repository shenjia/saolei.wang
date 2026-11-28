// 旧路径 /live/<uid> → /watch/<uid> 的 301 跳转（2026-11-28 张老师定「URL 中的 live
// 都改成 watch」）。旁观页 2026-11-27 上线时路径是 /live/，次日改名 /watch/；保留本
// 路由只为不断链——已收藏/已分享/已被搜索引擎抓取的旧链接 301 到新路径。
// ⚠️ 本文件不做任何业务逻辑，只跳转；登录/粉丝闸/黑名单都在新路径里判。
// 上线开关：LIVE_ENABLED=0 时与新路径同口径返回 404（功能关闭期间不该暴露入口）。
// ⚠️ App Router 页面必须 default export（不能像 route.ts 那样导出 GET）——首稿写成
//    export async function GET 触发 .next/dev/types/validator 的 AppPageConfig 约束报错。

import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function LiveRedirectPage({
  params,
}: {
  params: Promise<{ uid: string }>;
}) {
  if (process.env.LIVE_ENABLED === "0") notFound();
  const { uid: raw } = await params;
  const uid = Number(raw);
  if (!Number.isInteger(uid) || uid <= 0) notFound();
  redirect(`/watch/${uid}`);
}
