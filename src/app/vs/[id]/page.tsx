// 玩家对战 PK 页（2026-11-09 张老师需求）：
// 入口 = 用户主页性别图标+对话气泡右侧、侧栏玩家卡片对话气泡正下方的对战按钮。
// 布局（二轮改版 2026-11-09 张老师反馈定稿）：
//   ① 对战主视觉：#page.main 主站标准宽度；左右两个独立 .box 玩家面板（结构严格
//      照抄侧栏玩家卡片 .user_card：头像/AvatarCell 姓名+性别/TitleBadge 军衔/ranks），
//      横线以下放实力雷达（无标题），中间 VS 战斗字标图标；
//   ② 纪录（3 级别 × 时间/3BV/s/STNB，共 9 行，22:02 张老师）：头部（标题+双方
//      得分框+胜数）移到板块盒外部（22:24）；盒内表格三列＝左成绩｜项目｜右成绩
//      （22:57 结果列删除），胜方成绩格加自己阵营实底（我蓝／对手玫红），
//      纪录名按胜方色渲染（我方胜蓝 / 对方胜玫红 / 平金 / 都无亮灰）；
//   ③ 各BV比拼：初级/中级/高级各一盒，头部同样在盒外；
//      每行格子严格按「我胜/我独有/都没有/对方独有/对方胜」重排，行 = 十位段
//      （初级首段 0-9，0/1 与 50/52/53 为补位空格归「都没有」区）；hover 出
//      三行气泡「BV = n / 我方名：xx.xx / 对方名：xx.xx」，胜方整行金色、负方亮灰；
//      2026-11-10 21:16 起：无行首范围、无行尾比分、无本级得分行、无底部图例/规则模块。
//   ⑤ 22:20/22:24 张老师：计分规则不在板块内部占用空间，合并成页面最下方唯一一份
//      独立说明（不带 .box 包裹），随赛后板块一起出现。
//   ⑥ 22:23/22:24 张老师：头部得分框＝玩家色实底圆角矩形（蓝底黑字/玫红底白字）；
//      红方胜数、独有数放在得分框左侧；标题与双方统计整行在板块盒外部。
//   ④ 2026-11-10 第五轮：结果板块已删，总分挂 VS 两侧；赛前隐藏一切数字/胜败字/
//      下方板块，只留「战前预估评价 + 决出胜负按钮」；点击后按钮渐隐、评价渐隐、
//      两侧面板向左右滑开，再跑分；跑分完成下方板块才出现、图标下方换成赛后评价
//      （详见 VsScoreBoard 状态机）。
// 得分规则（张老师 2026-11-09 定，23:50 终版）：纪录 9 行按初/中/高 1/2/10 分
// 权重计（优者满分、独有 0.25、平局 0）；三级别 BV 格每胜一局固定 1 分、独有
// 0.25、平局 0。页面底部「计分规则」文案见 VS_RULE_TEXT。

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getHeaderUser } from "@/lib/usercard";
import { getVsData, type VsCell, type VsLevelPk, type VsPlayer, type VsRecRow } from "@/lib/vs";
import { scoreTime } from "@/lib/format";
import { AREA_OVERSEAS, areaDisplay } from "@/lib/config";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { DefaultAvatar } from "@/components/DefaultAvatar";
import { RadarChart } from "@/components/RadarChart";
import { VsScoreBoard } from "@/components/VsScoreBoard";

export const dynamic = "force-dynamic";

const LEVEL_CN: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
/** 级别标准配色：初绿 / 中橙 / 高黄（与 3BV 收集等板块同源） */
const LEVEL_COLOR: Record<string, string> = { beg: "#a6e22e", int: "#fd971f", exp: "#e6db74" };

/** 页面最下方「计分规则」（22:02 张老师逐字指定文案，不得改写；22:20 改为只出现
 *  一次）：此前纪录 / 初级 / 中级 / 高级四个板块各内嵌一份相同说明，占板块内部空间，
 *  现合并为 below 末尾唯一一份独立段落（不带 .box），不占任何板块盒内空间。 */
