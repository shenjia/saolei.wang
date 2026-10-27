// 纪录页 /records（2026-10-28 二轮，张老师口径）：
//
// 左栏（li.main 宽版）：一个大板块「纪录」——标准 .box 卡片 + page_head
//   （h1「纪录」左 + 三个级别筛选器右，复刻排行页页头；客户端切换级别），
//   每级别三图（时间 / 3BV/s / STNB）纪录演变，数据与后台「纪录演变」同口径
//   （lib/records.ts，10 分钟缓存），交互在 RecordsCurves 客户端组件。
// 右栏（li.sidebar 窄版）：八项「其他纪录」各一个标准 .box 板块——标题 h2 +
//   右侧大数 + 人名（AvatarCell 首页同款，含性别标记）+ 军衔（TitleBadge）+ 日期。
//   收集BV最多 = BV 榜第一（getBvRanking total，与排行页零口径差）。
//
// 军衔渲染走全站统一 TitleBadge（双体系随观看者切换）：曲线点 + 右栏行共 ~200 条
// 一次性丢给 dualTitles 批量换算（快照制口径：高级成绩 + 是否在榜，总司令=雷界第一人特判）。
//
// 版式复用首页 ul#home 双栏骨架（two_columns + li.main/li.sidebar）：
// 窄版右栏宽 300 与排行页一致（#page.records_old 覆盖，≥769 生效）；
// ≤880 单列化 + page_head 堆叠由既有规则接管。

import { getRecordsPageData } from "@/lib/records";
import { dualTitles } from "@/lib/title-system";
import { RecordsCurves, type MetricSectionData } from "@/components/RecordsCurves";
import { AvatarCell } from "@/components/Cells";
import { TitleBadge } from "@/components/TitleBadge";

export const metadata = { title: "纪录" };

const LEVEL_NAMES: Record<string, string> = { total: "总计", beg: "初级", int: "中级", exp: "高级" };
// 图表小标题口径（张老师 2026-10-28 四轮起「XX纪录」）
const METRIC_NAMES: Record<string, string> = {
  time: "时间纪录",
  "3bvs": "3BV/s纪录",
  stnb: "STNB纪录",
};

/** 大数 xxx.x万 显示（2026-10-28 七轮张老师定：w 改万；<1万 显示原值） */
function fmtWan(v: number): string {
  if (v >= 10000) return `${(v / 10000).toFixed(1)}`;
  return v.toLocaleString("zh-CN");
}

/** 右栏七项的标题/单位（2026-10-28 四轮张老师定名；val 由 lib/records.ts 归一化为 number） */
const TOP_META: Record<string, { label: string; unit: string; fmt?: (v: number) => string }> = {
  views: { label: "最高人气", unit: "万", fmt: fmtWan },
  bv: { label: "最多收集", unit: "个BV", fmt: (v) => v.toLocaleString("zh-CN") },
  upload: { label: "最多录像", unit: "部", fmt: (v) => v.toLocaleString("zh-CN") },
  post: { label: "最多文章", unit: "篇" },
  comment: { label: "最多评论", unit: "条", fmt: (v) => v.toLocaleString("zh-CN") },
  history: { label: "最多纪事", unit: "篇" },
  review: { label: "最多审核", unit: "万", fmt: fmtWan },
};

export default async function RecordsPage() {
  const { curves, tops } = await getRecordsPageData();

  // 双体系称号批量换算：曲线点 + 右栏行一次取全（dualTitles 内部只查一次雷界第一人）
  const titleRows = [
    ...curves.map((c) => ({ userId: c.userId, expTime: c.expTime, ranked: c.ranked, sex: c.sex })),
    ...tops.map((t) => ({ userId: t.userId, expTime: t.expTime, ranked: t.ranked, sex: t.sex })),
  ];
  const pairs = await dualTitles(titleRows);

  // 曲线行与称号按下标对齐（titleRows 前段=curves 原序），先钉住再筛分组
  const curveRows = curves.map((c, i) => ({ ...c, pair: pairs[i] }));

  // 曲线分组：指标板块 × 级别（四轮张老师定：左栏拆三板块，各自带四档级别筛选；
  // 总计三指标均为事件重放曲线，见 lib/records.ts）
  const sections: MetricSectionData[] = (["time", "3bvs", "stnb"] as const).map((metric) => ({
    metric,
    metricName: METRIC_NAMES[metric],
    levels: (["total", "beg", "int", "exp"] as const).map((level) => ({
      level,
      levelName: LEVEL_NAMES[level],
      points: curveRows
        .filter((c) => c.level === level && c.metric === metric)
        .sort((a, b) => a.ct - b.ct)
        .map((c) => ({
          v: c.vid,
          u: c.userId,
          n: c.name,
          s: c.sex,
          x: c.ct,
          y: c.val,
          t: c.pair,
        })),
    })),
  }));

  return (
    <div id="page" className="two_columns records_old">
      <ul id="home">
        <li className="main">
          <RecordsCurves sections={sections} />
        </li>
        <li className="sidebar">
          {tops.map((t, i) => {
            const meta = TOP_META[t.key];
            const val = meta.fmt ? meta.fmt(t.val) : String(t.val);
            return (
              <div className="box records_top" key={t.key}>
                <div className="records_top_head">
                  <h2>{meta.label}</h2>
                  <span className="records_top_val">
                    {val}
                    <small> {meta.unit}</small>
                  </span>
                </div>
                <div className="records_top_sub">
                  <span className="records_top_label">纪录保持者</span>
                  <span className="records_top_who">
                    <AvatarCell id={t.userId} name={t.name} sex={t.sex} link gender="small" />{" "}
                    <TitleBadge
                      title={pairs[curves.length + i].m}
                      classic={pairs[curves.length + i].c}
                      link
                    />
                  </span>
                </div>
              </div>
            );
          })}
        </li>
      </ul>
    </div>
  );
}
