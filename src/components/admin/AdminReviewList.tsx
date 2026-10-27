// 审核队列（客户端，2026-09-24；2026-10-19 接自动分拣池 + 播放栏）
//
// 播放入口用于防盲审，免核定录像可勾选批量操作。
// 审核管线的防盲审规则（2026-10-19 起口径）：在播放器里看过或下载过（任一）即可审核，
// 播放栏按钮弹全屏播放器出录像（AdminVideoPlayer），看过自动计数（markWatched）。
//
// 自动分拣（2026-10-19 方案 v2）：机器只分拣、不审批。
// · pool="exempt"（免核定池）→ 显示勾选框，可批量一键通过；
// · pool="need"（需核定池）→ 无勾选框，行内展示触发原因标签，只能逐条手审；
// · 无 pool（全部待审）→ 按行内标注混合展示：需核定行隐藏勾选框。

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminVideoRow } from "@/lib/admin/data";
import { LevelTag, StatusTag } from "./Widgets";
import { postOp, useOp } from "./AdminAction";
import { onPendingCounts, refreshPendingCounts } from "./PendingCounts";
import { toast } from "@/components/Toast";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";
import { VIDEO_STATUS, type VideoLevel } from "@/lib/config";
import { PRESS_AVG_MS, STNB_TRIGGER } from "@/lib/video-triage-limits";
import { AdminVideoPlayer, type AdminPlayerTarget } from "./AdminVideoPlayer";
import { confirmDialogChecked } from "@/components/Confirm";

const LEVEL_NAMES: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };

/** auto_reason 位码 → 后台标签（cheat 类红 / 价值类青 / 信任类紫 / 系统灰）；
 *  标签带具体数值与阈值（2026-10-19 张老师要求：需手审的要看得到原因细节） */
