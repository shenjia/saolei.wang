// 管理后台 · 反作弊复核（2026-10-27 张老师定：探测命中只禁排名，核实才转低信任）
// 待复核列表（resolved=0）+ 已复核历史。证据栈含 chrome-extension:// 前缀的
// 多为扩展误报（Grammarly/翻译类）——dismiss 即解除排名禁用。
// 核实（cheat.confirm）→ 封 7 天：低信任 7 天 + 排名禁用 7 天（同窗重计）；误报（cheat.dismiss）
// → 清除排名禁用。两操作都走站内浮窗确认。

import Link from "next/link";
import { prisma } from "@/lib/db";
import { AdminAction } from "@/components/admin/AdminAction";
import { SendMessageButton } from "@/components/admin/SendMessageButton";
import { AdminCard } from "@/components/admin/Widgets";
import { title as milTitle } from "@/lib/assess";
import { TITLE_COLORS } from "@/lib/config";
import { CHEAT_CONFIRM_NOTICE, CHEAT_DISMISS_NOTICE } from "@/lib/cheat-notice";

export const dynamic = "force-dynamic";
export const metadata = { title: "反作弊复核 | 管理后台" };

const REASON_LABEL: Record<string, string> = {
  op_bait: "诱饵读取",
  dom_inject: "DOM 注入",
  body_overlay: "覆盖层",
  canvas_tamper: "画布篡改",
  synthetic_input: "合成输入",
  proto_patch: "原型补丁",
  overlay_scan: "覆盖扫描",
  css_inject: "CSS 注入",
  shadow_dom: "Shadow 宿主",
  dom_foreign: "外来元素",
};

