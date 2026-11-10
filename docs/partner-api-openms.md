# 扫雷网（saolei.wang）开放 API 接入文档

> 适用对象：外部机器人 / 数据同步服务（首批 openms.top）
> 版本：v1（2026-10-24，取代 2026-10-21 未启用的 partner 草案）
> 基础地址：`https://saolei.wang`（2026-10-25 已正式切换主域，旧 new.saolei.wang 整体 301 到此，请接入方更新）

> **使用范围（2026-11-08 张老师定）**：录像目录 / 详情 / 文件的**批量同步**（轮询、全量或增量导入）**仅限合作站点**调用——须持有站长签发的合作 Key 并已报备同步方式；普通第三方服务（机器人、数据分析等）仅可做点查（单条 id 查询），不得批量拉取录像数据。

## 一、鉴权

所有请求需携带请求头：

```
X-Api-Key: <你的专用 key>
```

key 由扫雷网管理员在后台签发（格式 `sk-…`），请勿泄露、勿提交进公开仓库。丢失或泄露请联系管理员重新签发。

- 无 key / 错误 key：`401`
- 请求过频：`429`（每 key 每分钟上限由站点管理员单独配置，默认 60 次/分钟，按合作方计）
- 建议：全量同步控制在 30 req/min 以内，增量同步每小时一次即可

## 二、接口清单

### 0. 用户登录 `POST /api/public/v1/login`（2026-11-09 新增）

以扫雷网账号密码换取用户登录令牌（token），用于后续用户侧 API 的身份验证。**需携带 X-Api-Key**（2026-11-09（4）张老师定：login 面向持有 Key 的合作方客户端，防止非法客户端借公开端点探测用户密码）。

请求头：

```
X-Api-Key: <你的专用 key>
```

请求体（JSON）：

```json
{ "username": "your-username", "password": "your-password" }
```

成功响应：

```json
{
  "token": "ut-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "tokenType": "Bearer",
  "expiresIn": 604800,
  "user": { "id": 1, "username": "your-username" }
}
```

- `token` 有效期 **7 天**（`expiresIn` 秒），到期需重新登录换取新 token；重登签发的新 token 不顶掉旧 token（多端并存）
- 客户端保存 token，之后**所有用户侧请求**携带请求头 `Authorization: Bearer <token>`，即视为该用户的登录态
- 校验口径与站内登录完全一致（兼容旧站账号）；无/错 X-Api-Key `401`；用户名或密码错误 `401`；账号封禁 `403`（含解封时间提示）；同 IP 每分钟最多 10 次，超限 `429`
- token 只存 sha256 哈希，请妥善保管明文；疑似泄露可联系管理员吊销

### 0.1 登录态自检 `GET /api/public/v1/me`

验证当前 Bearer token 并取回身份。后续将提供一系列要求登录态的用户侧 API，均按此方式鉴权。

```json
{ "user": { "id": 1, "username": "your-username", "role": 0 } }
```

- 无效/过期/被吊销的 token：`401`（应重新 login）

### 1. 站点统计 `GET /api/public/v1/stats`

无参数。返回首页「站点统计」版块同口径数据 + 两个最大 ID（确定增量抓取范围用）。

```json
{
  "generatedAt": 1792555559,
  "stats": {
    "userTotal": 15999,
    "rankedTotal": 7890,
    "videoTotal": 308000,
    "videoCommentTotal": 12000,
    "bbsTopicTotal": 3000,
    "bbsReplyTotal": 45000,
    "practiceTotal": 200000
  },
  "maxVideoId": 344834,
  "maxUserId": 16100
}
```

字段：`userTotal` 注册人数（排除封禁）· `rankedTotal` 排行人数（有成绩且未封禁）· `videoTotal` 录像数（待审+已通过）· `videoCommentTotal` 录像评论数 · `bbsTopicTotal` 论坛主题数 · `bbsReplyTotal` 论坛回复数 · `practiceTotal` 在线练习累计盘数 · `maxVideoId`/`maxUserId` 当前最大录像/玩家 id（增量抓取定位，减少试探请求）。

