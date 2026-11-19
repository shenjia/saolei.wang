// 世界 TOP100 页面主体（移植 2008 版 Ranking/Top10_World.asp；数据实时抓取
// minesweepergame.com，1 天缓存）
// 中国选手行高亮（2008 版 .Ours 语义：站内雷友）
// 2026-09-24：默认只显示前 15 条，下面「加载更多」增量展开（张老师要求），表格交互在 WorldTop100Table
// 2026-09-27（张老师要求）：删除底部 world_foot（如何加入/更新时间/完整排行链接）——
//   「查看完整排行」改为按钮并入页脚（在 WorldTop100Table 内）
// 2026-10-15（张老师要求）：页脚改用标准翻页滑条 PageSlider（分页展示 15 条/页）；
//   世界排行加交互式世界地图——全量榜单按国籍聚合（综合排行指数 = Σ（世界总人数 −
//   个人名次），一天抓取一次），地图放排行规则下面（单列全宽堆叠，见
//   WorldRankingBody；当日先试过双栏右列版式，因地图压窄看不清改此终版），
//   抓取失败时地图整块隐藏、页面回落纯 TOP100 形态

import { getWorldTop100, getWorldCountryStats, WORLD_RANKING_PAGE } from "@/lib/worldtop";
import { RankingNav } from "@/components/RankingNav";
import { WorldRankingBody } from "@/components/WorldRankingBody";
import { RankingRules } from "@/components/RankingRules";

// 世界榜规则板块（2026-10-14 张老师要求；口径见 lib/worldtop.ts）。
// 配色（2026-10-15 张老师定）：金只留小标题，正文数字 <i> 亮灰
const WORLD_RULES = [
  <>
    <b>数据来源</b>：<a href={WORLD_RANKING_PAGE} target="_blank" rel="noopener noreferrer">minesweepergame.com</a> 的世界时间排行前 <i>100</i> 名，与本站成绩无关。
  </>,
  <>
    <b>排序规则</b>：沿用原站名次（世界总计时间升序），本站不做重排；中国玩家行高亮显示。
  </>,
  <>
    <b>成绩列</b>：初级 / 中级 / 高级世界纪录及纪录日期；带录像的纪录可点击，用站内播放器观看。
  </>,
  <>
    <b>更新频率</b>：数据缓存 <i>1</i> 天，每天更新一次。
  </>,
];

export async function WorldTop100() {
  // TOP100 表与全量国家聚合同源（minesweepergame.com 同一接口分页），各挂 1 天缓存
  const [data, stats] = await Promise.all([getWorldTop100(), getWorldCountryStats()]);
  return (
    // head/rules 跨 RSC 边界进客户端组件多孩子数组，无 key 会触发 dev key 警告，显式 key 豁免
    <WorldRankingBody
      rows={data?.rows ?? []}
      stats={stats?.countries ?? null}
      head={
        <div key="head" className="page_head">
          <h1 className="page_title">世界排行</h1>
          <RankingNav current="world" />
        </div>
      }
      rules={<RankingRules key="rules" title="世界排行规则" items={WORLD_RULES} />}
    />
  );
}
