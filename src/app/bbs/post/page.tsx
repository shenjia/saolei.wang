// 发布主题（移植 2008 版 BBS/Post.asp；公告板块仅管理员可选）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { BBS_BOARDS } from "@/lib/bbs";
import { PostForm } from "@/components/PostForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "发布主题 | 扫雷网" };

export default async function BbsPostPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");
  const admin = isManager(session.role);
  const boards = BBS_BOARDS.filter((b) => admin || b.id !== 0).map(
    (b) => [b.id, b.name] as [number, string]
  );

  return (
    <div id="page" className="main">
      <div className="box">
        <PostForm boards={boards} isAdmin={admin} />
      </div>
    </div>
  );
}
