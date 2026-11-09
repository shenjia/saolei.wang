// PK 对战页设计稿生成器（2026-11-09 张老师需求）：
// 用户首页气泡旁 / 侧栏玩家卡片气泡下方加对战入口 → /vs/[id] PK 页。
// 本脚本按「铁律：UI 先出单页高保真稿」生成 design/vs-page.html（真实本地库数据）。
//
// 用法：env -u NODE_OPTIONS node --experimental-transform-types \
//        --import ./scripts/sync/ts-extension-loader.mjs scripts/make-vs-design.ts
//
// 演示对：冯小峰(15416) vs 毛涤尘(19218)（三级 BV 覆盖最全、实力接近）。
//
// 得分规则（按参考图反推并复核：80.00 : 133.50 逐段吻合）：
//   · 双方都有某 BV 的纪录（该 BV 最快时间）：快者得 1.00 分，同毫秒平局各 0.50（假设，待确认）
//   · 只有单方有的 BV（独有）：该方得 0.25 分
//   · 各级别得分 = 段内得分之和；总分 = 三级别之和
//   · 各项记录比拼只标胜负、不计分（假设，待确认）

import { existsSync } from "fs";
import { prisma } from "../src/lib/db";
import {
  LEVEL_MIN_3BV,
  TITLES,
  TITLE_THRESHOLDS,
  TITLE_COLORS,
  areaDisplay,
  type VideoLevel,
} from "../src/lib/config";
import { scoreTime, score3bvs } from "../src/lib/format";
import { radarGrade, radarPercent } from "../src/lib/radar-standard.mjs";
import { gradeColor } from "../src/lib/videoscore";

const P1 = 9672; // 郭锦洋（左，蓝）
const P2 = 9952; // 濮天羿（右，粉）
const LEVELS: VideoLevel[] = ["beg", "int", "exp"];
const LEVEL_CN: Record<VideoLevel, string> = { beg: "初级", int: "中级", exp: "高级" };
const LEVEL_COLOR: Record<VideoLevel, string> = { beg: "#a6e22e", int: "#fd971f", exp: "#e6db74" };

// ---------- 军衔（与 lib/assess title 同口径，kingThreshold=0） ----------
function militaryTitle(expTime: number | null): string {
  if (!expTime) return "预备役";
  for (let i = 0; i < TITLE_THRESHOLDS.length; i++) {
    if (expTime <= TITLE_THRESHOLDS[i]) return TITLES[i + 1] ?? "";
  }
  return TITLES[TITLES.length - 1] ?? "";
}

interface PlayerData {
  id: number;
  name: string;
  en: string;
  sex: number;
  avatar: string;
  area: string;
  title: string;
  areaRank: number | null;
  natRank: number | null;
  scores: Record<string, number | null>; // beg_time / beg_3bvs / ... / sum_3bvs
  /** 每级别：BV → 最快时间(ms) */
  bv: Record<VideoLevel, Map<number, number>>;
  radar: { name: string; score: string; percent: number; grade: string }[];
}

