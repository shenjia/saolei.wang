// 扫雷教程索引（移植 2008 版 Guide/Index.asp）
// 原站教程正文都在论坛精华帖中，此处将各条目链接到对应的论坛帖子
// 2026-10-21 张老师需求：右侧开侧栏「常见问题」（旧版首页右下角 Help/List.asp 搬运），
//   4 条遮罩弹窗 + 3 条直链，见 GuideFaq 组件
// 2026-10-22：「扫雷术语介绍」改指站内独立页 /page/help/word（弹窗内容变长出滚动条），
//   GROUPS 条目支持 link 字段（站内页优先于论坛帖）；论坛原帖 227 保留作历史资料
// 2026-11-08 新增：知乎 MsPVZ.ZSW（张少武）专栏「Pro扫雷玩家的游戏技术推广」10 篇外链
//   （按内容归入基础入门/中级进阶；专栏共 17 篇，2 篇已被作者删除不挂，
//   录像赏析类 3 篇与纪录盘点经张老师裁定不收录——教程页只收教程）

import Link from "next/link";
import GuideFaq from "@/components/GuideFaq";

export const metadata = { title: "扫雷教程" };

// [分类, [标题, 作者, 论坛帖子id | null, 站内链接?, 站外链接?]]
const GROUPS: [string, [string, string, number | null, string?, string?][]][] = [
  [
    "基础入门",
    [
      ["扫雷新手上路", "门世运", 177],
      ["扫雷术语介绍", "张砷镓", null, "/page/help/word"],
      ["扫雷定式及其变化", "张砷镓", 362],
      ["关于数字1-7周围8格中雷的分布的各种形状", "杨萧杨", 8243],
      ["新手向教学：综合实力提升", "龚浩然", 21006],
      ["新手判雷上路（一）——初步认识减法公式及其衍生定式", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/27439584"],
      ["新手判雷上路（二）——121和1221定式变形", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/27550382"],
    ],
  ],
  [
    "中级进阶",
    [
      ["猜雷的一些心得", "张砷镓", 187],
      ["谈局部最优化操作", "张砷镓", 1262],
      ["怎样节省标雷", "李峰", 374],
      ["3BV/s的公式及其应用", "张宏", 825],
      ["纪录的构成分析", "张砷镓", 1188],
      ["雷诀八条", "张砷镓", 1579],
      ["进阶选手补漏——21定式及其变形的常见应用", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/27762182"],
      ["一支穿云箭——“破空”简要教程", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/28703132"],
      ["进阶技能之“跳判”简介——为FL锦上添花", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/85103708"],
      ["连贯性思维基础速览——反应速度、预判与点击次序", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/37685811"],
      ["连贯性思维——郭蔚嘉的NF基础", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/41319677"],
      ["低水平玩家的顽疾——支离破碎的NF操作", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/107117509"],
      ["标雷简单优化——标雷双击的获益及数字1的标雷", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/31423337"],
      ["猜雷与收尾无脑操作的简要教程——别把实力当运气", "张少武", null, undefined, "https://zhuanlan.zhihu.com/p/35974785"],
    ],
  ],
  [
    "综合教程",
    [
      ["扫雷基本经验", "张砷镓", 92],
      ["小谈盲扫与标雷", "李峰", 285],
      ["扫雷游戏前热身之我见", "李峰", 333],
      ["一方谈扫雷07版", "田溢昉", 453],
      ["一方谈扫雷09版", "田溢昉", 4845],
      ["郭嘉NF经验谈", "郭蔚嘉", 11409],
      ["郭嘉谈NF v2.0", "郭蔚嘉", 12992],
      ["浅谈隔空判雷及标雷", "周丹", 8367],
      ["NF十层境界", "郭锦洋", 10388],
    ],
  ],
  [
    "软件周边",
    [
      ["Minesweeper Arbiter使用教程(一)", "周丹", 11038],
      ["Minesweeper Arbiter使用教程(二)", "周丹", 11039],
      ["Minesweeper Arbiter中文插件", "郭锦洋", 11499],
      ["Minesweeper Clone 0.97 使用说明", "张砷镓", 1006],
      ["Minesweeper Clone 0.97 常见问题", "张砷镓", 1007],
      ["Minesweeper Clone 0.97 自动录像教程", "吴梦熊", 115],
      ["扫雷硬件談之一鼠标", "华俊", 105],
      ["扫雷硬件談之二鼠标垫", "华俊", 128],
      ["将分辨率调成640x480的方法", "张砷镓", 283],
      ["关于调节鼠标速度", "张砷镓", 385],
      ["怎样调节适合自己的鼠标灵敏度", "李峰", 1082],
      ["扫雷世界排行榜简史(2008.5.25)", "张砷镓", 2294],
    ],
  ],
];

export default function GuidePage() {
  return (
    <div id="page" className="two_columns">
      <ul id="home">
        <li className="main">
          <div id="guide" className="box text">
            <h1>扫雷教程</h1>
            {GROUPS.map(([group, items]) => (
              <div key={group}>
                <h2>【{group}】</h2>
                <hr />
                {items.map(([title, author, postId, pageLink, extLink]) =>
                  pageLink ? (
                    <p key={title}>
                      ※ <Link href={pageLink}>{title}</Link>　<em>作者: {author}</em>
                    </p>
                  ) : extLink ? (
                    <p key={title}>
                      ※{" "}
                      <a href={extLink} target="_blank" rel="noopener noreferrer">
                        {title}
                      </a>{" "}
                      <em>作者: {author}</em>
                    </p>
                  ) : postId ? (
                    <p key={title}>
                      ※ <Link href={`/bbs/${postId}`}>{title}</Link>　<em>作者: {author}</em>
                    </p>
                  ) : (
                    <p key={title}>
                      ※ {title}　<em>作者: {author}</em>
                    </p>
                  )
                )}
              </div>
            ))}
          </div>
        </li>
        <li className="sidebar">
          <GuideFaq />
        </li>
      </ul>
    </div>
  );
}
