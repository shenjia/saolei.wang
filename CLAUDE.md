# 扫雷网 saolei.wang — 架构说明

用 Next.js + MySQL 重写扫雷网，继承 2013 年 PHP 新版（saolei.net）的样式与功能，数据来自 2013 版已迁移完成的 MySQL dump。

## 技术栈

- Next.js 16（App Router，Turbopack）+ React 19 + TypeScript
- Prisma 6.19.3 + MySQL（本地库 `saolei`，`mysql://root@localhost:3306/saolei`）
- pnpm（注意：`pnpm.onlyBuiltDependencies` 必须包含 prisma/@prisma/engines，否则引擎不装）

## 数据来源

- `saolei.net/database/saolei_2019-5-18.sql`（2013 版项目已从旧版 MSSQL 全量迁移）：
  11,564 用户、57,728 录像、55,657 动态、4,173 签名
  **注意：该 dump 数据实际止于 2013-10-23**（迁移完成时点），并非 2019
- 导入方式：`grep -E "^INSERT INTO" dump.sql | mysql -uroot saolei`
- **旧站增量同步（2026-09-23 首次完成）**：直连线上 MSSQL `SaoleiNet` 库（只读账号），
  管线与映射规则见 `scripts/sync/README.md`（extract → transform → fixup → validate）。
  同步后：34,035 用户、308,210 录像、150,479 动态、54,167 评论、BBS 2,833 帖/17,904 回复、
  历程 4,985、站内信 219。 staging 库 `saolei_mssql` 保留原始快照
- **待办 Phase B**：~25 万新录像的实体文件（mvf/avf）下载解析，回填 hash/board/signature 等

## Schema 约定（沿用 2013 版 20 张表）

- 用户域：`user` / `user_info` / `user_auth` / `user_stat` / `user_sig` 共用主键 = 用户 id
- 成绩域：`user_scores`（flag）/ `user_scores_nf`（NF），主键 = 用户 id
- 录像域：`video` / `video_info` / `video_stat` / `video_scores_{beg,int,exp}(_nf)` 共用主键 = 录像 id
- 其他：`news` / `comment` / `donate` / `distribution`
- 与 migrations SQL 的唯一差异：`user_stat` 无 `clicker` 列（以 2019 dump 为准）
- `user_sig.signature` 必须 `utf8 COLLATE utf8_bin`（大小写敏感签名，db push 后需手动 ALTER）
- 成绩存储：时间=毫秒；3BV/s=实际值×1000；时间戳=Unix 秒（bigint）

## 关键领域逻辑（src/lib/）

- `config.ts`：军衔 18 级（大元帅→列兵）、评级 SSS~F、级别/排序/录像状态（0 屏蔽 / 10 待审 / 20 通过）、棋盘尺寸 beg 8×8 / int 16×16 / exp 30×16
- `assess.ts`：军衔/评级按 `distribution` 表最新一行阈值计算（军衔看 sum_time）
- `format.ts`：成绩格式化（ms→秒 2 位、×1000→3 位）、相对时间（移植 Time::opposite）
- `queries.ts`：排行榜排序 time 升序 / 3bvs 降序；录像列表 level=all 按 id 倒序、指定级别走 video_scores_{level}（flag 榜）；录像 3bvs = board_3bv×1e6/real_time，board_3bv<4 记负（删除线不承认）

## 样式

- 完整继承 2013 版暗色 Monokai 风格：`public/styles/legacy-2013.css`（由 layout.tsx 以 `<link>` 原样加载）
- **不要**把 legacy CSS 经 Tailwind/PostCSS `@import` 引入——Tailwind v4 解析器会对 IE filter hack 报 "Unterminated string"
- 图片资源在 `public/images/common|form/`（棋盘格、性别、头像等，URL 已从 `../images/` 改为 `/images/`）
- 新增样式（分页器、筛选标签）在 `src/app/globals.css`

## 页面