function reasonTagList(v: AdminVideoRow) {
  const r = v.autoReason;
  const lv = v.level;
  const pressLine = PRESS_AVG_MS[lv] ?? 60;
  const stnbLine = STNB_TRIGGER[lv] ?? 150;
  const tags: { text: string; title: string; cls: string }[] = [];
  const pressVal = v.pressAvgMs != null ? `${v.pressAvgMs}ms` : "命中";
  if (r & (1 << 0)) {
    tags.push({
      text: `按住时长 ${pressVal}≤${pressLine}ms`,
      title: `全盘鼠标按下→松开平均时长 ${v.pressAvgMs != null ? v.pressAvgMs + "ms（命中键：左/右键独立判定，取命中值）" : "（现算失败）"}，低于${LEVEL_NAMES[lv] ?? "该级别"}线 ${pressLine}ms，疑似机器生成事件流`,
      cls: "bad",
    });
  }
  if (r & (1 << 1)) {
    tags.push({
      text: `STNB ${v.stnb != null ? v.stnb.toFixed(1) : "?"}>${stnbLine}`,
      title: `表现分 STNB 超过${LEVEL_NAMES[lv] ?? "该级别"}线 ${stnbLine}（p99），值得人工复核的高光局`,
      cls: "info",
    });
  }
  if (r & (1 << 2)) {
    tags.push({
      text: `手速 ${v.cls != null ? v.cls.toFixed(1) : "?"}次/秒`,
      title: `手速超过 10 次/秒（全站真实最高 7.77），人类极难达到`,
      cls: "bad",
    });
  }
  if (r & (1 << 3)) {
    tags.push({
      text: "无鼠标移动",
      title: "全程鼠标行程为 0 且点击超过 20 次——无移动连点，脚本特征",
      cls: "bad",
    });
  }
  if (r & (1 << 4)) {
    tags.push({
      text: `点击数 ${v.cl ?? "?"} 过少`,
      title: `总点击低于盘面 3BV×0.8 的理论下限，通关操作量不足`,
      cls: "bad",
    });
  }
  if (r & (1 << 6)) tags.push({ text: "破个人纪录", title: "该成绩将刷新上传者个人最好成绩，动态发布前需人工确认", cls: "info" });
  if (r & (1 << 7)) tags.push({ text: "进级别 TOP 榜", title: "该成绩将进入级别 TOP 榜，上榜成绩需人工把关", cls: "info" });
  if (r & (1 << 8)) tags.push({ text: "首次入伍", title: "该录像通过将使上传者三级成绩首次齐全（触发入伍动态）", cls: "info" });
  if (r & (1 << 9)) tags.push({ text: "低信任账号", title: "上传者名下有被屏蔽录像或账号有封禁记录，全部录像需人工审核", cls: "warn" });
  if (r & (1 << 10)) {
    tags.push({
      text: "path 异常·超大往返瞬移",
      title: "鼠标轨迹含超大范围往返瞬移：相邻事件 >100px 的瞬移贡献过半行程，且方向左右对称、呈周期性（2026-10-23 347022 与已屏蔽 3 盘定标；全站 30 万盘回扫零误报）——脚本/外挂特征",
      cls: "bad",
    });
  }
  if (r & (1 << 11)) {
    tags.push({
      text: "path 超速·平均移动过快",
      title: "全程平均鼠标移动速率超 30 格/秒（≥30 秒长局）——人类全站最高 22.4 格/s（2026-10-23 定标，347022 作弊盘 51.2 格/s）",
      cls: "bad",
    });
  }
  if (r & (1 << 12)) {
    tags.push({
      text: "ms-toollib 校验不通过",
      title: "ms-toollib（Rust 扫雷算法库）按排名网站自动审核规则判为不通过：软件白名单外 / 校验和为测试值 / 软件判定使用辅助手段 / 鼠标轨迹呈程序化特征（重复移动 / 按住过短 / 极短按过多 / 轨迹熵过低）。⚠️ 元扫雷 3.3.5+ 新版本不在库白名单内也会触发本项，复核时先看录像 software 字段",
      cls: "bad",
    });
  }
  if (r & (1 << 13)) {
    tags.push({
      text: "ms-toollib 校验可疑",
      title: "ms-toollib 自动审核判为可疑：操作细节不足（动作数/3BV < 10）或鼠标特征达可疑阈值（按住时长 30~40ms / 极短按 4~10 次 / 轨迹方向熵/转向熵偏低），无法确认真实，需人工复核",
      cls: "warn",
    });
  }
  if (r & (1 << 14)) {
    tags.push({
      text: "盲区率过低",
      title: "排名局行为审计：重放权威事件流 + 可靠性求解器，本局盲区点击率 <2%，且本局盲区 ≥2 个、决策点击 ≥15（盲区太少的局比率无参考意义，初/中级短局天然豁免）。定标依据：高级时间榜 TOP20 真人实测 2.6%~10%，低于 2% 是求解器特征（2026-10-27 张老师定标）",
      cls: "bad",
    });
  }
  if (r & (1 << 15)) {
    tags.push({
      text: "排名录像签名不符",
      title: "排名模式 evf 的服务端 HMAC 签名与当前文件字节不一致——文件在上传后被替换/篡改（2026-10-27）。请核对该录像的上传链路与文件完整性",
      cls: "bad",
    });
  }
  if (r & (1 << 16)) {
    tags.push({
      text: "排名局·历史强审标记",
      title: "2026-10-27 排名局曾全部强制转手审时打的标记（该临时口径已于 2026-10-28 停用，排名局恢复正常分拣）。这不是作弊信号；本盘未被重跑分拣前仍显示旧位",
      cls: "info",
    });
  }
  return tags;
}

function ReasonTags({ video }: { video: AdminVideoRow }) {
  const tags = reasonTagList(video);
  if (!tags.length) return <span className="sub">—</span>;
  const cheatHits = tags.filter((t) => t.cls === "bad").length;
  return (
    <>
      {cheatHits >= 2 && <span className="admin_tag bad">疑似作弊</span>}{" "}
      {tags.map((t) => (
        <span key={t.text} className={`admin_tag ${t.cls}`} title={t.title}>
          {t.text}
        </span>
      ))}
    </>
  );
}