const VS_RULE_TEXT = "初中高级纪录胜一局1/2/10分，BV胜一局计1分，独有计0.25分";
/** 规则行下方的致谢声明（2026-11-11 02:00 张老师逐字指定，02:06 去掉「声明」两字） */
const VS_DECLARE_TEXT =
  "BV对抗系统借鉴了钟言开发的小瞄机器人，特在此表示感谢";
function VsRule() {
  return (
    <div className="vs_rule">
      <p className="vs_rule_line">
        <span className="vs_rule_label">规则：</span>
        <span className="vs_rule_text">{VS_RULE_TEXT}</span>
      </p>
      <p className="vs_rule_line vs_declare">{VS_DECLARE_TEXT}</p>
    </div>
  );
}

/** 浏览器标签页标题（2026-11-10 张老师定）：「我方名 vs 对方名」，
 *  与页面左右布局同序；站点后缀由根布局 title.template 统一拼接。
 *  这里只取姓名两条轻量查询，不复用 getVsData（会重复拉 BV/雷达/STNB 全量数据）。 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const targetId = parseInt(id, 10);
  if (!targetId) return { title: "玩家对战" };
  const session = await getSession();
  // 未登录会跳登录页；自己和自己比拼走兜底提示，两种都不暴露对手姓名
  if (!session || session.uid === targetId) return { title: "玩家对战" };
  const [me, rival] = await Promise.all([
    getHeaderUser(session.uid),
    getHeaderUser(targetId),
  ]);
  if (!me || !rival) return { title: "玩家对战" };
  return { title: `${me.chineseName} vs ${rival.chineseName}` };
}

/** 格子归属配色（与 globals.css .vs_c 同步维护：改这里必须改 CSS 注释说明）。
 *  2026-11-10 张老师：我的颜色一律用蓝（#66d9ef 系）不用绿；
 *  对方一律玫瑰红（评级 A 色太鲜艳，18:01 回退）；none=空格暗底 */
const CELL_BG: Record<VsCell["out"], string> = {
  p1: "#66d9ef", // 我胜：蓝色实底（与雷达/主页同款）
  u1: "#1e3a45", // 我独有：深底蓝字
  tie: "#e6db74", // 平局：黄底黑字
  u2: "#46222f", // 对方独有：深底玫瑰红字
  p2: "#e34f8c", // 对方胜：玫瑰红实底
  none: "#2b2b26", // 双方都没有：空格暗底灰字
};
const CELL_FG: Record<VsCell["out"], string> = {
  p1: "#272822",
  u1: "#66d9ef",
  tie: "#272822",
  u2: "#e874ab",
  p2: "#ffffff",
  none: "#565549",
};

/** 每行严格五类顺序（2026-11-10 21:13 张老师）：我胜 → 我独有 → 都没有 → 对方独有 → 对方胜；
 *  平局（各 0 分）与「双方都没有」同归「都没有」区，组内按 BV 升序。 */
const CELL_ORDER: Record<VsCell["out"], number> = {
  p1: 0, u1: 1, none: 2, tie: 2, u2: 3, p2: 4,
};
function orderCells(cells: VsCell[]): VsCell[] {
  return [...cells].sort((a, b) => CELL_ORDER[a.out] - CELL_ORDER[b.out] || a.bv - b.bv);
}

/** BV 格 hover 气泡（2026-11-10 21:32 张老师定）：三行
 *  「BV = n / 我方玩家名：xx.xx / 对方玩家名：xx.xx」——A/B 是玩家名占位符，
 *  不是字面 A/B。首行「BV = 」暗灰、数字亮灰（等号左右各一空格）；
 *  胜方整行金色 #fdc61a、负方整行亮灰 #b1b1a4；平局/双方都没有时两行均亮灰。
 *  纯 CSS :hover 显隐（收集墙 .tip 同款暗底描边气泡），零客户端 JS。 */
