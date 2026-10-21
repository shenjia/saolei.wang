# 扫雷网（saolei.wang）数据同步 API 接入文档

> 适用对象：开源扫雷网（openms.top）
> 版本：v1（2026-10-21）
> 基础地址：`https://new.saolei.wang`（正式域名切换为 www.saolei.wang 后地址不变，届时另行通知）

## 一、鉴权

所有请求需携带请求头：

```
X-Api-Key: <你的专用 key>
```

key 由扫雷网签发，请勿泄露、勿提交进公开仓库。丢失或泄露请联系管理员重置。

- 无 key / 错误 key：`401`
- 请求过频：`429`（限 60 次/分钟，按合作方计）
- 建议：全量同步控制在 30 req/min 以内，增量同步每小时一次即可

## 二、接口清单

### 1. 榜单（全量）`GET /api/partner/v1/rankings`

参数：

| 参数 | 说明 |
|---|---|
| `by` | 榜单列：`beg_time` / `beg_3bvs` / `int_time` / `int_3bvs` / `exp_time` / `exp_3bvs` / `sum_time` / `sum_3bvs`（默认 `sum_time`） |
| `view` | `nf` = 无标雷榜；缺省 = 标准榜 |
| `page` | 页码，从 1 起，每页固定 100 条 |

响应示例：

```json
{
  "by": "exp_time", "view": "standard", "page": 1, "size": 100, "total": 7890,
  "generatedAt": 1792555559,
  "rows": [
    { "rank": 1, "id": 18290, "name": "鞠泽恩", "englishName": "Ju Ze En",
      "score": 25100, "videoId": 328090 }
  ]
}
```

字段说明：
- `score`：time 榜为毫秒（如 25100 = 25.10 秒）；3bvs 榜为实际值×1000（显示时除以 1000）
- `videoId`：达成该成绩的录像 ID，0 = 无关联录像
- 与站内 `/ranking` 完全同口径（含封禁账号排除）

全量拉取：对 8 个 `by` × 2 个 `view` 逐个 `page=1..⌈total/100⌉` 循环即可。

### 2. 录像元数据（增量）`GET /api/partner/v1/videos`

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
- 只含过审（status=20）胜局录像；**录像文件本体不提供**，如需回放请链接到 `https://new.saolei.wang/video/{id}`

增量同步建议：记上次 `nextCursor`，每次从断点续拉；上传侧删除/屏蔽的录像会从数据中消失，建议以「全量对账 + 增量追加」组合维护。

### 3. 玩家公开信息 `GET /api/partner/v1/users`

参数：`id` = 逗号分隔的玩家 ID（最多 100 个）

响应示例：

```json
{
  "generatedAt": 1792555560,
  "users": [
    { "id": 1, "name": "张砷镓", "englishName": "Zhang Shen Jia", "sex": 1,
      "area": "陕西", "registeredAt": 1167758493, "banned": false,
      "scores": { "begTime": 980, "beg3bvs": 7289, "intTime": 10310,
                  "int3bvs": 5301, "expTime": 37820, "exp3bvs": 4226,
                  "sumTime": 49110, "sum3bvs": 16816 } }
  ]
}
```

说明：`banned: true` 的账号不带成绩（与站内「封禁不在榜」口径一致）；`area` 已做合规显示名处理（香港 → 中国香港）。

## 三、通用约定

- 所有时间戳均为 Unix 秒
- 数据仅限站内公开展示口径；**不包含**任何联系方式（QQ/邮箱）、IP、登录时间等隐私字段
- 引用数据时请注明来源：扫雷网 saolei.wang
- 接口变更会尽量保持向后兼容；重大变更提前通知
- 本 API 不提供录像文件下载；网页回放请引导用户访问 `https://new.saolei.wang/video/{id}`

## 四、快速验证

```bash
curl -H "X-Api-Key: <你的key>" "https://new.saolei.wang/api/partner/v1/rankings?by=exp_time&page=1"
```

---

**附：站点侧已同步上线反爬措施**（UA 黑名单 + 全站 10r/s + 录像文件 3r/s 限速），页面抓取方式将不可用或极慢，请统一走本 API。
