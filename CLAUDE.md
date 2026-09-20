# 扫雷网 saolei.wang — 架构说明

用 Next.js + MySQL 重写扫雷网，继承 2013 年 PHP 新版（saolei.net）的样式与功能，数据来自 2013 版已迁移完成的 MySQL dump。

## 技术栈

- Next.js 16（App Router，Turbopack）+ React 19 + TypeScript
- Prisma 6.19.3 + MySQL（本地库 `saolei`，`mysql://root@localhost:3306/saolei`）
- pnpm（注意：`pnpm.onlyBuiltDependencies` 必须包含 prisma/@prisma/engines，否则引擎不装）

## 数据来源

- `saolei.net/database/saolei_2019-5-18.sql`（2013 版项目已从旧版 MSSQL 全量迁移）：
  11,564 用户、57,728 录像、55,657 动态、4,173 签名
- 导入方式：`grep -E "^INSERT INTO" dump.sql | mysql -uroot saolei`
- **待办**：线上 ASP 旧站 2019-05 之后的增量数据需另写 MSSQL→MySQL 增量同步

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

## 页面（只读先行）

| 路由 | 说明 |
|---|---|
| `/` | 雷界动态 + 入伍新兵 + 十大元帅 |
| `/ranking?level&order&page` | 排行榜（sum/beg/int/exp × time/3bvs），sum 链接到用户页，单级别链接到录像 |
| `/video?level&order&author&page` | 录像列表（detail 模式，含棋盘缩略） |
| `/video/[id]` | 录像详情（棋盘、成绩、审核信息、统计） |
| `/user/[id]` | 用户主页（成绩总表、最新动态、个人资料、统计） |

## 待实现（后续阶段）

- 账号体系（注册/登录/改密，新版测试.txt 要求改邮箱登录 + 密码找回）
- 录像上传（MVF 解析）与审核流
- 评论、新闻管理、捐赠
- 旧版 MSSQL 增量数据同步
- 部署（目前仅本地开发，`pnpm dev`，端口任意）

## 工程约定

- git 操作用 `xgit-saolei`（/usr/local/bin，规避受保护路径弹窗）
- Node/构建类命令前置 `env -u NODE_OPTIONS`（规避安全删除护栏）
- 本地提交原子化；push 需张老师明确指令
