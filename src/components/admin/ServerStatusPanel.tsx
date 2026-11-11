"use client";

// 服务器负载面板（2026-10-28 张老师需求）：后台练习数据页，列出全部权威服务
// 实例，每 3s 轮询 /api/admin/authority-status 刷新。
// 2026-10-31 张老师需求：卡片改表格 + 可排序表头——默认按在线人数降序，表头
// 点击切换升/降序（视觉语言照前台录像列表表头 VideoRows 的 .sa 双三角）。
// 2026-11-01 张老师需求：①「进行」改「对局」，在线/对局合并一列（照录像列表
// 评论/点击的「N / M」双数字形态）；②延迟列弃后台探测值，改玩家实测
// （ranked_rtt_log 近 7 天按节点聚合）。
// 2026-11-01 二次（张老师定稿）：③隐藏状态列，状态色点移到服务器名前；
// ④在线/对局各独立一列，均显「x / y」双数字——在线 x＝当前在线连接数 /
// y＝累计去重连接人数；对局 x＝进行中对局数 / y＝累计开局面数（gamesServed）。
// 2026-11-01 三次（张老师定稿）：⑤累计值（y）一律暗灰，当前对局数金色（当前
// 在线保持绿）；⑥表头只显「在线」「对局」单词，点击按累计值排序，默认按累计
// 连接人数降序。
// 2026-11-01 四次（张老师）：平均延迟列三色渲染（35/75 分界），口径与今日地区表
// 同源（rttColor.ts）。
// 2026-11-02 改版（张老师需求）：轮询提升到 PracticeRegionBoard（服务器数据同时
// 喂地图 PIN 钉），本组件变纯展示；行 hover 上报 onHoverServer 与地图钉联动
// （hover 行 → 钉高亮放大；hover 钉 → 行 .hl 高亮）。
// 2026-11-02 二次（张老师需求）：点击服务器行展开/收起该服在线玩家列表
// （地区/玩家名/性别/军衔/本服累计对局数），数据随 3s 轮询同源自
// /api/admin/authority-status（Next 侧查库补齐展示字段）；再点行收起。
// 2026-11-02 三次（张老师）：①性别/军衔不单独成列——玩家名后放性别小标记
// （.gender.small）+ 军衔徽章（TitleBadge 小号）+军衔名；②对局列后加在线
// 时长列（本轮连接建立起算，core /players 出 secs，同 uid 多标签页取最早）。
// 2026-11-08 张老师需求：灰色累计值改「仅限今天」——在线 y＝今日去重连接
// 人数、对局 y＝今日开局面数（core server.mjs 北京时间零点清零，stats.json
// 落盘重启不清零），排序同步按今日值。
// 2026-11-11 张老师需求：展开玩家列表中正在对局中的玩家，对局数字金色渲染
// （同主表进行中对局数 #fdc61d；core /players 出 playing=任一连接挂着未结束的局）。

import { Fragment, useState } from "react";
import { rttColor, RTT_LEGEND } from "./rttColor";
import { TitleBadge } from "../Cells";

/* 展开子表单元格样式（紧凑小字号，暗底与主表区分；导出供今日地区明细行展开复用） */
export const SUB_TH: React.CSSProperties = { fontWeight: 400, padding: "1px 10px 3px 0", borderBottom: "1px solid #3e3d32" };
export const SUB_TD: React.CSSProperties = { padding: "1px 10px 1px 0", color: "#d6d6cc", whiteSpace: "nowrap" };

/** 在线玩家行（与 /api/admin/authority-status 的 PlayerRow 同形） */
export interface PlayerBrief {
  uid: number;
  name: string;
  area: string;
  sex: number;
  rank: string;
  games: number;
  /** 本轮在线时长（秒，连接建立起算） */
  online: number;
  /** 本节点 ranked 局实测平均延迟（近 7 天，null=无样本） */
  rttAvg: number | null;
  /** 本节点延迟样本数 */
  rttN: number;
  /** 正在对局中（2026-11-11 张老师需求：对局数字金色渲染；旧版实例缺字段按 false） */
  playing: boolean;
}

/** 在线时长折算（2026-11-02 三次：对局列后加在线时长列） */
function fmtOnline(s: number): string {
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分`;
  return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`;
}

export interface ServerRow {
  name: string;
  region: string;
  slot: string;
  ok: boolean;
  rtt: number;
  connections: number;
  active: number;
  games: number;
  draining: boolean;
  connsUsers: number;
  gamesServed: number;
  rttAvg: number | null;
  rttN: number;
  /** 在线玩家（null=获取失败；[]＝无在线玩家） */
  players: PlayerBrief[] | null;
}

type SortKey = "name" | "connsUsers" | "gamesServed" | "rttAvg";
interface SortSpec {
  key: SortKey;
  dir: "asc" | "desc";
}
/** 各列默认方向：计数列降序（多在前），延迟列升序（快在前），名称列升序。
    在线/对局表头单词化（2026-11-01 三次），排序键=累计值 */
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  name: "asc",
  connsUsers: "desc",
  gamesServed: "desc",
  rttAvg: "asc",
};