async function loadPlayer(id: number): Promise<PlayerData> {
  const u = await prisma.$queryRaw<
    { chinese_name: string; english_name: string; sex: number; avatar: string; area: string; exp_time: number | null }[]
  >`
    SELECT u.chinese_name, u.english_name, u.sex, u.avatar, u.area, s.exp_time
    FROM \`user\` u LEFT JOIN user_scores s ON s.id = u.id
    WHERE u.id = ${BigInt(id)}`;
  if (!u.length) throw new Error(`user ${id} not found`);
  const row = u[0];

  const sc = await prisma.$queryRaw<Record<string, number | null>[]>`
    SELECT beg_time, beg_3bvs, int_time, int_3bvs, exp_time, exp_3bvs, sum_time, sum_3bvs
    FROM user_scores WHERE id = ${BigInt(id)}`;
  const scores = (sc[0] ?? {}) as Record<string, number | null>;

  // 每级别每 BV 最快时间（口径 = 收集墙：status<>0，封禁连坐保留）
  const bvRows = await prisma.$queryRaw<{ level: string; b3bv: number; rt: number }[]>`
    SELECT v.level, vi.board_3bv AS b3bv, MIN(vi.real_time) AS rt
    FROM video v
    JOIN video_info vi ON vi.id = v.id
    JOIN \`user\` uu ON uu.id = v.user
    WHERE v.user = ${BigInt(id)}
      AND (v.status <> 0 OR (v.status = 0 AND uu.status <> 0))
      AND vi.board_3bv >= CASE v.level
        WHEN 'beg' THEN ${LEVEL_MIN_3BV.beg}
        WHEN 'int' THEN ${LEVEL_MIN_3BV.int}
        ELSE ${LEVEL_MIN_3BV.exp} END
    GROUP BY v.level, vi.board_3bv`;
  const bv: Record<VideoLevel, Map<number, number>> = {
    beg: new Map(), int: new Map(), exp: new Map(),
  };
  for (const r of bvRows) {
    if (r.level === "beg" || r.level === "int" || r.level === "exp") {
      bv[r.level].set(r.b3bv, r.rt);
    }
  }

  // 名次（近似口径：现役 status=0 按 sum_time 升序；设计稿展示用，与 rank_snapshot 可能差并列细节）
  const me = scores.sum_time ?? 0;
  let natRank: number | null = null;
  let areaRank: number | null = null;
  if (me > 0) {
    const nat = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) + 1 AS c FROM user_scores s JOIN \`user\` u2 ON u2.id = s.id
      WHERE u2.status = 0 AND s.sum_time > 0 AND s.sum_time < ${me}`;
    natRank = Number(nat[0]?.c ?? 0);
    const ar = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) + 1 AS c FROM user_scores s JOIN \`user\` u2 ON u2.id = s.id
      WHERE u2.status = 0 AND s.sum_time > 0 AND s.sum_time < ${me} AND u2.area = ${row.area}`;
    areaRank = Number(ar[0]?.c ?? 0);
  }

  // 头像：本地照片墙 → 默认（avatar='0' 是老站标记）
  // ⚠️ 设计稿经 file:// 预览，public 下资源用相对路径（../public/...），线上再换回 /images/...
  let avatar = "../public/images/common/avatar.png";
  if (existsSync(`public/images/player/${id}.jpg`)) avatar = `../public/images/player/${id}.jpg`;

  // 雷达 8 维（与 lib/radar getRadarData 同序：time 的 sum/exp/int/beg → 3bvs 的 sum/exp/int/beg）
  const distRow = await prisma.$queryRaw<Record<string, string>[]>`
    SELECT * FROM distribution ORDER BY id DESC LIMIT 1`;
  const dist = (distRow[0] ?? {}) as Record<string, string>;
  const parseDist = (k: string) =>
    (dist[k] ?? "").split(",").filter((s) => s !== "").map(Number);
  const RADAR_LEVELS = ["sum", "exp", "int", "beg"] as const;
  const LEVEL_AXIS: Record<string, string> = { sum: "总计", exp: "高级", int: "中级", beg: "初级" };
  const radar: PlayerData["radar"] = [];
  for (const order of ["time", "3bvs"] as const) {
    for (const lv of RADAR_LEVELS) {
      const raw = scores[`${lv}_${order}`] ?? 0;
      const d = parseDist(`${lv}_${order}`);
      const direction = order === "time" ? "asc" : "desc";
      radar.push({
        name: LEVEL_AXIS[lv] + (order === "time" ? "时间" : "3BV/s"),
        score: order === "time" ? scoreTime(raw as number) : score3bvs(raw as number),
        percent: radarPercent(raw as number, d, direction),
        grade: radarGrade(raw as number, d, direction),
      });
    }
  }

  return {
    id,
    name: row.chinese_name,
    en: row.english_name,
    sex: row.sex,
    avatar,
    area: row.area,
    title: militaryTitle(row.exp_time),
    areaRank,
    natRank,
    scores,
    bv,
    radar,
  };
}

// ---------- BV 比拼计算 ----------
type Outcome = "p1" | "p2" | "tie" | "u1" | "u2";
interface BvCell { bv: number; out: Outcome; t1: number | null; t2: number | null }
interface Band { lo: number; hi: number; cells: (BvCell | null)[]; s1: number; s2: number }
interface LevelPk {
  level: VideoLevel;
  bands: Band[];
  cnt1: number; cnt2: number; // 总bv数（收集数）
  total1: number; total2: number;
  contest: number; win1: number; win2: number; tie: number; u1: number; u2: number;
}

function bandsFor(level: VideoLevel, maxBv: number): [number, number][] {
  const bands: [number, number][] = [];
  if (level === "beg") {
    bands.push([2, 9]);
    for (let s = 10; s <= maxBv; s += 10) bands.push([s, Math.min(s + 9, Math.max(maxBv, s + 9))]);
  } else {
    const start = Math.floor(LEVEL_MIN_3BV[level] / 10) * 10;
    for (let s = start; s <= maxBv; s += 10) bands.push([s, s + 9]);
  }
  return bands;
}

