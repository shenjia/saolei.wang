// 世界 TOP100（移植 2008 版 Ranking/Top10_World.asp；数据实时抓取 minesweepergame.com，1 天缓存）
// 中国选手行高亮（2008 版 .Ours 语义：站内雷友）
// 2026-09-24：默认只显示前 15 条，下面「加载更多」增量展开（张老师要求），表格交互在 WorldTop100Table
// 2026-09-27（张老师要求）：删除底部 world_foot（如何加入/更新时间/完整排行链接）——
//   「查看完整排行」改为按钮并入页脚（在 WorldTop100Table 内）
// 2026-10-15（张老师要求）：页脚改用标准翻页滑条 PageSlider（分页展示 15 条/页），
//   最右侧保留「查看完整排行」外链按钮

import { getWorldTop100 } from "@/lib/worldtop";
import { RankingNav } from "@/components/RankingNav";
import { WorldTop100Table } from "@/components/WorldTop100Table";
import { RankingRules } from "@/components/RankingRules";
import { FlopPlayer } from "@/components/FlopPlayer";

// 世界榜页底规则板块（2026-10-14 张老师要求；口径见 lib/worldtop.ts）
const WORLD_RULES = [
  <>
    <b>数据来源</b>：minesweepergame.com 的世界时间排行前 100 名，与本站成绩无关。
  </>,
  <>
    <b>排序规则</b>：沿用原站名次（世界总计时间升序），本站不做重排；中国玩家行高亮显示。
  </>,
  <>
    <b>成绩列</b>：初级 / 中级 / 高级世界纪录及纪录日期；带录像的纪录可点击，用站内播放器观看。
  </>,
  <>
    <b>更新频率</b>：数据缓存 1 天，每天更新一次。
  </>,
];

export async function WorldTop100() {
  const data = await getWorldTop100();
  return (
    <div id="world_top" className="box ranking_box">
      <div className="page_head">
        <h1 className="page_title">世界排行</h1>
        <RankingNav current="world" />
      </div>
      {data ? (
        <>
          <WorldTop100Table rows={data.rows} />
          {/* 纪录点击播放（原站 avf 经 /api/world/video 代理，站内 flop 播放器渲染） */}
          <FlopPlayer />
        </>
      ) : (
        <p className="world_fail">暂时无法获取世界排行，请稍后再试。</p>
      )}
      <RankingRules title="世界排行规则" items={WORLD_RULES} />
    </div>
  );
}
