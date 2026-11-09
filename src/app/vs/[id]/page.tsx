// 玩家对战 PK 页（2026-11-09 张老师需求）：
// 入口 = 用户主页性别图标+对话气泡右侧、侧栏玩家卡片对话气泡正下方的对战按钮。
// 布局（design/vs-page.html 设计稿定稿）：
//   ① 对战主视觉：左=发起者卡片（头像/姓名/军衔/名次）+ 实力雷达，右=被挑战者，
//      中间金色 VS；
//   ② 各项记录比拼（4 级别 × 时间/3BV/s）：与 BV 同规则计分（胜 1.00 / 独有 0.25 / 平 0），
//      胜方成绩金色 + 胜负列；
//   ③ 各BV比拼：阵营式行布局——我胜的 BV 绿色升序靠左、对方胜的玫瑰红升序靠右、
//      独有/平局居中；行 = BV 十位段（初级首段 2-9），行右分段得分，段内 hover 显示双方时间；
//   ④ 胜负结果：总得分（记录得分 + 三级别 BV 得分）大字 + 详细得分统计表。
// 得分规则（张老师 2026-11-09 定）：同 3BV 对抗快者 1.00，独有 0.25，平局各 0。

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getVsData, type VsCell, type VsLevelPk, type VsPlayer, type VsRecRow } from "@/lib/vs";
import { scoreTime } from "@/lib/format";
import { RadarChart } from "@/components/RadarChart";

export const dynamic = "force-dynamic";

const LEVEL_CN: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
/** 级别标准配色：初绿 / 中橙 / 高黄（与 3BV 收集等板块同源） */
const LEVEL_COLOR: Record<string, string> = { beg: "#a6e22e", int: "#fd971f", exp: "#e6db74" };

export async function generateMetadata(): Promise<Metadata> {
  return { title: "玩家对战 - 扫雷网" };
}

/** 格子归属配色（与 globals.css .vs_c 同步维护：改这里必须改 CSS 注释说明） */
const CELL_BG: Record<VsCell["out"], string> = {
  p1: "#a6e22e", // 我胜：绿色实底
  u1: "#2e3d1a", // 我独有：深底绿字
  tie: "#e6db74", // 平局：黄底黑字
  u2: "#46222f", // 对方独有：深底玫瑰红字
  p2: "#e34f8c", // 对方胜：玫瑰红实底
};
const CELL_FG: Record<VsCell["out"], string> = {
  p1: "#272822",
  u1: "#a6e22e",
  tie: "#272822",
  u2: "#e874ab",
  p2: "#ffffff",
};

function cellTitle(c: VsCell, name1: string, name2: string): string {
  if (c.t1 !== null && c.t2 !== null) {
    return `3BV=${c.bv}\n${name1} ${scoreTime(c.t1)}s\n${name2} ${scoreTime(c.t2)}s`;
  }
  const solo = c.out === "u1" ? name1 : name2;
  return `3BV=${c.bv}\n仅${solo} ${scoreTime(c.t1 ?? c.t2)}s`;
}

function VsCellSpan({ c, name1, name2 }: { c: VsCell; name1: string; name2: string }) {
  return (
    <span
      className="vs_c"
      title={cellTitle(c, name1, name2)}
      style={{ background: CELL_BG[c.out], color: CELL_FG[c.out] }}
    >
      {c.bv}
    </span>
  );
}

