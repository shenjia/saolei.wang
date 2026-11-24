// 比赛板块（服务端组件，2026-11-13 二期抽出共用）：
// 列表页每场比赛一块；详情页 /tournaments/[id] 顶部板块与列表页完全一致（张老师 14:45 定），
// 两处渲染同一个 TourBlock，保证信息与状态机不漂移。
//
// 七轮修正（张老师 2026-11-14 03:10 口径）：
// · 盒子内部 padding 对齐纪录页（.video_cell.box 的 .box 默认 30px，CSS 兜）；
// · 标题字号对齐纪录页 h1（26px/39px，CSS 兜）；
// · 发起人整块下线（张老师 03:10 定「隐藏发起人」）；
// · 右上角按钮组整组下线（报名/进行中/已结束钮及其 hover 气泡随之退役——报名改走详情页右栏）；
// · 状态标签：绿「进行中」/ 金「未开始」/ 绿「已报名✓」（仅未开赛且已报名时追加）/
//   亮灰「已结束」，圆角描边小标签（配色同全站级别色系）。
//   2026-11-24 张老师需求：已开赛（status=active/ended）标题后不再显示「已报名✓」，
//   列表页与详情页共用本组件，一处改动两页同效。
//
// 2026-11-18 张老师需求：
// · 标题行不再显示起止日期，改图表下方「比赛时间：11月11日 ~ 12月3日」一行；
// · 「收录级别」更名「比赛级别」；
// · 比赛标识空（未设置）时整行不展示——后台支持手动设置标识后，空标识是常态。
//
// 2026-11-22 张老师需求（窗口赛标识口径）：
// · 窗口赛（windowHours>0）不走全局标识：个人未开窗口显示「开赛后生成个人标识」；
//   已开窗口（mySession）显示个人会话标识（上传挂接只认它）；个人窗口已结束
//   （比赛未结束）仍显示全局 code 存档（空则不显示整行）。

import Link from "next/link";
import {
  fmtDateRange,
  fmtPrize,
  type TourRow,
} from "@/lib/tournament";
import { fmtTourScore, TOUR_METRICS } from "@/lib/tour-metric";
import { LEVEL_NAMES } from "@/lib/config";
import { AvatarCell } from "@/components/Cells";
import { TitleBadge } from "@/components/TitleBadge";
import { TourChart } from "./TourChart";

