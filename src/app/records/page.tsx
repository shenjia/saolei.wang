// 纪录页 /records（2026-10-28，张老师需求：首页导航「下载」前加「纪录」入口）
//
// 左栏（li.main）：三级（初/中/高）× 三图（时间 / 3BV/s / STNB）纪录演变，
//   数据与后台「纪录演变」同口径（lib/records.ts，10 分钟缓存），
//   交互（拖动 / hover 创造者+军衔+保持时长 / 纪录值点击跳录像）在 RecordsCurves 客户端组件。
// 右栏（li.sidebar）：八项「其他纪录」TOP1 服务端直出（人气 / 收集BV / 上传录像 /
//   发表文章 / 发表评论 / 发表纪事 / 练习盘数 / 审核录像），标题 + 右侧大数 + 人名军衔日期。
//
// 军衔渲染走全站统一 TitleBadge（双体系随观看者切换）：曲线点 + 右栏行共 ~200 条
// 一次性丢给 dualTitles 批量换算（快照制口径：高级成绩 + 是否在榜，总司令=雷界第一人特判）。
//
// 版式复用首页 ul#home 双栏骨架（two_columns + li.main/li.sidebar）：
// ≤880 单列带由 globals.css 既有规则接管，无需本页自写移动端几何。

import Link from "next/link";
import { getRecordsPageData } from "@/lib/records";
import { dualTitles } from "@/lib/title-system";
import { formatDate } from "@/lib/format";
import { RecordsCurves, type CurveGroup } from "@/components/RecordsCurves";
import { TitleBadge } from "@/components/TitleBadge";

export const metadata = { title: "纪录" };

const LEVEL_NAMES: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
const METRIC_NAMES: Record<string, string> = {
  time: "时间纪录",
  "3bvs": "3BV/s 纪录",
  stnb: "STNB 纪录",
};
const METRIC_ORDER: Record<string, number> = { time: 0, "3bvs": 1, stnb: 2 };
const LEVEL_ORDER: Record<string, number> = { beg: 0, int: 1, exp: 2 };

/** 右栏八项的标题/单位（val 由 lib/records.ts 归一化为 number） */
const TOP_META: Record<string, { label: string; unit: string; fmt?: (v: number) => string }> = {
  views: { label: "人气最高", unit: "次访问" },
  bv: { label: "收集BV最多", unit: "BV", fmt: (v) => v.toLocaleString("zh-CN") },
  upload: { label: "上传录像最多", unit: "部", fmt: (v) => v.toLocaleString("zh-CN") },
  post: { label: "发表文章最多", unit: "篇" },
  comment: { label: "发表评论最多", unit: "条", fmt: (v) => v.toLocaleString("zh-CN") },
  history: { label: "发表纪事最多", unit: "篇" },
  practice: { label: "练习盘数最多", unit: "盘", fmt: (v) => v.toLocaleString("zh-CN") },
  review: { label: "审核录像最多", unit: "部", fmt: (v) => v.toLocaleString("zh-CN") },
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

  // 曲线分组：级别 × 指标（初/中/高 × 时间/3BV/s/STNB 固定顺序）
  const groups: CurveGroup[] = (["beg", "int", "exp"] as const).map((level) => ({
    level,
    levelName: LEVEL_NAMES[level],
    charts: (["time", "3bvs", "stnb"] as const).map((metric) => ({
      metric,
      metricName: METRIC_NAMES[metric],
      points: curveRows
        .filter((c) => c.level === level && c.metric === metric)
        .sort((a, b) => a.ct - b.ct)
        .map((c) => ({
          v: c.vid,
          u: c.userId,
          n: c.name,
          x: c.ct,
          y: c.val,
          t: c.pair,
        })),
    })),
  }));

  return (
    <div id="page" className="two_columns">
      <ul id="home">
        <li className="main">
          <h1>纪录</h1>
          <RecordsCurves groups={groups} />
        </li>
        <li className="sidebar">
          <div id="records_tops" className="records_tops">
            <h2>其他纪录</h2>
            {tops.map((t, i) => {
              const meta = TOP_META[t.key];
              const val = meta.fmt ? meta.fmt(t.val) : String(t.val);
              return (
                <div className="records_top" key={t.key}>
                  <div className="row">
                    <span className="name">{meta.label}</span>
                    <span className="val">
                      {val}
                      <small> {meta.unit}</small>
                    </span>
                  </div>
                  <div className="sub">
                    <Link href={`/user/${t.userId}`}>{t.name}</Link>{" "}
                    <TitleBadge title={pairs[curves.length + i].m} classic={pairs[curves.length + i].c} />　
                    {t.lastCt > 0 ? formatDate(t.lastCt, "Y-m-d") : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </li>
      </ul>
    </div>
  );
}
