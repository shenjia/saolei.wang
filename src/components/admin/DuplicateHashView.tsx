// 录像管理 · 重复 hash 组视图（2026-11-11 防重复上传核查；2026-11-11 下午由独立页
// /admin/duplicates 合并入 /admin/videos?dup=1——张老师定：不占导航空间）
// 同一 hash 出现多次＝字节级重复上传（理论上只可能来自同一文件）。
// 口径与仪表盘 getAnomalies.duplicateHashGroups 一致：排除空 hash，只列出现 ≥2 次的 hash。
// 点 hash 进入展开态看该组全量成员；?hash= 支持精确展开（32 位）或前缀过滤；?page= 分页。
// 仅人工参考，处置永远人工决定。

import Link from "next/link";
import { Suspense } from "react";
import { PlayerTip, TitleBadge } from "@/components/Cells";
import { getDuplicateHashGroups } from "@/lib/admin/data";
import { AdminCard, AdminPager, Kpi, LevelTag, StatusTag } from "@/components/admin/Widgets";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { formatDate, scoreTime } from "@/lib/format";

type SP = Record<string, string | undefined>;

export default async function DuplicateHashView({ sp }: { sp: SP }) {
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize, stats, expandedHash } = await getDuplicateHashGroups({
    hash: sp.hash,
    page,
  });

  // 组列表/翻页的公共底座：视图参数 dup=1 恒在，hash 筛选跟随
  const baseParams = new URLSearchParams({ dup: "1" });
  if (sp.hash) baseParams.set("hash", sp.hash as string);
  const groupBase = `/admin/videos?${baseParams.toString()}`;

  return (
    <>
      <div className="admin_kpis">
        <Kpi label="重复组数" value={stats.totalGroups} tone="yellow" />
        <Kpi label="重复录像总数" value={stats.totalDupVideos} tone="orange" />
        <Kpi label="最大组录像数" value={stats.maxGroup} tone={stats.maxGroup >= 5 ? "red" : "grey"} />
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选加载中…</div>}>
          <AdminFilters
            keepParams={["dup"]}
            fields={[
              { name: "hash", type: "search", placeholder: "输入完整 32 位 hash 精确展开，或输入前缀过滤" },
            ]}
          />
        </Suspense>

        {expandedHash ? (
          <ExpandedGroup hash={expandedHash} data={rows} backHref="/admin/videos?dup=1" />
        ) : (
          <div className="admin_scroll">
            <table className="admin_table">
              <thead>
                <tr>
                  <th>hash（前 12 位）</th>
                  <th className="num">录像数</th>
                  <th>组内录像</th>
                  <th>标签</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ group: g, members }) => {
                  const show = members.slice(0, 6);
                  const rest = members.length - show.length;
                  return (
                    <tr key={g.hash}>
                      <td className="mono">
                        <Link className="link" href={`${groupBase}&hash=${g.hash}`}>
                          {g.hash.slice(0, 12)}…
                        </Link>
                      </td>
                      <td className="num strong">{g.count}</td>
                      <td>
                        {show.map((m) => (
                          <span key={m.id} style={{ marginRight: 8, whiteSpace: "nowrap" }}>
                            <Link
                              className="link"
                              href={`/video/${m.id}`}
                              target="_blank"
                              prefetch={false}
                            >
                              {m.id}
                            </Link>
                            <span className="pt_bubble">
                              <PlayerTip id={m.user} name={m.authorName} englishName="" />
                            </span>
                          </span>
                        ))}
                        {rest > 0 && <span className="sub">等 {members.length} 个</span>}
                      </td>
                      <td>
                        <span className="admin_tags">
                          {g.count >= 5 && <span className="admin_tag bad">疑似批量重复</span>}
                          {g.count < 5 && <span className="admin_tag plain">量级正常</span>}
                        </span>
                      </td>
                      <td className="ops">
                        <Link className="admin_btn sm" href={`${groupBase}&hash=${g.hash}`}>
                          查看
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <div className="admin_empty">没有重复的录像组</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <AdminPager base="/admin/videos" params={{ ...sp, dup: "1" }} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · <b>判定</b>：录像文件经解析后计算 hash，<code>video.hash</code> 相同＝字节级一致，几乎只可能来自同一文件重复上传。<br />
          · <b>排除</b>：空 hash（缺失解析的录像）不计入重复判定；本表只列「出现 ≥2 次」的 hash。<br />
          · <b>处置</b>：仅人工参考，不自动删除；重复可能是误传、换号重传或历史迁移，请结合状态与上传者人工判断。<br />
          · 在上方输入框输入完整 32 位 hash 可展开该组全部成员（含级别 / 成绩 / 状态 / 上传时间）；输入前缀可按 hash 过滤组列表。
        </div>
      </AdminCard>
    </>
  );
}

/** 精确查询态：单组全量成员展开 */
function ExpandedGroup({
  hash,
  data,
  backHref,
}: {
  hash: string;
  data: Awaited<ReturnType<typeof getDuplicateHashGroups>>["rows"];
  backHref: string;
}) {
  const members = data[0]?.members ?? [];
  return (
    <div className="admin_scroll">
      <div className="admin_note" style={{ margin: "10px 16px 0" }}>
        精确查询 hash <b className="mono">{hash}</b> · 共 {members.length} 个录像
        {" · "}
        <Link className="link" href={backHref}>
          返回组列表
        </Link>
      </div>
      <table className="admin_table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th className="c">ID</th>
            <th>上传者</th>
            <th className="c">级别</th>
            <th className="num">成绩</th>
            <th className="c">状态</th>
            <th>上传时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td className="c">
                <Link className="link" href={`/video/${m.id}`} target="_blank" prefetch={false}>
                  {m.id}
                </Link>
              </td>
              <td>
                <Link className="link" href={`/admin/users/${m.user}`}>
                  {m.authorName}
                  <span className="pt_bubble">
                    <PlayerTip id={m.user} name={m.authorName} englishName="" />
                  </span>
                </Link>
                {m.authorTitle && <TitleBadge title={m.authorTitle} />}
              </td>
              <td className="c">
                <LevelTag level={m.level} />
              </td>
              <td className="num strong">{m.realTime ? scoreTime(m.realTime) : "—"}</td>
              <td className="c">
                <StatusTag status={m.status} />
              </td>
              <td>
                <span className="sub">{formatDate(m.createTime, "Y-m-d H:i")}</span>
              </td>
              <td className="ops">
                <Link className="admin_btn sm" href={`/video/${m.id}`} target="_blank" prefetch={false}>
                  播放
                </Link>
              </td>
            </tr>
          ))}
          {members.length === 0 && (
            <tr>
              <td colSpan={7}>
                <div className="admin_empty">没有命中的录像</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