function computeLevelPk(level: VideoLevel, a: PlayerData, b: PlayerData): LevelPk {
  const ma = a.bv[level], mb = b.bv[level];
  const all = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y);
  const maxBv = all.length ? all[all.length - 1] : LEVEL_MIN_3BV[level];
  const pk: LevelPk = {
    level, bands: [], cnt1: ma.size, cnt2: mb.size,
    total1: 0, total2: 0, contest: 0, win1: 0, win2: 0, tie: 0, u1: 0, u2: 0,
  };
  for (const [lo, hi] of bandsFor(level, maxBv)) {
    const band: Band = { lo, hi, cells: new Array(10).fill(null), s1: 0, s2: 0 };
    for (const bv of all) {
      if (bv < lo || bv > hi) continue;
      const t1 = ma.get(bv) ?? null;
      const t2 = mb.get(bv) ?? null;
      let out: Outcome;
      if (t1 !== null && t2 !== null) {
        pk.contest++;
        if (t1 < t2) { out = "p1"; pk.win1++; band.s1 += 1; }
        else if (t2 < t1) { out = "p2"; pk.win2++; band.s2 += 1; }
        else { out = "tie"; pk.tie++; } // 平局各 0 分（张老师 2026-11-09 定）
      } else if (t1 !== null) { out = "u1"; pk.u1++; band.s1 += 0.25; }
      else { out = "u2"; pk.u2++; band.s2 += 0.25; }
      band.cells[bv % 10] = { bv, out, t1, t2 };
    }
    pk.bands.push(band);
    pk.total1 += band.s1;
    pk.total2 += band.s2;
  }
  return pk;
}

// ---------- HTML 渲染 ----------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
let NAME1 = "", NAME2 = "";

// 格子配色（张老师 2026-11-09 定）：我胜绿色靠左 / 对方胜玫瑰红靠右 / 独有居中
const CELL_BG: Record<Outcome, string> = {
  p1: "#a6e22e", u1: "#2e3d1a", tie: "#e6db74", u2: "#46222f", p2: "#e34f8c",
};
const CELL_FG: Record<Outcome, string> = {
  p1: "#272822", u1: "#a6e22e", tie: "#272822", u2: "#e874ab", p2: "#ffffff",
};

function cardHtml(p: PlayerData, side: "l" | "r", accent: string): string {
  const rankHtml =
    p.areaRank !== null && p.natRank !== null
      ? `<span class="rank_line">${areaDisplay(p.area)}第 <em>${p.areaRank}</em> 名</span>
         <span class="rank_line">全国第 <em>${p.natRank}</em> 名</span>`
      : `<span class="rank_line ucd_null">未加入排行</span>`;
  const radarHtml = p.radar.length ? radarSvg(p.radar, accent) : "";
  return `
  <div class="vs_card">
    <div class="vs_card_top">
      <img class="vs_avatar" src="${p.avatar}" alt="${esc(p.name)}" />
      <div class="vs_card_right">
        <p class="vs_name">
          <a href="/user/${p.id}" target="_blank" prefetch="false">${esc(p.name)}</a>
          <span class="gender small ${p.sex ? "male" : "female"}"></span>
        </p>
        <p class="vs_en">(${esc(p.en)})</p>
        <span class="vs_title" style="color:${TITLE_COLORS[p.title] ?? "#f8f8f2"};border-color:${TITLE_COLORS[p.title] ?? "#f8f8f2"}">${esc(p.title)}</span>
        <div class="vs_ranks">${rankHtml}</div>
      </div>
    </div>
    <div class="vs_radar">
      <h3>实力</h3>
      ${radarHtml}
    </div>
  </div>`;
}