/** 升降序双箭头（照抄 VideoRows.SortArrows 视觉：金色=当前方向） */
function SortArrows({ dir }: { dir: "asc" | "desc" }) {
  return (
    <span className="sa" aria-hidden="true">
      <i className={`up${dir === "asc" ? " on" : ""}`} />
      <i className={`down${dir === "desc" ? " on" : ""}`} />
    </span>
  );
}

export function ServerStatusPanel({
  servers,
  at,
  hoverServer,
  onHoverServer,
}: {
  servers: ServerRow[] | null;
  at: number;
  hoverServer: string | null;
  onHoverServer: (name: string | null) => void;
}) {
  const [sort, setSort] = useState<SortSpec>({ key: "connsUsers", dir: "desc" });
  /* 展开的服务器名集合（2026-11-02 二次：点击行展开在线玩家，再点收起） */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const clickSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] },
    );

  // 排序键取值：数值列不可用行 -1 沉底，无延迟样本（null）在延迟列恒沉底
  const rank = (r: ServerRow): number => {
    if (sort.key === "name") return 0;
    if (sort.key === "rttAvg") return r.rttAvg !== null && r.ok ? r.rttAvg : -1;
    return r.ok ? (r[sort.key] as number) : -1;
  };
  const sorted = [...(servers ?? [])].sort((a, b) => {
    if (sort.key === "name") {
      return sort.dir === "asc" ? a.name.localeCompare(b.name, "zh") : b.name.localeCompare(a.name, "zh");
    }
    const d = rank(a) - rank(b);
    return sort.dir === "asc" ? d : -d;
  });

  /** 表头排序按钮（双数字列的两个数字各自独立排序入口） */
  const thInner = (key: SortKey, label: string, tip: string) => (
    <button
      type="button"
      className={`sv_sort${sort.key === key ? " on" : ""}`}
      onClick={() => clickSort(key)}
      title={tip}
    >
      {label}
      {sort.key === key && <SortArrows dir={sort.dir} />}
    </button>
  );

  /** 状态色点（2026-11-01 二次：状态列隐藏，色点移到服务器名前） */
  const dot = (r: ServerRow) => (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 5,
        verticalAlign: "middle",
        background: r.ok ? (r.draining ? "#f79646" : "#a6e22e") : "#e24b4a",
      }}
      aria-label={r.ok ? (r.draining ? "排空中" : "可用") : "不可用"}
      title={r.ok ? (r.draining ? "排空中（拒绝新局）" : "正常") : "不可用"}
    />
  );

  /** 「x / y」双数字单元格（2026-11-01 三次：当前在线绿、当前对局金、累计一律暗灰） */
  const pair = (r: ServerRow, now: number, nowColor: string, total: number) =>
    r.ok ? (
      <>
        <b style={{ color: nowColor }}>{now}</b>
        <span style={{ color: "#49483e" }}> / </span>
        <b style={{ color: "#75715e" }}>{total.toLocaleString("zh-CN")}</b>
      </>
    ) : (
      <span style={{ color: "#49483e" }}>—</span>
    );

  return (
    <div
      className="sv_panel"
      style={{
        flex: "0 0 400px",
        border: "1px solid #3e3d32",
        borderRadius: 6,
        background: "#272822",
        padding: "10px 12px",
        fontSize: 13,
        lineHeight: 1.5,
        color: "#f8f8f2",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <b style={{ fontSize: 14 }}>服务器负载</b>
        <span style={{ color: "#75715e", fontSize: 12 }}>
          {servers ? `每 3 秒刷新 · ${at ? new Date(at).toLocaleTimeString("zh-CN", { hour12: false }) : ""}` : "获取中…"}
        </span>
      </div>
      <table className="sv_table">
        <thead>
          <tr>
            <th>{thInner("name", "服务器", "按服务器名称排列")}</th>
            {/* 在线/对局表头单词化（2026-11-01 三次），点击按累计值排序 */}
            {/* 在线/对局表头单词化（2026-11-01 三次），点击按累计值排序；内容左对齐（11-01 张老师） */}
            <th>{thInner("connsUsers", "在线", "按今日去重连接人数排列（多在前）")}</th>
            <th>{thInner("gamesServed", "对局", "按今日开局面数排列（多在前）")}</th>
            <th className="c">{thInner("rttAvg", "平均延迟", "按玩家实测平均延迟排列（快在前；近 7 天采样）")}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <Fragment key={r.name}>
              <tr
                className={`${hoverServer === r.name ? "hl" : ""}${expanded.has(r.name) ? " sv_open" : ""}`}
                style={{ cursor: "pointer" }}
                title="点击展开/收起该服在线玩家列表"
                onMouseEnter={() => onHoverServer(r.name)}
                onMouseLeave={() => onHoverServer(null)}
                onClick={() => toggleExpand(r.name)}
              >
                <td>
                  {dot(r)}
                  <b style={{ color: "#d6d6cc" }}>{r.name}</b>
                </td>
                <td title="x＝当前在线连接数 · y＝今日去重连接人数（北京时间零点清零，重启不清零；点击表头按今日值排序）">
                  {pair(r, r.connections, "#a6e22e", r.connsUsers)}
                </td>
                <td title="x＝进行中对局数 · y＝今日开局面数（北京时间零点清零，重启不清零；点击表头按今日值排序）">
                  {pair(r, r.active, "#fdc61d", r.gamesServed)}
                </td>
                <td
                  className="c"
                  title={r.ok && r.rttAvg !== null ? `近 7 天 ${r.rttN} 个玩家实测样本 · ${RTT_LEGEND}` : undefined}
                >
                  {r.ok && r.rttAvg !== null ? (
                    <span style={{ color: rttColor(r.rttAvg) }}>{r.rttAvg}ms</span>
                  ) : (
                    <span style={{ color: "#49483e" }}>—</span>
                  )}
                </td>
              </tr>
              {/* 在线玩家列表（2026-11-02 二次）：点击行展开，再点收起。
                  players=null=获取失败；空数组=无在线玩家；数据随 3s 轮询刷新 */}
              {expanded.has(r.name) && (
                <tr>
                  <td colSpan={4} style={{ background: "#1e1f1a", padding: "6px 10px 8px 23px" }}>
                    {!r.ok ? (
                      <span style={{ color: "#49483e" }}>实例不可用</span>
                    ) : r.players === null ? (
                      <span style={{ color: "#e24b4a" }}>在线玩家获取失败</span>
                    ) : r.players.length === 0 ? (
                      <span style={{ color: "#75715e" }}>当前无在线玩家</span>
                    ) : (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, lineHeight: 1.7 }}>
                        <thead>
                          <tr style={{ color: "#75715e", textAlign: "left" }}>
                            <th style={SUB_TH}>地区</th>
                            <th style={SUB_TH}>玩家</th>
                            <th style={{ ...SUB_TH, textAlign: "right" }} title="该玩家今日在本服务器开局面数（北京时间零点清零，重启不清零）；金色＝正在对局中">对局</th>
                            <th style={{ ...SUB_TH, textAlign: "right" }} title="本轮连上本服务器起的在线时长（刷新/断线重连重新计；同 uid 多标签页取最早连接）">在线时长</th>
                            <th style={{ ...SUB_TH, textAlign: "right" }} title={`该玩家近 7 天在本节点排行局实测平均延迟（随局上报采样）· ${RTT_LEGEND}`}>延迟</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.players.map((p) => (
                            <tr key={p.uid}>
                              <td style={SUB_TD} title={p.area ? undefined : "未填写地区"}>
                                {p.area || <span style={{ color: "#49483e" }}>未知</span>}
                              </td>
                              <td style={SUB_TD}>
                                <a
                                  href={`/user/${p.uid}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: "#f8f8f2", textDecoration: "none" }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {p.name}
                                </a>
                                {/* 性别小标记 + 军衔徽章（2026-11-02 三次：并入玩家列，不单独成列） */}
                                <span
                                  className={`gender ${p.sex ? "male" : "female"} small`}
                                  style={{ margin: "0 4px 0 5px" }}
                                  title={p.sex ? "男" : "女"}
                                />
                                <TitleBadge title={p.rank} badgeSize={13} />
                              </td>
                              {/* 对局数字金色=正在对局中（2026-11-11，同主表进行中对局色） */}
                              <td style={{ ...SUB_TD, textAlign: "right" }} className="num">
                                {p.playing ? (
                                  <b style={{ color: "#fdc61d" }} title="正在对局中">{p.games.toLocaleString("zh-CN")}</b>
                                ) : (
                                  p.games.toLocaleString("zh-CN")
                                )}
                              </td>
                              <td style={{ ...SUB_TD, textAlign: "right" }} className="num" title="本轮连上本服务器起的在线时长">
                                {fmtOnline(p.online)}
                              </td>
                              {/* 延迟列（2026-11-02 五次：三色同主表 rttColor 口径，无样本显 —） */}
                              <td
                                style={{ ...SUB_TD, textAlign: "right" }}
                                className="num"
                                title={p.rttAvg !== null ? `近 7 天 ${p.rttN} 个实测样本 · ${RTT_LEGEND}` : "暂无实测样本"}
                              >
                                {p.rttAvg !== null ? (
                                  <span style={{ color: rttColor(p.rttAvg) }}>{p.rttAvg}ms</span>
                                ) : (
                                  <span style={{ color: "#49483e" }}>—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {servers !== null && servers.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "#e24b4a", textAlign: "center" }}>
                全部实例不可达
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div style={{ marginTop: 8, color: "#75715e", fontSize: 12 }}>
        <span style={{ color: "#a6e22e" }}>●</span> 正常 ·{" "}
        <span style={{ color: "#f79646" }}>●</span> 排空 ·{" "}
        <span style={{ color: "#e24b4a" }}>●</span> 不可用 · 在线＝当前连接 / 今日人数（灰） ·
        对局＝进行中 / 今日局数（灰） · 平均延迟＝玩家实测近 7 天均值（{RTT_LEGEND}） ·
        点击表头按今日值排序 · 点击行展开在线玩家
      </div>
    </div>
  );
}