function VsCellSpan({ c, name1, name2 }: { c: VsCell; name1: string; name2: string }) {
  // 22:44 张老师：气泡里没有成绩的一侧显示「无录像」（原「—」弃用）
  const a = c.t1 !== null ? scoreTime(c.t1) : "无录像";
  const b = c.t2 !== null ? scoreTime(c.t2) : "无录像";
  const aWin = c.out === "p1" || c.out === "u1";
  const bWin = c.out === "p2" || c.out === "u2";
  return (
    <span
      className="vs_c"
      tabIndex={0} /* 21:46：移动端 tap 聚焦后由 :focus 显示气泡，点另一格自动转移 */
      style={{ background: CELL_BG[c.out], color: CELL_FG[c.out] }}
    >
      {c.bv}
      <i className="vs_tip">
        <span className="vs_tip_bv">BV{" "}={" "}<b>{c.bv}</b></span>
        <span className={aWin ? "vs_tip_rec vs_tip_gold" : "vs_tip_rec"}>{name1}：{a}</span>
        <span className={bWin ? "vs_tip_rec vs_tip_gold" : "vs_tip_rec"}>{name2}：{b}</span>
      </i>
    </span>
  );
}

/** 级别板块（2026-11-10 21:13 起第六轮改版）：初级/中级/高级各一个独立盒。
 *  · 标题居中，左右两端为本级汇总「玩家名：x分 n胜 m独有」（21:32 张老师：
 *    A/B 是玩家名占位符，一律渲染真实姓名，hover 完整名走 title）。
 *  · 每行格子严格按五类顺序重排；行首 BV 范围、行尾分段比分、板块尾部「本级得分」
 *    行、标题边「总bv数」小字均已去掉（张老师 21:16）；格子区占满整个板块宽度。
 *  · 所有行共用同一套等宽列（列数＝本级别最多格子数，注入 --vs_cols）。 */
/** 板块头部一侧汇总（21:36 / 21:45 / 22:33/22:34 张老师）：玩家名 24px 加粗阵营色；
 *  得分恢复**玩家色文字**（22:33：不要背景框了）——我蓝 / 对手玫红；
 *  红蓝两侧同序：名字 → 得分 → 胜 → 独有（22:34：红方得分恢复到胜数前面）；
 *  胜数金、但**胜数为 0 时亮灰**（22:34）；独有数亮灰；单位暗灰，字号 22/20
 *  （比名字小两号阶梯），单位前留一空格；移动端隐藏「玩家名：」只留统计。
 *  纪录板块同款头部（没有「独有」段，solo 省略时该段不渲染）。 */
function VsLevelStat({
  name, total, win, solo, side,
}: { name: string; total: number; win: number; solo?: number; side: "a" | "b" }) {
  const plain = `${name}：${total.toFixed(2)}分 ${win}胜${solo === undefined ? "" : ` ${solo}独有`}`;
  return (
    <span className={`vs_lv_stat vs_lv_stat_${side}`} title={plain}>
      <b className="vs_lv_name">{name}：</b>
      <b className="vs_lv_score">{total.toFixed(2)}</b>{" "}<i className="vs_lv_unit">分</i>{" "}
      <b className={`vs_lv_win${win === 0 ? " vs_lv_win_zero" : ""}`}>{win}</b>{" "}<i className="vs_lv_unit">胜</i>
      {solo !== undefined && (
        <>{" "}<b className="vs_lv_solo">{solo}</b>{" "}<i className="vs_lv_unit">独有</i></>
      )}
    </span>
  );
}

