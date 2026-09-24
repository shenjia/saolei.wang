// 管理后台 · 站内信广播（2026-09-24）
// 全站广播（仅超管）+ 历史广播回看 + 收发统计。
// 注意：广播按「每个玩家一条 message」写入，3 万+ 玩家会产生 3 万+ 行，属于重操作，已做批量分片。

import Link from "next/link";
import { getBroadcastHistory, getMessageStats } from "@/lib/admin/data";
import { AdminForm } from "@/components/admin/AdminAction";
import { AdminCard, Kpi } from "@/components/admin/Widgets";
import { formatDate } from "@/lib/format";
import { MESSAGE_CONTENT_LIMIT } from "@/lib/message";

export const dynamic = "force-dynamic";
export const metadata = { title: "站内信广播 | 管理后台" };

export default async function AdminMessagesPage() {
  const [stats, history] = await Promise.all([getMessageStats(), getBroadcastHistory(20)]);

  return (
    <>
      <div className="admin_page_head">
        <h1>站内信广播</h1>
        <span className="sub">向全站玩家发送系统通知</span>
      </div>

      <div className="admin_kpis">
        <Kpi label="站内信总数" value={stats.total} tone="cyan" foot="含私信与系统广播" />
        <Kpi label="未读" value={stats.unread} tone="yellow" foot="全体玩家累计" />
        <Kpi label="系统广播" value={stats.system} tone="purple" foot="is_system = 1" />
        <Kpi label="今日新增" value={stats.today} tone="green" foot="含私信与广播" />
      </div>

      <AdminCard title="发送全站广播（仅超级管理员）">
        <AdminForm
          op="message.broadcast"
          layout="stack"
          fields={[
            {
              name: "content",
              label: `广播内容（最多 ${MESSAGE_CONTENT_LIMIT} 字）`,
              type: "textarea",
              placeholder: "例如：本站已恢复成绩审核，请大家正常上传录像。",
              required: true,
            },
          ]}
          submitLabel="确认广播"
          confirm="⚠️ 确认向全部玩家发送这条广播？每人收件箱会立即出现该消息，不可撤回（只能逐条删除）。"
        />
        <div className="admin_hint" style={{ marginTop: 10 }}>
          广播会以「系统消息」写入每个玩家的收件箱，属于重操作（数万行写入，分片执行需要数秒到数十秒）。
          请确认内容无误后再提交，避免重复发送。
        </div>
      </AdminCard>

      <AdminCard title="历史广播" tight more="按内容聚合，同一次广播只显示一行">
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th>时间</th>
                <th>发送人</th>
                <th>内容</th>
                <th className="num">送达</th>
                <th className="num">已读</th>
                <th className="num">阅读率</th>
              </tr>
            </thead>
            <tbody>
              {history.map((b, i) => (
                <tr key={`${b.createTime}-${i}`}>
                  <td className="sub">{formatDate(b.createTime, "Y-m-d H:i")}</td>
                  <td>
                    <Link className="link" href={`/admin/users/${b.fromUser}`}>
                      {b.author?.chineseName ?? `#${b.fromUser}`}
                    </Link>
                  </td>
                  <td style={{ maxWidth: 460 }}>{b.content}</td>
                  <td className="num">{b.receivers.toLocaleString("zh-CN")}</td>
                  <td className="num">{b.readCount.toLocaleString("zh-CN")}</td>
                  <td className="num">
                    <span className="admin_progress">
                      <i style={{ width: `${b.receivers ? Math.round((b.readCount / b.receivers) * 100) : 0}%` }} />
                    </span>{" "}
                    {b.receivers ? Math.round((b.readCount / b.receivers) * 100) : 0}%
                  </td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="admin_empty">还没有发送过系统广播</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard title="说明">
        <div className="admin_note">
          · 广播移植自 2008 版 <code>Message/Broad_Action</code>：逐玩家写入站内信，前端收件箱与未读红点会立即体现。<br />
          · 阅读率 = 已读条数 / 送达条数；玩家点开消息才算已读，因此刚发出时百分比偏低属正常。<br />
          · 单条消息正文上限 {MESSAGE_CONTENT_LIMIT} 字，超长会被服务端截断。
        </div>
      </AdminCard>
    </>
  );
}
