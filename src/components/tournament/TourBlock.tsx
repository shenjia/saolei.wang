// 比赛板块（服务端组件，2026-11-13 二期抽出共用）：
// 列表页每场比赛一块；详情页 /tournaments/[id] 顶部板块与列表页完全一致（张老师 14:45 定），
// 两处渲染同一个 TourBlock，保证信息与状态机不漂移。
//
// 七轮修正（张老师 2026-11-14 03:10 口径）：
// · 盒子内部 padding 对齐纪录页（.video_cell.box 的 .box 默认 30px，CSS 兜）；
// · 标题字号对齐纪录页 h1（26px/39px，CSS 兜）；
// · 发起人整块下线（张老师 03:10 定「隐藏发起人」）；
// · 右上角按钮组整组下线（报名/进行中/已结束钮及其 hover 气泡随之退役——报名改走详情页右栏）；
// · 状态标签：绿「进行中」/ 金「未开始」/ 绿「已报名✓」（未结束且已报名时追加）/
//   亮灰「已结束」，圆角描边小标签（配色同全站级别色系）。
//
// 2026-11-18 张老师需求：
// · 标题行不再显示起止日期，改图表下方「比赛时间：11月11日 ~ 12月3日」一行；
// · 「收录级别」更名「比赛级别」；
// · 比赛标识空（未设置）时整行不展示——后台支持手动设置标识后，空标识是常态。

import Link from "next/link";
import {
  fmtDateRange,
  fmtPrize,
  type TourRow,
} from "@/lib/tournament";
import { LEVEL_NAMES } from "@/lib/config";
import { TourChart } from "./TourChart";

/** 「创造于」时刻 → YYYY-MM-DD HH:mm（北京时间；图表行专用，站内其余处走 RelTime） */
function fmtBestAt(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function TourBlock({
  c,
  now,
  loggedIn,
  detail,
}: {
  c: TourRow;
  now: number;
  /** 是否登录（未登录报名按钮渲染为登录跳转链接） */
  loggedIn: boolean;
  /** 详情页形态：标题同 26px/39px（七轮起列表页与详情页标题尺寸一致），
      历史上曾区分 22px 小两号，五轮 20:13 后仅用于关闭「进行中」钮（该钮七轮已退役），
      现仅保留参数位（详情页右栏「开始比赛」双钮仍由页面自身渲染） */
  detail?: boolean;
}) {
  return (
    <div className="box comp_item">
      {/* 标题行：标题+状态标签左，总奖金右（2026-11-18 起止日期移图表下方「比赛时间」行） */}
      <div className="comp_head">
        <div className="comp_title_group">
          <h3 className={"comp_name" + (c.status === "active" ? " on" : "")}>
            <Link className="comp_name_link" href={`/tournaments/${c.id}`}>
              {c.name}
            </Link>
          </h3>
          {/* 状态标签（七轮 03:10 张老师定）：绿「进行中」/金「未开始」/亮灰「已结束」；
              已报名且未结束时追加绿色「已报名✓」（可与前两者并存） */}
          {c.status === "active" && <span className="comp_status_tag st_active">进行中</span>}
          {c.status === "upcoming" && <span className="comp_status_tag st_upcoming">未开始</span>}
          {c.status === "ended" && <span className="comp_status_tag st_ended">已结束</span>}
          {c.joined && c.status !== "ended" && (
            <span className="comp_status_tag st_joined">已报名✓</span>
          )}
        </div>
        <div className="comp_ctrl">
          {/* 总奖金，hover 出分配方案气泡（朝上） */}
          <span className="comp_tipwrap">
            <span className="comp_prize">
              总奖金：<b>{fmtPrize(c.prizeTotal)}</b>
            </span>
            {c.prizeLines.length > 0 && (
              <span className="comp_tip">{`分配方案：${c.prizeLines.join("，")}`}</span>
            )}
          </span>
        </div>
      </div>

      {/* 纪录图表（2026-11-18 晚张老师定：复刻纪录页样式金线+下方阴影+右标尺）——
          上部「最好成绩：xxx 姓名 军衔 创造于 xxx-xx-xx xx:xx」（总分口径第一名）；
          未开始/无成绩保持占位文案 */}
      <div className="comp_chart">
        {c.status !== "upcoming" && c.chartPoints.length > 0 && c.bestLine ? (
          <div className="comp_chart_body">
            <p className="comp_chart_best">
              最好成绩：<b>{(c.bestLine.score / 1000).toFixed(3)}</b>
              <Link className="comp_chart_best_name" href={`/user/${c.bestLine.uid}`}>
                {c.bestLine.name}
              </Link>
              {c.bestLine.title && <span className="comp_chart_best_title">{c.bestLine.title}</span>}
              <span className="comp_chart_best_at">
                创造于 {fmtBestAt(c.bestLine.at)}
              </span>
            </p>
            <TourChart points={c.chartPoints} />
          </div>
        ) : c.status === "upcoming" ? (
          <span className="comp_chart_empty">尚未开始</span>
        ) : (
          <span className="comp_chart_empty">暂无成绩数据</span>
        )}
      </div>

      {/* 信息行（2026-11-18 晚张老师定：比赛级别+比赛标识一行在上，比赛时间一行在下；
          级别标签亮灰（原绿/橙/金圆角标签退役）；标识整段加粗高亮含括号与简称，
          未设置（空）时不渲染） */}
      <div className="comp_meta">
        <span className="comp_levels">
          比赛级别：
          {c.levels.map((l) => (
            <span key={l} className="comp_lv_plain">
              {LEVEL_NAMES[l]}
            </span>
          ))}
        </span>
        {c.code && (
          <span className="comp_code">
            比赛标识：
            <b className="comp_code_all">
              {c.code}({c.shortName})
            </b>
          </span>
        )}
      </div>
      <div className="comp_time_line">
        <span className="comp_time">比赛时间：{fmtDateRange(c.start, c.end)}</span>
      </div>

      <p className="comp_rules">比赛规则：{c.rules}</p>
    </div>
  );
}