function VsLevelBox({ pk, name1, name2 }: { pk: VsLevelPk; name1: string; name2: string }) {
  // 21:42 张老师：整行（十位段）双方都没有任何纪录时不画这一行——
  // 判定用「任一方有纪录」而非格子归属，平局（tie，双方都有成绩）仍算有数据。
  // --vs_cols 也只按可见行算，避免隐藏的空行仍决定列宽。
  const visibleBands = pk.bands.filter((band) =>
    band.cells.some((c) => c.t1 !== null || c.t2 !== null));
  const cols = Math.max(1, ...visibleBands.map((b) => b.cells.length));
  return (
    // 22:24 张老师：标题与双方统计整行移到板块盒**外部**（.vs_lv_head 在 .box 之上），
    // 板块盒里只放格子，头部与盒子一起套进 .vs_lvblk 控制上下间距。
    <div className="vs_lvblk">
      <div className="vs_lv_head">
        <VsLevelStat name={name1} total={pk.total1} win={pk.win1} solo={pk.u1} side="a" />
        <h1 className="gray">
          <span style={{ color: LEVEL_COLOR[pk.level] }}>{LEVEL_CN[pk.level]}</span>
        </h1>
        <VsLevelStat name={name2} total={pk.total2} win={pk.win2} solo={pk.u2} side="b" />
      </div>
      <div className="box vs_lvbox">
        <div className="vs_lvbody">
          <div className="vs_lvmain" style={{ "--vs_cols": cols } as React.CSSProperties}>
            {visibleBands.map((band) => (
              <div className="vs_bandrow" key={band.lo}>
                <div className="vs_mid">
                  {orderCells(band.cells).map((c) => (
                    <VsCellSpan key={c.bv} c={c} name1={name1} name2={name2} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 玩家面板：结构严格照抄侧栏玩家卡片 .user_card 上半部（横线以上），
    横线以下放实力雷达（2026-11-09 二轮：去掉「实力」二字标题）。
    accent 缺省＝主页同款默认青蓝（2026-11-10 张老师：自己的雷达不改色） */
function VsPanel({ p, accent }: { p: VsPlayer; accent?: string }) {
  return (
    <div className="box vs_panel">
      <div className="user_card">
        <div className="ucd_top">
          <div className="ucd_left">
            <Link
              className="avatar_link"
              href={`/user/${p.id}`}
              target="_blank"
              prefetch={false}
              title={`进入 ${p.name} 的地盘`}
            >
              {/* 无头像：军衔制下按性别给军装默认头像（72px 位走 mid 档，与玩家卡片同款），
                  旧版称号仍 no.jpg（2026-11-11）；有头像走原 URL */}
              {p.avatarIsDefault ? (
                <DefaultAvatar sex={p.sex} size="mid" className="ucd_avatar" alt={p.name} />
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element -- 用户上传头像，走原 URL */
                <img className="ucd_avatar" src={p.avatarUrl} alt={p.name} />
              )}
            </Link>
          </div>
          <div className="ucd_right">
            {/* 姓名 + 性别 + 军衔：与侧栏卡片同一套 AvatarCell + TitleBadge 组件 */}
            <p className="ucd_name">
              <AvatarCell id={p.id} name={p.name} englishName={p.en} sex={p.sex} gender="small" link />
              <TitleBadge title={p.militaryTitle} classic={p.classicTitle} link />
            </p>
            {/* 地区 / 全国排名：与玩家卡片 .ranks 同构（海外玩家口径一致） */}
            <div className="ranks">
              {p.area === AREA_OVERSEAS ? (
                p.areaRank !== null ? (
                  <span className="rank_line">
                    海外第 <em>{p.areaRank}</em> 名
                  </span>
                ) : (
                  <span className="rank_line ranks_overseas">海外玩家</span>
                )
              ) : (
                <>
                  {p.areaRank !== null ? (
                    <span className="rank_line">
                      {areaDisplay(p.area)}第 <em>{p.areaRank}</em> 名
                    </span>
                  ) : (
                    <span className="rank_line ucd_null">未加入地区排行</span>
                  )}
                  {p.natRank !== null ? (
                    <span className="rank_line">
                      全国第 <em>{p.natRank}</em> 名
                    </span>
                  ) : (
                    <span className="rank_line ucd_null">未加入全国排行</span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        <hr className="ucd_hr" />
        {p.radar.length > 0 && (
          <div className="vs_radar">
            <RadarChart data={p.radar} accent={accent} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 纪录行成绩格（21:53 张老师）：格内不再放「胜/负/平」字标，也不再用旧的
 *  深绿/浅玫红半行底色；只有胜方那一侧加自己的阵营实底（我蓝 / 对手玫红）。 */
function RecScore({ mark, side, score }: { mark: VsRecRow["mark"]; side: "l" | "r"; score: string }) {
  const winSide = side === "l" ? "p1" : "p2";
  const bg = mark === winSide ? (side === "l" ? "half_p1" : "half_p2") : "";
  return (
    <td className={`vs_half vs_half_${side} ${bg}`}>
      <span className="vs_score">{score}</span>
    </td>
  );
}

/** 结果列已删（22:57 张老师）：胜负信息改由中间纪录名按胜方色渲染——
 *  我方胜蓝 / 对方胜玫红 / 平金 / 都无纪录亮灰（见 .vs_item.item_* 规则）。 */

export default async function VsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const targetId = parseInt(id, 10);
  if (!targetId) notFound();

  const session = await getSession();
  if (!session) redirect("/account/login");

  // 不能和自己比拼：入口按钮已灰置，直连 URL 兜底提示
  if (session.uid === targetId) {
    return (
      <div id="page" className="main vs_page">
        <div className="box vs_self">
          <h1>不能和自己比拼</h1>
          <p>换一个对手试试？</p>
        </div>
      </div>
    );
  }

  const data = await getVsData(session.uid, targetId);
  if (!data) notFound();
  const { p1, p2, levels, recRows, rec1, rec2, bv1, bv2, preComment, preTone, postComment } = data;

  const total1 = rec1 + bv1;
  const total2 = rec2 + bv2;
  const winner = total1 === total2 ? 0 : total1 > total2 ? 1 : 2;
  // 21:55 张老师：纪录板块头部「胜数」＝该方占优的纪录行数（mark=p1/p2，含独有局）
  const recWin1 = recRows.filter((r) => r.mark === "p1").length;
  const recWin2 = recRows.filter((r) => r.mark === "p2").length;

  // 2026-11-10 第五轮：下面所有板块交给客户端舞台（VsScoreBoard）控制显隐——
  // 赛前完全不挂载，点「决出胜负」跑分完成后才出现。RSC 节点可作为 props 传入客户端边界。
  // 21:16/21:17 张老师：标题一律居中；得分规则说明、图例/胜负统计模块全部去掉，
  // 最底部只留三个级别板块。
  const below = (
    <>
      {/* ① 纪录（22:23 / 22:24 / 22:57 张老师）：头部（标题+双方得分框+胜数）移到板块盒外部；
          盒内表格三列＝左成绩｜项目｜右成绩（结果列已删）；胜方成绩格加自己的阵营实底，
          纪录名按胜方色渲染（我方胜蓝 / 对方胜玫红 / 平金 / 都无亮灰）。 */}
      <div className="vs_lvblk">
        <div className="vs_lv_head">
          <VsLevelStat name={p1.name} total={rec1} win={recWin1} side="a" />
          <h1 className="gray">纪录</h1>
          <VsLevelStat name={p2.name} total={rec2} win={recWin2} side="b" />
        </div>
        <div className="box" id="vs_records">
          <div className="vs_lvbody">
            <div className="vs_lvmain">
              <table className="vs_rec" cellPadding={0} cellSpacing={0}>
                <tbody>
                  {recRows.map((row) => (
                    <tr key={row.label}>
                      <RecScore mark={row.mark} side="l" score={row.s1} />
                      <th className={`vs_item item_${row.mark}`}>{row.label}</th>
                      <RecScore mark={row.mark} side="r" score={row.s2} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      {/* ② 各BV比拼：初级/中级/高级各一个独立板块（无图例/规则尾部模块） */}
      <div id="vs_bv">
        {levels.map((pk) => (
          <VsLevelBox key={pk.level} pk={pk} name1={p1.name} name2={p2.name} />
        ))}
      </div>

      {/* ③ 22:20 张老师：所有计分规则合并到页面最下方，独立成段，不占板块内部空间 */}
      <VsRule />
    </>
  );

  return (
    <div id="page" className="main vs_page">
      <VsScoreBoard
        total1={total1}
        total2={total2}
        winner={winner}
        preComment={preComment}
        preTone={preTone}
        postComment={postComment}
        opponentId={targetId}
        leftPanel={<VsPanel p={p1} />}
        rightPanel={<VsPanel p={p2} accent="#e34f8c" />}
        below={below}
      />
    </div>
  );
}