### 2. 录像列表（增量同步）`GET /api/public/v1/video_list`

参数：

| 参数 | 说明 |
|---|---|
| `cursor` | 上次响应的 `nextCursor`，首次不传 |
| `since` | Unix 秒，跳过该时间之前上传的（仅首次全量可选用；与 cursor 同给时 cursor 优先） |
| `level` | `beg` / `int` / `exp`，缺省 = 全部 |
| `player_id` | 玩家 ID，提供后只返回该玩家的录像；需为大于 0 的整数 |
| `size` | 每页条数，默认 200，上限 1000 |

响应示例：

```json
{
  "cursor": 0, "nextCursor": 25, "hasMore": true, "size": 2,
  "generatedAt": 1792555559,
  "items": [
    { "id": 24, "level": "beg", "userId": 1, "userName": "张砷镓",
      "hash": "4cd9e3e261f76888be8d8919f06d0428", "status": 20,
      "uploadTime": 1167978360, "reviewTime": 1167978403,
      "realTime": 1110, "board3bv": 4, "3bvs": -3604,
      "nf": true, "software": "Clone", "version": "0.97" }
  ]
}
```

字段说明：
- `status`：0=已屏蔽 / 10=待审 / 20=已通过；列表返回全部审核状态，调用方可按需自行筛选
- **来源过滤（2026-11-07）**：经外站同步接口落库的录像带来源标记（`video.from_site` = 来源 key）。每个调用方**永远看不到自己 key 来源的录像**（防止「本站抓走 → 又被同步回来」的递归循环）；其他合作方来源与站内原生录像不受影响。协议级约定：调用方不应假设录像 id 连续。
- `realTime` 毫秒（= 秒精确到小数点第三位）；`3bvs` 已按站内口径算好（`ROUND(board_3bv×1e6/real_time)`），**负值 = 运气盘**（初级 3BV<10、中高级 3BV<4），成绩不被站内承认，建议同步侧同样标注或排除。**展示口径提示**：站内时间成绩显示为两位小数、第三位**截去不四舍五入**（如 37299ms 显示 37.29），消费方展示时应按同口径换算
- `nf`：true = 无标雷（NF）录像
- **录像文件本体不随列表提供**，如需回放请链接到 `https://saolei.wang/video/{id}`；已屏蔽录像不能通过 `video_info` 查询详情或文件

增量同步建议：记上次 `nextCursor`，每次从断点续拉；已删除的录像会从数据中消失，屏蔽录像则保留并以 `status=0` 返回，建议以「全量对账 + 增量追加」组合维护。用 `stats` 接口的 `maxVideoId` 确定抓取上界。

### 3. 录像详情（含重放指标）`GET /api/public/v1/video_info?id=1,2,3`

`id` = 逗号分隔的录像 ID，最多 50 个。返回录像全部**已落盘公开数据**：video_list 全部字段 + `signature`（录像内嵌玩家标识）+ `metrics`（离线重放引擎算得的落盘指标）+ `fileUrl`（前台同款文件下载地址）；`status` 仅含 10=待审 / 20=已通过，屏蔽录像不返回。

```json
{
  "generatedAt": 1792555559,
  "items": [
    { "id": 328090, "level": "exp", "userId": 18290, "userName": "鞠泽恩",
      "hash": "…", "status": 20,
      "uploadTime": 1790000000, "reviewTime": 1790000500,
      "realTime": 25100, "board3bv": 152, "3bvs": 6055,
      "nf": false, "software": "Arbiter", "version": "0.52.3",
      "signature": "JuZeEn",
      "fileUrl": "https://saolei.wang/video/download/328090",
      "metrics": {
        "cl": 185,
        "clLeft": 120, "clRight": 40, "clDouble": 25,
        "ce": 159,
        "path": 812,
        "ioe": 0.822,
        "stnb": 50.31
      } }
  ]
}
```

