// 活跃排行视图（2026-11-08 URI 统一：由独立路由 /active 并入 /ranking?view=active；
// 旧路径 /active 308 重定向到新 URI，本组件只负责渲染）
// 近 7 日活跃玩家榜：列 = 排名 | 地区 | 姓名 | 军衔 | 初级 | 中级 | 高级 | 观看 | 评论 | 登录 | 活跃指数。
// 地区 = user.area（展示经 areaDisplay 合规化，2026-11-09 张老师要求加在姓名前）；
// 初/中/高 = 该级别（录像上传数 + 练习完成盘数）；
// 观看 = 近 7 日观看录像时长折点（每满 1 分钟 1 点，2026-11-10 张老师定，原地回放口径）；
// 评论 = 评论条数；登录 = 近 7 日访问天数（每日访问记 1 点活跃值）；
// 活跃指数 = 练习 3BV 计点 + 录像级别加权分（初1/中2/高10）+ 评论数 + 登录点 + 观看点。
// 默认按活跃指数降序，数据列可点击表头切换排序（?by=）。口径见 lib/activerank.ts。
// 2026-11-10 张老师要求：进步/活跃榜搜索与雷界榜一致——搜索框扩到本榜（RankingNav
// active 模式），登录聚焦/清空推荐「自己」（含榜内名次，getActiveRankOfUsers 零重活）；
// ?page=/?hl= 支持 whereami 302 落地（换 key 重挂 + SSR 即高亮）。

import { getActiveRanking, getActiveRankOfUsers, ACTIVE_BYS, type ActiveBy } from "@/lib/activerank";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingThreshold } from "@/lib/title-system";
import { RankingNav } from "@/components/RankingNav";
import { ActiveFeed, type TitledActiveRow } from "@/components/ActiveFeed";
import { RankingRules } from "@/components/RankingRules";

// 活跃榜页底规则板块（配色与各排行页同口径：金只留小标题，正文数字 <i> 亮灰）
// 2026-11-10 张老师定：「分项列」条删除；「活跃指数」条改为合并一句话口径
const ACTIVE_RULES = [
  <>
    <b>活跃指数</b>：在线练习和上传录像，初级每盘计 <i>1</i> 点；中级每盘计 <i>4</i> 点、高级每盘计 <i>20</i> 点
    （完成过半按完成率折扣取整）；非排行模式练习只得 <i>50%</i> 练习点（向下取整）；
    观看录像累计每分钟计 <i>1</i> 点；发表录像评论 / 文章评论计 <i>1</i> 点；登录一天计 <i>1</i> 点。
  </>,
  <>
    <b>排序规则</b>：默认按活跃指数降序；点击<i>初级/中级/高级/观看/评论/登录/活跃指数</i>表头可切换排序（悬停表头可查看各列口径）。
  </>,
  <>
    <b>有效口径</b>：上传录像、练习、观看、评论、访问须来自正常账号；被屏蔽的录像与评论不计。
  </>,
  <>
    <b>更新频率</b>：快照每分钟重算一次，观看/访问/上传/评论/审核变化最迟约 <i>1</i> 分钟后计入；封禁即时生效。
  </>,
];

export async function ActiveRankingView({
  sp,
}: {
  sp: Record<string, string | undefined>;
}) {
  const by: ActiveBy = ACTIVE_BYS.includes(sp.by as ActiveBy) ? (sp.by as ActiveBy) : "act";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize } = await getActiveRanking(page, undefined, by);
  // 军衔双体系评估（与进步榜同构；无高级成绩 expTime=0 → title() 返回无军衔档）
  const kingTh = await getThunderKingThreshold();
  const pairs = await dualTitles(
    rows.map((u) => ({ userId: u.id, expTime: u.expTime, ranked: true, sex: u.sex }))
  );
  const titled: TitledActiveRow[] = await Promise.all(
    rows.map(async (u, i) => ({
      ...u,
      title: await assessTitle(u.expTime, kingTh),
      classic: pairs[i]?.c ?? null,
    }))
  );

  // 登录态：搜索框空输入推荐「自己」+ 自己在当前排序列活跃榜内的名次
  //（2026-11-10 张老师要求，与雷界榜同体验；名次取当前 by 列口径——
  //  搜索定位走的也是当前 by 序，两处口径一致）
  const session = await getSession();
  let me:
    | { id: number; chineseName: string; englishName: string; sex: number; actRank?: number }
    | undefined;
  if (session?.uid) {
    const [u, myRanks] = await Promise.all([
      prisma.user.findUnique({
        where: { id: BigInt(session.uid) },
        select: { id: true, chineseName: true, englishName: true, sex: true },
      }),
      getActiveRankOfUsers([session.uid], by),
    ]);
    if (u) {
      me = {
        id: Number(u.id),
        chineseName: u.chineseName,
        englishName: u.englishName,
        sex: u.sex,
        actRank: myRanks.get(Number(u.id)),
      };
    }
  }

  // 搜索/whereami 定位落地行：SSR 即高亮（无 JS 也可见），客户端接管后持续
  const hl = Math.max(0, parseInt(sp.hl ?? "0", 10) || 0) || undefined;

  return (
    <div id="page" className="main ranking_old">
      <div className="box ranking_box">
        <div className="page_head">
          <h1 className="page_title">活跃排行</h1>
          <RankingNav current="active" by={by === "act" ? undefined : by} me={me} />
        </div>
        {/* 切排序/whereami 落地即换 key 重挂（Feed 软导航 initial 不重置铁律） */}
        <ActiveFeed
          key={`active-${by}-${page}-${hl ?? 0}`}
          initial={titled}
          total={total}
          pageSize={pageSize}
          by={by}
          initialHl={hl}
        />
      </div>
      <RankingRules title="活跃排行规则" items={ACTIVE_RULES} />
    </div>
  );
}
