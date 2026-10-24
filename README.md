# 扫雷网 saolei.wang

用 Next.js + MySQL 重写的扫雷网（原 saolei.net），继承 2013 PHP 新版的样式与 2008 ASP 版的全部功能。
面向扫雷玩家的成绩排行 / 录像分享 / 社区网站。

## 功能一览

- **排行榜**：总榜 / 初级 / 中级 / 高级 × 时间 / 3BV/s × 标准按旗（FL）/ 无标（NF），共 12 张榜；
  进步榜（每日快照）、人气榜、地区榜、神界 / 雷神殿 / 十大元帅
- **录像**：上传（MVF/AVF/RMV）、在线回放引擎（棋盘逐帧重放）、录像分析雷达（BVS/IOE/CORR/CLS/PPC/STNB 六维）、
  成绩榜、评论、下载计数；上传走审核流（管理员审核 + 非胜局自动拒绝）
- **用户**：个人主页（成绩总表 / 3BV 收集 / 雷界历程 / 动态）、军衔 18 级体系、QQ/微信扫码登录、
  邮箱绑定与找回密码、头像上传（AI 初审 + 人工复核）
- **社区**：论坛（4 板块，UBB 渲染）、评论、站内信、全站动态流
- **管理后台** `/admin`：仪表盘 / 数据分析 / 玩家与录像管理 / 审核 / 封禁（限时+连坐）/ 内容管理 / 操作日志
- **UGC 安全**：前置敏感词 Trie 过滤 + 后置 AI 复核双闸门，AI 永不自动删除，失败一律放行

## 技术栈

Next.js 16（App Router）· React 19 · TypeScript · Prisma 6 · MySQL · Tailwind v4 · pnpm
样式主体继承 2013 版 `public/styles/legacy-2013.css`（暗色 Monokai 风格）。

## 快速开始

要求：Node 22+、pnpm、MySQL 8+（本地 root 即可）。

```bash
pnpm install                 # prisma/@prisma/engines 必须参与构建（package.json 已配置）
cp .env.example .env         # 默认 DATABASE_URL 即 mysql://root@localhost:3306/saolei
pnpm exec prisma generate
```

导入最小测试数据库（约 1.3MB，全量表结构 + 精选数据，无需 `prisma db push`）：

```bash
mysql -uroot -e "CREATE DATABASE IF NOT EXISTS saolei CHARACTER SET utf8mb4"
gunzip < database/dev-seed.sql.gz | mysql -uroot saolei
pnpm dev                     # http://localhost:3000
```

### 测试账号

| 登录名 | 密码 | 角色 |
|---|---|---|
| `admin` | `admin` | 超级管理员（role=100，可进 `/admin` 全部功能） |

### 种子库说明

- 用户只放**综合排行 TOP100**（sum_time 升序、排除封禁）+ 测试管理员，共 101 人；
  最好成绩、军衔、签名、统计一应俱全，排名/军衔/评级照常工作
- **真实用户密码已全部替换为随机值**（任何人无法登录旧账号），邮箱、登录 IP 等隐私字段已清空
- 录像放 TOP100 每人最近 50 部已通过录像 + 其最好成绩录像（约 5500 部，含棋盘串与六维指标），
  回放 / 雷达 / 排行均可演示；news、评论、论坛等互动表留空
- 重新生成：`python3 scripts/make-dev-dump.py`（依赖 pymysql，读本地 `DATABASE_URL`）
- 种子库口径与代码 schema 同步演进，schema 变更后请重跑生成脚本并提交

### 录像文件

`videos/`（55 万+ 录像实体文件）不入仓，本地没有也不影响开发：
本地缺失的录像由 `/videos/*` 路由按 `VIDEO_FALLBACK_ORIGIN`（`.env` 中配置，填
`https://saolei.wang`）反向代理主站同名文件，
在线回放与下载都能走通。留空该变量则缺失录像直接 404。

## 部署

GitHub Actions 全自动蓝绿部署，push 到 `main` 即触发（`.github/workflows/deploy.yml`）：

1. CI 在 ubuntu runner 构建标准 `.next` 产物（服务器**绝对禁止** `next build`——小内存机器会 swap 假死）
2. rsync 源码 + 产物到生产机，`scripts/server-release.sh` 复制成 blue/green 双槽并 `pm2 reload` 切换
   （nginx upstream；`.next-blue` / `.next-green` 靠 `next.config.ts` 的 `NEXT_DIST_DIR` 隔离）
3. 部署前 `prisma db push` 遇 schema 外表会中止全站部署——生产库不放临时表

环境变量（数据库凭据、AUTH_SECRET、GLM_API_KEY 等）只存在于生产机 `.env`，不入仓。

## 给共创者的约定

- 架构细节、领域口径（军衔阈值、3BV/s 计算、审核管线等）见 [CLAUDE.md](CLAUDE.md)——**动手前先读它**
- 改了 Prisma schema：`pnpm exec prisma generate` 后重启 dev 进程（常驻进程持有旧 Client）
- 新增 UGC 发布入口（含编辑入口）必须同时挂前置敏感词过滤与后置 AI 复核（见 CLAUDE.md「UGC 双闸门」）
- 热点统计查询必须挂 `unstable_cache`（30 万行级大表全扫会挤爆连接池）
- raw SQL 一律 snake_case 列名；`$queryRawUnsafe` 的 `?` 必须传参