metrics 字段：`cl` 总点击（左+右+双）· `clLeft`/`clRight`/`clDouble` 分类点击 · `ce` 有效点击 · `path` 鼠标行程（16px/格折算）· `ioe` 效率（3BV/总点击）· `stnb` 判雷指标。

说明：
- 屏蔽（status=0）录像不返回；待审（10）/已通过（20）均可查
- `fileUrl` = 录像文件（MVF/EVF 等）下载地址（前台「下载」按钮同款入口 `/video/download/{id}`），直接 GET 即得文件本体（`application/octet-stream`），每次访问计一次下载（同站内下载计数）；该路径全站限速 10 req/s，批量拉取请自行排队，勿并发打爆
- `metrics` 为 null 表示该录像重放指标尚未落盘（老录像跑批覆盖中）
- 点击计数为站内 flop 引擎口径（2026-10-16 定稿）：左/右/双按事件语义归类，`ce` = 有效点击，与其他站点的派生口径可能不同，请勿混用

### 4. 玩家详情 `GET /api/public/v1/user_info?id=1,2,3`

`id` = 逗号分隔的玩家 ID，最多 50 个。返回公开信息 + 双体系成绩（标准 / NF，各级 time、3bvs 附达成录像 ID）+ 录像标识列表。

```json
{
  "generatedAt": 1792555560,
  "users": [
    { "id": 1, "name": "张砷镓", "englishName": "Zhang Shen Jia", "sex": 1,
      "area": "陕西", "registeredAt": 1167758493, "banned": false,
      "scores": {
        "beg": { "time": 980, "timeVideoId": 12345, "3bvs": 7289, "3bvsVideoId": 23456 },
        "int": { "time": 10310, "timeVideoId": 12346, "3bvs": 5301, "3bvsVideoId": 23457 },
        "exp": { "time": 37820, "timeVideoId": 12347, "3bvs": 4226, "3bvsVideoId": 23458 },
        "sum": { "time": 49110, "3bvs": 16816 }
      },
      "scoresNf": { },
      "signatures": ["张砷镓", "zsj"] }
  ]
}
```

说明：`banned: true` 的账号不带成绩（与站内「封禁不在榜」口径一致）；`*VideoId` = 0 表示该列无关联录像；`area` 已做合规显示名处理（香港 → 中国香港）。

### 5. 玩家列表（轻量）`GET /api/public/v1/user_list?id=1,2,3`

`id` = 逗号分隔的玩家 ID，最多 100 个。字段同 user_info 但不含 scoresNf / signatures / 逐级录像指针（`scores` 为 8 列合计成绩），适合批量补齐姓名等基础信息的场景。

### 6. 帖子查询 `GET /api/public/v1/post_info?id=1,2,3`

`id` = 逗号分隔的帖子 ID，最多 50 个。返回帖子基本信息（**不含正文**）：标题、分类、发布者、发布时间、更新时间、最后回复时间、评论数、点击数、置顶/加精/锁定状态。只返回正常帖（已删除、待审不返回）；正文请引导用户访问 `https://saolei.wang/bbs/{id}`。

```json
{
  "generatedAt": 1792555560,
  "items": [
    { "id": 362, "title": "扫雷定式及变化", "board": 1,
      "userId": 1, "userName": "张砷镓",
      "postTime": 1181620008, "updateTime": 1201508595, "lastReplyTime": 1637886023,
      "replies": 35, "clicks": 187923,
      "pinned": false, "nice": true, "locked": false }
  ]
}
```

字段：`board` 0=公告 / 1=技术 / 2=杂谈 / 3=问答 · `postTime` 发布时间 · `updateTime` 最后编辑时间（改帖/加精/置顶等写操作，非最后回复）· `lastReplyTime` 最后回复时间 · `pinned` 置顶 · `nice` 加精 · `locked` 锁定。

### 7. 帖子关键词查询 `GET /api/public/v1/post_search?keyword=…&cursor=0`

