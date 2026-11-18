// 比赛板块（服务端组件，2026-11-13 二期抽出共用）：
// 列表页每场比赛一块；详情页 /competitions/[id] 顶部板块与列表页完全一致（张老师 14:45 定），
// 两处渲染同一个 CompBlock，保证信息与状态机不漂移。
//
// 七轮修正（张老师 2026-11-14 03:10 口径）：
// · 盒子内部 padding 对齐纪录页（.video_cell.box 的 .box 默认 30px，CSS 兜）；
// · 标题字号对齐纪录页 h1（26px/39px，CSS 兜）；
// · 发起人整块下线（张老师 03:10 定「隐藏发起人」）；
// · 右上角按钮组整组下线（报名/进行中/已结束钮及其 hover 气泡随之退役——报名改走详情页右栏）；
// · 起止日期后加彩色状态标签：绿「进行中」/ 金「未开始」/ 绿「已报名✓」（未结束且已报名时追加）/
//   亮灰「已结束」，圆角描边小标签（配色同全站级别色系）。

import Link from "next/link";
import {
  fmtDateRange,
  fmtPrize,
  type CompRow,
} from "@/lib/competition";
import { LEVEL_NAMES } from "@/lib/config";

export function CompBlock({
  c,
  now,
  loggedIn,
  detail,
}: {
  c: CompRow;
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
      {/* 标题行：标题+日期+状态标签左，总奖金右 */}
      <div className="comp_head">
        <div className="comp_title_group">
          <h3 className={"comp_name" + (c.status === "active" ? " on" : "")}>
            <Link className="comp_name_link" href={`/competitions/${c.id}`}>
              {c.name}
            </Link>
          </h3>
          <span className="comp_dates">{fmtDateRange(c.start, c.end)}</span>
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

      {/* 纪录图表：x=排名（最右为 1）y=成绩；本期成绩采集未接入，无数据占位 */}
      <div className="comp_chart">
        {c.status === "upcoming" ? (
          <span className="comp_chart_empty">尚未开始</span>
        ) : (
          <span className="comp_chart_empty">暂无成绩数据</span>
        )}
      </div>

      {/* 信息行（2026-11-13 张老师定：收录级别一行在上，比赛标识一行在下）——
          标识整段加粗高亮，含括号与简称；级别渲染为圆角标签（六轮 23:20 定，
          配色复用后台 LevelTag 同款：初级绿/中级橙/高级金） */}
      <div className="comp_meta">
        <span className="comp_levels">
          收录级别：
          {c.levels.map((l) => (
            <span key={l} className={"comp_lv_tag lv_" + l}>
              {LEVEL_NAMES[l]}
            </span>
          ))}
        </span>
        <span className="comp_code">
          比赛标识：
          {c.status === "upcoming" ? (
            "待定"
          ) : (
            <b className="comp_code_all">
              {c.code}({c.shortName})
            </b>
          )}
        </span>
      </div>

      <p className="comp_rules">比赛规则：{c.rules}</p>
    </div>
  );
}
