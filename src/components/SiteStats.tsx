// 首页右栏统计盒（移植 2008 版 Main/Satus.asp，原版标题「雷界统计」）
// 2026-09-27 张老师要求：数字亮灰加粗；今日有新数据时绿色显示增量（全站统一）。
// 2026-10-13 张老师要求：①增量不写「今日」二字；②增量单独占一列（三列：标签 | 数值 | 增量），
//   原先「数值（+N）」挤在一格，各行数值位数不同就对齐不了；③增量带括号且靠右边缘。
// 2026-10-13 二轮（张老师要求）：①行名统一为「动作」口径——录像总数→上传录像、
//   论坛主题→发布主题、评论总数→发布评论；②「发布评论」移到最底行（顺序见下）。
// 2026-10-13 三轮：标题「雷界统计」→「数据统计」（与 /video 右栏同标题）。
// 2026-10-22 张老师要求：行名回正——「发布主题」→「论坛主题」、「发布评论」→「论坛评论」
//   （数据源同步换 bbs_reply）；「上传录像」下新增一行「录像评论」（原 comment 表数据
//   各归各位）。行序：录像评论紧贴上传录像、论坛评论固定最底行。
// 2026-10-22 二轮：「论坛主题」下新增「在线练习」行——practice_log 累计练习盘数
//   +今日增量（口径同「今日练习」板块：胜负都算、游客局也计）；论坛评论仍固定最底行。
// 2026-10-22 三轮（张老师要求）：行名「在线练习」改「练习盘数」，行位由「论坛主题」下
//   移至「排行人数」之下（与上传录像等 UGC 行分区分开，紧跟人数类指标）。
// 排行人数无「今日」增量——user_scores.create_time 是注册时间非上榜时间，历史数据不干净。
// 2026-11-02 张老师要求：底部新增「资金结余」行——赞助页同口径结余（donate 合计 −
// donate_expense 合计），正数金色、负数红色，点击跳赞助页 /page/donate。

import Link from "next/link";
import { getSiteStats } from "@/lib/queries";

function StatRow({
  label,
  total,
  today,
  children,
}: {
  label: string;
  total?: number;
  today?: number;
  /** 自定义数值单元格（如资金结余的彩色 Link）；提供时忽略 total */
  children?: React.ReactNode;
}) {
  const hasDelta = today !== undefined && today > 0;
  return (
    <tr>
      <td className="label">{label}</td>
      <td className="num">{children ?? <em>{total}</em>}</td>
      <td className="delta">{hasDelta ? `（+${today}）` : ""}</td>
    </tr>
  );
}

export async function SiteStats() {
  const s = await getSiteStats();
  return (
    <div id="site_stats" className="box">
      <h2>数据统计</h2>
      <table cellPadding={0} cellSpacing={0} className="table full">
        <tbody>
          <StatRow label="雷友总数" total={s.userTotal} today={s.userToday} />
          <StatRow label="排行人数" total={s.rankedTotal} />
          {/* 2026-10-22 张老师要求：新增「练习盘数」——practice_daily 汇总；
              2026-11-13 张老师定：改按「完成盘数」口径（wins 列，含游客完成局）——
              尝试盘数含踩雷可刷，完成才是有效盘数；行位移到「排行人数」之下 */}
          <StatRow label="练习盘数" total={s.practiceTotal} today={s.practiceToday} />
          <StatRow label="上传录像" total={s.videoTotal} today={s.videoToday} />
          {/* 2026-10-22 张老师要求：新增「录像评论」（原「发布评论」的 comment 表数据归此处） */}
          <StatRow label="录像评论" total={s.commentTotal} today={s.commentToday} />
          <StatRow label="论坛主题" total={s.bbsTotal} today={s.bbsToday} />
          {/* 论坛评论固定在最底行（2026-10-13 张老师要求；2026-10-22 换数据源 bbs_reply） */}
          <StatRow label="论坛评论" total={s.bbsReplyTotal} today={s.bbsReplyToday} />
          {/* 2026-11-02 张老师要求：底部新增「资金结余」行（赞助页同口径结余）；
              正数金色、负数红色；点击跳赞助页——target=_blank 必配 prefetch=false（铁律）。
              2026-11-02 二轮（张老师要求）：不显示小数——四舍五入取整到元，与整列整数对齐；
              赞助页 donateYuanPlain 口径不变 */}
          <StatRow label="资金结余">
            <Link href="/page/donate" target="_blank" prefetch={false}>
              <em className={s.donateBalanceCents >= 0 ? "balance_pos" : "balance_neg"}>
                {`${s.donateBalanceCents < 0 ? "-" : ""}¥${Math.round(
                  Math.abs(s.donateBalanceCents) / 100
                ).toLocaleString("zh-CN")}`}
              </em>
            </Link>
          </StatRow>
        </tbody>
      </table>
    </div>
  );
}
