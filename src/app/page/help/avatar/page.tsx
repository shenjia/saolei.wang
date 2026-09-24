// 怎样上传我的照片（移植 2008 版 Help/Image.asp）
// 2026-09-24 更新：旧流程是「把照片发邮件给站长人工开通」，现已改为
// 个人资料页在线上传 + AI 初审 + 站长复核，本页同步改写。

import Link from "next/link";

export const metadata = { title: "怎样上传我的照片 | 扫雷网" };

export default function AvatarHelpPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>怎样上传我的照片？</h1>
        <p>1、选择自己最满意的一张生活照片，越清晰越好。</p>
        <p>
          2、打开「
          <Link href="/account/profile">账号中心 → 修改资料</Link>
          」，点击头像位置选择图片。不用自己裁剪、不用改尺寸，系统会自动处理成合适的大小。
        </p>
        <p>
          3、提交后系统会先自动审核一遍，拿不准的会转给站长人工复核。在审核通过之前，
          你原来的头像照常显示，不会先露出没审过的图。
        </p>
        <p>4、审核结果会通过站内信通知你；没通过的话，信里会说明原因，重新换一张就好。</p>
        <hr />
        <h2>照片要求</h2>
        <p>
          只接受<b>本人真实照片</b>。卡通、动漫、表情包、风景、物品、纯色图案，以及 AI
          生成的写实人脸都会被驳回——本站在头像上和旧站的「照片墙」保持一致，要的就是真人。
          另外色情低俗、涉政敏感的内容一律不接受。
        </p>
        <p>照片格式支持 JPG / PNG，手机里直接选原图就行。</p>
        <hr />
        <p>
          <em>
            说明：旧版需要把照片发邮件给站长手动开通，这个流程已经停用，现在直接在网站上换就可以了。
          </em>
        </p>
        <Link href="/page/help" className="button active">
          我明白怎么上传照片了
        </Link>
      </div>
    </div>
  );
}
