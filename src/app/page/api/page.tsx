// 开放 API 说明页（2026-10-24）
// 站内对外入口：footer「开放API」链到本页。内容与 docs/partner-api-openms.md 同源，
// 面向想接入的第三方开发者（机器人 / 数据同步服务）。
// 2026-10-24 二轮（张老师要求）：每个接口详细列出输入参数表 + 响应示例（JSON），
// 页面自足可读，不必跳 GitHub；接口区块用 <details> 折叠（默认展开，长页可收起）。

import Link from "next/link";

export const metadata = { title: "开放 API" };

interface ParamDoc {
  name: string;
  required?: boolean;
  desc: string;
}

interface ApiDoc {
  path: string;
  title: string;
  desc: string;
  params: ParamDoc[];
  request: string;
  response: string;
  notes?: string[];
}

const APIS: ApiDoc[] = [
  {
    path: "/api/public/v1/stats",
    title: "站点统计",
    desc: "首页「站点统计」版块同口径数据 + 两个最大 ID（确定增量抓取范围、减少试探请求用）。无参数。",
    params: [],
    request: "GET /api/public/v1/stats",
    response: `{
  "generatedAt": 1792555559,
  "stats": {
    "userTotal": 34085,
    "rankedTotal": 7371,
    "videoTotal": 307494,
    "videoCommentTotal": 54198,
    "bbsTopicTotal": 2839,
    "bbsReplyTotal": 17949,
    "practiceTotal": 3163
  },
  "maxVideoId": 345159,
  "maxUserId": 35488
}`,
    notes: [
      "userTotal 注册人数（排除封禁）· rankedTotal 排行人数（有成绩且未封禁）· videoTotal 录像数（待审+已通过）",
      "maxVideoId / maxUserId 供增量抓取定位上界",
    ],
  },
  {
    path: "/api/public/v1/video_list",
    title: "录像列表（增量同步）",
    desc: "按录像 id 升序分页拉取，只含过审（status=20）胜局录像；cursor 断点续拉。配合 stats.maxVideoId 可做「全量对账 + 增量追加」。",
    params: [
      { name: "cursor", desc: "上次响应的 nextCursor，首次不传" },
      { name: "since", desc: "Unix 秒，跳过该时间之前上传的（仅首次全量可选用；与 cursor 同给时 cursor 优先）" },
      { name: "level", desc: "beg / int / exp，缺省 = 全部" },
      { name: "size", desc: "每页条数，默认 200，上限 1000" },
    ],
    request: "GET /api/public/v1/video_list?cursor=0&size=2",
    response: `{
  "cursor": 0,
  "nextCursor": 25,
  "hasMore": true,
  "size": 2,
  "generatedAt": 1792555559,
  "items": [
    {
      "id": 24,
      "level": "beg",
      "userId": 1,
      "userName": "张砷镓",
      "hash": "4cd9e3e261f76888be8d8919f06d0428",
      "uploadTime": 1167978360,
      "reviewTime": 1167978403,
      "realTime": 1110,
      "board3bv": 4,
      "3bvs": -3604,
      "nf": true,
      "software": "Clone",
      "version": "0.97"
    }
  ]
}`,
    notes: [
      "realTime 毫秒；3bvs 已按站内口径算好（ROUND(board_3bv×1e6/real_time)），负值 = 运气盘（初级 3BV<10、中高级 3BV<4），成绩不被站内承认",
      "nf: true = 无标雷（NF）录像；列表不含录像文件，需要文件用 video_info 的 fileUrl，网页回放链到 https://saolei.wang/video/{id}",
    ],
  },
  {
    path: "/api/public/v1/video_info",
    title: "录像详情（含重放指标 + 录像文件 URL）",
    desc: "返回录像全部已落盘公开数据：video_list 全部字段 + status + signature（录像内嵌玩家标识）+ metrics（离线重放引擎算得的落盘指标）+ fileUrl（录像文件完整 URL）。",
    params: [{ name: "id", required: true, desc: "逗号分隔的录像 ID，最多 50 个" }],
    request: "GET /api/public/v1/video_info?id=328090",
    response: `{
  "generatedAt": 1792555559,
  "items": [
    {
      "id": 328090,
      "level": "exp",
      "userId": 18290,
      "userName": "鞠泽恩",
      "hash": "6d58634fbe0987003dda90f4a68944a7",
      "status": 20,
      "uploadTime": 1753974216,
      "reviewTime": 1754020972,
      "realTime": 25100,
      "board3bv": 123,
      "3bvs": 4900,
      "nf": false,
      "fileUrl": "https://saolei.wang/videos/2025/07/31/6d58634fbe0987003dda90f4a68944a7.avf",
      "software": "Arbiter",
      "version": "0.52",
      "signature": "Ju Ze En",
      "metrics": {
        "cl": 150,
        "clLeft": 95,
        "clRight": 22,
        "clDouble": 33,
        "ce": 124,
        "path": 363,
        "ioe": 0.82,
        "stnb": 223.3
      }
    }
  ]
}`,
    notes: [
      "status：10=待审 / 20=已通过（屏蔽 0 不返回）",
      "fileUrl：录像文件（MVF/EVF 等）完整下载地址，直接 GET 即得文件本体；该类文件全站限速 3 次/秒，批量拉取请自行排队",
      "metrics：cl 总点击（左+右+双）· ce 有效点击 · path 鼠标行程（16px/格折算）· ioe 效率（3BV/总点击）· stnb 判雷指标；null = 该录像重放指标尚未落盘",
      "点击计数为站内 flop 引擎口径，与其他站点的派生口径可能不同，请勿混用",
    ],
  },
  {
    path: "/api/public/v1/user_info",
    title: "玩家详情",
    desc: "公开信息 + 双体系成绩（标准 / NF，各级 time、3bvs 附达成录像 ID）+ 录像标识列表。",
    params: [{ name: "id", required: true, desc: "逗号分隔的玩家 ID，最多 50 个" }],
    request: "GET /api/public/v1/user_info?id=1",
    response: `{
  "generatedAt": 1792555560,
  "users": [
    {
      "id": 1,
      "name": "张砷镓",
      "englishName": "Zhang Shen Jia",
      "sex": 1,
      "area": "陕西",
      "registeredAt": 1167758493,
      "banned": false,
      "scores": {
        "beg": { "time": 980, "timeVideoId": 154, "3bvs": 7289, "3bvsVideoId": 4807 },
        "int": { "time": 10310, "timeVideoId": 15129, "3bvs": 5301, "3bvsVideoId": 9262 },
        "exp": { "time": 37820, "timeVideoId": 9195, "3bvs": 4226, "3bvsVideoId": 8212 },
        "sum": { "time": 49110, "3bvs": 16816 }
      },
      "scoresNf": {
        "beg": { "time": 980, "timeVideoId": 154, "3bvs": 5614, "3bvsVideoId": 8079 },
        "int": { "time": 11540, "timeVideoId": 9428, "3bvs": 4601, "3bvsVideoId": 12093 },
        "exp": { "time": 52220, "timeVideoId": 10614, "3bvs": 3720, "3bvsVideoId": 16200 },
        "sum": { "time": 64740, "3bvs": 13835 }
      },
      "signatures": ["张砷镓", "zsj"]
    }
  ]
}`,
    notes: [
      "banned: true 的账号不带成绩（与站内「封禁不在榜」口径一致）",
      "*VideoId = 0 表示该列无关联录像；area 已做合规显示名处理（香港 → 中国香港）",
      "signatures 为该玩家自注册的录像签名归属（本站特有数据）",
    ],
  },
  {
    path: "/api/public/v1/user_list",
    title: "玩家列表（轻量）",
    desc: "批量补齐玩家基础信息的轻量版：字段同 user_info 但不含 scoresNf / signatures / 逐级录像指针（scores 为 8 列合计成绩）。",
    params: [{ name: "id", required: true, desc: "逗号分隔的玩家 ID，最多 100 个" }],
    request: "GET /api/public/v1/user_list?id=1,2",
    response: `{
  "generatedAt": 1792555560,
  "users": [
    {
      "id": 1,
      "name": "张砷镓",
      "englishName": "Zhang Shen Jia",
      "sex": 1,
      "area": "陕西",
      "registeredAt": 1167758493,
      "banned": false,
      "scores": {
        "begTime": 980,
        "beg3bvs": 7289,
        "intTime": 10310,
        "int3bvs": 5301,
        "expTime": 37820,
        "exp3bvs": 4226,
        "sumTime": 49110,
        "sum3bvs": 16816
      }
    }
  ]
}`,
  },
];

