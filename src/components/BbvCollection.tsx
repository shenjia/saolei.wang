// 个人主页侧栏「3BV / PB」版块（2026-10-13 张老师方案，设计稿 design/3bv-collection.html v3；
// 2026-10-27 改「3BV / PB」：每格渲染该 3BV 最好成绩录像的时间评级）。
// 每个级别一行：级别名 + 已收集/总数 + 3px 进度条（同筛选器高亮线粗细）+ 方格墙。
// 方格区间 = level_3bv_range 表的站内统计区间（2026-10-14 张老师：下限按现行排行规则
// 钳到 LEVEL_MIN_3BV——初 2 / 中 30 / 高 100，低于下限的 3BV 不再统计完成度），每整数一格。
// 2026-10-22 张老师：区间上限抬到理论最大值（初级 54），50/52/53 三个数学不可达值
// **彻底不渲染**（不留占位缺口，格子墙连续收缩为 50 格，54 为末格、外观与其他格一致）；
// 总数与进度条按「可达值个数」计（与 BV 榜分母同源）。
//
// 方格配色（2026-10-27 张老师要求）：不再按级别色，改按**该 3BV 最好成绩录像的时间评级**
// 分四档——SSS/SS/S 金、A/B 玫红、C/D/E 紫、F 及无法评级(?) 灰。级别色保留在
// 级别名 / 收集数 / 进度条上（初绿中橙高黄），两套色不冲突。
// 悬停出 CSS 气泡（2026-10-13 张老师要求）：3BV 值 + 最好成绩与评级（2026-10-27 加）
// + 该 3BV 录像数与点击提示（2026-10-20 张老师要求）；未收集的格子显示「暂无录像」。
// 已收集方格点击跳该 3BV 定向录像列表 /video?author=..&level=..&3bv=..&order=time
// （2026-10-20 张老师需求：筛该玩家该级别该 3BV 全部录像，默认按成绩升序；
// 原先直开首个录像详情的 target=_blank 属「录像链接」惯例，目标是列表页后改为当前标签导航）。
// 纯服务端渲染：气泡也是纯 CSS（:hover 显隐），无 hydration、无 API 路由、无任何客户端 JS。

import Link from "next/link";
import { LEVEL_NAMES, VIDEO_LEVELS, UNREACHABLE_3BV, type VideoLevel } from "@/lib/config";
import { gradeColor } from "@/lib/videoscore";
import { scoreTime } from "@/lib/format";
import type { BbvCell } from "@/lib/queries";

/**
 * 评级 → 方格底色的四档归类（2026-10-27 张老师定：SSS-S 都显示为金色）。
 * 与雷达 GRADE_COLORS 同源取色（gradeColor），只是把相近档并成四档，10px 小格上才分得清：
 *   金 #E6DB74 / 玫红 #FF0080 / 紫 #A000E5 / 灰 #8A8878。尾缀 +/- 不影响档位。
 */
function gradeTone(grade: string): string {
  const g = grade.replace(/[+-]$/, "");
  if (g === "SSS" || g === "SS" || g === "S") return "g_gold";
  if (g === "A" || g === "B") return "g_rose";
  if (g === "C" || g === "D" || g === "E") return "g_violet";
  return "g_gray"; // F / ?
}

export function BbvCollection({
  userId,
  ranges,
  collected,
}: {
  /** 玩家 id（已收集方格的定向列表链接 /video?author= 用） */
  userId: number;
  ranges: Partial<Record<VideoLevel, { min: number; max: number }>>;
  /** level -> (3BV -> 该 3BV 的录像数 + 最好成绩录像与评级)（口径见 getUser3bvCollection） */
  collected: Record<VideoLevel, Map<number, BbvCell>>;
}) {
  return (
    <div className="box" id="user_3bv">
      <h2>3BV / PB</h2>
      {VIDEO_LEVELS.map((level) => {
        const range = ranges[level];
        if (!range) return null;
        // 区间内可达值序列（2026-10-22）：跳过数学不可达值（初级 50/52/53），
        // 方格墙留空槽、分母/进度条均按此序列计
        const dead = new Set(UNREACHABLE_3BV[level] ?? []);
        const values: number[] = [];
        for (let b = range.min; b <= range.max; b++) if (!dead.has(b)) values.push(b);
        const total = values.length;
        if (total <= 0) return null;
        const map = collected[level];
        const n = values.reduce((acc, b) => acc + (map.has(b) ? 1 : 0), 0);
        const pct = (n / total) * 100;
        return (
          <div className={`bbv_level ${level}`} key={level}>
            <div className="bbv_head">
              <span className="bbv_name">{LEVEL_NAMES[level]}</span>
              <span className="bbv_stat">
                <em>{n}</em>/{total}
              </span>
            </div>
            <div className="bbv_bar">
              <div className="bbv_fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="bbv_grid">
              {values.map((b) => {
                // 已收集 = 该 3BV 有录像（cell），未收集 = undefined
                const cell = map.get(b);
                const tip = (
                  <i className="tip">
                    <b>3BV = {b}</b>
                    {cell ? (
                      <>
                        {/* 2026-10-27 张老师要求：3BV 行下加「最好成绩 + 评级」 */}
                        <span>
                          最好成绩：<em>{scoreTime(cell.bestTime)}</em> 秒　评级：
                          <b
                            className="gr"
                            style={{ color: gradeColor(cell.grade) }}
                          >
                            {cell.grade}
                          </b>
                        </span>
                        <span>
                          共 <em>{cell.n}</em> 个录像，点击查看
                        </span>
                      </>
                    ) : (
                      <span>暂无录像</span>
                    )}
                  </i>
                );
                return cell ? (
                  <Link
                    key={b}
                    className={`sq on ${gradeTone(cell.grade)}`}
                    href={`/video?author=${userId}&level=${level}&3bv=${b}&order=time`}
                  >
                    {tip}
                  </Link>
                ) : (
                  <span key={b} className="sq">
                    {tip}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