// 雷达静态 SVG（复刻 RadarChart 几何；accent 区分左右双色）
function radarSvg(data: { name: string; score: string; percent: number; grade: string }[], accent: string): string {
  const SIZE = 222, CENTER = SIZE / 2, RADIUS = 68, LABEL_RADIUS = RADIUS + 20;
  const n = data.length;
  const f = (v: number) => Math.round(v * 100) / 100;
  const polar = (i: number, r: number): [number, number] => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [f(CENTER + r * Math.cos(a)), f(CENTER + r * Math.sin(a))];
  };
  const ring = (r: number) => Array.from({ length: n }, (_, i) => polar(i, r).join(",")).join(" ");
  let svg = `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="实力雷达图">`;
  for (const p of [15, 35, 50, 60, 70, 80, 90, 100]) {
    svg += `<polygon points="${ring((p / 100) * RADIUS)}" fill="none" stroke="${p === 100 ? "#6a685c" : "#565549"}" stroke-width="${p === 100 ? 1.2 : 0.7}" />`;
  }
  for (let i = 0; i < n; i++) {
    const [x, y] = polar(i, RADIUS);
    svg += `<line x1="${CENTER}" y1="${CENTER}" x2="${x}" y2="${y}" stroke="#565549" stroke-width="0.7" />`;
  }
  const pts = data.map((d, i) => polar(i, (d.percent / 100) * RADIUS));
  svg += `<polygon points="${pts.map((p) => p.join(",")).join(" ")}" fill="${accent}22" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round" />`;
  data.forEach((d, i) => {
    const [x, y] = pts[i];
    const [lx, ly] = polar(i, LABEL_RADIUS);
    svg += `<circle cx="${x}" cy="${y}" r="2.5" fill="${accent}" />`;
    svg += `<text x="${lx}" y="${ly - 3}" text-anchor="middle"><tspan fill="${gradeColor(d.grade)}" font-size="13" font-weight="bold">${esc(d.grade)}</tspan><tspan x="${lx}" dy="14" fill="#8a8878" font-size="9">${esc(d.name)}</tspan></text>`;
  });
  svg += `</svg>`;
  return svg;
}

function cellHtml(c: BvCell): string {
  const tip = c.t1 !== null && c.t2 !== null
    ? `title="3BV=${c.bv}&#10;${esc(NAME1)} ${(c.t1! / 1000).toFixed(3)}s&#10;${esc(NAME2)} ${(c.t2! / 1000).toFixed(3)}s"`
    : `title="3BV=${c.bv}&#10;仅${esc(c.out === "u1" ? NAME1 : NAME2)} ${(Number(c.t1 ?? c.t2) / 1000).toFixed(3)}s"`;
  return `<span class="vs_c" ${tip} style="background:${CELL_BG[c.out]};color:${CELL_FG[c.out]}">${c.bv}</span>`;
}

function gridHtml(pk: LevelPk): string {
  let h = `<div class="vs_lv">
    <div class="vs_lv_head"><span class="vs_lv_name" style="color:${LEVEL_COLOR[pk.level]}">${LEVEL_CN[pk.level]}</span>
      <span class="vs_lv_cnt">(总bv数: ${pk.cnt1} : ${pk.cnt2})</span></div>`;
  for (const band of pk.bands) {
    const has = band.cells.some((c) => c);
    if (!has) continue;
    // 阵营式布局：我胜的 BV 升序靠左，独有/平局居中，对方胜的升序靠右
    const mine = band.cells.filter((c): c is BvCell => !!c && c.out === "p1");
    const mid = band.cells.filter((c): c is BvCell => !!c && (c.out === "u1" || c.out === "u2" || c.out === "tie"));
    const theirs = band.cells.filter((c): c is BvCell => !!c && c.out === "p2");
    h += `<div class="vs_bandrow">
      <div class="vs_band">${band.lo === 2 ? `2-9` : `${band.lo}-${band.hi}`}</div>
      <div class="vs_mid">
        <span class="vs_grp">${mine.map(cellHtml).join("")}</span>
        <span class="vs_grp vs_midgrp">${mid.map(cellHtml).join("")}</span>
        <span class="vs_grp">${theirs.map(cellHtml).join("")}</span>
      </div>
      <div class="vs_seg"><span class="s1">${band.s1.toFixed(2)}</span><span class="s2">${band.s2.toFixed(2)}</span></div>
    </div>`;
  }
  h += `<div class="vs_bandrow vs_lv_total">
      <div class="vs_band">本级得分</div>
      <div class="vs_mid"></div>
      <div class="vs_seg"><span class="s1">${pk.total1.toFixed(2)}</span><span class="s2">${pk.total2.toFixed(2)}</span></div>
    </div>`;
  h += `</div>`;
  return h;
}

