// 活跃排行视图（2026-11-08 URI 统一：由独立路由 /active 并入 /ranking?view=active；
// 旧路径 /active 308 重定向到新 URI，本组件只负责渲染）
// 近 7 日活跃玩家榜：列 = 排名 | 地区 | 姓名 | 军衔 | 初级 | 中级 | 高级 | 观看 | 评论 | 登录 | 活跃指数。
// 地区 = user.area（展示经 areaDisplay 合规化，2026-11-09 张老师要求加在姓名前）；
// 初/中/高 = 该级别（录像上传数 + 练习完成盘数）；
// 观看 = 近 7 日观看录像时长折点（每满 1 分钟 1 点，2026-11-10 张老师定，原地回放口径）；
// 评论 = 评论条数；登录 = 近 7 日访问天数（每日访问记 1 点活跃值）；
// 活跃指数 = 练习 3BV 计点 + 录像级别加权分（初1/中2/高10）+ 评论数 + 登录点 + 观看点。
// 默认按活跃指数降序，数据列可点击表头切换排序（?by=）。口径见 lib/activerank.ts。

import { getActiveRanking, ACTIVE_BYS, type ActiveBy } from "@/lib/activerank";
import { getSession } from "@/lib/auth";
import { title as assessTitle } from "@/lib/assess";
import { dualTitles, getThunderKingThreshold } from "@/lib/title-system";
import { RankingNav } from "@/components/RankingNav";
import { ActiveFeed, type TitledActiveRow } from "@/components/ActiveFeed";
import { RankingRules } from "@/components/RankingRules";

// 活跃榜页底规则板块（配色与各排行页同口径：金只留小标题，正文数字 <i> 亮灰）
// 2026-11-10 张老师定：「分项列」条删除；「活跃指数」条改为合并一句话口径
const ACTIVE_RULES = [
  <>
    <b>活跃指数</b>：在线练习和上传录像，初级每盘计 <i>1</i> 点；中级每盘计 <i>2</i> 点
    （完成过半计 <i>1</i> 点）；高级每盘计 <i>10</i> 点（完成过半按完成率折扣取整）；
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

  return (
    <div id="page" className="main ranking_old">
      <div className="box ranking_box">
        <div className="page_head">
          <h1 className="page_title">活跃排行</h1>
          <RankingNav current="active" />
        </div>
        {/* 切排序即换 key 重挂（Feed 软导航 initial 不重置铁律） */}
        <ActiveFeed key={by} initial={titled} total={total} pageSize={pageSize} by={by} />
      </div>
      <RankingRules title="活跃排行规则" items={ACTIVE_RULES} />
    </div>
  );
}