按关键词匹配帖子**标题**（站内论坛搜索同口径，不含正文与回复），返回前 20 条帖子基本信息（字段同 post_info，不含正文），cursor 断点翻页（id 倒序，新帖在前）。

| 参数 | 说明 |
|---|---|
| `keyword` | 必填，搜索关键词，限 30 字；标题包含匹配，`%` `_` 通配符按字面处理 |
| `cursor` | 上次响应的 `nextCursor`，首次不传；翻页取更早（id 更小）的结果 |

```json
{
  "cursor": 0, "nextCursor": 23979, "hasMore": true,
  "keyword": "扫雷", "size": 20, "generatedAt": 1793089487,
  "items": [
    { "id": 24361, "title": "予我以扫雷——加入竞速扫雷的一些心路历程",
      "board": 2, "userId": 33769, "userName": "孙沁晗",
      "postTime": 1791446702, "updateTime": 1792679104, "lastReplyTime": 1791567522,
      "replies": 14, "clicks": 364,
      "pinned": false, "nice": false, "locked": false }
  ]
}
```

说明：每页固定 20 条；`hasMore=false` 时 `nextCursor` 为 null；只搜正常帖。

### 8. 玩家搜索 `GET /api/public/v1/user_search?keyword=…`（2026-11-09 新增）

按姓名关键词搜索玩家：中文姓名**前缀 / 包含**模糊 + 英文名**前缀**（站内排行搜索框同口径）；纯数字关键词按**玩家 ID 精确匹配**。返回最多 `limit` 条（默认 10，上限 20），封禁账号不返回。

| 参数 | 说明 |
|---|---|
| `keyword` | 必填，搜索关键词，限 12 字 |
| `limit` | 可选，返回条数上限，默认 10，上限 20 |

```json
{
  "generatedAt": 1794310000,
  "keyword": "张",
  "size": 1,
  "users": [
    { "id": 1, "name": "张砷镓", "englishName": "Zhang Shen Jia",
      "area": "陕西",
      "avatar": "https://saolei.wang/images/player/1.jpg",
      "title": "总司令" }
  ]
}
```

字段：`name` 中文姓名 · `englishName` 英文名 · `area` 地区（合规显示名，香港 → 中国香港）· `avatar` 头像完整 URL（**空串 = 无头像**，请用调用方默认图占位）· `title` 军衔制称号（总司令=动态阈值档，与站内榜单徽章同口径）。排序＝上榜者按全国总计时间榜名次序在前，未上榜沉底按 id 升序。

### 9. 排行榜查询 `GET /api/public/v1/ranking?view=…&order=…`（2026-11-09 新增）

覆盖线上排行页除「世界排行」外的全部榜单（站内「加载更多」同一查询函数与排序口径）。每页固定锚点 20 条，`cursor` 整数页码游标翻页（首次不传 = 第 1 页），`size` 可放大本批行数（20–100，页锚点仍按 20）；`hasMore = cursor×20 < total`。

| 参数 | 说明 |
|---|---|
| `view` | `rank` 成绩榜（默认）/ `bv` BV 收集榜 / `stnb` STNB 榜 / `area` 地区榜 |
| `order` | 排序列，随 view 不同（见下） |
| `cursor` | 上次响应的 `nextCursor`，首次不传 |
| `size` | 本批行数，20–100，默认 20 |
| `nf` | `1` = NF（无标雷）榜；仅 rank / bv / stnb 支持 |
| `area` | 限定地区（数据库原值，如 `陕西`）；仅 rank 支持 |

`order` 合法值：

- `rank`：`beg_time` `beg_3bvs` `int_time` `int_3bvs` `exp_time` `exp_3bvs` `sum_time` `sum_3bvs`（缺省 `sum_time`）
- `bv` / `stnb`：`total` `beg` `int` `exp`（缺省 `total`）
- `area`：`activity`（缺省）`power` `players` `active` `best`

**rank 响应示例**（`?view=rank&order=sum_time`）：

