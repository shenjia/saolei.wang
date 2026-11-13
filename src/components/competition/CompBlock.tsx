// 比赛板块（服务端组件，2026-11-13 二期抽出共用）：
// 列表页每场比赛一块；详情页 /competitions/[id] 顶部板块与列表页完全一致（张老师 14:45 定），
// 两处渲染同一个 CompBlock，保证信息与状态机不漂移。
//
// 二轮修正（张老师 14:45 口径）：
// · 标题可点进详情页，字号与全站主标题一致（26px）；只有进行中金色；
// · 报名气泡两行：第一行报名信息（人数金色），第二行开始时间（时长绿色）；
// · 已结束气泡两行：第一行已于xx结束，第二行白字「点击查看详细结果」；
//   按钮本体 hover 变亮灰 + 文字切换「查看结果」，点击进详情页；
// · 信息行：比赛标识在左（展示时整段加粗高亮，含括号与简称）、发起人在右；
// · 总奖金字号比标题小两号（26px 主标题 → 18px，14:45 二轮再放大）；
// · 「开始比赛」hover 文字不得变绿（#page a:hover 特异性覆盖，见 globals.css）。

import Link from "next/link";
import { SignupButton } from "./SignupButton";
import {
  fmtDateRange,
  fmtDuration,
  fmtEndedAt,
  fmtPrize,
  remainColor,
  type CompRow,
} from "@/lib/competition";

export function CompBlock({
  c,
  now,
  loggedIn,
}: {
  c: CompRow;
  now: number;
  /** 是否登录（未登录报名按钮渲染为登录跳转链接） */
  loggedIn: boolean;
}) {
  return (
    <div className="box comp_item">
      {/* 标题行：标题+日期左，总奖金+按钮右 */}
      <div className="comp_head">
        <div className="comp_title_group">
          <h3 className={"comp_name" + (c.status === "active" ? " on" : "")}>
            <Link className="comp_name_link" href={`/competitions/${c.id}`}>
              {c.name}
            </Link>
          </h3>
          <span className="comp_dates">{fmtDateRange(c.start, c.end)}</span>
        </div>
        <div className="comp_ctrl">
          {/* 总奖金（26px 主标题小两号），hover 出分配方案气泡（朝上） */}
          <span className="comp_tipwrap">
            <span className="comp_prize">
              总奖金：<b>{fmtPrize(c.prizeTotal)}</b>
            </span>
            {c.prizeLines.length > 0 && (
              <span className="comp_tip">{`分配方案：${c.prizeLines.join("，")}`}</span>
            )}
          </span>

          {c.status === "upcoming" && (
            <span className="comp_tipwrap">
              <span className="comp_btn_zone">
                {loggedIn ? (
                  <SignupButton compId={c.id} joined={c.joined} name={c.name} />
                ) : (
                  <Link className="comp_btn comp_btn_join" href="/account/login?next=/competitions">
                    报名参加
                  </Link>
                )}
              </span>
              {/* 两行气泡（14:45 定）：报名信息在上，开始时间在下（时长绿色） */}
              <span className="comp_tip">
                <span className="comp_tip_line">
                  已有<b className="gold">{c.entryCount}</b>位玩家报名
                </span>
                <span className="comp_tip_line">
                  <span className="comp_tip_time">{fmtDuration(Math.max(c.start - now, 0))}</span>后开始
                </span>
              </span>
            </span>
          )}

          {c.status === "active" && (
            <span className="comp_tipwrap">
              {/* 开赛 → /online?c=比赛ID（张老师 15:14 定：带比赛 ID 进练习页比赛模式；
                  三轮 16:40 定文案「开赛」；四轮 20:03 定新标签页打开） */}
              <a className="vs_fight comp_link" href={`/online?c=${c.id}`} target="_blank">
                开赛
              </a>
              <span className="comp_tip">
                <b style={{ color: remainColor(c.end - now) }}>
                  {fmtDuration(Math.max(c.end - now, 0))}
                </b>
                后结束
              </span>
            </span>
          )}

          {c.status === "ended" && (
            <span className="comp_tipwrap">
              {/* 已结束 → 可点进详情页；hover 文字切「看结果」+ 按钮提亮为亮灰（14:45 定）；
                  四轮 20:03 定新标签页打开（铁律：_blank 的 Link 必须 prefetch={false}，
                  新标签页预取缓存无用、纯吃 nginx 限速配额 e77f131） */}
              <Link className="comp_btn comp_btn_ended comp_btn_result" href={`/competitions/${c.id}`} target="_blank" prefetch={false}>
                <span className="lbl_a">已结束</span>
                <span className="lbl_b">看结果</span>
              </Link>
              <span className="comp_tip">
                <span className="comp_tip_line">
                  已于<b>{fmtEndedAt(c.end, now)}</b>结束
                </span>
                <span className="comp_tip_line white">点击查看详细结果</span>
              </span>
            </span>
          )}
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

      {/* 信息行（三轮 16:40 定：发起人单独一行局左在上，比赛标识一行在下）——
          标识整段加粗高亮，含括号与简称 */}
      <div className="comp_meta">
        <span className="comp_creator">发起人：{c.creatorName}</span>
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