export default function ApiPage() {
  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>开放 API</h1>
        <p>
          扫雷网对外提供结构化数据接口，供机器人、数据分析等第三方服务接入。
          所有接口均需凭 <b>API Key</b> 调用，请勿抓取站内页面（已有限速与反爬措施，页面抓取方式不可用或极慢）。
        </p>

        <h2>申请 Key</h2>
        <p>
          API Key 由站长签发。请通过站内私信、论坛或 QQ 群联系管理员，
          说明你的项目用途与合作方名称，审核通过后即可获得专用 Key（格式 <code>sk-…</code>）。
          Key 请妥善保管，请勿泄露或提交进公开仓库；丢失可联系重签。
        </p>

        <h2>调用方式</h2>
        <p>所有请求携带请求头：</p>
        <pre className="api_code">
          <code>X-Api-Key: 你的key</code>
        </pre>
        <ul className="api_brief">
          <li>无 Key / 错误 Key：<code>401</code>；请求过频：<code>429</code>（限 60 次/分钟，按合作方计）</li>
          <li>全量同步建议控制在 30 次/分钟以内；增量同步每小时一次即可</li>
          <li>所有时间戳均为 Unix 秒；time 类成绩为毫秒，3bvs 为实际值（整数）</li>
          <li>数据仅限公开展示口径，不含任何联系方式、IP 等隐私字段</li>
          <li>引用数据时请注明来源：扫雷网 saolei.wang</li>
        </ul>

        <h2>接口详情</h2>
        {APIS.map((api) => (
          <details key={api.path} className="api_endpoint" open>
            <summary>
              <span className="api_method">GET</span>
              <code>{api.path}</code>
              <span className="api_ep_title">{api.title}</span>
            </summary>
            <div className="api_ep_body">
              <p className="api_ep_desc">{api.desc}</p>

              <div className="api_sub">输入参数{api.params.length === 0 ? "：无" : ""}</div>
              {api.params.length > 0 && (
                <table className="api_table">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>参数</th>
                      <th style={{ width: 60 }}>必填</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {api.params.map((p) => (
                      <tr key={p.name}>
                        <td>
                          <code>{p.name}</code>
                        </td>
                        <td>{p.required ? "是" : "否"}</td>
                        <td>{p.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="api_sub">请求示例</div>
              <pre className="api_code">
                <code>{api.request}</code>
              </pre>

              <div className="api_sub">返回示例</div>
              <pre className="api_code">
                <code>{api.response}</code>
              </pre>

              {api.notes && (
                <ul className="api_brief">
                  {api.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        ))}

        <p>
          快速验证：
          <code>curl -H &quot;X-Api-Key: 你的key&quot; https://saolei.wang/api/public/v1/stats</code>
        </p>

        <hr />
        <Link href="/page/about" className="button">
          了解本站
        </Link>
      </div>
    </div>
  );
}
