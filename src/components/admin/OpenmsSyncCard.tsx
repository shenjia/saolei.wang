// 后台仪表盘 · 开源扫雷网录像同步概览卡（2026-11-10 张老师定）
//
// 只做首页卡、10 秒轮询、纯只读：没有任何触发/重试/停止按钮。
// 首帧由 RSC 传入 initial（无 JS 也能看到状态），挂载后每 10 秒拉一次
// /api/admin/openms-sync/status 校准；轮询失败静默保留旧值，不闪归零。
// 相对时间用「服务端 now + 客户端挂载后秒数」计算，避免 hydration 不一致。

"use client";

import { useEffect, useRef, useState } from "react";
import type { OpenmsSyncStatus } from "@/lib/admin/openms-sync";

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

  const r = d.run;
  const t = d.totals;
  const segValues = r ? { ok: r.ok, skip: r.skip, gaveUp: r.gaveUp, retry: r.retry } : { ok: 0, skip: 0, gaveUp: 0, retry: 0 };
  const segTotal = SEG.reduce((a, s) => a + segValues[s.key], 0);
  const scannedThisRun = r ? r.registered + r.seen : 0;
  const heartbeatAge = d.heartbeatAgeSec === null ? null : Math.max(0, d.heartbeatAgeSec + elapsed);
  const lastError = r?.lastError || null;

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
        <div className="admin_sync_kpis">
          <div className="admin_kpi green">
            <div className="label">本轮已处理</div>
            <div className="value">{fmt(r?.handled ?? 0)}<small> 盘</small></div>
            <div className="foot">扫到 {fmt(scannedThisRun)} 个 ID · 限速 5 盘/分</div>
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
            <div className="label">待重试</div>
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
              本轮扫描构成
              <span>（分母＝本轮实际扫到的 {fmt(segTotal)} 个 ID，随扫描增长，非全量完成度）</span>
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
              <span className="dim">另有 {fmt(r?.seen ?? 0)} 条历史 ID 按台账直接跳过（不下载、不占配额）</span>
            </div>
            <div className="admin_hint" style={{ marginTop: 8 }}>
              对方接口不返回总量，故不显示「全量完成 XX%」；游标只是已处理过的最大 video_id，不能换算百分比。
              {lastError && <> 上轮错误：<span style={{ color: "#f92672" }}>{lastError}</span></>}
            </div>
          </div>
          <div className="side">
            {d.state === "never" ? (
              <div className="admin_hint">尚无跑批记录：等待 crontab 注册后的首轮 --apply 跑批。</div>
            ) : (
              <div className="admin_sync_ctx">
                {d.state === "running" || d.state === "stuck" ? "当前" : "上轮最后"}：
                雷网用户 <span className="hl">#{fmt(r?.currentUser ?? 0)}</span> / 开源 profile <span className="hl">{fmt(r?.currentProfile ?? 0)}</span><br />
                游标推进至 <span className="ok">#{fmt(r?.currentCursor ?? 0)}</span>
                {r && r.currentVideoId > 0 && <> · 末条开源 #{fmt(r.currentVideoId)}</>}<br />
                心跳 {heartbeatAge === null ? "—" : `${dur(heartbeatAge)}前`}（{r?.heartbeatText ?? "—"}）· 阈值 180 秒
              </div>
            )}
            <div className="admin_hint" style={{ marginTop: 8 }}>
              上一轮 {d.lastFinished ? `${d.lastFinished.startedText} 完成 · 耗时 ${dur(d.lastFinished.durationSec)}` : "暂无完成记录"}<br />
              crontab 每 10 分钟一轮 · 参与用户 {fmt(t.syncUsers)} / {fmt(t.linksTotal)} 人（仅 consent=1）
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
