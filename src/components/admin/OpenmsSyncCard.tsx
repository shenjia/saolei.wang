// 后台仪表盘 · 开源扫雷网录像同步概览卡（2026-11-10 建，2026-11-17 拆双脚本后分栏）
//
// 只做首页卡、10 秒轮询、纯只读：没有任何触发/重试/停止按钮。
// 首帧由 RSC 传入 initial（无 JS 也能看到状态），挂载后每 10 秒拉一次
// /api/admin/openms-sync/status 校准；轮询失败静默保留旧值，不闪归零。
// 相对时间用「服务端 now + 客户端挂载后秒数」计算，避免 hydration 不一致。
//
// 2026-11-17：扫描器（每 10 分钟穿越全部用户、只登记台账）与下载器（每 2 分钟消费台账队列、
// 连续 4.8 盘/分）拆成两个脚本，卡片按两侧分栏展示各自心跳与本轮计数。

"use client";

import { useEffect, useRef, useState } from "react";
import type { OpenmsSideStatus, OpenmsSyncStatus } from "@/lib/admin/openms-sync";

const REFRESH_MS = 10_000;

const fmt = (n: number) => n.toLocaleString("zh-CN");

function dur(sec: number | null): string {
  if (sec === null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

const SEG = [
  { key: "ok", label: "已导入", color: "#a6e22e" },
  { key: "skip", label: "已拒收", color: "#e6db74" },
  { key: "gaveUp", label: "放弃", color: "#f92672" },
  { key: "retry", label: "待重试", color: "#66d9ef" },
] as const;

export function OpenmsSyncCard({ initial }: { initial: OpenmsSyncStatus }) {
  const [d, setD] = useState(initial);
  /** 客户端挂载后累计秒数：让「心跳 N 秒前」在两次轮询之间也走动 */
  const [elapsed, setElapsed] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let inflight = false;
    const load = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const res = await fetch("/api/admin/openms-sync/status", { cache: "no-store" });
        if (res.ok && alive.current) {
          const next = (await res.json()) as OpenmsSyncStatus;
          setD(next);
          setElapsed(0);
        }
      } catch {
        /* 网关抖动/离线：保留上次状态 */
      } finally {
        inflight = false;
      }
    };
    const tick = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    const poll = window.setInterval(load, REFRESH_MS);
    return () => {
      alive.current = false;
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, []);

  const sc = d.scan;
  const dl = d.download;
  const t = d.totals;
  const r = dl.run;
  const sr = sc.run;
  const segValues = r ? { ok: r.ok, skip: r.skip, gaveUp: r.gaveUp, retry: r.retry } : { ok: 0, skip: 0, gaveUp: 0, retry: 0 };
  const segTotal = SEG.reduce((a, s) => a + segValues[s.key], 0);
  const hbAge = (side: OpenmsSideStatus) =>
    side.heartbeatAgeSec === null ? null : Math.max(0, side.heartbeatAgeSec + elapsed);
  const lastError = dl.run?.lastError || sc.run?.lastError || null;

  return (
    <div className="admin_card">
      <h2>
        开源扫雷网录像同步
        <span className={`admin_tag ${d.tone}`}>
          <span className={`admin_sync_dot ${d.dot}`} />
          {d.label}
        </span>
        <span className="more">10 秒自动刷新 · 只读</span>
      </h2>
      <div className="admin_card_body">
        {/* 扫描器 / 下载器 两侧 */}
        <div className="admin_sync_split">
          <div className="admin_sync_side">
            <div className="hd">
              扫描器
              <span className={`admin_tag ${sc.tone}`}>
                <span className={`admin_sync_dot ${sc.dot}`} />
                {sc.label}
              </span>
              <em>每 10 分钟 · 不下载</em>
            </div>
            <div className="admin_sync_ctx">
              本轮登记 <span className="ok">{fmt(sr?.registered ?? 0)}</span> 个新 ID · 穿越
              <span className="hl"> {fmt(sr?.users ?? 0)}</span> 人 / {fmt(sr?.pages ?? 0)} 页
              <span className="dim">（已存在 {fmt(sr?.seen ?? 0)} 条）</span><br />
              心跳 {hbAge(sc) === null ? "—" : `${dur(hbAge(sc))}前`}（{sr?.heartbeatText ?? "—"}）· 阈值 180 秒 /
              停滞 15 分钟
            </div>
          </div>
          <div className="admin_sync_side">
            <div className="hd">
              下载器
              <span className={`admin_tag ${dl.tone}`}>
                <span className={`admin_sync_dot ${dl.dot}`} />
                {dl.label}
              </span>
              <em>每 2 分钟 · 连续 4.8 盘/分</em>
            </div>
            <div className="admin_sync_ctx">
              本轮下载 <span className="ok">{fmt(r?.handled ?? 0)}</span> / 配额 {fmt(r?.maxItems ?? 0)} 盘 ·
              成功 <span className="ok">{fmt(r?.ok ?? 0)}</span> / 拒收 <span className="hl">{fmt(r?.skip ?? 0)}</span> /
              放弃 {fmt(r?.gaveUp ?? 0)}<br />
              心跳 {hbAge(dl) === null ? "—" : `${dur(hbAge(dl))}前`}（{r?.heartbeatText ?? "—"}）· 阈值 180 秒 /
              停滞 8 分钟
            </div>
          </div>
        </div>

        <div className="admin_sync_kpis">
          <div className="admin_kpi green">
            <div className="label">本轮已导入</div>
            <div className="value">{fmt(r?.ok ?? 0)}<small> 盘</small></div>
            <div className="foot">下载间隔 12.5s（对方限速 5 盘/分）</div>
          </div>
          <div className="admin_kpi green">
            <div className="label">累计已导入</div>
            <div className="value">{fmt(t.imported)}</div>
            <div className="foot">今日 <b>{fmt(t.importedToday)}</b> 盘 · 待审状态 10</div>
          </div>
          <div className="admin_kpi cyan">
            <div className="label">累计已扫过 ID</div>
            <div className="value">{fmt(t.scanned)}</div>
            <div className="foot">已登记进映射台账</div>
          </div>
          <div className="admin_kpi yellow">
            <div className="label">待下载队列</div>
            <div className="value">{fmt(t.pending)}</div>
            <div className="foot">其中 <b>{fmt(t.pendingHigh)}</b> 条已重试 3 次</div>
          </div>
          <div className="admin_kpi red">
            <div className="label">已放弃</div>
            <div className="value">{fmt(t.gaveUp)}</div>
            <div className="foot">重试耗尽 · 终态不再处理</div>
          </div>
        </div>

        <div className="admin_sync_body">
          <div className="main">
            <div className="admin_sync_caption">
              本轮下载构成
              <span>（分母＝本轮实际处理的 {fmt(segTotal)} 盘，随队列推进，非全量完成度）</span>
            </div>
            <div className="admin_sync_seg">
              {segTotal > 0 && SEG.map((s) => (
                segValues[s.key] > 0 && (
                  <i key={s.key} style={{ width: `${(segValues[s.key] / segTotal) * 100}%`, background: s.color }} />
                )
              ))}
            </div>
            <div className="admin_sync_legend">
              {SEG.map((s) => (
                <span key={s.key}><b style={{ background: s.color }} />{s.label} {fmt(segValues[s.key])}</span>
              ))}
              <span className="dim">扫描器只登记不下载，所以不存在「跳过占配额」</span>
            </div>
            <div className="admin_hint" style={{ marginTop: 8 }}>
              对方接口不返回总量，故不显示「全量完成 XX%」；游标只是已扫描过的最大 video_id。
              {lastError && <> 上轮错误：<span style={{ color: "#f92672" }}>{lastError}</span></>}
            </div>
          </div>
          <div className="side">
            {d.state === "never" ? (
              <div className="admin_hint">尚无跑批记录：等待 crontab 注册后的首轮跑批。</div>
            ) : (
              <div className="admin_sync_ctx">
                {dl.state === "running" || dl.state === "stuck" ? "当前下载" : "上轮最后下载"}：
                开源 <span className="ok">#{fmt(r?.currentVideoId ?? 0)}</span> → 雷网用户
                <span className="hl"> #{fmt(r?.currentUser ?? 0)}</span><br />
                扫描侧游标：雷网用户 <span className="hl">#{fmt(sr?.currentUser ?? 0)}</span> /
                开源 profile <span className="hl">{fmt(sr?.currentProfile ?? 0)}</span> →
                已扫至 <span className="ok">#{fmt(sr?.currentCursor ?? 0)}</span><br />
                上轮下载 {dl.lastFinished ? `${dl.lastFinished.startedText} 完成 · 耗时 ${dur(dl.lastFinished.durationSec)}` : "暂无"}<br />
                上轮扫描 {sc.lastFinished ? `${sc.lastFinished.startedText} 完成 · 耗时 ${dur(sc.lastFinished.durationSec)}` : "暂无"}
              </div>
            )}
            <div className="admin_hint" style={{ marginTop: 8 }}>
              参与用户 {fmt(t.syncUsers)} / {fmt(t.linksTotal)} 人（仅 consent=1）
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
