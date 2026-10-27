// 个人主页侧栏「收集墙」版块（2026-10-13 张老师方案，设计稿 design/3bv-collection.html v3；
// 2026-10-27 改「收集墙」：3BV / PB 两个筛选器 + 两种配色，选择记在 localStorage）。
// 每个级别一行：级别名 + 已收集/总数 + 3px 进度条（同筛选器高亮线粗细）+ 方格墙。
// 方格区间 = level_3bv_range 表的站内统计区间（2026-10-14 张老师：下限按现行排行规则
// 钳到 LEVEL_MIN_3BV——初 2 / 中 30 / 高 100，低于下限的 3BV 不再统计完成度），每整数一格。
// 2026-10-22 张老师：区间上限抬到理论最大值（初级 54），50/52/53 三个数学不可达值
// **彻底不渲染**（不留占位缺口，格子墙连续收缩为 50 格，54 为末格、外观与其他格一致）；
// 总数与进度条按「可达值个数」计（与 BV 榜分母同源）。
//
// 两种配色（2026-10-27 张老师定，同一批格子靠 `#user_3bv[data-mode]` 切 CSS，不重渲染）：
//   · 「3BV」模式（默认）：**级别三色**——初绿 #a6e22e / 中橙 #fd971f / 高黄 #e6db74；
//   · 「PB」模式：按该 3BV **最好成绩录像的时间评级**分四档——SSS~S 金 / A~B 玫红 /
//     C~E 紫 / F·? 灰（格子带 g_* 类，CSS 只在 data-mode="pb" 下生效）。
// 选择存 localStorage（键 bbv_mode，**全站共用一份**——张老师要求「查看全站用户都用自己
// 的选择」，即按访问者而非被查看者）。筛选器是**链接**（2026-10-27 二轮：不用按钮），
// href 带 ?bbv=，点击被 BbvModeSync 拦截（不导航，纯 CSS 切换 + replaceState 同步 URL），
// JS 不可用时降级为整页跳转、服务端按 ?bbv= 直接渲染对应配色；为免首屏闪一下 3BV 配色，
// box 内第一段内联脚本在解析到格子之前就把 data-mode 改好（URL 参数优先于 localStorage）。
//
// 悬停出 CSS 气泡：3BV 值 + 最好成绩与评级（2026-10-27 加）+ 该 3BV 录像数与点击提示
// （2026-10-20 张老师要求）；未收集的格子显示「暂无录像」。
// 已收集方格点击跳该 3BV 定向录像列表 /video?author=..&level=..&3bv=..&order=time
// （2026-10-20 张老师需求：筛该玩家该级别该 3BV 全部录像，默认按成绩升序）。
// 除两个内联脚本外无客户端 JS、无 hydration、无 API 路由。

import Link from "next/link";
import { LEVEL_NAMES, VIDEO_LEVELS, UNREACHABLE_3BV, type VideoLevel } from "@/lib/config";
import { gradeColor } from "@/lib/videoscore";
import { scoreTime } from "@/lib/format";
import type { BbvCell } from "@/lib/queries";
import { BbvModeSync } from "./BbvModeSync";

/** localStorage 键：全站共用（张老师 2026-10-27：看任何人的主页都是自己选的那个模式） */
const MODE_KEY = "bbv_mode";

/**
 * 评级 → 方格底色的四档归类（2026-10-27 张老师定：SSS-S 都显示为金色）。
 * 与雷达 GRADE_COLORS 同源取色（gradeColor），只是把相近档并成四档，10px 小格上才分得清：
 *   金 #E6DB74 / 玫红 #FF0080 / 紫 #A000E5 / 灰 #8A8878。尾缀 +/- 不影响档位。
 * ⚠️ 这些类只在 `#user_3bv[data-mode="pb"]` 下生效，3BV 模式下格子走级别三色。
 */
function gradeTone(grade: string): string {
  const g = grade.replace(/[+-]$/, "");
  if (g === "SSS" || g === "SS" || g === "S") return "g_gold";
  if (g === "A" || g === "B") return "g_rose";
  if (g === "C" || g === "D" || g === "E") return "g_violet";
  return "g_gray"; // F / ?
}

/** 首屏防闪：解析到这里时 box 已在 DOM 上（currentScript 的父节点），先定模式。
 *  优先级：URL ?bbv= > localStorage > 默认 3bv（与服务端 initialMode 同一优先级，
 *  URL 明确给了 3bv 时不得被 localStorage 的 pb 闪回去）。
 *  ⚠️ 只设 data-mode 这一个属性——tab 高亮与格子配色全由 CSS 跟着它走，脚本不碰任何 class，
 *  hydration 差异被 box 上的 suppressHydrationWarning 吃掉（属性差异 React 不会回填）。 */
const APPLY_MODE_SCRIPT = `(function(){var q="",m="";try{q=new URLSearchParams(location.search).get("bbv")||""}catch(e){}try{m=localStorage.getItem("${MODE_KEY}")||""}catch(e){}var v=(q==="3bv"||q==="pb")?q:(m==="3bv"||m==="pb"?m:"3bv");if(v==="pb")document.currentScript.parentNode.setAttribute("data-mode","pb")})();`;

export function BbvCollection({
  userId,
  ranges,
  collected,
  initialMode = "3bv",
}: {
  /** 玩家 id（已收集方格的定向列表链接 /video?author= 与筛选器链接 /user/{id}?bbv= 用） */
  userId: number;
  ranges: Partial<Record<VideoLevel, { min: number; max: number }>>;
  /** level -> (3BV -> 该 3BV 的录像数 + 最好成绩录像与评级)（口径见 getUser3bvCollection） */
  collected: Record<VideoLevel, Map<number, BbvCell>>;
  /** 服务端初始配色（URL ?bbv= 明确指定时用它；无参数时默认 3bv，客户端再按 localStorage 校正） */
  initialMode?: "3bv" | "pb";
}) {
  return (
    <div className="box" id="user_3bv" data-mode={initialMode} suppressHydrationWarning>
      <script dangerouslySetInnerHTML={{ __html: APPLY_MODE_SCRIPT }} />
      <div className="bbv_title">
        <h2>收集墙</h2>
        <div className="bbv_tabs" aria-label="收集墙配色">
          <Link
            className="bbv_tab"
            data-mode="3bv"
            href={`/user/${userId}?bbv=3bv`}
            prefetch={false}
          >
            3BV
          </Link>
          <Link
            className="bbv_tab"
            data-mode="pb"
            href={`/user/${userId}?bbv=pb`}
            prefetch={false}
          >
            PB
          </Link>
        </div>
      </div>
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
                          <b className="gr" style={{ color: gradeColor(cell.grade) }}>
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
      {/* 模式同步器：挂载时校正 data-mode（内联脚本管不到 RSC 软导航）+ 委托点击 */}
      <BbvModeSync />
    </div>
  );
}
