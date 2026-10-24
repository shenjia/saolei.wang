# 扫雷网（saolei.wang）开放 API 接入文档

> 适用对象：外部机器人 / 数据同步服务（首批 openms.top）
> 版本：v1（2026-10-24，取代 2026-10-21 未启用的 partner 草案）
> 基础地址：`https://saolei.wang`（2026-10-25 已正式切换主域，旧 new.saolei.wang 整体 301 到此，请接入方更新）

## 一、鉴权

所有请求需携带请求头：

```
X-Api-Key: <你的专用 key>
```

key 由扫雷网管理员在后台签发（格式 `sk-…`），请勿泄露、勿提交进公开仓库。丢失或泄露请联系管理员重新签发。

- 无 key / 错误 key：`401`
- 请求过频：`429`（限 60 次/分钟，按合作方计）
- 建议：全量同步控制在 30 req/min 以内，增量同步每小时一次即可

## 二、接口清单

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
| `size` | 每页条数，默认 200，上限 1000 |

响应示例：

```json
{
  "cursor": 0, "nextCursor": 25, "hasMore": true, "size": 2,
  "generatedAt": 1792555559,
  "items": [
    { "id": 24, "level": "beg", "userId": 1, "userName": "张砷镓",
      "hash": "4cd9e3e261f76888be8d8919f06d0428",
      "uploadTime": 1167978360, "reviewTime": 1167978403,
      "realTime": 1110, "board3bv": 4, "3bvs": -3604,
      "nf": true, "software": "Clone", "version": "0.97" }
  ]
}
```

字段说明：
- `realTime` 毫秒；`3bvs` 已按站内口径算好（`ROUND(board_3bv×1e6/real_time)`），**负值 = 运气盘**（初级 3BV<10、中高级 3BV<4），成绩不被站内承认，建议同步侧同样标注或排除
- `nf`：true = 无标雷（NF）录像
- 只含过审（status=20）胜局录像；**录像文件本体不提供**，如需回放请链接到 `https://saolei.wang/video/{id}`

增量同步建议：记上次 `nextCursor`，每次从断点续拉；上传侧删除/屏蔽的录像会从数据中消失，建议以「全量对账 + 增量追加」组合维护。用 `stats` 接口的 `maxVideoId` 确定抓取上界。

### 3. 录像详情（含重放指标）`GET /api/public/v1/video_info?id=1,2,3`

`id` = 逗号分隔的录像 ID，最多 50 个。返回录像全部**已落盘公开数据**：video_list 全部字段 + `status`（10=待审 / 20=已通过）+ `signature`（录像内嵌玩家标识）+ `metrics`（离线重放引擎算得的落盘指标）+ `fileUrl`（录像文件完整 URL）。

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
      "fileUrl": "https://saolei.wang/videos/2025/09/28/xxx.evf",
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
- `fileUrl` = 录像文件（MVF/EVF 等）完整下载地址，直接 GET 即得文件本体（`application/octet-stream`）；注意全站对该类静态文件限速 3 req/s，批量拉取请自行排队，勿并发打爆
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

## 三、通用约定

- 所有时间戳均为 Unix 秒；time 类成绩为毫秒，3bvs 为实际值（整数）
- 录像文件本体不随 `video_list` 出（列表接口轻量）；需要文件时用 `video_info` 的 `fileUrl` 下载
- 数据仅限站内公开展示口径；**不包含**任何联系方式（QQ/邮箱）、IP、登录时间等隐私字段
- 引用数据时请注明来源：扫雷网 saolei.wang
- 接口变更会尽量保持向后兼容；重大变更提前通知
- 网页回放请引导用户访问 `https://saolei.wang/video/{id}`

## 四、快速验证

```bash
curl -H "X-Api-Key: <你的key>" "https://saolei.wang/api/public/v1/stats"
```

---

**附：站点侧已同步上线反爬措施**（UA 黑名单 + 全站 10r/s + 录像文件 3r/s 限速），页面抓取方式将不可用或极慢，请统一走本 API。

**变更记录**
- 2026-10-24：`video_info` 新增 `fileUrl` 字段（录像文件完整 URL）。
- 2026-10-24：草案重构。`/api/partner/v1/*` → `/api/public/v1/*`；`videos` → `video_list`、`users` → `user_list`；新增 `video_info`（含重放指标）、`user_info`（双体系成绩+标识列表）、`stats`（站点统计+max id）；key 改为后台签发管理（原 .env 草案 key 过渡期兼容）；草案期 rankings 接口废弃。
