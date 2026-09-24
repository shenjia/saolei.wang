// 管理后台 · 动态管理（2026-09-24）
// 成绩动态是首页/个人主页的信息流，误发（异常成绩引发）时需要能定位并删除。

import Link from "next/link";
import { Suspense } from "react";
import { NEWS_TYPE } from "@/lib/config";
import { getNewsListAdmin } from "@/lib/admin/data";
import { AdminAction } from "@/components/admin/AdminAction";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager } from "@/components/admin/Widgets";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "动态管理 | 管理后台" };

type SP = Record<string, string | undefined>;

const TYPE_NAMES: Record<number, string> = {
  [NEWS_TYPE.NOTICE]: "公告",
  [NEWS_TYPE.NEWBIE]: "入伍新兵",
  [NEWS_TYPE.PERSON_RECORD]: "个人纪录",
  [NEWS_TYPE.AREA_RECORD]: "地区纪录",
  [NEWS_TYPE.NATION_RECORD]: "全国纪录",
  [NEWS_TYPE.VIDEO]: "上传录像",
  [NEWS_TYPE.ARTICLE]: "论坛文章",
  [NEWS_TYPE.JOIN]: "加入扫雷网",
  [NEWS_TYPE.AVATAR]: "更换头像",
  [NEWS_TYPE.COMMENT]: "评论",
};

const TYPE_OPTIONS: [string, string][] = [
  ["", "全部类型"],
  ...Object.entries(TYPE_NAMES).map(([k, v]) => [k, v] as [string, string]),
];

/** details_data 是 JSON 串，解析出「级别/成绩变化」等可读摘要 */
function summarize(raw: string): string {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d && typeof d === "object" && "lv" in d) {
      const lv: Record<string, string> = { beg: "初级", int: "中级", exp: "高级" };
      const fmt = (v: unknown) => (Number(v) ? (Number(v) / 1000).toFixed(2) : "—");
      return `${lv[String(d.lv)] ?? d.lv} ${String(d.od) === "3bvs" ? "3BV/s" : "时间"}：${fmt(d.or)} → ${fmt(d.cr)}${Number(d.nf) ? "（NF）" : ""}`;
    }
  } catch {
    /* 兼容旧数据非 JSON */
  }
  return raw || "—";
}

export default async function AdminNewsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize } = await getNewsListAdmin({ q: sp.q, type: sp.type, page });

  return (
    <>
      <div className="admin_page_head">
        <h1>动态管理</h1>
        <span className="sub">共 {total.toLocaleString("zh-CN")} 条动态命中当前条件</span>
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "动态 ID / 玩家 ID / 录像 ID" },
              { name: "type", type: "select", prefix: "类型", options: TYPE_OPTIONS },
            ]}
          />
        </Suspense>

        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th className="c">类型</th>
                <th>玩家</th>
                <th>摘要</th>
                <th>引用录像</th>
                <th className="num">总计时间</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n.id}>
                  <td className="c sub">{n.id}</td>
                  <td className="c">
                    <span className="admin_tag plain">{TYPE_NAMES[n.type] ?? n.type}</span>
                  </td>
                  <td>
                    <Link className="link" href={`/admin/users/${n.user}`}>
                      {n.author?.chineseName ?? `#${n.user}`}
                    </Link>
                  </td>
                  <td>{summarize(n.detailsData)}</td>
                  <td>
                    {n.reference ? (
                      <Link className="link" href={`/video/${n.reference}`} target="_blank">
                        #{n.reference}
                      </Link>
                    ) : (
                      <span className="sub">—</span>
                    )}
                  </td>
                  <td className="num sub">{n.userScore ? (n.userScore / 1000).toFixed(2) : "—"}</td>
                  <td className="sub">{formatDate(n.createTime, "Y-m-d H:i")}</td>
                  <td className="ops">
                    <AdminAction
                      op="news.delete"
                      params={{ id: n.id }}
                      label="删除"
                      variant="danger"
                      confirm={`确认删除动态 #${n.id}？首页与个人主页将不再显示。`}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="admin_empty">没有符合条件的动态</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <AdminPager base="/admin/news" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · 动态由审核通过时自动生成：首次三级成绩齐全发「入伍新兵」，其后每次刷新个人/地区/全国纪录发一条纪录动态。<br />
          · <code>user_score</code> 是发布当时的玩家总计时间：基线（2013-10-23）前的历史动态是真实值，
          其后的历史动态由模拟回填脚本估算，新站产生的动态则是实际值。<br />
          · 删除动态是物理删除，不可恢复；若成绩本身有问题，应改去<Link href="/admin/videos"> 录像管理 </Link>屏蔽录像，成绩与动态会一并回退。
        </div>
      </AdminCard>
    </>
  );
}