export function AdminReviewList({
  initial,
  status,
  pool,
  pendingTotal,
  poolCounts,
  exemptTotal,
  needTotal,
}: {
  initial: AdminVideoRow[];
  status: number;
  pool?: string;
  /** 服务端渲染这一刻的待审录像总数（video.status=10）。用作「队列变了」的基线：
   *  客户端校准到的待审数一旦与之不同 → 说明有新片进来或被别人审掉 → 自动刷新本页 */
  pendingTotal: number;
  /** 两个分拣池待审数（仅待审视图有值）：当前池没活时自动切到有活的那个 */
  poolCounts: { exempt: number; need: number };
  /** 当前待审免核定总数（跨页全选用，来自列表查询 total 或独立 count） */
  exemptTotal?: number;
  /** 2026-10-21 需核定池剩余数（免核定清空后的自动跳转判断用） */
  needTotal?: number;
}) {
  const [items, setItems] = useState(initial);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  /** 全选跨页模式：选中「全部免核定」（不限于本页）；此时已选数＝服务端全池计数。
   *  2026-10-21 张老师需求：进免核定池默认全选（进页即可批量通过）。 */
  const [allMode, setAllMode] = useState(pool === "exempt");
  /** 屏蔽气泡确认（应用内弹窗，不用浏览器模态） */
  const [banConfirm, setBanConfirm] = useState<"page" | "all" | null>(null);
  /** 批量屏蔽 → 低信任分流勾选（2026-10-28 张老师需求，默认勾选；单条屏蔽走 confirmDialogChecked） */
  const [banLowTrust, setBanLowTrust] = useState(true);
  /** 全屏回放播放器（2026-10-19 张老师需求：点时间列弹层看录像） */
  const [playTarget, setPlayTarget] = useState<AdminPlayerTarget | null>(null);

  // ---------- 队列实时校准（2026-10-27 张老师报障） ----------
  // 现象：全部审完后又有新录像，侧栏/顶栏红数字亮了（60s 轮询），本页还停在「该状态下没有录像」。
  // 做法：订阅同一份待审计数，数字一变就 router.refresh() 重跑本页（KPI、池计数、列表都是服务端算的）。

  /** 已知的待审总数基线：服务端每次重渲后跟新值，避免同一次变化反复刷新 */
  const pendingRef = useRef(pendingTotal);
  useEffect(() => {
    pendingRef.current = pendingTotal;
  }, [pendingTotal]);

  /** 忙（批量操作中）/ 正在看录像时不打断，等下一轮轮询再处理 */
  const busyRef = useRef(busy);
  const playingRef = useRef(playTarget !== null);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    playingRef.current = playTarget !== null;
  }, [playTarget]);

  /** 刷新去抖：一次变化只刷一次（避免连续变化把渲染冲掉） */
  const timerRef = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      router.refresh();
    }, 600);
  }, [router]);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  useEffect(() => {
    if (status !== VIDEO_STATUS.NORMAL) return;
    return onPendingCounts(({ pending }) => {
      if (pending === pendingRef.current) return;
      // 基线不动 → 下一轮轮询会再判一次（忙完/关掉播放器后自动补上）
      if (busyRef.current || playingRef.current) return;
      pendingRef.current = pending;
      scheduleRefresh();
    });
  }, [status, scheduleRefresh]);

  /** 审核页把校准频率提到 10s（全局 60s 太钝：新片进来要尽快看到）。
   *  同一份计数只拉一次，侧栏 badge 与顶栏摘要跟着一起准。 */
  useEffect(() => {
    if (status !== VIDEO_STATUS.NORMAL) return;
    const id = window.setInterval(() => void refreshPendingCounts(true), 10_000);
    return () => window.clearInterval(id);
  }, [status]);

  /** 服务端重渲带回新列表（自动刷新 / 自己审完的 router.refresh）→ items 跟上。
   *  useState 只在挂载时吃 initial，之后 props 变了不会自动同步——
   *  不补这一步，自动刷新只会更新外壳与 KPI，表格还是旧的（甚至是空着）。 */
  const initialRef = useRef(initial);
  useEffect(() => {
    if (initialRef.current === initial) return;
    initialRef.current = initial;
    setItems(initial);
    // 勾选只保留仍然存在的行（被别人审掉的行不能继续算进批量操作）
    setPicked((prev) => {
      if (prev.size === 0) return prev;
      const keep = new Set(initial.map((i) => i.id));
      const next = new Set([...prev].filter((id) => keep.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [initial]);

  /** 当前池清空了、另一个池有活 → 自动切过去。
   *  沿用 2026-10-21「免核定清空后自动转需核定」的口径：空队列不让人干等；
   *  也覆盖「清空后新片进了另一个池」——否则本页空着、角标却在亮红数字。 */
  useEffect(() => {
    if (status !== VIDEO_STATUS.NORMAL || !pool || items.length > 0) return;
    const self = pool === "exempt" ? poolCounts.exempt : poolCounts.need;
    const other = pool === "exempt" ? poolCounts.need : poolCounts.exempt;
    if (self > 0 || other <= 0) return;
    const to = pool === "exempt" ? "need" : "exempt";
    router.replace(`/admin/review?status=${VIDEO_STATUS.NORMAL}&pool=${to}`);
  }, [status, pool, items.length, poolCounts.exempt, poolCounts.need, router]);

  // 可勾选的行：免核定池（或未分池视图里的免核定行）且仍待审
  const pickable = (v: AdminVideoRow) =>
    status === VIDEO_STATUS.NORMAL && v.autoFlag === 1;

  const drop = (ids: number[]) => setItems((prev) => prev.filter((i) => !ids.includes(i.id)));

  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pickableItems = items.filter(pickable);
  // 全池免核定数：exempt 池视图直接用列表 total；混合视图独立统计本页（全选仅对 exempt 池开放跨页）
  const exemptCount = pool === "exempt" ? (exemptTotal ?? pickableItems.length) : pickableItems.length;
  const allOn = allMode || (pickableItems.length > 0 && picked.size === pickableItems.length && pool !== "exempt");
  const toggleAll = () => {
    if (pool === "exempt") {
      // 跨页全选：进入 all 模式（已选=全部免核定）；再点取消
      setAllMode((v) => !v);
      setPicked(new Set());
    } else {
      setPicked(allOn ? new Set() : new Set(pickableItems.map((i) => i.id)));
    }
  };
  const selectedCount = allMode ? exemptCount : picked.size;

  const runBatch = async (ids: number[], all: boolean, nextStatus: number, lowTrust?: boolean) => {
    setBusy(true);
    const res = await postOp("video.batchReview", {
      ids: all ? ["all"] : ids, // ids=["all"]+pool=exempt = 服务端取全部免核定（跨页）
      pool: all ? "exempt" : undefined,
      status: nextStatus,
      ...(nextStatus === VIDEO_STATUS.BANNED && lowTrust !== undefined ? { lowTrust } : {}),
    });
    setBusy(false);
    toast(res.ok ? res.message ?? "批量完成" : res.error ?? "批量失败", res.ok ? "success" : "error");
    if (res.ok) {
      if (all) setItems([]); // 全池操作：本页清空（全池都已处理）
      else drop(ids);
      setPicked(new Set());
      setAllMode(false);
      // 刷新服务端布局：侧栏待审角标 / 顶栏摘要 / KPI 随审核结果同步减少，归零即消失
      //（2026-10-22 张老师报障：批量审核走裸 postOp 不刷新布局，红数字不动）
      router.refresh();
      // 免核定清空后自动转去需核定手审（2026-10-21 张老师需求；下一屏没活干就回全部待审）
      if (pool === "exempt") {
        const rest = (exemptTotal ?? ids.length) - ids.length;
        if (rest <= 0) {
          const to = (needTotal ?? 0) > 0 ? "/admin/review?status=10&pool=need" : "/admin/review?status=10";
          if (typeof window !== "undefined") window.location.href = to;
        }
      }
    }
  };

  // 批量通过：免确认直接执行（2026-10-19 张老师定：通过无需确认）
  const batchPass = () => {
    if (allMode) return runBatch([], true, VIDEO_STATUS.REVIEWED);
    const ids = [...picked];
    if (ids.length) return runBatch(ids, false, VIDEO_STATUS.REVIEWED);
  };
  // 批量屏蔽：应用内气泡确认（不用 window.confirm 模态）
  const batchBanAsk = () => {
    setBanLowTrust(true); // 每次打开重置默认勾选
    setBanConfirm(allMode ? "all" : "page");
  };
  const batchBanDo = () => {
    setBanConfirm(null);
    if (allMode) return runBatch([], true, VIDEO_STATUS.BANNED, banLowTrust);
    const ids = [...picked];
    if (ids.length) return runBatch(ids, false, VIDEO_STATUS.BANNED, banLowTrust);
  };

  const showBatchBar = status === VIDEO_STATUS.NORMAL && (pool === undefined || pool === "exempt") && items.length > 0;

  return (
    <>
      {showBatchBar && (
        <div className="admin_filterbar">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#939387" }}>
            <input type="checkbox" checked={allOn} onChange={toggleAll} style={{ width: 14, height: 14 }} />
            {pool === "exempt" ? "全选全部免核定（跨页）" : "全选本页免核定"}
          </label>
          <span className="label">
            已选 {selectedCount} 条{allMode ? "（全部免核定，含未翻页）" : pool === "exempt" ? ` / 共 ${exemptCount} 条` : ""}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="admin_btn primary"
            disabled={busy || selectedCount === 0}
            onClick={batchPass}
          >
            批量通过{selectedCount > 0 ? `（${selectedCount}）` : ""}
          </button>
          <button
            type="button"
            className="admin_btn danger"
            disabled={busy || selectedCount === 0}
            onClick={batchBanAsk}
          >
            批量屏蔽
          </button>
          {(picked.size > 0 || allMode) && (
            <button
              type="button"
              className="admin_btn"
              onClick={() => {
                setPicked(new Set());
                setAllMode(false);
              }}
            >
              取消选择
            </button>
          )}
        </div>
      )}

      {/* 批量屏蔽气泡确认（应用内弹窗，复用 ban_overlay 视觉） */}
      {banConfirm && (
        <div className="ban_overlay" onClick={() => !busy && setBanConfirm(null)}>
          <div className="ban_dialog" onClick={(e) => e.stopPropagation()}>
            <h1>批量屏蔽确认</h1>
            <p className="ban_desc">
              即将屏蔽 <b style={{ color: "#f92672" }}>{banConfirm === "all" ? `全部 ${exemptCount} 条免核定` : `${picked.size} 条选中`}</b>
              录像，对应玩家最好成绩会被回退（有次优录像则自动顶替）。此操作影响公开榜单，请确认。
            </p>
            <label className="ban_check">
              <input type="checkbox" checked={banLowTrust} onChange={(e) => setBanLowTrust(e.target.checked)} />
              <span>同时将涉及的上传者加入低信任用户组</span>
            </label>
            <div className="ban_ops">
              <button type="button" className="admin_btn" disabled={busy} onClick={() => setBanConfirm(null)}>
                取消
              </button>
              <button type="button" className="admin_btn danger" disabled={busy} onClick={batchBanDo}>
                {busy ? "处理中…" : "确认屏蔽"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全屏回放播放器（点时间列弹出，Esc/关闭按钮退出）；
          markWatched 落库成功即把该行置已看（按钮/淡显即时切换，2026-10-27） */}
      <AdminVideoPlayer
        target={playTarget}
        onClose={() => setPlayTarget(null)}
        onWatched={(id) =>
          setItems((prev) => prev.map((i) => (i.id === id && !i.watched ? { ...i, watched: true } : i)))
        }
      />

      <div className="admin_scroll">
        <table className="admin_table">
          <thead>
            <tr>
              {status === VIDEO_STATUS.NORMAL && <th style={{ width: 36 }} />}
              <th className="c">ID</th>
              <th>玩家</th>
              <th className="c">级别</th>
              <th className="num">时间</th>
              <th className="num">3BV</th>
              <th className="num">3BV/s</th>
              <th className="num">STNB</th>
              <th className="c">玩法</th>
              <th>软件</th>
              <th className="c">分拣</th>
              <th className="c">播放</th>
              <th className="c">状态</th>
              <th>上传时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <ReviewRow
                key={v.id}
                video={v}
                showPick={pickable(v)}
                picked={picked.has(v.id)}
                onToggle={() => toggle(v.id)}
                onRemoved={() => drop([v.id])}
                onPlay={() =>
                  setPlayTarget(
                    v.filepath && v.realTime
                      ? {
                          id: v.id,
                          level: v.level as VideoLevel,
                          filepath: v.filepath,
                          realTime: v.realTime,
                          player: v.author?.chineseName ?? `#${v.user}`,
                        }
                      : null
                  )
                }
              />
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={15}>
                  <div className="admin_empty">该状态下没有录像</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ReviewRow({
  video: v,
  showPick,
  picked,
  onToggle,
  onRemoved,
  onPlay,
}: {
  video: AdminVideoRow;
  showPick: boolean;
  picked: boolean;
  onToggle: () => void;
  onRemoved: () => void;
  onPlay: () => void;
}) {
  const { run, busy } = useOp();
  // 需核定行（含未分拣/失败保守处理）微红底提示；已看行整行淡显（2026-10-19 张老师定：视觉区分）
  const needRow = v.autoFlag !== 1;
  const rowStyle = needRow
    ? { background: "rgba(249,38,114,.05)" }
    : v.watched
      ? { opacity: 0.55 }
      : undefined;
  return (
    <tr style={rowStyle}>
      {showPick ? (
        <td className="c">
          <input
            type="checkbox"
            checked={picked}
            onChange={onToggle}
            style={{ width: 14, height: 14 }}
            aria-label={`选择录像 ${v.id}`}
          />
        </td>
      ) : (
        <td className="c sub" title="需核定：只能逐条手审">🔒</td>
      )}
      <td className="c">
        <Link className="link" href={`/video/${v.id}`} target="_blank">
          {v.id}
        </Link>
      </td>
      <td>
        <Link className="link" href={`/admin/users/${v.user}`}>
          {v.author?.chineseName ?? `#${v.user}`}
        </Link>
      </td>
      <td className="c">
        <LevelTag level={v.level} />
      </td>
      <td className="num strong">
        {v.realTime && v.filepath ? (
          <a
            className={v.watched ? "" : "link"}
            style={v.watched ? { color: "#75715e", cursor: "pointer" } : undefined}
            href={`/video/${v.id}`}
            target="_blank"
            title="点击弹层播放该录像"
            onClick={(e) => {
              e.preventDefault();
              onPlay();
            }}
          >
            {scoreTime(v.realTime)}
          </a>
        ) : v.realTime ? (
          scoreTime(v.realTime)
        ) : (
          "—"
        )}
      </td>
      <td className="num">{v.board3bv || "—"}</td>
      <td className="num">{v.board3bv && v.realTime ? score3bvs(Math.round((v.board3bv * 1e6) / v.realTime)) : "—"}</td>
      <td className="num">{v.stnb != null ? v.stnb.toFixed(1) : "—"}</td>
      <td className="c">{v.noflag ? <span className="admin_tag info">NF</span> : <span className="sub">标雷</span>}</td>
      <td className="sub">{[v.software, v.version].filter(Boolean).join(" ") || "—"}</td>
      <td className="c">
        {v.autoFlag === 1 ? (
          <span className="admin_tag ok" title="五类触发器零命中，可批量一键通过（仍需先下载防盲审）">免核定</span>
        ) : v.autoFlag === 2 ? (
          <span className="admin_tag plain" title="分拣失败（文件缺失/解析失败），按需核定兜底">需核定·分拣失败</span>
        ) : v.autoFlag === -1 ? (
          <span className="admin_tag plain" title="历史存量未分拣，保守按需核定">需核定·未分拣</span>
        ) : (
          <ReasonTags video={v} />
        )}
      </td>
      <td className="c">
        {/* 播放栏（2026-10-19 张老师定：下载栏改播放栏）：按钮弹全屏播放器出录像；
            看过即计防盲审（播放器 markWatched 或下载任一 → watched）；
            已看按钮静态灰化（行也淡显），未看高亮引导 */}
        <button
          type="button"
          className={`admin_btn sm${v.watched ? "" : " primary"}`}
          title={v.watched ? "已看过（点击再次播放）" : "点击播放该录像（看过即可审核）"}
          onClick={(e) => {
            e.preventDefault();
            onPlay();
          }}
          style={{ minWidth: 0, padding: "2px 8px" }}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true" style={{ verticalAlign: "-1px", marginRight: 3 }}>
            <path d="M7 4.8v14.4c0 .9 1 1.45 1.76.96l9.6-7.2a1.14 1.14 0 0 0 0-1.92l-9.6-7.2A1.14 1.14 0 0 0 7 4.8z" />
          </svg>
          {v.watched ? "已看" : "播放"}
        </button>
      </td>
      <td className="c">
        <StatusTag status={v.status} />
      </td>
      <td className="sub">{v.createTime ? timeOpposite(v.createTime) : "—"}</td>
      <td className="ops">
        <a className="admin_btn sm" href={`/video/download/${v.id}`} title="下载录像文件（兜底：播放器放不了的格式用这个）">
          文件
        </a>
        {v.status !== VIDEO_STATUS.REVIEWED && (
          <button
            type="button"
            className="admin_btn primary sm"
            disabled={busy}
            onClick={async () => {
              const ok = await run("video.review", { id: v.id, status: VIDEO_STATUS.REVIEWED });
              if (ok) onRemoved();
            }}
          >
            通过
          </button>
        )}
        {v.status !== VIDEO_STATUS.BANNED && (
          <button
            type="button"
            className="admin_btn danger sm"
            disabled={busy}
            onClick={async () => {
              // 屏蔽 + 低信任分流确认（2026-10-28 张老师需求）：勾选默认开——
              // 确认后一并把上传者纳入低信任组；不勾则只屏蔽录像、不动用户
              const { ok, checked } = await confirmDialogChecked({
                title: "屏蔽录像",
                message: `确认屏蔽录像 #${v.id}？对应最好成绩会被回退。`,
                danger: true,
                confirmText: "确认屏蔽",
                  checkbox: {
                    label: (
                      <>
                        同时将 <b>{v.author?.chineseName ?? `#${v.user}`}</b> 加入低信任用户组
                      </>
                    ),
                    defaultChecked: true,
                  },
              });
              if (!ok) return;
              const done = await run("video.review", {
                id: v.id,
                status: VIDEO_STATUS.BANNED,
                lowTrust: checked,
              });
              if (done) onRemoved();
            }}
          >
            屏蔽
          </button>
        )}
      </td>
    </tr>
  );
}
