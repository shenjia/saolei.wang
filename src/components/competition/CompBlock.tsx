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
import { AvatarCell, TitleBadge } from "@/components/Cells";
import {
  fmtDateRange,
  fmtDuration,
  fmtEndedAt,
  fmtPrize,
  remainColor,
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
  /** 详情页形态（五轮 20:13 张老师定）：标题恢复首页标准 26px/39px；不渲染「开赛」按钮
      （入口移到右栏「开始比赛」双钮行）——列表页保持三轮 22px 小两号口径不变 */
  detail?: boolean;
}) {
  return (
    <div className="box comp_item">
      {/* 标题行：标题+日期左，总奖金+按钮右 */}
      <div className="comp_head">
        <div className="comp_title_group">
          <h3 className={"comp_name" + (c.status === "active" ? " on" : "") + (detail ? " comp_name_lg" : "")}>
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

          {/* 未开始：报名三态钮（五轮 20:13 定）——未报名默认亮灰「报名中」hover 绿
              「报名参赛」；已报名 hover 玫瑰红「退赛」（confirmDialog 确认）；未登录
              点击弹登录浮窗（SignupButton 内 dispatch app:login） */}
          {c.status === "upcoming" && (
            <span className="comp_tipwrap">
              <span className="comp_btn_zone">
                <SignupButton compId={c.id} joined={c.joined} name={c.name} loggedIn={loggedIn} />
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

          {!detail && c.status === "active" && (
            <span className="comp_tipwrap">
              {/* 进行中：绿色「进行中」链接钮（五轮 20:13 定）——点击与标题一样进详情页
                  （本页跳转，原「开赛」钮退役）；保留「xx后结束」气泡 */}
              <Link className="comp_btn comp_btn_active" href={`/competitions/${c.id}`}>
                进行中
              </Link>
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

      {/* 发起人（2026-11-13 张老师定：移到图表下方右侧对齐，名字展示与玩家卡片一致
          ——首页同款 AvatarCell（性别图标+名气泡）+ TitleBadge（军衔徽章）） */}
      <div className="comp_creator">
        <span>发起人：</span>
        <AvatarCell
          id={c.creatorId}
          name={c.creatorName}
          englishName={c.creatorEnglishName}
          sex={c.creatorSex}
          gender="small"
          link
        />
        <TitleBadge title={c.creatorTitle} classic={c.creatorClassic} link />
      </div>

      {/* 信息行（2026-11-13 张老师定：收录级别一行在上，比赛标识一行在下）——
          标识整段加粗高亮，含括号与简称 */}
      <div className="comp_meta">
        <span className="comp_levels">
          收录级别：
          {c.levels.map((l) => LEVEL_NAMES[l]).join("、")}
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