```json
{
  "view": "rank", "order": "sum_time", "nf": false,
  "cursor": 1, "nextCursor": 2, "hasMore": true, "total": 7371, "size": 20,
  "generatedAt": 1794310000,
  "rows": [
    { "rank": 1, "id": 18290, "name": "鞠泽恩", "englishName": "", "sex": 1,
      "title": "总司令",
      "scores": { "beg_time": 980, "beg_3bvs": 7289000, "int_time": 10310, "int_3bvs": 5301000,
                  "exp_time": 37820, "exp_3bvs": 4226000, "sum_time": 49110, "sum_3bvs": 16816000 },
      "videos": { "beg_time": 154, "beg_3bvs": 4807, "int_time": 15129, "int_3bvs": 9262,
                  "exp_time": 9195, "exp_3bvs": 8212, "sum_time": 0, "sum_3bvs": 0 },
      "delta": 0,
      "classic": { "name": "雷圣", "color": "#ff0000" } }
  ]
}
```

- `scores` 8 列存储值：time 类=毫秒，3bvs=×1000；`0` 通常=无成绩（初级 3BV/s 有初级时间时为例外零纪录）
- `videos` 各列达成录像 id（`0` = 无；`sum_*` 恒 0）
- `delta` 仅 `order=sum_time` 且无 nf/area 时提供：数字=较昨日升降名次，`null` = 今日新进榜（无基准）
- `title` 军衔制称号（动态阈值总司令口径）；`classic` 旧版称号对（`null` = 未算）
- `area` 参数提供时响应带 `"area": "地区显示名"`，rows 仅该地区人口，无 `delta`

**bv 响应示例**（`?view=bv&order=total`）：rows 每行为 `{ rank, id, name, englishName, sex, title, beg, int, exp, total, classic }`（各级收集数与总计），响应额外带 `den`（各级 3BV 可达区间跨度）与 `totalDen`（进度条分母）。

**stnb 响应示例**（`?view=stnb&order=beg`）：rows 每行为 `{ rank, id, name, englishName, sex, title, beg, int, exp, total, best, classic }`——beg/int/exp=各级历史最高 STNB（1 位小数，0=无有效成绩），total 仅三级齐全时非 0；`best` = `{ beg, int, exp }` 各级最优盘 `{ vid, timeMs, nf, ct }`（null=无；`vid` 可链 `https://saolei.wang/video/{id}`）；响应额外带 `den`（各级全站最高 STNB）与 `totalDen`。

**area 响应示例**（`?view=area&order=activity`）：rows 每行为 `{ rank, area, players, active, power, activity, bestRank, wins7d, videos7d, best: { id, name, englishName, expTime, sumTime } }`——地区维度（非玩家），`best` = 该地区领军人物。

通用说明：聚合榜（bv/stnb）数据源失败时返回 `503`（附 `error` 标识），请调用方退避重试；封禁账号不出现在任何玩家榜（地区榜 `players/active` 口径与站内一致）。

## 三、绑定协议 v2（2026-11-09：跳转确认+回来核销，无服务端互调）

> 双方对齐定案（2026-11-08~09）：绑定流程「一边发起、另一边确认」；确认以登录态授权页完成，取代人工审核。
> **不做 API KEY、不做服务端互调**——凭一次性令牌 + 双方各自公开查询接口完成核验与核销。
> **同步口径：两站各抓各的**（2026-11-10 张老师定）：每站只控制自己方面的抓取，管不到另一方。
> 雷网只存「开源扫雷网录像→雷网」开关（`openms_link.consent`，默认勾选=1），雷网 worker 按它过滤；
> 开源站是否抓取雷网录像由开源站自己决定，雷网不读写、不存储、不向对方发送该设定，
> 雷网提供的 `bind-request` / `links` 等接口均不携带任何反方向开关。

### 3.1 流程

**方向 A：扫雷网发起 → 开源扫雷网授权页确认（主力方向）**

