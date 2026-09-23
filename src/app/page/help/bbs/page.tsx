// 论坛管理条例（移植 2008 版 Help/BBS.asp）
import Link from "next/link";

export const metadata = { title: "论坛管理条例 | 扫雷网" };

export default function BbsRulePage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>论坛管理条例</h1>
        <h2>宗旨</h2>
        <p>本论坛设立的宗旨是为国内扫雷玩家互相交流创造条件，促进沟通和水平进步。</p>
        <p>原则上不限制讨论范围，提倡扫雷话题。</p>
        <h2>欢迎讨论的主题</h2>
        <p>
          ※ 扫雷心得体会
          <br />
          ※ 扫雷理论探索
          <br />
          ※ 扫雷问题研究
          <br />
          ※ 扫雷历程
          <br />
          ※ 扫雷新闻
          <br />
          ※ 扫雷人物故事
          <br />
          ※ 扫雷周边及其附属游戏
        </p>
        <h2>不欢迎讨论的主题</h2>
        <p>
          ※ 无任何意义
          <br />
          ※ 带有政治和宗教色彩
          <br />
          ※ 包含色情、YY 等内容
          <br />
          ※ 包含广告、病毒等内容
          <br />
          ※ 包含违法内容
          <br />
          ※ 敏感话题
          <br />
          ※ 诽谤、诋毁、人身攻击
        </p>
        <h2>管理办法</h2>
        <p>※ 对符合以上规定的优秀主题，将加入精华或进行置顶。</p>
        <p>※ 对不符合以上规定的主题和回复，将直接删除。情况恶劣时可封停直至删除用户。</p>
        <p>扫雷网管理团队保留对以上条例的最终解释权。</p>
        <hr />
        <Link href="/bbs" className="button active">
          明白了，我一定遵守
        </Link>
      </div>
    </div>
  );
}