function VsGrid({ pk, name1, name2 }: { pk: VsLevelPk; name1: string; name2: string }) {
  return (
    <div className="vs_lv">
      <div className="vs_lv_head">
        <span className="vs_lv_name" style={{ color: LEVEL_COLOR[pk.level] }}>{LEVEL_CN[pk.level]}</span>
        <span className="vs_lv_cnt">(总bv数: {pk.cnt1} : {pk.cnt2})</span>
      </div>
      {pk.bands.map((band) => {
        // 阵营式布局：我胜升序靠左，独有/平局居中，对方胜升序靠右（cells 已按 bv 升序）
        const mine = band.cells.filter((c) => c.out === "p1");
        const mid = band.cells.filter((c) => c.out !== "p1" && c.out !== "p2");
        const theirs = band.cells.filter((c) => c.out === "p2");
        return (
          <div className="vs_bandrow" key={band.lo}>
            <div className="vs_band">{band.lo === 2 ? "2-9" : `${band.lo}-${band.hi}`}</div>
            <div className="vs_mid">
              <span className="vs_grp">
                {mine.map((c) => <VsCellSpan key={c.bv} c={c} name1={name1} name2={name2} />)}
              </span>
              <span className="vs_grp vs_midgrp">
                {mid.map((c) => <VsCellSpan key={c.bv} c={c} name1={name1} name2={name2} />)}
              </span>
              <span className="vs_grp">
                {theirs.map((c) => <VsCellSpan key={c.bv} c={c} name1={name1} name2={name2} />)}
              </span>
            </div>
            <div className="vs_seg">
              <span className="s1">{band.s1.toFixed(2)}</span>
              <span className="s2">{band.s2.toFixed(2)}</span>
            </div>
          </div>
        );
      })}
      <div className="vs_bandrow vs_lv_total">
        <div className="vs_band">本级得分</div>
        <div className="vs_mid" />
        <div className="vs_seg">
          <span className="s1">{pk.total1.toFixed(2)}</span>
          <span className="s2">{pk.total2.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}

function VsCard({ p, accent }: { p: VsPlayer; accent: string }) {
  return (
    <div className="vs_card">
      <div className="vs_card_top">
        <img className="vs_avatar" src={p.avatarUrl} alt={p.name} />
        <div className="vs_card_right">
          <p className="vs_name">
            <Link href={`/user/${p.id}`} target="_blank" prefetch={false}>
              {p.name}
            </Link>
            <span className={`gender small ${p.sex ? "male" : "female"}`}></span>
          </p>
          <p className="vs_en">({p.en})</p>
          <span className="vs_title" style={{ color: p.titleColor, borderColor: p.titleColor }}>
            {p.militaryTitle}
          </span>
          <div className="vs_ranks">
            {p.natRank === null && p.areaRank === null ? (
              <span className="rank_line vs_null">未加入排行</span>
            ) : (
              <>
                {p.areaRank !== null && (
                  <span className="rank_line">
                    {p.area}第 <em>{p.areaRank}</em> 名
                  </span>
                )}
                {p.natRank !== null && (
                  <span className="rank_line">
                    全国第 <em>{p.natRank}</em> 名
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      {p.radar.length > 0 && (
        <div className="vs_radar">
          <h3>实力</h3>
          <RadarChart data={p.radar} accent={accent} />
        </div>
      )}
    </div>
  );
}

function RecMark({ row, name1, name2 }: { row: VsRecRow; name1: string; name2: string }) {
  if (row.mark === "tie") return <td className="mk tie_mk">平</td>;
  if (row.mark === "none") return <td className="mk">—</td>;
  return <td className="mk">{row.mark === "p1" ? name1 : name2} 胜</td>;
}

export default async function VsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const targetId = parseInt(id, 10);
  if (!targetId) notFound();

  const session = await getSession();
  if (!session) redirect("/account/login");

  // 不能和自己比拼：入口按钮已灰置，直连 URL 兜底提示
  if (session.uid === targetId) {
    return (
      <div id="page">
        <div className="box vs_self">
          <h1>不能和自己比拼</h1>
          <p>换一个对手试试？</p>
        </div>
      </div>
    );
  }

  const data = await getVsData(session.uid, targetId);
  if (!data) notFound();
  const { p1, p2, levels, recRows, rec1, rec2, bv1, bv2 } = data;

  const total1 = rec1 + bv1;
  const total2 = rec2 + bv2;
  const winner = total1 === total2 ? 0 : total1 > total2 ? 1 : 2;

  const statsRow = (label: string, v1: React.ReactNode, v2: React.ReactNode) => (
    <tr key={label}>
      <th>{label}</th>
      <td>{v1}</td>
      <td>{v2}</td>
    </tr>
  );

  return (
    <div id="page">
      {/* ① 对战主视觉 */}
      <div className="box" id="vs_hero">
        <VsCard p={p1} accent="#a6e22e" />
        <div className="vs_vs"><span>VS</span></div>
        <VsCard p={p2} accent="#e34f8c" />
      </div>

      {/* ② 各项记录比拼 */}
      <div className="box" id="vs_records">
        <h1 className="gray">各项记录比拼</h1>
        <table className="vs_rec" cellPadding={0} cellSpacing={0}>
          <tbody>
            <tr className="vs_head">
              <th>项目</th>
              <th className="c1">{p1.name}</th>
              <th className="c2">{p2.name}</th>
              <th className="mk">胜负</th>
            </tr>
            {recRows.map((row) => (
              <tr key={row.label}>
                <th>{row.label}</th>
                <td className={"c1" + (row.mark === "p1" ? " win" : "")}>{row.s1}</td>
                <td className={"c2" + (row.mark === "p2" ? " win" : "")}>{row.s2}</td>
                <RecMark row={row} name1={p1.name} name2={p2.name} />
              </tr>
            ))}
          </tbody>
        </table>
        <p className="vs_rule_note">
          得分规则：记录与各 BV 比拼同规则计分——双方都有成绩时优者得 1.00 分（同值平局各 0 分），只有一方有的得 0.25 分。
        </p>
      </div>

      {/* ③ 各BV比拼 */}
      <div className="box" id="vs_bv">
        <h1 className="gray">各BV比拼</h1>
        {levels.map((pk) => <VsGrid key={pk.level} pk={pk} name1={p1.name} name2={p2.name} />)}
        <div className="vs_legend">
          <span className="lg"><i style={{ background: CELL_BG.p1 }}></i>{p1.name}胜</span>
          <span className="lg"><i style={{ background: CELL_BG.u1 }}></i>{p1.name}独有</span>
          <span className="lg"><i style={{ background: CELL_BG.tie }}></i>平局</span>
          <span className="lg"><i style={{ background: CELL_BG.u2 }}></i>{p2.name}独有</span>
          <span className="lg"><i style={{ background: CELL_BG.p2 }}></i>{p2.name}胜</span>
        </div>
        <p className="vs_rule_note">
          得分规则：同一 3BV 双方都有纪录，快者得 1.00 分（同毫秒平局各 0 分）；只有一方有的 3BV（独有）得 0.25 分。悬停格子可看双方该 BV 的最快时间。
        </p>
      </div>

      {/* ④ 胜负结果 */}
      <div className="box" id="vs_result">
        <h1 className="gray">胜负结果</h1>
        <div className="vs_big">
          <span className={"vs_big_s1" + (winner === 1 ? " win_big" : "")}>{total1.toFixed(2)}</span>
          <span className="vs_big_vs">:</span>
          <span className={"vs_big_s2" + (winner === 2 ? " win_big" : "")}>{total2.toFixed(2)}</span>
          <span className="vs_verdict">
            {winner === 0 ? "战成平手" : `${winner === 1 ? p1.name : p2.name} 胜出`}
          </span>
        </div>
        <table className="vs_rec" cellPadding={0} cellSpacing={0}>
          <tbody>
            {statsRow("总得分", total1.toFixed(2), total2.toFixed(2))}
            {statsRow("记录得分", rec1.toFixed(2), rec2.toFixed(2))}
            {levels.map((pk) =>
              statsRow(`${LEVEL_CN[pk.level]}BV得分`, pk.total1.toFixed(2), pk.total2.toFixed(2))
            )}
            {statsRow(
              "收集 BV 数",
              levels.reduce((s, l) => s + l.cnt1, 0),
              levels.reduce((s, l) => s + l.cnt2, 0)
            )}
            {levels.map((pk) => statsRow(`${LEVEL_CN[pk.level]}对抗 BV 数`, pk.contest, pk.contest))}
            {levels.map((pk) =>
              statsRow(
                `${LEVEL_CN[pk.level]}胜 / 平 / 负`,
                `${pk.win1} / ${pk.tie} / ${pk.win2}`,
                `${pk.win2} / ${pk.tie} / ${pk.win1}`
              )
            )}
            {levels.map((pk) => statsRow(`${LEVEL_CN[pk.level]}独有 BV 数`, pk.u1, pk.u2))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