1. 用户在扫雷网账户设置点「绑定开源扫雷网」→ 授权页勾「开源扫雷网录像同步到扫雷网」开关（默认勾选）→ 点「发起绑定」，扫雷网落一行 48 字符一次性 token 的待确认申请（`openms_bind_request`，status=0）
2. 扫雷网**本页不跳转**：在用户点击的同步栈里新开一个标签页加载 `https://openms.top/#/bind/saolei?token=<token>`（开源扫雷网 SPA 为 hash 路由；授权页凭 3.3① 读取申请者信息，用户登录后确认。开源站授权页自身的抓取开关属开源站内部设定，雷网不参与、不感知）
3. 扫雷网发起页同时切为等待态（转圈动画 +「等待开源扫雷网确认授权...」），每 5 秒调一次本站 `POST /api/openms/bind {action:"settle"}`，内部反查开源扫雷网状态 API（见 3.3③）；`status=="confirmed"` 才取回 profile 落 `openms_link` 并把申请置为已核销，其余状态继续等待，申请失效/冲突则终止轮询并提示
4. 核销成功后显示「绑定成功」并返回扫雷网账户管理页 `/account`；开源扫雷网侧凭 `links` 列表（见 3.2②）拿到 profile↔uid 映射，维护本站绑定关系

> 2026-11-10 修订：不再要求用户手动回扫雷网点「完成绑定」，改为新标签页授权 + 发起页自动轮询核销；开源扫雷网授权页确认成功后**无需回跳**，扫雷网靠状态 API 反查即可判定授权结果。settle 只接受申请者本人会话调用。

**方向 B：开源网发起 → 扫雷网授权页确认**

1. 用户在开源站生成一次性 token 并记录申请（profile 关联）
2. 跳转扫雷网授权页 `https://saolei.wang/account/openms/bind?token=<token>`
3. 用户登录扫雷网 → 页面核验 token（调开源站 API，见 3.3①）→ 展示申请者 → 用户勾选「开源扫雷网录像同步到扫雷网」开关（默认勾选）→ 点「确认绑定」→ 扫雷网落绑定关系
4. 开源站侧核销：定时拉 `GET /api/public/v1/openms/links`，出现自己的 profile 即写入本站绑定关系

### 3.2 扫雷网提供的接口（无需 key）

**① `GET /api/public/v1/openms/bind-request?token=<48位hex>`**
开源站授权页展示「谁在申请」用。

```json
{ "status": 0, "uid": 35545, "username": "许欣怡" }
```

`status`：0=待确认 · 1=已核销 · 2=已取消（2/1 时授权页应提示申请已失效）。令牌错误/失效：404。

**② `GET /api/public/v1/openms/links`**
绑定关系列表（开源站维护 link 表 + 方向 B 核销依据）。

```json
{
  "generatedAt": 1794188128,
  "links": [
    { "profile": 103, "uid": 2051, "username": "cphq1" }
  ]
}
```

全量当前 96 人量级，建议 5~10 分钟拉一次。是否抓取某用户的扫雷网录像由开源站自行决定（雷网管不到），本列表不携带任何同步开关。

### 3.3 开源站接口（已实现，随授权页前端同 PR；按其路由惯例挂在 /api/accountlink/saolei/bind/ 下）

**① 申请信息查询（方向 A：开源站授权页展示「谁在申请」用）**
`GET https://openms.top/api/accountlink/saolei/bind/request?token=<token>`

后端代理扫雷网 `bind-request`（3.2①）透传，无需开源站建申请表：

```json
{ "status": 0, "uid": 35545, "username": "许欣怡" }
```

`status` 为扫雷网侧语义（0=待确认 · 1=已核销 · 2=已取消）；token 无效返回 404。方向 B（开源站发起）需要单独的申请表与发起接口，暂未实现——现 `request` 语义已定为透传，方向 B 落地时另定端点。