export default async function AdminCheatPage() {
  const [pending, resolved] = await Promise.all([
    prisma.cheatReport.findMany({
      where: { resolved: 0 },
      orderBy: { id: "desc" },
      take: 50,
    }),
    prisma.cheatReport.findMany({
      where: { resolved: { gt: 0 } },
      orderBy: { id: "desc" },
      take: 30,
    }),
  ]);
  /* 玩家名列（2026-10-27 张老师需求）：批量取姓名+军衔（高级时间阈值口径） */
  const uids = Array.from(new Set([...pending, ...resolved].map((r) => r.user)));
  const users = await prisma.user.findMany({
    where: { id: { in: uids } },
    select: { id: true, chineseName: true },
  });
  const scores = await prisma.userScores.findMany({
    where: { id: { in: uids } },
    select: { id: true, expTime: true },
  });
  const nameMap = new Map(users.map((u) => [u.id, u.chineseName]));
  const rankMap = new Map(scores.map((i) => [i.id, milTitle(i.expTime)]));
  /* 玩家累计复核战绩（2026-10-27 张老师需求）：待复核列表在玩家名下显示
     「n 作弊 n 误报」＝该玩家历史上被核实作弊（resolved=1）/ 判为误报（resolved=2）
     的次数。分组聚合一次取全量历史，供人工分诊：惯犯多命中即实锤，首次命中更可能
     是扩展误报（Grammarly/翻译类）。待复核（resolved=0）不计入，那些还没结论 */
  const pendingUids = Array.from(new Set(pending.map((r) => r.user)));
  const histRows = pendingUids.length
    ? await prisma.cheatReport.groupBy({
        by: ["user", "resolved"],
        where: { user: { in: pendingUids }, resolved: { in: [1, 2] } },
        _count: { _all: true },
      })
    : [];
  const histMap = new Map<string, { cheat: number; fp: number }>();
  for (const h of histRows) {
    const k = String(h.user);
    const cur = histMap.get(k) ?? { cheat: 0, fp: 0 };
    if (h.resolved === 1) cur.cheat = h._count._all;
    if (h.resolved === 2) cur.fp = h._count._all;
    histMap.set(k, cur);
  }
  /* 复核者名单（已复核表显示「名字（#id）」） */
  const rids = Array.from(new Set(resolved.map((r) => r.resolver).filter((v) => v > BigInt(0))));
  const resolvers = rids.length
    ? await prisma.user.findMany({ where: { id: { in: rids } }, select: { id: true, chineseName: true } })
    : [];
  const resolverMap = new Map(resolvers.map((u) => [u.id, u.chineseName]));

  const rows = (list: typeof pending, withHist = false) =>
    list.map((r) => {
      const extSuspect = r.evidence.includes("chrome-extension://");
      /* 证据内嵌截图标记 [shot:/uploads/cheat/x.jpg]（2026-10-27 张老师需求：
         命中瞬间整页截图供人工分诊——文字只够定性，截图看得到扩展悬浮窗真容） */
      const shotMatch = r.evidence.match(/\[shot:(\/uploads\/cheat\/[^\]]+)\]/);
      const shotUrl = shotMatch ? shotMatch[1] : null;
      /* 核验状态（2026-10-27 拆列）：新记录读 verified 列（1=通过 / 2=不符）；
         拆列前的老记录把结果写在证据前缀 `[verified=true] ` 里——回退解析，
         历史行不丢状态（也保证后台切上线那一刻新旧数据都能看） */
      const legacyVerified = r.evidence.match(/\[verified=(true|false)\]\s*/);
      const verifiedState = r.verified > 0 ? r.verified : legacyVerified ? (legacyVerified[1] === "true" ? 1 : 2) : 0;
      /* 证据正文：只剥标记、不截断——完整内容折行显示（原 slice(0,60) 会把
         140 字符的「渲染异常 UL…存在 2 个子节点但 ge|tClientRects=0」切成半句） */
      const plainEv = r.evidence
        .replace(/\[shot:[^\]]*\]\s*/, "")
        .replace(/\[verified=(?:true|false)\]\s*/, "")
        .trim();
      return (
        <tr key={r.id}>
          <td>
            <Link href={`/admin/users/${r.user}`} target="_blank" className="cheat_uid">
              {r.user}
            </Link>
          </td>
          <td className="cheat_player">
            <Link href={`/user/${r.user}`} target="_blank">
              {nameMap.get(r.user) ?? "（已注销）"}
            </Link>
            <span className="cheat_rank" style={{ color: TITLE_COLORS[rankMap.get(r.user) ?? ""] ?? "#999" }}>
              {rankMap.get(r.user) ?? ""}
            </span>
            {withHist &&
              (() => {
                /* 累计战绩（2026-10-27 张老师定）：作弊次数红、误报次数绿——
                   与核验标签同一套主题色，暗面板上「红=坏事 / 绿=清白」一眼分开。
                   零次也照样显示（首次命中就该看到 0 作弊，那是最像误报的情形） */
                const h = histMap.get(String(r.user)) ?? { cheat: 0, fp: 0 };
                return (
                  <div
                    className="cheat_hist"
                    title={`历史复核：核实作弊 ${h.cheat} 次 · 误报 ${h.fp} 次（不含本条待复核）`}
                  >
                    <b className="hist_cheat">{h.cheat}</b> 作弊 <b className="hist_fp">{h.fp}</b> 误报
                  </div>
                );
              })()}
          </td>
          <td>{REASON_LABEL[r.reason] ?? r.reason}</td>
          <td className="cheat_ev">
            {shotUrl && (
              <a href={shotUrl} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={shotUrl} alt="命中瞬间截图" className="cheat_shot" />
              </a>
            )}
            {extSuspect && (
              <div className="cheat_ev_tags">
                <span className="cheat_ev_tag warn" title="证据含 chrome-extension:// —— 多为浏览器扩展误报（Grammarly/翻译类）">
                  🧩 扩展
                </span>
              </div>
            )}
            {/* 核验状态标签内联在正文前（2026-10-27 张老师要求）：原来独立一行
                白占高度，且「通过」这个状态是读正文前最该先看到的判断依据 */}
            <div className="cheat_ev_text" title={plainEv}>
              {verifiedState === 1 && (
                <span className="cheat_ev_tag ok inline" title="权威进程核验通过：对局存在、属于该玩家、事件序未超界">
                  ✓ 真实对局
                </span>
              )}
              {verifiedState === 2 && (
                <span className="cheat_ev_tag bad inline" title="权威进程核验不符：对局/玩家/事件序对不上（伪造上报或旧局残留）">
                  ⚠ 核验不符
                </span>
              )}
              {plainEv}
            </div>
          </td>
          <td>{new Date(Number(r.createTime) * 1000).toLocaleString("zh-CN")}</td>
          {r.resolved === 0 ? (
            <td className="cheat_ops">
              {/* hover 气泡＝点下去实际会发给玩家的系统消息（同一常量，逐字一致） */}
              <span className="admin_tip" data-tip={`发送：${CHEAT_CONFIRM_NOTICE}`}>
                <AdminAction
                  op="cheat.confirm"
                  params={{ reportId: Number(r.id) }}
                  label="核实作弊"
                  variant="danger"
                  confirm={`确认核实报告 #${r.id} 为真实作弊？将转低信任用户组（7 天限流+全量人工审）并封禁排名模式 7 天，同时给玩家发一条系统消息。`}
                />
              </span>
              <span className="admin_tip" data-tip={`发送：${CHEAT_DISMISS_NOTICE}`}>
                <AdminAction
                  op="cheat.dismiss"
                  params={{ reportId: Number(r.id) }}
                  label="误报"
                  variant="warn"
                  confirm={`判定报告 #${r.id} 为误报？将立即解除该玩家的排名模式禁用，并给玩家发一条系统消息。`}
                />
              </span>
              <SendMessageButton uid={Number(r.user)} name={nameMap.get(r.user) ?? "（已注销）"} />
            </td>
          ) : (
            <>
              <td>{r.resolved === 1 ? "✅ 已核实" : "↩️ 误报"}</td>
              <td className="cheat_resolver">
                {resolverMap.get(r.resolver) ? `${resolverMap.get(r.resolver)}（#${r.resolver}）` : r.resolver > BigInt(0) ? `#${r.resolver}` : "—"}
              </td>
              <td>{Number(r.resolvedTime) > 0 ? new Date(Number(r.resolvedTime) * 1000).toLocaleString("zh-CN") : "—"}</td>
            </>
          )}
        </tr>
      );
    });

  return (
    <>
      <div className="admin_page_head">
        <h1>反作弊复核</h1>
      </div>
      <AdminCard title={`待复核（${pending.length}）`} tight>
        <table className="admin_table">
          <thead>
            <tr>
              <th>ID</th>
              <th>玩家</th>
              <th>类型</th>
              <th>证据</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pending.length ? (
              rows(pending, true)
            ) : (
              <tr>
                <td colSpan={6} className="admin_hint">
                  暂无待复核报告——探测命中才会产生记录，干净时段为空属正常
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="admin_hint" style={{ marginTop: 8 }}>
          处置口径（2026-10-27 张老师定）：探测命中只禁用排名模式 24h（嫌疑期临时限制）；
          🧩 前缀（证据含 chrome-extension://）多为浏览器扩展误报——判「误报」立即解禁。
          核实为真实作弊即封 7 天：低信任用户组（上传限 5/日 + 全量人工审）与排名禁用同为 7 天。
        </p>
      </AdminCard>
      {resolved.length > 0 && (
        <AdminCard title={`已复核（最近 ${resolved.length}）`} tight>
          <table className="admin_table">
            <thead>
              <tr>
                <th>ID</th>
                <th>玩家</th>
                <th>类型</th>
                <th>证据</th>
                <th>时间</th>
                <th>结论</th>
                <th>复核者</th>
                <th>复核时间</th>
              </tr>
            </thead>
            <tbody>{rows(resolved)}</tbody>
          </table>
        </AdminCard>
      )}
    </>
  );
}