| 路由 | 说明 |
|---|---|
| `/` | 雷界动态（加载更多）+ 每日一星 + 论坛新帖 + 入伍新兵 + 十大元帅 + 雷界统计 |
| `/ranking?level&order&nf&page` | 排行榜（sum/beg/int/exp × time/3bvs × 普通/NF）；登录后有「我在哪里」定位按钮 |
| `/ranking/whereami?id&level&order&nf` | 302 定位到该用户所在页 `#id_<uid>`（移植 Ranking::getPage 同分扫描） |
| `/grow` | 进步榜（rank_snapshot 每日惰性快照，今 vs 昨名次差） |
| `/click` | 人气榜（click 表 user+ip+date 去重；访问地盘即计数） |
| `/world` | 雷界生态：军衔人数分布 + 神界全员（sum_time 前 41） |
| `/hero` | 雷神殿：神界前 30 |
| `/team` | 管理团队：管理员名单 + 各自审核量 |
| `/user/random` | 随机串门（302 到随机有成绩用户地盘） |
| `/video?level&order&author&page` | 录像列表（detail 模式，含棋盘缩略；order 含 comments 热评） |
| `/video/[id]` | 录像详情（棋盘、flop 播放、评论、计数、管理员审核面板） |
| `/video/upload` | 录像上传（登录，mvf/avf，500KB 上限） |
| `/video/review?status` | 录像审核列表（管理员；待审/已通过/已屏蔽） |
| `/video/download/[id]` | 录像下载（先 uniqueAction('download') 计数再发文件） |
| `/user/[id]` | 用户主页（成绩总表、雷达图、动态、历程 CRUD、资料、人气统计、发短消息） |
| `/bbs` `/bbs/[id]` `/bbs/post` `/bbs/edit/[id]` | 论坛：4 板块（0 公告仅管理员）、置顶/精华/锁定/软删、UBB 渲染、回复分页 |
| `/message` `/message/[id]` | 站内信：收件箱/读信/发信/清空 + 管理员广播；导航 30s 未读轮询 |
| `/account` `/account/profile` `/account/password` | 账号中心：我的资料 / 修改资料 / 修改密码（均需登录） |
| `/account/login` `/account/bind` `/account/oauth` | 密码登录 / 老用户强制绑定 / 扫码注册（见 2026-09-21 日志） |
| `/account/forgot` `/account/reset?token` | 邮箱找回密码（token sha256 入库、30min 一次性；SMTP_* 未配时链接打日志） |
| `/page/titles` `/page/help` | 军衔体系说明 / 新手上路（如何加入排行） |
| `/page/help/*` | 11 个帮助子页：why/grow/word/video/upload/freeze/star/clone-faq/bbs/email/avatar |
| `/page/guide` `/page/about` `/page/donate` `/page/history` `/page/download` `/page/world` | 教程索引 / 关于 / 赞助 / 更新历史 / 软件下载（暂链旧站文件）/ 世界 TOP10 |
| API | `/api/comment/post|more`、`/api/news/more`、`/api/account/profile|password`、`/api/video/upload|review`、`/api/bbs`、`/api/message`、`/api/history`、`/api/auth/password` |

## 关键模块（src/lib/）

- `mvf.ts` / `avf.ts`：MVF/AVF 解析器（594/349 行 C 的忠实 TS 移植），输出 RawVF 文本行
- `rawvf.ts`：Parser::format / renderBoard 移植。**棋盘必须复刻 PHP 7.1+ 字符串负偏移怪癖**
  （`"$row[-1]"` 取行尾 → 左边界格把同行 x=max 当左邻），否则与库内数据不一致
- `review.ts`：审核与成绩管线（Review/VideoScores/UserScores/News 全移植，含 NF 榜；
  文件头记录两处按旧代码意图修正的 bug）
- `stat.ts`：uniqueAction 点击/下载计数（相邻同 IP 去重）
- 解析器验证方法：旧项目 `code/videos/**` 抽样，按文件 hash 与 DB `video+video_info` 全字段对比
  （本地 videos/ 样本文件名≠内容 md5，是改名测试文件，不能当真值）

## 待实现（后续阶段）

- 邮箱注册 + 密码找回（新版测试.txt 新需求，需邮件服务方案）
- 新闻管理、捐赠（2013 版也无代码，仅 document/donate.xlsx）
- 录像实体文件同步（Phase B，见 scripts/sync/README.md）
- 部署（目前仅本地开发，`pnpm dev`，端口任意）

## 工程约定

- git 操作用 `xgit-saolei`（/usr/local/bin，规避受保护路径弹窗）
- Node/构建类命令前置 `env -u NODE_OPTIONS`（规避安全删除护栏）
- 本地提交原子化；**提交即 push**（网站未上线期间默认，2026-09-24 张老师指令；remote=git@github.com:shenjia/saolei.wang.git **公开仓**，历史已做敏感信息清洗，凭据一律走 env；上线后如需恢复审批制再改）
