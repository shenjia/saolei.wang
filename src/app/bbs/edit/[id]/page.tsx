// 编辑主题（本人或管理员）

import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { BBS_BOARDS, getPost } from "@/lib/bbs";
import { PostForm } from "@/components/PostForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "编辑主题" };

export default async function BbsEditPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const { id } = await params;
  // includePending=true：作者可编辑被 AI 转待审（status=5）的主题（2026-10-22 本人可见口径）
  const post = await getPost(parseInt(id, 10) || 0, false, true);
  if (!post) notFound();
  const admin = isManager(session.role);
  if (!admin && session.uid !== post.author?.id) notFound();

  const boards = BBS_BOARDS.filter((b) => admin || b.id !== 0).map(
    (b) => [b.id, b.name] as [number, string]
  );

  return (
    <div id="page" className="main">
      <div className="box">
        <PostForm
          postId={post.id}
          boards={boards}
          isAdmin={admin}
          authorId={session.uid}
          initialBoard={post.board}
          initialTitle={post.title}
          initialContent={post.content}
        />
      </div>
    </div>
  );
}
