// 上传录像页（移植 views/video/upload；2026-10-23 张老师定稿文案：只列 avf / evf；
// 2026-10-24 补版本号与低版本拦截口径——检查实现在 rawvf.checkProgramVersion。
// 注意 mvf 仍在上传白名单内——文案是给用户看的重点，不代表格式支持面收窄）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { UploadForm } from "@/components/UploadForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "上传录像" };

export default async function VideoUploadPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  return (
    <div id="page" className="main">
      <div className="video_upload box center">
        <h1>上传录像</h1>
        <p>
          本站现接受{" "}
          <a href="/download/Arbiter_0.52.3.zip" download>
            <em>Minesweeper Arbiter 0.52.3</em>
          </a>{" "}
          生成的 <em>avf</em> 录像，以及{" "}
          <a href="/download/Metasweeper_3.3.4.exe" download>
            <em>元扫雷 3.3.4</em>
          </a>{" "}
          生成的 <em>evf</em> 录像。
        </p>
        <p>上传成功后的录像，需要通过管理员的审核，成绩才能计入排行。</p>
        <hr />
        <UploadForm />
      </div>
    </div>
  );
}
