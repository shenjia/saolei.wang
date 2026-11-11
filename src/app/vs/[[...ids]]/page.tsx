// /vs 统一路由（2026-11-11 张老师需求，十轮 14:11 定稿 URL 口径）：
//   /vs            → 空竞技场，服务端直接预填自己（URL 随即变 /vs/{自己id}）
//   /vs/{l}        → 左卡=l、右空（「只选左边的，URL就变成/vs/id」）
//   /vs?/{r}       → 右卡=r、左空（「只选右边的」——? 占位左段；实测无尾斜杠的
//                    /vs?/{r} 不被 Next 规范化，刷新保真；带尾斜杠的 /vs/?/{r} 会被
//                    308 成编码形态但解析等价，两种都认）
//   /vs/{l}/{r}    → 对决页：VsDuelView 战前态（赛前预测计算并显示），**手动**点
//                    「一决胜负」跑分——后台观看直接访问本地址，无任何参数
//                    （十轮 14:11 张老师：不要加 fight=1 参数）。URL 即对决链接，
//                    可刷新/分享/旁观；record＝会话是否为对决双方本人
//                   （KPI 口径＝双方本人访问，后台旁观 uid 非本人自然不落库）。
// 竞技场「一决胜负」（选满双方）经 sessionStorage「vs_autorun」标记跳转同一
// /vs/{l}/{r} 地址自动跑分（八轮 13:29 张老师：点一下直接开跑、URL 无参数；
// 直接访问/刷新无标记 → 手动两段式）。选人/换人/清空走 history.replaceState
// 实时改 URL（张老师：每换一个人 URL 实时变化）。
// 旧路由 /vs/page.tsx、/vs/[id]/page.tsx、/vs/[id]/[bid]/page.tsx（旁观）已并入本页，
// 后台「观看」链接即 /vs/{u1}/{u2}。

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getVsPickPlayer } from "@/lib/vspick";
import { VsPickArena } from "@/components/VsPick";
import { VsDuelView, getVsDuelTitle } from "@/components/VsDuel";

export const dynamic = "force-dynamic";

interface VsArenaProps {
  params: Promise<{ ids?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** 从查询串解析「? 占位左段」的右卡 id：/vs?/21557 → 键 "/21557"（Next 会把
 *  308 编码形态 %2F21557 解码回 "/21557"，两种写法等价） */
function rightIdFromQuery(sp: Record<string, string | string[] | undefined>): number {
  for (const k of Object.keys(sp)) {
    const m = /^\/(\d+)$/.exec(k);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

export async function generateMetadata({ params, searchParams }: VsArenaProps): Promise<Metadata> {
  const { ids } = await params;
  const nums = (ids ?? []).map((s) => parseInt(s, 10));
  // 双段对决链接给对决标题；竞技场一律「对决」（不暴露对手姓名）
  if (nums.length === 2 && nums[0] && nums[1] && nums[0] !== nums[1]) {
    return { title: await getVsDuelTitle(nums[0], nums[1]) };
  }
  return { title: "对决" };
}

export default async function VsArenaPage({ params, searchParams }: VsArenaProps) {
  const { ids } = await params;
  const sp = await searchParams;
  const session = await getSession();
  if (!session) redirect("/account/login");

  // 路径段解析：至多两段、必须纯数字（0 非法）——多段/非法段一律 404
  const nums = (ids ?? []).map((s) => parseInt(s, 10));
  if (nums.length > 2 || nums.some((n) => !n)) notFound();
  const [l, r] = nums;
  // 查询串占位的右卡 id（/vs?/{r} 形态）；路径双段时以路径为准
  const qr = r || rightIdFromQuery(sp);

  // 双段 → 对决页（战前态、手动跑分；自动跑分由竞技场经 sessionStorage 交接）；
  // 「历史对决」板块翻页改客户端（15:48 张老师改版），URL 不再带 ?page=N。
  // 换人就地清卡（16:36 张老师）：旁观者（非对决双方）需装配登录者卡；双方本人
  // 的卡片由 VsDuelView 内部从对决数据零查询转换，这里传 null 免重复拉取
  if (l && qr) {
    const swapMe = session.uid === l || session.uid === qr ? null : await getVsPickPlayer(session.uid);
    return (
      <VsDuelView
        uid1={l}
        uid2={qr}
        record={session.uid === l || session.uid === qr}
        swapMe={swapMe}
      />
    );
  }

  // 竞技场：URL 里已有的 id 服务端预取卡片（查无此人按空位处理，URL 随客户端自愈）；
  // 裸 /vs 空入口（无任何 id）由服务端预填自己（张老师 13:38：vs入口进来就自动填上自己的ID）
  const me = await getVsPickPlayer(session.uid);
  if (!me) notFound();
  const [initialLeft, initialRight] = await Promise.all([
    l ? getVsPickPlayer(l) : null,
    qr ? getVsPickPlayer(qr) : null,
  ]);

  return (
    <div id="page" className="main vs_pick_page">
      <VsPickArena
        me={me}
        initialLeft={!l && !qr ? me : initialLeft}
        initialRight={initialRight}
      />
    </div>
  );
}
