// /vs 竞技场统一路由（2026-11-11 张老师需求，五轮 13:38 URL 口径）：
//   /vs            → 空竞技场，服务端直接预填自己（URL 随即变 /vs/{自己id}）
//   /vs/{l}        → 左卡=l、右空（「只选左边的，URL就变成/vs/id」）
//   /vs/{l}/{r}    → 双卡就位（「点其他用户主页的VS标记进来，链接变成/vs/自己id/对方id」）
//   /vs/{l}/{r}?fight=1 → 对决页：渲染 VsDuelView 并自动跑分（竞技场「一决胜负」
//     落地即开跑，免二次点击）；URL 即对决链接，可刷新/分享/旁观。
// 选人/换人/清空全部走客户端 history.replaceState 实时改 URL（张老师：每换一个人
// URL 实时变化；「只选右边的」地址栏显示 /vs//{r}——⚠️ Next 会把双斜杠 308 规范化，
// 该形态刷新后退化成 /vs/{r}（左位），已知边缘，见 2026-11-11 日志）。
// 旧路由 /vs/page.tsx、/vs/[id]/page.tsx、/vs/[id]/[bid]/page.tsx（旁观）已并入本页：
//   旁观语义由 record=会话是否为对决双方本人 决定（KPI 口径＝双方本人访问），
//   后台「观看」链接已改指 /vs/{u1}/{u2}?fight=1。

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getVsPickPlayer } from "@/lib/vspick";
import { VsPickArena } from "@/components/VsPick";
import { VsDuelView, getVsDuelTitle } from "@/components/VsDuel";

export const dynamic = "force-dynamic";

interface VsArenaProps {
  params: Promise<{ ids?: string[] }>;
  searchParams: Promise<{ fight?: string }>;
}

export async function generateMetadata({ params, searchParams }: VsArenaProps): Promise<Metadata> {
  const { ids } = await params;
  const { fight } = await searchParams;
  const nums = (ids ?? []).map((s) => parseInt(s, 10));
  // fight 链接给对决标题；竞技场一律「对决」（不暴露对手姓名）
  if (fight === "1" && nums.length === 2 && nums[0] && nums[1] && nums[0] !== nums[1]) {
    return { title: await getVsDuelTitle(nums[0], nums[1]) };
  }
  return { title: "对决" };
}

export default async function VsArenaPage({ params, searchParams }: VsArenaProps) {
  const { ids } = await params;
  const { fight } = await searchParams;
  const session = await getSession();
  if (!session) redirect("/account/login");

  // 段位解析：至多两段、必须纯数字（0 非法）——多段/非法段一律 404
  const nums = (ids ?? []).map((s) => parseInt(s, 10));
  if (nums.length > 2 || nums.some((n) => !n)) notFound();
  const [l, r] = nums;

  // fight=1 且双方齐 → 对决页（自动跑分）。record＝会话是否为对决双方本人
  //（KPI 口径＝双方本人访问；后台旁观 uid 非本人自然不落库）
  if (fight === "1" && l && r) {
    return (
      <VsDuelView
        uid1={l}
        uid2={r}
        record={session.uid === l || session.uid === r}
        autoRun
      />
    );
  }

  // 竞技场：URL 里已有的 id 服务端预取卡片（查无此人按空位处理，URL 随客户端自愈）；
  // 裸 /vs 空入口由服务端预填自己（张老师 13:38：vs入口进来就自动填上自己的ID）
  const me = await getVsPickPlayer(session.uid);
  if (!me) notFound();
  const [initialLeft, initialRight] = await Promise.all([
    l ? getVsPickPlayer(l) : null,
    r ? getVsPickPlayer(r) : null,
  ]);

  return (
    <div id="page" className="main vs_pick_page">
      <VsPickArena
        me={me}
        initialLeft={!l && !r ? me : initialLeft}
        initialRight={initialRight}
      />
    </div>
  );
}