**② 授权页确认（方向 A：开源站授权页「确认绑定」按钮调用，需登录态）**
`POST https://openms.top/api/accountlink/saolei/bind/confirm`（JSON：`token`、`sync`=开源站自身「是否抓取该用户扫雷网录像」的开关，默认 true；该参数仅由开源站授权页传给开源站后端，属开源站内部设定，雷网不参与、不感知）

行为：后端凭 token 调扫雷网 `bind-request`（3.2①）核验（非 pending 返回 404）并取回 uid → 在同一业务事务内建 `AccountSaolei(id=uid, parent=当前用户, name=扫雷网用户名, auto_sync=sync)` + `AccountLinkQueue(platform=SAOLEI, identifier=uid, verified=True)`（绑定生效判定两行都要有）；同 uid 已被其他开源站用户绑定、或当前用户已绑定其他扫雷网账户返回 409；同一对绑定重复确认幂等（刷新 name/auto_sync）。事务提交后写入本次令牌的确认凭据（含确认者 ID，TTL 24h）。未登录返回 403。

**③ 申请状态查询（方向 A：扫雷网核销用）**
`GET https://openms.top/api/accountlink/saolei/bind/status?token=<token>`

```json
{ "profile": 103, "status": "confirmed" }
```

实现：先按扫雷网 `bind-request` 处理已取消（status=2，直接 pending）；随后读取本次令牌的确认凭据，只有 uid 与远端一致、且 `AccountSaolei(id=uid).parent_id` 仍等于凭据中的确认者 ID 时才返回 `confirmed`（profile=确认者 ID）。历史绑定、换绑后的旧凭据、无凭据的已核销申请均返回 `{ "profile": null, "status": "pending" }`，无需另建申请表。

### 3.4 通用约定（绑定相关）

- token 为 48 位 hex 一次性令牌，重复发起自动顶掉旧申请（旧 token 即失效）
- 绑定关系唯一：一个开源站 profile 只能绑定一个扫雷网账户（冲突时双方各自拒绝并提示）
- 绑定/解绑只影响本站是否抓取（2026-11-08 定案）：解绑需用户在两边分别操作，任一侧保留绑定关系即视为绑定
- 历史存量 96 人由扫雷网直接灌入绑定关系，不走本协议流程

## 四、通用约定

- 所有时间戳均为 Unix 秒；time 类成绩为毫秒（精确到小数点第三位秒），3bvs 为实际值（整数）；展示两位小数时第三位截去不四舍五入（2026-11-04 站内口径）
- 录像文件本体不随 `video_list` 出（列表接口轻量）；需要文件时用 `video_info` 的 `fileUrl` 下载
- 数据仅限站内公开展示口径；**不包含**任何联系方式（QQ/邮箱）、IP、登录时间等隐私字段
- 引用数据时请注明来源：扫雷网 saolei.wang
- 接口变更会尽量保持向后兼容；重大变更提前通知
- 网页回放请引导用户访问 `https://saolei.wang/video/{id}`

## 五、快速验证

```bash
curl -H "X-Api-Key: <你的key>" "https://saolei.wang/api/public/v1/stats"
```

---

**附：站点侧已同步上线反爬措施**（UA 黑名单 + 全站 10r/s + 录像文件 3r/s 限速），页面抓取方式将不可用或极慢，请统一走本 API。

