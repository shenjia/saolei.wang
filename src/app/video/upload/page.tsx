// 上传录像页（移植 views/video/upload；2026-10-23 张老师定稿文案：只列 avf / evf；
// 2026-10-24 补版本号与低版本拦截口径——检查实现在 rawvf.checkProgramVersion。
// 注意 mvf 仍在上传白名单内——文案是给用户看的重点，不代表格式支持面收窄。
// 2026-11-02 张老师：说明文字整体沉底为「上传规则」独立板块（复用 RankingRules，
// 同排行页底部规则板块形态），页面主体只留上传表单。
// 2026-11-07 张老师：正文补列 Viennasweeper 4.0.0b2 生成的 rmv 录像）

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { UploadForm } from "@/components/UploadForm";
import { RankingRules } from "@/components/RankingRules";
import { countWeeklyUploads, weeklyUploadLimit, sumDonateCents } from "@/core/src/lib/anticheat";

export const dynamic = "force-dynamic";
export const metadata = { title: "上传录像" };

export default async function VideoUploadPage() {
  const session = await getSession();
  if (!session) redirect("/account/login");

  // 滚动 7 天剩余额度（2026-11-02 张老师定：默认 100/周，赞助每 1 元 +20、2000 封顶）
  const [limit, used] = await Promise.all([
    sumDonateCents(session.uid).then(weeklyUploadLimit),
    countWeeklyUploads(session.uid),
  ]);
  const remaining = Math.max(0, limit - used);

  return (
    <div id="page" className="main">
      <div className="video_upload box center">
        <h1>上传录像</h1>
        {/* 支持格式说明（2026-11-02 张老师：从规则板块拿回标题下作正文，原样式；
            2026-11-07 补 Viennasweeper 4.0.0b2 rmv——版本闸见 rawvf.checkProgramVersion；
            11:35 张老师改版式：一行三项（元扫雷殿后），ul 换回段落（li 字号偏小），
            格式名 avf/evf/rmv 用站点黄 #fdc61d） */}
        <p>本站目前支持以下录像格式上传：</p>
        <p>
          <a href="/download/Arbiter_0.52.3.zip" download>
            <em>Minesweeper Arbiter 0.52.3</em>
          </a>{" "}
          生成的 <em style={{ color: "#fdc61d" }}>avf</em> 录像
          {"　"}
          <a href="/download/Viennasweeper_4.0.0.zip" download>
            <em>Viennasweeper 4.0.0</em>
          </a>{" "}
          生成的 <em style={{ color: "#fdc61d" }}>rmv</em> 录像
          {"　"}
          <a href="/download/Metasweeper_3.3.4.exe" download>
            <em>元扫雷 3.3.4</em>
          </a>{" "}
          生成的 <em style={{ color: "#fdc61d" }}>evf</em> 录像
        </p>
        <UploadForm initialRemaining={remaining} />
      </div>
      {/* 上传规则板块（2026-11-02 张老师：说明文字沉底，形态同排行页底部排行规则）；
          实时剩余行 14:22 改移「开始上传」按钮左（UploadForm 内），板块不再带 footer */}
      <RankingRules
        title="上传规则"
        items={[
          <>
            <b>先审后排</b>：上传成功后的录像，需要通过管理员的审核，成绩才能计入排行。
          </>,
          <>
            <b>3BV限制</b>：排行可接受的初级最低 3BV 为 <i>2</i>，中级最低 <i>30</i>，高级最低 <i>100</i>
            。低于以上3BV的录像仍可上传，但成绩不能加入排行。
          </>,
          <>
            <b>录像来源</b>：在线练习产生的录像无法上传（排行模式录像将由服务器生成，不支持外部上传）。
          </>,
          <>
            <b>每周限额</b>：每账户每周最多上传<i>100</i>个录像，对本站
            {/* 绿色链接（2026-11-02 张老师二改：不再亮灰 hover） */}
            <Link href="/page/donate" style={{ color: "#a6e22e" }}>
              提供赞助
            </Link>
            可大大提升上传限额。
          </>,
        ]}
      />
    </div>
  );
}