// ---------- 主流程 ----------
async function main() {
  const [a, b] = await Promise.all([loadPlayer(P1), loadPlayer(P2)]);
  NAME1 = a.name;
  NAME2 = b.name;
  const pks = LEVELS.map((lv) => computeLevelPk(lv, a, b));

  // 各项记录比拼（4 级别 × 2 指标，张老师 2026-11-09 定：与 BV 同规则计分）
  // 双有→快者/大者 1.00；单有→0.25；同值→平 0
  let rec1 = 0, rec2 = 0;
  const recRows = (["time", "3bvs"] as const).flatMap((order) =>
    (["beg", "int", "exp", "sum"] as const).map((lv) => {
      const v1 = a.scores[`${lv}_${order}`] ?? null;
      const v2 = b.scores[`${lv}_${order}`] ?? null;
      let mark: "p1" | "p2" | "tie" | "none" = "none";
      if (v1 && v2) mark = v1 === v2 ? "tie" : (order === "time" ? (v1 < v2 ? "p1" : "p2") : v1 > v2 ? "p1" : "p2");
      else if (v1) mark = "p1";
      else if (v2) mark = "p2";
      if (mark === "p1") rec1 += v1 && v2 ? 1 : 0.25;
      else if (mark === "p2") rec2 += v1 && v2 ? 1 : 0.25;
      const fmt = (v: number | null) => (order === "time" ? scoreTime(v) : score3bvs(v)) || "—";
      const label = `${LEVEL_CN[lv as VideoLevel] ?? "总计"}${order === "time" ? "时间" : " 3BV/s"}`;
      return { label, s1: fmt(v1), s2: fmt(v2), mark };
    })
  );

  const bvTotal1 = pks.reduce((s, p) => s + p.total1, 0);
  const bvTotal2 = pks.reduce((s, p) => s + p.total2, 0);
  const total1 = rec1 + bvTotal1;
  const total2 = rec2 + bvTotal2;

  const update = new Date();
  const updateStr = `${String(update.getMonth() + 1).padStart(2, "0")}-${String(update.getDate()).padStart(2, "0")} ${String(update.getHours()).padStart(2, "0")}:${String(update.getMinutes()).padStart(2, "0")}`;
  const winner = total1 === total2 ? 0 : total1 > total2 ? 1 : 2;

  const recordsHtml = `
  <div class="box" id="vs_records">
    <h1 class="gray">各项记录比拼</h1>
    <table class="vs_rec" cellPadding="0" cellSpacing="0"><tbody>
      <tr><th>项目</th><th class="c1">${esc(a.name)}</th><th class="c2">${esc(b.name)}</th><th class="mk">胜负</th></tr>
      ${recRows.map((r) => {
        const c1 = r.mark === "p1" ? `<td class="c1 win">${r.s1}</td>` : `<td class="c1">${r.s1}</td>`;
        const c2 = r.mark === "p2" ? `<td class="c2 win">${r.s2}</td>` : `<td class="c2">${r.s2}</td>`;
        const mk = r.mark === "tie" ? `<td class="mk tie_mk">平</td>`
          : r.mark === "none" ? `<td class="mk">—</td>`
          : `<td class="mk">${r.mark === "p1" ? esc(a.name) : esc(b.name)} 胜</td>`;
        return `<tr><th>${r.label}</th>${c1}${c2}${mk}</tr>`;
      }).join("")}
    </tbody></table>
  </div>`;

  const bvHtml = `
  <div class="box" id="vs_bv">
    <h1 class="gray">各BV比拼</h1>
    ${pks.map(gridHtml).join("")}
    <div class="vs_legend">
      <span class="lg"><i style="background:${CELL_BG.p1}"></i>${esc(a.name)}胜</span>
      <span class="lg"><i style="background:${CELL_BG.u1}"></i>${esc(a.name)}独有</span>
      <span class="lg"><i style="background:${CELL_BG.tie}"></i>平局</span>
      <span class="lg"><i style="background:${CELL_BG.u2}"></i>${esc(b.name)}独有</span>
      <span class="lg"><i style="background:${CELL_BG.p2}"></i>${esc(b.name)}胜</span>
      <span class="vs_update">更新:${updateStr}</span>
    </div>
    <p class="vs_rule_note">得分规则：同一 3BV 双方都有纪录，快者得 1.00 分（同毫秒平局各 0 分）；只有一方有的 3BV（独有）得 0.25 分。各项记录比拼同规则计分（胜 1.00 / 独有 0.25 / 平 0）。</p>
  </div>`;

  const statsRow = (label: string, v1: string | number, v2: string | number) =>
    `<tr><th>${label}</th><td>${v1}</td><td>${v2}</td></tr>`;
  const resultHtml = `
  <div class="box" id="vs_result">
    <h1 class="gray">胜负结果</h1>
    <div class="vs_big">
      <span class="vs_big_s1 ${winner === 1 ? "win_big" : ""}">${total1.toFixed(2)}</span>
      <span class="vs_big_vs">:</span>
      <span class="vs_big_s2 ${winner === 2 ? "win_big" : ""}">${total2.toFixed(2)}</span>
      <span class="vs_verdict">${winner === 0 ? "战成平手" : `${esc(winner === 1 ? a.name : b.name)} 胜出`}</span>
    </div>
    <table class="vs_rec" cellPadding="0" cellSpacing="0"><tbody>
      ${statsRow("总得分", total1.toFixed(2), total2.toFixed(2))}
      ${statsRow("记录得分", rec1.toFixed(2), rec2.toFixed(2))}
      ${pks.map((p) => statsRow(`${LEVEL_CN[p.level]}BV得分`, p.total1.toFixed(2), p.total2.toFixed(2))).join("")}
      ${statsRow("收集 BV 数", a.bv.beg.size + a.bv.int.size + a.bv.exp.size, b.bv.beg.size + b.bv.int.size + b.bv.exp.size)}
      ${pks.map((p) => statsRow(`${LEVEL_CN[p.level]}对抗 BV 数`, p.contest, p.contest)).join("")}
      ${pks.map((p) => statsRow(`${LEVEL_CN[p.level]}胜 / 平 / 负`, `${p.win1} / ${p.tie} / ${p.win2}`, `${p.win2} / ${p.tie} / ${p.win1}`)).join("")}
      ${pks.map((p) => statsRow(`${LEVEL_CN[p.level]}独有 BV 数`, p.u1, p.u2)).join("")}
    </tbody></table>
  </div>`;

  const entryHtml = `
  <div class="mock_note"><b>入口示意</b>（两处新增对战按钮，20px 交叉双剑图标，hover 文案「和TA比拼一下」，未登录/看自己灰置）：</div>
  <div class="box vs_entry_demo">
    <div class="vs_demo_row">
      <span class="vs_demo_label">① 用户主页 · 性别图标 + 对话气泡右侧新增：</span>
      <span class="vs_demo_gender">♂</span>
      <button class="msg_btn" type="button">${BUBBLE_SVG}</button>
      <button class="vs_btn" type="button" title="和TA比拼一下">${SWORDS_SVG}</button>
    </div>
    <div class="vs_demo_row">
      <span class="vs_demo_label">② 侧栏玩家卡片 · 对话气泡按钮下方新增：</span>
      <div class="ranks vs_demo_card">
        <span class="rank_line">山东第 <em>3</em> 名</span>
        <span class="rank_line">全国第 <em>17</em> 名</span>
        <span class="ucd_msg"><button class="msg_btn" type="button">${BUBBLE_SVG}</button></span>
        <span class="ucd_vs"><button class="vs_btn" type="button" title="和TA比拼一下">${SWORDS_SVG}</button></span>
      </div>
    </div>
  </div>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>玩家对战 PK 页 · 设计稿</title>
<link rel="stylesheet" href="../public/styles/legacy-2013.css">
<style>
/* ===== 拟新增样式（设计稿内联预览，确认后落 globals.css） ===== */
/* 入口按钮：20px 交叉双剑，与 .msg_btn 同族；hover 金色（气泡按钮 hover 全站绿，对战用金色区分） */
.vs_btn { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px;
  padding:0; border:0; background:none; color:#75715e; cursor:pointer; vertical-align:middle; }
.vs_btn svg { width:20px; height:20px; }
.vs_btn:hover { color:#fdc61a; }
.vs_btn--disabled { color:#49483e; cursor:default; }
/* 主页 info 区入口：与 SendMessageButton 同排 */
#user_view .info .vs_btn { margin-left:6px; }
/* 卡片入口：气泡按钮正下方（气泡 right:0 top:50% margin-top:-11px 居中于排名块，
   对战按钮同右缘、落到气泡下方：气泡半高 11px + 间隙 2px） */
/* ⚠️ globals 里 .ucd_msg 定位限定在 .user_card .ranks 下，示意区无 .user_card 包裹，此处补等效定位 */
.vs_demo_card .ucd_msg { position:absolute; right:0; top:50%; margin-top:-11px; line-height:0; }
/* 示意区没引 globals.css：复刻 button.msg_btn 外观（22×22 透明底，hover 全站绿） */
.vs_entry_demo button.msg_btn { width:22px; height:22px; margin:0 0 0 2px; padding:0; border:0;
  border-radius:6px; background:transparent; background-image:none; box-shadow:none;
  color:#b1b1a4; font-size:0; line-height:0; vertical-align:middle; }
.vs_entry_demo button.msg_btn:hover { color:#a6e22e; background:rgba(166,226,46,.1); }
.ucd_vs { position:absolute; right:0; top:50%; margin-top:13px; }
.vs_demo_card { position:relative; display:inline-block; padding-right:40px; }
.vs_demo_gender { color:#a6e22e; font-size:18px; font-weight:bold; }
/* ===== PK 页 ===== */
#vs_hero { display:flex; align-items:stretch; gap:12px; }
.vs_card { flex:1 1 0; min-width:0; }
.vs_card_top { display:flex; gap:12px; }
.vs_avatar { width:84px; height:84px; border-radius:6px; object-fit:cover; }
.vs_card_right { min-width:0; }
.vs_name { margin:0; font-size:22px; font-weight:bold; }
.vs_name a { color:#f8f8f2; text-decoration:none; }
.vs_name a:hover { color:#fdc61a; }
.vs_en { margin:0; color:#75715e; font-size:13px; }
.vs_title { display:inline-block; margin-top:4px; padding:1px 8px; border:1px solid; border-radius:3px; font-size:12px; }
.vs_ranks { margin-top:6px; font-size:13px; color:#888; }
.vs_ranks .rank_line { display:block; }
.vs_ranks em { color:#e6db74; font-weight:bold; font-style:normal; }
.vs_radar { text-align:center; }
.vs_radar h3 { margin:4px 0 0; font-size:14px; color:#8a8878; font-weight:normal; }
.vs_vs { display:flex; align-items:center; justify-content:center; }
.vs_vs span { font-size:64px; font-weight:900; font-style:italic; color:#fdc61a;
  text-shadow:0 0 18px rgba(253,198,26,.45), 2px 2px 0 #7a5c00; letter-spacing:2px; }
#vs_records table, #vs_result table { width:100%; max-width:640px; }
.vs_rec th, .vs_rec td { padding:5px 10px; border-bottom:1px solid #3e3d32; text-align:right; font-size:13px; }
.vs_rec tr > th:first-child, .vs_rec tr > td.mk { text-align:left; }
.vs_rec thead th, .vs_rec tr.vs_head th { color:#75715e; font-weight:normal; border-bottom:1px solid #565549; }
.vs_rec td.win { color:#fdc61a; font-weight:bold; }
.vs_rec td.mk { color:#888; font-size:12px; white-space:nowrap; }
.vs_rec td.tie_mk { color:#e6db74; }
.vs_rec th.c1 { color:#9fc9e2; } .vs_rec th.c2 { color:#d9a8c0; }
/* BV 网格 */
.vs_lv { margin-top:18px; }
.vs_lv_head { margin-bottom:6px; font-size:15px; }
.vs_lv_cnt { color:#888; font-size:13px; margin-left:6px; }
.vs_rec th.c1 { color:#a6e22e; } .vs_rec th.c2 { color:#e874ab; }
/* BV 网格：阵营式行布局（我胜靠左 / 独有居中 / 对方胜靠右） */
.vs_bandrow { display:flex; align-items:center; gap:10px; margin-top:6px; min-height:28px; }
.vs_band { width:64px; flex:none; color:#8a8878; font-size:12.5px; background:#2b2b26;
  border:1px solid #3e3d32; text-align:center; padding:4px 0; white-space:nowrap; }
.vs_mid { flex:1 1 auto; display:flex; align-items:center; justify-content:space-between; gap:10px; }
.vs_grp { display:inline-flex; gap:4px; flex-wrap:wrap; }
.vs_c { display:inline-flex; width:27px; height:24px; align-items:center; justify-content:center;
  font-size:12px; font-weight:bold; border-radius:3px; cursor:default; }
.vs_seg { width:86px; flex:none; background:#2b2b26; border:1px solid #3e3d32;
  padding:2px 4px; text-align:center; white-space:nowrap; }
.vs_seg .s1, .vs_seg .s2 { display:block; font-weight:bold; }
.vs_seg .s1 { color:#a6e22e; } .vs_seg .s2 { color:#e874ab; }
.vs_lv_total .vs_band { color:#b1b1a4; }
.vs_lv_total th { color:#b1b1a4; }
.vs_legend { margin-top:14px; display:flex; flex-wrap:wrap; gap:12px; align-items:center; font-size:12.5px; color:#b1b1a4; }
.vs_legend .lg i { display:inline-block; width:14px; height:14px; margin-right:4px; border-radius:2px; vertical-align:-2px; }
.vs_update { color:#75715e; margin-left:auto; }
.vs_rule_note { margin-top:10px; color:#636359; font-size:12px; }
/* 胜负结果 */
.vs_big { display:flex; align-items:baseline; gap:16px; margin:14px 0 18px; }
.vs_big_s1, .vs_big_s2 { font-size:44px; font-weight:bold; }
.vs_big_s1 { color:#a6e22e; } .vs_big_s2 { color:#e874ab; }
.vs_big .win_big { color:#fdc61a; text-shadow:0 0 14px rgba(253,198,26,.4); }
.vs_big_vs { font-size:28px; color:#75715e; }
.vs_verdict { font-size:18px; color:#f8f8f2; margin-left:12px; }
/* 设计稿演示区 */
.vs_entry_demo { margin-bottom:16px; }
.vs_demo_row { margin:10px 0; display:flex; gap:40px; flex-wrap:wrap; align-items:center; }
.vs_demo_label { color:#939387; font-size:13px; margin-right:12px; }
.vs_demo_card .ranks { position:relative; display:inline-block; padding-right:44px; }
body { overflow:auto; }
</style>
</head>
<body>
<div class="mock_note">设计稿 · PK 对战页 <b>/vs/[id]</b> · 真实数据（郭锦洋 9672 vs 濮天羿 9952）·
BV 网格：<b>我胜的 BV 绿色升序靠左 / 对方胜的玫瑰红升序靠右 / 独有与平局居中</b>（2026-11-09 张老师定）·
得分规则：同 BV 对抗快者 1.00 / 独有 0.25 / 平局各 0（张老师定）·
各项记录比拼同规则计分（胜 1.00 / 独有 0.25 / 平 0）·
入口：主页气泡右侧 + 侧栏卡片气泡下方 · 未登录/看自己灰置</div>
${entryHtml}
<div id="page">
  <div class="box" id="vs_hero">
    ${cardHtml(a, "l", "#a6e22e")}
    <div class="vs_vs"><span>VS</span></div>
    ${cardHtml(b, "r", "#e34f8c")}
  </div>
  ${recordsHtml}
  ${bvHtml}
  ${resultHtml}
</div>
</body>
</html>`;

  const { writeFileSync } = await import("fs");
  writeFileSync("design/vs-page.html", html);
  console.log("design/vs-page.html written");
  console.log(`总得分: ${a.name} ${total1.toFixed(2)} : ${b.name} ${total2.toFixed(2)}`);
  for (const p of pks) {
    console.log(`${p.level}: 对抗${p.contest} 胜${p.win1}/${p.win2} 平${p.tie} 独有${p.u1}/${p.u2} 得分 ${p.total1.toFixed(2)}:${p.total2.toFixed(2)}`);
  }
  await prisma.$disconnect();
}

// 气泡 / 双剑图标（与组件同源）
const BUBBLE_SVG = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20"><path d="M10 3.2c-4.1 0-7.4 2.8-7.4 6.3 0 1.9 1 3.7 2.6 4.9l-.7 3 3.1-1.7c.77.2 1.57.3 2.4.3 4.1 0 7.4-2.9 7.4-6.5S14.1 3.2 10 3.2z" stroke-linejoin="round"/><circle cx="6.9" cy="9.5" r="0.95" fill="currentColor" stroke="none"/><circle cx="10" cy="9.5" r="0.95" fill="currentColor" stroke="none"/><circle cx="13.1" cy="9.5" r="0.95" fill="currentColor" stroke="none"/></svg>`;
const SWORDS_SVG = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 3.5 L14.5 14 M16 3.5 L5.5 14" stroke-linecap="round"/><path d="M12.6 13.1 L15.5 16 M7.4 13.1 L4.5 16" stroke-linecap="round"/><path d="M3 16.2 L5.2 14" stroke-linecap="round"/><path d="M17 16.2 L14.8 14" stroke-linecap="round"/></svg>`;

main().catch((e) => { console.error(e); process.exit(1); });