**变更记录**
- 2026-11-10（4）：台账 `openms_video_map` 增加 `attempts` 计数与「放弃」终态（state=3）。临时失败（429/5xx/网络/落库异常）首次后最多再重试 3 次（`--max-retries`），累计 4 次失败即落定放弃、写原因并越过该 ID，避免一条坏录像永久卡住流水线；终态 1/2/3 一律按 video_id 跳过。另：schema 仍保留 `sync_to_openms` 两处字段映射**仅为兼容生产残留列**（代码／API／UI 已零引用）——CI 的 `prisma db push` 遇删列会中止部署、旧 Prisma Client 也会 SELECT 全列；DROP 两列须待新 Client 上线后按「先手工 DROP 生产列、再删 schema 字段」顺序执行。
- 2026-11-10（3）：方向 A 后台录像同步接入对方定稿接口 `GET /api/accountlink/saolei/unmapped_videos?user_id=&cursor=&count=`（cursor 为 **inclusive** 下界、继续须传 last_id+1；`user_id` 为开源站 UserProfile.id，省略会 504；列表限速 1/2s、下载限速 5/m）；雷网新增 `openms_video_map` 台账，扫到的 video_id 一律入库，已有终态（已导入/已拒收）按 ID 过滤不再重复下载。实现见 `scripts/openms-sync-all.ts`。
- 2026-11-10（2）：同步口径定为「两站各抓各的、只控制自己方面的抓取」——摘除雷网侧 `sync_to_openms` 设定（`openms_link` / `openms_bind_request` 两列及全部读写、UI 引导），雷网只保留 `openms_link.consent`；反方向由开源站自行决定，雷网不读写、不存储、不发送。
- 2026-11-10：方向 A 改为「新标签页打开授权页 + 发起页每 5 秒轮询核销」，成功后提示并返回账户管理页；开源扫雷网授权页无需回跳，雷网凭状态 API 反查判定授权结果；settle 增加申请者本人校验。
- 2026-11-09（6）：`video_info.fileUrl` 改为前台同款下载地址 `/video/download/{id}`（不再暴露 `/videos/…` 静态文件直链；GET 语义不变，直接下载文件本体，每次访问计一次下载，限速档由文件静态 3 req/s 改为通用 10 req/s）。
- 2026-11-09（5）：新增 `user_search`（姓名关键词搜玩家，返回 id/name/area/avatar/title）与 `ranking`（view=rank/bv/stnb/area 覆盖除世界排行外全部榜单，20 条/页 cursor 翻页，order/nf/area/size 参数；聚合榜失败 503）。
- 2026-11-09（4）：login 接口改为**需要 X-Api-Key**（张老师定：防止非法客户端借公开端点探测用户密码）；me 及后续用户侧接口仍仅凭 Bearer token。
- 2026-11-09（3）：新增用户登录体系——`POST /api/public/v1/login`（账号密码换 7 天 Bearer token，落库 sha256）+ `GET /api/public/v1/me`（登录态自检）；后续用户侧 API 均凭 `Authorization: Bearer <token>` 鉴权。
- 2026-11-09（2）：绑定协议 v2 修订——同步开关改为**各站落点、默认勾选**：开源网→扫雷网开关在扫雷网授权页（默认勾选），扫雷网→开源网开关在开源站授权页（AccountSaolei.auto_sync，默认 True）；`links` 不再携带 syncToOpenms（开源站按自身 auto_sync 过滤）；开源站契约新增 ③授权页确认接口（confirm）。
- 2026-11-09：新增「三、绑定协议 v2」——绑定流程改版（跳转确认+回来核销）、bind-request/links 两个免 key 接口、开源站侧契约（request/status）；`links.syncToOpenms` 为开源站 worker 抓取过滤依据（默认 0 不抓）。
- 2026-11-04：文档补充时间成绩展示口径说明（两位小数、第三位截去不四舍五入）；接口数据本身无变化（realTime 仍为毫秒整数）。
- 2026-10-27：新增 `post_info`（按 id 查帖子基本信息，不含正文）、`post_search`（标题关键词查询，前 20 条/页 + cursor 翻页）。
- 2026-10-26：`video_list` 不再按审核状态过滤，条目新增 `status` 字段；新增可选参数 `player_id`，用于只拉取指定玩家录像。
- 2026-10-24：`video_info` 新增 `fileUrl` 字段（录像文件完整 URL）。
- 2026-10-24：草案重构。`/api/partner/v1/*` → `/api/public/v1/*`；`videos` → `video_list`、`users` → `user_list`；新增 `video_info`（含重放指标）、`user_info`（双体系成绩+标识列表）、`stats`（站点统计+max id）；key 改为后台签发管理（原 .env 草案 key 过渡期兼容）；草案期 rankings 接口废弃。
