// 军衔玩家列表页（2026-09-24 张老师要求：徽章墙每个军衔可点击，查看本军衔所有玩家）
// 顶部=完整大徽章（与军衔页样式一致）；表格=照搬排行榜组件，截选本军衔区间；
// 每页 20 条「加载更多」；登录后「我在哪里?」定位到自己军衔的对应位置
// /titles/预备役 → 未加入排行的注册玩家（序号/姓名/注册时间）

import Link from "next/link";
import { notFound } from "next/navigation";
import { getTitleMemberCount, getTitleMembers, getTitleMemberOffset } from "@/lib/queries";
import { TITLE_COLORS } from "@/lib/config";
import { getSession } from "@/lib/auth";
import { RankBadge } from "@/components/RankBadge";
import { TitleMemberList } from "@/components/TitleMemberList";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export async function generateMetadata({ params }: { params: Promise<{ title: string }> }) {
  const { title } = await params;
  return { title: `${decodeURIComponent(title)} | 扫雷网` };
}

export default async function TitleMembersPage({ params }: { params: Promise<{ title: string }> }) {
  const raw = (await params).title;
  const t = decodeURIComponent(raw);
  const count = await getTitleMemberCount(t);
  if (count < 0) notFound();

  const first = await getTitleMembers(t, 0, PAGE_SIZE);
  if (!first) notFound();

  // 登录用户 + 我在本军衔的行偏移（不在本军衔=-1，不显示按钮）
  const session = await getSession();
  let myOffset: number | null = null;
  if (session) {
    myOffset = await getTitleMemberOffset(session.uid, t);
  }

  return (
    <div id="page" className="main">
      <div className="box title_members_box">
        <h1 className="badge_header">
          <Link href="/titles" title="返回军衔体系">
            <RankBadge title={t} size={72} />
          </Link>
          <span className="badge_name" style={{ color: TITLE_COLORS[t] }}>
            {t}
          </span>
          <span className="count">
            共 <em>{count.toLocaleString("zh-CN")}</em> 人
          </span>
        </h1>
        <TitleMemberList
          title={t}
          memberTitle={t}
          initial={first.rows}
          initialHasMore={first.hasMore}
          total={count}
          myId={session ? session.uid : null}
          myOffset={myOffset}
        />
      </div>
    </div>
  );
}
