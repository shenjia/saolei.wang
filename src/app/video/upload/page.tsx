// 上传录像页（移植 views/video/upload；旧版文案说只收 avf，与解析器实际行为不符，按实际写）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { UploadForm } from "@/components/UploadForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "上传录像 | 扫雷网" };

export default async function VideoUploadPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  return (
    <div id="page" className="main">
      <div className="video_upload box center">
        <h1>上传录像</h1>
        <p>
          本站接受 <em>Minesweeper Clone</em> 保存的 <em>mvf</em> 录像与{" "}
          <em>Minesweeper Arbiter</em> 保存的 <em>avf</em> 录像。
        </p>
        <p>上传成功后的录像，需要通过管理员的审核，成绩才能计入排行。</p>
        <hr />
        <UploadForm />
      </div>
    </div>
  );
}