/** 图表标尺小数位：3bv/crossings 整数，其余 3 位（2026-11-21 多数据项） */
function chartDigits(metric: TourRow["scoreMetric"]): number {
  return TOUR_METRICS[metric]?.digits ?? 3;
}

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
  myUid,
}: {
  c: TourRow;
  now: number;
  /** 是否登录（未登录报名按钮渲染为登录跳转链接） */
  loggedIn: boolean;
  /** 详情页形态：标题同 26px/39px（七轮起列表页与详情页标题尺寸一致），
      历史上曾区分 22px 小两号，五轮 20:13 后仅用于关闭「进行中」钮（该钮七轮已退役），
      现仅保留参数位（详情页右栏「开始比赛」双钮仍由页面自身渲染） */
  detail?: boolean;
  /** 观看者 uid（2026-11-19 张老师定：参赛且在榜 → 图表绿点+垂线标记我的位置） */
  myUid?: number;
}) {
  return (
    <div className="box comp_item">
      {/* 标题行：标题+状态标签左，总奖金右（2026-11-18 起止日期移图表下方「比赛时间」行） */}
      <div className="comp_head">
        <div className="comp_title_group">
          {/* 标题颜色（2026-11-19 张老师定）：详情页恒金色；列表页已结束亮灰、
              其余金色。链接优先比赛代号（2026-11-19：/tournaments/<alias> 避免裸 id） */}
          <h3 className={"comp_name" + (detail || c.status !== "ended" ? " on" : "")}>
            <Link className="comp_name_link" href={`/tournaments/${c.alias || c.id}`}>
              {c.name}
            </Link>
          </h3>
          {/* 状态标签（七轮 03:10 张老师定）：绿「进行中」/金「未开始」/亮灰「已结束」；
              2026-11-24 张老师定：「已报名✓」只在未开赛（upcoming）时追加，
              已开赛（active/ended）标题后不再显示 */}
          {c.status === "active" && <span className="comp_status_tag st_active">进行中</span>}
          {c.status === "upcoming" && <span className="comp_status_tag st_upcoming">未开始</span>}
          {c.status === "ended" && <span className="comp_status_tag st_ended">已结束</span>}
          {c.joined && c.status === "upcoming" && (
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

      {/* 纪录图表（2026-11-19 凌晨张老师定：严格复刻纪录页 rec_card——深底 #1e1f1c、
          金线+下方阴影、右标尺、hover 气泡）——上部「最好成绩」行严格复刻 rec_head：
          元帅金大数字 + 性别 + 军衔徽章。
          2026-11-19 早张老师定：无数据比赛也渲染同款卡片占位（同样式的深底空卡），
          中间「尚无成绩数据」，不再是裸文本——视觉上与有数据的比赛一致 */}
      <div className="comp_chart">
        {c.status !== "upcoming" && c.chartPoints.length > 0 && c.bestLine ? (
          <div className="rec_card comp_chart_body">
            <div className="rec_head">
              <span className="rec_name">最好成绩：</span>
              <b className="rec_val">{fmtTourScore(c.scoreMetric, c.bestLine.score)}</b>
              <span className="rec_meta">　</span>
              <AvatarCell
                id={c.bestLine.uid}
                name={c.bestLine.name}
                sex={c.bestLine.sex}
                link
                className="rec_user"
                gender="small"
              />
              {c.bestLine.title && <TitleBadge title={c.bestLine.title} link />}
              {/* at>0 才显示「创造于」（列表形态为省查询不取精确时刻） */}
              {!!c.bestLine.at && <span className="rec_meta">　创造于 {fmtBestAt(c.bestLine.at)}</span>}
            </div>
            <TourChart points={c.chartPoints} myUid={myUid} desc={c.scoreDesc} digits={chartDigits(c.scoreMetric)} />
          </div>
        ) : (
          <div className="rec_card comp_chart_body">
            {/* 2026-11-19 早张老师定：占位卡左上角不显示「最好成绩」，只留居中文案（稍大） */}
            <div className="comp_chart_placeholder">
              {c.status === "upcoming" ? "尚未开始" : "尚无成绩数据"}
            </div>
          </div>
        )}
      </div>

      {/* 信息行（2026-11-19 早张老师定：级别用级别色绿/橙/金不加粗；
          标识不带括号简称——已开始亮灰、未开始暗灰「待定」；
          2026-11-22 张老师需求：窗口赛（个人计时）统一标识无意义——
          未开个人窗口显示「开赛后生成个人标识」，开赛后显示个人会话标识
          （上传挂接只认它，同右栏 WindowPlayBox）；已结束回退全局标识存档） */}
      <div className="comp_meta">
        <span className="comp_levels">
          比赛级别：
          {c.levels.map((l) => (
            <span key={l} className={"comp_lv_plain comp_lv_" + l}>
              {LEVEL_NAMES[l]}
            </span>
          ))}
        </span>
        {c.windowHours > 0 ? (
          c.mySession ? (
            <span className="comp_code">
              比赛标识：
              <b className="comp_code_started" title={c.mySession.finished ? "个人比赛窗口已结束（已完赛）" : "上传录像时此标识自动挂接本比赛"}>
                {c.mySession.race}
              </b>
            </span>
          ) : c.status === "ended" ? (
            c.code && (
              <span className="comp_code">
                比赛标识：
                <b className="comp_code_started">{c.code}</b>
              </span>
            )
          ) : (
            <span className="comp_code">
              比赛标识：
              <b className="comp_code_pending">开赛后生成个人标识</b>
            </span>
          )
        ) : c.status === "upcoming" ? (
          <span className="comp_code">
            比赛标识：
            <b className="comp_code_pending">待定</b>
          </span>
        ) : (
          c.code && (
            <span className="comp_code">
              比赛标识：
              <b className="comp_code_started">{c.code}</b>
            </span>
          )
        )}
      </div>
      <div className="comp_time_line">
        <span className="comp_time">
          比赛时间：{fmtDateRange(c.start, c.end)}
          {/* 窗口赛括号文案（2026-11-19 张老师定）：自选 X 小时窗口 */}
          {c.windowHours > 0 && <span className="comp_time_window">（任选 {c.windowHours} 小时）</span>}
        </span>
      </div>

      <p className="comp_rules">比赛规则：{c.rules}</p>
    </div>
  );
}
