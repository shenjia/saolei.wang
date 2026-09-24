// 管理后台 · 排行与荣誉（2026-09-24）
// 排行快照（进步榜数据源）、军衔阈值体系、每日一星——这三块是主站展示层的「数据地基」。

import Link from "next/link";
import { getSession } from "@/lib/auth";
import { getStarHistory } from "@/lib/admin/data";
import { getSnapshotHealth, getTitleThresholds } from "@/lib/admin/stats";
import { AdminAction, AdminForm } from "@/components/admin/AdminAction";
import { AdminCard, Kpi } from "@/components/admin/Widgets";
import { TitleBadge } from "@/components/Cells";
import { TITLE_COLORS } from "@/lib/config";
import { formatDate, scoreTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "排行与荣誉 | 管理后台" };

export default async function AdminRankPage() {
  const [snapshot, titles, stars, session] = await Promise.all([
    getSnapshotHealth(),
    getTitleThresholds(),
    getStarHistory(14),
    getSession(),
  ]);
  void session;

  const totalRanked = titles?.rows.reduce((s, r) => s + r.count, 0) ?? 0;

  return (
    <>
      <div className="admin_page_head">
        <h1>排行与荣誉</h1>
        <span className="sub">榜单地基数据的体检与人工干预</span>
        <div className="right">
          <Link className="admin_btn" href="/ranking" target="_blank">
            前台排行榜
          </Link>
          <Link className="admin_btn" href="/grow" target="_blank">
            进步榜
          </Link>
        </div>
      </div>

      <div className="admin_kpis">
        <Kpi
          label="今日排行快照"
          value={snapshot.todayDone ? "已生成" : "未生成"}
          tone={snapshot.todayDone ? "green" : "red"}
          foot={`最新快照日期 ${snapshot.latest}`}
        />
        <Kpi label="快照累计天数" value={snapshot.days} unit="天" tone="cyan" foot="进步榜有效数据天数" />
        <Kpi label="上榜玩家" value={totalRanked} tone="yellow" foot="三级成绩齐全" />
        <Kpi label="军衔编制" value={titles?.size ?? 0} unit="人" tone="purple" foot="大元帅/元帅/大将等固定编制" />
      </div>

      <AdminCard title="排行快照">
        <div className="admin_note" style={{ marginBottom: 12 }}>
          进步榜靠「今日名次 − 昨日名次」算升降，数据源就是 <code>rank_snapshot</code> 表。
          快照由首次访问进步榜时惰性生成（每天一次）；若发现进步榜整页空白或名次异常，先在这里重算。
        </div>
        <div className="admin_ops">
          <AdminAction
            op="rank.snapshot"
            label="立即重算今日快照"
            variant="primary"
            sm={false}
            confirm="重算会覆盖今日已生成的快照（按当前 user_scores 重新计算名次），确认执行？"
          />
          <Link className="admin_btn" href="/admin/stats">
            查看快照健康度明细
          </Link>
        </div>
      </AdminCard>

      <AdminCard title="军衔阈值体系" tight more={titles ? `颁布于 ${formatDate(titles.createTime, "Y-n-j")}` : "无分布数据"}>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">序</th>
                <th>军衔</th>
                <th className="num">总计时间上限（秒）</th>
                <th className="num">当前人数</th>
                <th className="c">徽章</th>
              </tr>
            </thead>
            <tbody>
              {(titles?.rows ?? []).map((r, i) => (
                <tr key={r.title}>
                  <td className="c sub">{i + 1}</td>
                  <td style={{ color: TITLE_COLORS[r.title] ?? "#b1b1a4" }}>{r.title}</td>
                  <td className="num">{r.threshold ? scoreTime(r.threshold) : "无上限"}</td>
                  <td className="num">{r.count.toLocaleString("zh-CN")}</td>
                  <td className="c">
                    <TitleBadge title={r.title} />
                  </td>
                </tr>
              ))}
              {(!titles || titles.rows.length === 0) && (
                <tr>
                  <td colSpan={5}>
                    <div className="admin_empty">distribution 表没有军衔阈值数据</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard title="每日一星（近 14 天）" tight more={<Link href="/" target="_blank">前台首页 →</Link>}>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th>日期</th>
                <th>当选玩家</th>
                <th>产生时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {stars.map((s) => (
                <tr key={s.date}>
                  <td className="strong">{s.date}</td>
                  <td>
                    <Link className="link" href={`/admin/users/${s.user}`}>
                      {s.author?.chineseName ?? `#${s.user}`}
                    </Link>
                  </td>
                  <td className="sub">{formatDate(s.createTime, "Y-m-d H:i")}</td>
                  <td className="ops">
                    <AdminAction
                      op="star.set"
                      params={{ date: s.date, userId: s.user, clear: true }}
                      label="清除"
                      variant="danger"
                      confirm={`确认清除 ${s.date} 的每日一星？清除后当天会按规则重新评选。`}
                    />
                    <Link className="admin_btn sm" href={`/user/${s.user}`} target="_blank">
                      主页
                    </Link>
                  </td>
                </tr>
              ))}
              {stars.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="admin_empty">还没有每日一星记录（首次访问首页时会自动评选）</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard title="人工指定每日一星">
        <AdminForm
          op="star.set"
          layout="row"
          resetAfterSubmit
          fields={[
            { name: "date", label: "日期", type: "date", defaultValue: new Date().toISOString().slice(0, 10) },
            { name: "userId", label: "玩家 ID", type: "text", placeholder: "玩家 ID（数字）", width: "tiny", required: true },
          ]}
          submitLabel="指定"
          confirm="确认把该玩家指定为这一天的每日一星？会覆盖当天已评选结果。"
        />
        <div className="admin_hint" style={{ marginTop: 8 }}>
          默认评选规则：候选 = 神界（总计时间前 41）∪ 近 30 天破纪录的玩家，本月已当选者不再参与，
          按日期哈希在候选里确定性随机取一位（同一天结果稳定、不会重复插入）。
        </div>
      </AdminCard>

      <AdminCard title="说明">
        <div className="admin_note">
          · 军衔阈值存放在 <code>distribution</code> 表最后一行（按总计时间分档），改阈值需要新增一行分布数据，后台不做写入。<br />
          · 前 6 级（大元帅～少将）是固定编制人数，其余按比例分档；未上榜玩家统一显示「预备役」。<br />
          · 人工指定一星时若日期填写非法，操作会落到「今天」，请用日期控件选择。
        </div>
      </AdminCard>
    </>
  );
}
