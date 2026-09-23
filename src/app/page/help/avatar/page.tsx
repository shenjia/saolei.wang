// 怎样上传我的照片（移植 2008 版 Help/Image.asp）
import Link from "next/link";

export const metadata = { title: "怎样上传我的照片 | 扫雷网" };

export default function AvatarHelpPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>怎样上传我的照片？</h1>
        <p>1、选择自己最满意的一张生活照片，越清晰越好。</p>
        <p>
          2、将头部部分剪切出来，特别注意要在头部周围预留一些空间，不要做成大头状，然后编辑成
          100x100 像素，存成 JPG 格式。
        </p>
        <p>
          3、将编辑好的照片连同自己的 Id 发邮件到 <em>zhangshenjia@qq.com</em>：
        </p>
        <p>
          标题：申请开通照片
          <br />
          正文：站长你好，我申请开通照片功能，我的 Id 是 1，谢谢！
          <br />
          附件：id1.jpg
        </p>
        <hr />
        <Link href="/page/help" className="button active">
          我明白怎么上传照片了
        </Link>
      </div>
    </div>
  );
}
