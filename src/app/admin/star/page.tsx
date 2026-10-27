// 管理后台 · 每日一星历史（2026-10-27）
// star 表历史记录：当选玩家、感言、赞/踩计数、删除情况。
// 感言赞/踩计数 2026-10-27 上线起记录（此前历史恒 0）。

import Link from "next/link";
import { getStarListAdmin } from "@/lib/admin/data";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager } from "@/components/admin/Widgets";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "每日一星 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminStarPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize } = await getStarListAdmin({ q: sp.q, page });

  return (
    <>
      <div className="admin_page_head">
        <h1>每日一星</h1>
        <span className="sub">共 {total.toLocaleString("zh-CN")} 条当选记录</span>
      </div>

      <AdminCard tight>
        <AdminFilters
          fields={[
            { name: "q", type: "search", placeholder: "玩家 ID / 名字前缀" },
          ]}
        />

        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">日期</th>
                <th>当选玩家</th>
                <th>感言</th>
                <th className="c">👍 赞</th>
                <th className="c">👎 踩</th>
                <th className="c">删除次数</th>
                <th className="c sub">当选时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="c">{s.date}</td>
                  <td>
                    <Link className="link" href={`/admin/users/${s.user}`}>
                      {s.author?.chineseName ?? `#${s.user}`}
                    </Link>
                  </td>
                  <td className="sub" style={{ maxWidth: 320 }}>
                    {s.speech ? `“${s.speech}”` : <span className="sub">—</span>}
                  </td>
                  <td className="c">{s.speechUp || <span className="sub">0</span>}</td>
                  <td className="c">{s.speechDown || <span className="sub">0</span>}</td>
                  <td className="c">
                    {s.speechDel > 0 ? (
                      <span className={s.speechDel >= 2 ? "admin_tag bad" : "admin_tag wait"}>{s.speechDel}</span>
                    ) : (
                      <span className="sub">0</span>
                    )}
                  </td>
                  <td className="c sub">{s.createTime ? formatDate(s.createTime, "Y-m-d H:i") : "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="admin_empty">没有符合条件的记录</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <AdminPager base="/admin/star" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · 评选口径（2026-10-25 新版）：候选 =（少将及以上现役 且 30 天内登录过）∪（30 天内破纪录 且 名次上升），
          排除近 30 日已当选者；按日期哈希确定性抽签，有真人头像者概率翻倍。<br />
          · 感言 ≤30 字、当日一次性；被管理员删除后可重发一次，删两次永久禁止（删除次数 ≥2 即封嘴）。<br />
          · 赞/踩计数 2026-10-27 上线：游客可投、每个浏览器一天一票（localStorage 去重）；
          前端删除感言或本人重发时计数清零。此前历史记录计数恒为 0。
        </div>
      </AdminCard>
    </>
  );
}
