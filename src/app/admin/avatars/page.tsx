// 管理后台 · 头像审核（2026-09-24 张老师需求）
//
// 队列来源：用户在 /account/profile 点击上传后，AI 初审「拿不准 / 未启用 / 超时 / 异常」
// 的一律落 status=10 进本队列；AI 判定为合格真人照片的已直接生效，不占用人工。
// 管理员通过 = 写入 user.avatar 生效；驳回 = 标记驳回并发站内信；对已通过的可「撤销并驳回」（回滚）。

import Link from "next/link";
import { AdminAvatarList } from "@/components/admin/AdminAvatarList";
import { AdminCard, Kpi } from "@/components/admin/Widgets";
import { getAvatarListAdmin, getAvatarStats } from "@/lib/admin/data";
import { AVATAR_CATEGORY_NAMES, AVATAR_REVIEW_STATUS } from "@/lib/avatar";

export const dynamic = "force-dynamic";
export const metadata = { title: "头像审核 | 管理后台" };

type SP = Record<string, string | undefined>;

const TABS: [number, string][] = [
  [AVATAR_REVIEW_STATUS.PENDING, "待审核"],
  [AVATAR_REVIEW_STATUS.APPROVED, "已通过"],
  [AVATAR_REVIEW_STATUS.REJECTED, "已驳回"],
];

export default async function AdminAvatarsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const valid = TABS.map(([v]) => v);
  const parsed = parseInt(sp.status ?? "", 10);
  const status = valid.includes(parsed) ? parsed : AVATAR_REVIEW_STATUS.PENDING;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const [list, stats] = await Promise.all([getAvatarListAdmin({ status, page }), getAvatarStats()]);

  const risky = stats.categoryCounts
    .map((c) => `${AVATAR_CATEGORY_NAMES[c.category] ?? c.category} ${c.count}`)
    .join(" · ");

  return (
    <>
      <div className="admin_page_head">
        <h1>头像审核</h1>
        <span className="sub">
          待审 {stats.pending} 张
          {stats.pending === 0 && " · 队列已清空"}
        </span>
        <div className="right">
          <Link className="admin_btn" href="/page/help/avatar" target="_blank">
            头像帮助页
          </Link>
        </div>
      </div>

      <div className="admin_kpis">
        <Kpi
          label="待审核"
          value={stats.pending}
          tone={stats.pending > 0 ? "red" : "green"}
          foot={stats.pending ? "含 AI 存疑与 AI 异常" : "队列已清空"}
        />
        <Kpi label="已通过" value={stats.approved} tone="green" foot={`含 AI 自动放行 ${stats.autoApproved} 张`} />
        <Kpi label="已驳回" value={stats.rejected} tone="grey" foot="累计驳回数" />
        <Kpi
          label="AI 标记风险"
          value={stats.categoryCounts.reduce((s, c) => s + c.count, 0)}
          tone="yellow"
          foot={risky || "暂无风险标记"}
        />
      </div>

      <AdminCard tight>
        <div className="admin_filterbar">
          {TABS.map(([v, label]) => (
            <Link
              key={v}
              href={`/admin/avatars?status=${v}`}
              className={`admin_btn${status === v ? " primary" : ""}`}
            >
              {label}
            </Link>
          ))}
          <span className="spacer" />
          <span className="label">共 {list.total.toLocaleString("zh-CN")} 张</span>
        </div>

        <AdminAvatarList key={`${status}_${page}`} initial={list.rows} status={status} />

        {list.total > list.pageSize && (
          <div className="admin_pager">
            {page > 1 && <Link href={`/admin/avatars?status=${status}&page=${page - 1}`}>上一页</Link>}
            <span className="current">{page}</span>
            {page * list.pageSize < list.total && (
              <Link href={`/admin/avatars?status=${status}&page=${page + 1}`}>下一页</Link>
            )}
            <span style={{ border: 0, marginLeft: 12, color: "#75715e" }}>
              共 {Math.ceil(list.total / list.pageSize)} 页
            </span>
          </div>
        )}
      </AdminCard>

      <AdminCard title="审核规则与口径（2026-09-24）">
        <div className="admin_note">
          · <b>只收真人照片</b>：卡通、动漫、表情包、风景、物品、纯色图案、AI 生成的写实人脸一律驳回（与旧站「照片墙」定位一致）。<br />
          · AI 初审用智谱 <code>glm-4v-flash</code>，拦截 <b>色情低俗 / 涉政敏感 / 非真人</b> 三类。判定「合格真人照片」的直接生效，不占用人工。<br />
          · <b>AI 永不自动拒绝</b>：拿不准、未启用、超时、异常一律转本队列由人工定夺，避免误杀正常用户。<br />
          · 通过 = 写入 <code>user.avatar</code> 生效；驳回 = 标记驳回 + 发站内信通知用户（可填原因）。<br />
          · 对<b>已通过</b>的记录点「撤销并驳回」会把头像回滚到上传前的值（仅当该图正在对外展示时才回滚，避免冲掉用户后来换上的新头像）。<br />
          · 待审期间用户旧头像照常展示，因此驳回无需额外回滚。图片存于 <code>public/uploads/avatar/</code>（不入仓）。
        </div>
      </AdminCard>
    </>
  );
}
