---
name: dyhub
description: DyHub 抖音直播弹幕采集与分发中台对接指南。当用户需要采集抖音直播弹幕、连接直播间、监听弹幕/礼物/进场/点赞/关注事件、或通过 REST API / WebSocket / SSE / Webhook 消费弹幕数据时使用。触发词：dyhub、抖音弹幕、直播弹幕、弹幕采集、弹幕中台、danmaku、live stream chat。
---

# DyHub — 抖音直播弹幕采集与分发中台

## DyHub 是什么

DyHub 是一个**抖音直播弹幕采集与分发中台**。它连接抖音直播间，实时采集弹幕、礼物、进场、点赞、关注等事件，归一化为统一的 `DanmakuEvent` 格式，再通过 WebSocket / SSE / Webhook 三通道分发给下游消费端。

核心价值：**上游抖音改协议不碰消费端，下游只认一种事件协议。**

```
抖音直播间 → 采集内核 → 标准化 → 去重 → EventBus → WS / SSE / Webhook → 你的 Agent
```

### 事件类型一览

| 类型 | 说明 | 关键字段 |
|---|---|---|
| `chat` | 弹幕评论 | `data.content` |
| `gift` | 礼物 | `data.giftName`, `data.diamondCount`, `data.repeatCount` |
| `member` | 进场 | `data.memberCount` |
| `like` | 点赞 | `data.count`, `data.total` |
| `follow` | 关注 | `data.action` |
| `room` | 房间统计 | `data.total`, `data.popularity` |
| `unknown` | 未识别消息（透传） | `data.method`, `data.payloadBase64` |

---

## 安装与启动

### 方式一：本地运行（开发）

```bash
git clone <repo-url> && cd dyhub
npm install
npm run dev          # 开发模式（tsx 直接运行，免编译）
```

### 方式二：Docker 部署（生产，推荐）

```bash
docker compose up -d --build   # 内置 Chromium + 中文字体
```

### 方式三：编译后运行

```bash
npm install
npm run build        # 编译 TS + 拷贝 UI
npm start            # node dist/index.js
```

启动后管理台默认在 `http://localhost:8757`。

### 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DYHUB_PORT` | 管理端口 | `8757` |
| `DYHUB_HOST` | 监听地址 | `0.0.0.0` |
| `DYHUB_CHROME` | Chrome 路径 | 自动探测 |
| `DYHUB_HEADED` | `1`/`true` 开有头浏览器（调试） | 无头 |
| `DYHUB_COLLECTOR` | `browser`（默认，最稳）/ `lightweight`（纯代码直连） | `browser` |
| `DYHUB_COOKIE` | 直接注入 cookie，绕过自动获取 | 无 |

---

## Agent 对接指南

### 第一步：确认 DyHub 已运行

```bash
curl http://localhost:8757/api/stats
```

返回 JSON 即正常。如果连接失败，先启动 DyHub。

### 第二步：选择对接模式

根据 Agent 的运行环境选择最合适的模式：

| 模式 | 适合场景 | 实时性 | 复杂度 |
|---|---|---|---|
| **Webhook 推送** | Agent 有 HTTP 端点（服务器/Bot） | 实时 | 最低 |
| **WebSocket 订阅** | Agent 是长连接客户端 | 实时 | 低 |
| **SSE 订阅** | Agent 是浏览器/EventSource | 实时 | 低 |
| **REST 轮询** | Agent 只能发 HTTP 请求 | 近实时 | 中 |

---

### 模式一：Webhook 推送（推荐 — 事件面）

Agent 启动一个 HTTP 端点接收事件，DyHub 主动推送。

**1. Agent 侧准备 HTTP 端点**（示例：监听 `/dyhub-events`）：

```javascript
// Agent 侧伪代码
app.post('/dyhub-events', (req, res) => {
  // 可选：验证签名
  if (req.headers['x-dyhub-signature']) {
    const sig = req.headers['x-dyhub-signature']; // "sha256=<hex>"
    const expected = 'sha256=' + hmacSha256(SECRET, req.rawBody, 'hex');
    if (sig !== expected) return res.status(401).send('invalid signature');
  }
  const event = req.body;  // DanmakuEvent JSON
  handleEvent(event);
  res.send('ok');
});
```

**2. 注册 Webhook 到 DyHub**：

```bash
curl -X POST http://localhost:8757/api/webhooks \
  -H 'Content-Type: application/json' \
  -d '{
    "roomId": "708764876300",
    "url": "https://your-agent.com/dyhub-events",
    "secret": "your-hmac-secret",
    "types": ["chat", "gift"]
  }'
```

- `roomId`：`"*"` 表示订阅所有房间
- `types`：省略则订阅全部类型
- `secret`：设置后 DyHub 会用 HMAC-SHA256 签名，头 `X-DyHub-Signature: sha256=<hex>`
- 注册后如果房间未连接，DyHub **自动触发连接**

**3. 收到的事件格式**：

```json
{
  "id": "7234abc",
  "roomId": "708764876300",
  "platform": "douyin",
  "type": "chat",
  "ts": 1716960000000,
  "receivedAt": 1716960000050,
  "user": { "id": "123456", "nickname": "张三", "avatar": "https://..." },
  "data": { "content": "主播好厉害" }
}
```

---

### 模式二：WebSocket 订阅

适合 Agent 作为长连接客户端直接消费事件流。

```javascript
const ws = new WebSocket('ws://localhost:8757/ws?roomId=708764876300&types=chat,gift');

ws.on('message', (data) => {
  const event = JSON.parse(data);
  // 控制帧：__hello / __connecting / __connected / __error
  if (event.type.startsWith('__')) {
    console.log('控制帧:', event.type);
    return;
  }
  // 业务事件
  handleEvent(event);
});
```

- 连接时先收到 `__hello`，然后是 `__connecting` → `__connected`（或 `__error`）
- 房间未活跃时**自动触发连接**
- `types` 省略则接收全部类型

---

### 模式三：SSE 订阅

适合浏览器环境或支持 EventSource 的客户端。

```javascript
const es = new EventSource('http://localhost:8757/api/events?roomId=708764876300&types=chat,gift');

es.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if (event.type.startsWith('__')) return;  // 控制帧
  handleEvent(event);
};
```

---

### 模式四：REST 轮询（控制面）

用 REST API 控制采集，适合不需要实时事件的场景。

```bash
# 连接房间
curl -X POST http://localhost:8757/api/rooms/connect \
  -H 'Content-Type: application/json' \
  -d '{"roomId": "708764876300"}'

# 查看房间状态
curl http://localhost:8757/api/rooms/708764876300

# 查看统计
curl http://localhost:8757/api/stats

# 断开房间（保留态，可快速恢复）
curl -X POST http://localhost:8757/api/rooms/708764876300/disconnect

# 彻底删除房间
curl -X DELETE http://localhost:8757/api/rooms/708764876300
```

---

## REST API 完整参考

> Base URL: `http://localhost:8757`
> 所有 POST/PUT/DELETE body 为 JSON，Content-Type: application/json

### 房间管理

| 方法 | 路径 | 说明 | Body / Query |
|---|---|---|---|
| `GET` | `/api/rooms` | 列出所有已连接房间 | — |
| `POST` | `/api/rooms/connect` | 连接直播间 | `{roomId, cookie?}` |
| `GET` | `/api/rooms/:roomId` | 查看房间详情 | — |
| `POST` | `/api/rooms/:roomId/disconnect` | 断开（保留态） | — |
| `DELETE` | `/api/rooms/:roomId` | 彻底删除 | — |

- `roomId` 支持纯数字、直播间 URL（`live.douyin.com/123`）、全角数字
- `cookie` 可选，传入后持久化，后续重连自动复用

### Cookie 管理

| 方法 | 路径 | 说明 | Body |
|---|---|---|---|
| `GET` | `/api/cookie` | 全局 cookie 状态 | — |
| `POST` | `/api/cookie` | 设置全局 cookie | `{cookie, persist?}` |
| `DELETE` | `/api/cookie` | 清除全局 cookie | — |
| `GET` | `/api/rooms/:roomId/cookie` | 房间 cookie 状态 | — |
| `PUT` | `/api/rooms/:roomId/cookie` | 设置房间独立 cookie | `{cookie}` |
| `DELETE` | `/api/rooms/:roomId/cookie` | 清除房间 cookie | — |

- 全局 cookie 是默认/回退；房间独立 cookie 优先级更高
- 有登录态 cookie（含 `sessionid` 等）才能收到礼物事件
- `persist=true` 写入磁盘，Docker 重启后自动恢复

### Webhook 管理

| 方法 | 路径 | 说明 | Body |
|---|---|---|---|
| `GET` | `/api/webhooks` | 列出所有 webhook | — |
| `POST` | `/api/webhooks` | 添加 webhook | `{roomId, url, secret?, types?}` |
| `DELETE` | `/api/webhooks/:id` | 删除 webhook | — |

### 统计

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/stats` | 运行时统计（uptime、事件数、连接数、房间状态） |

### 事件流

| 协议 | 路径 | 参数 |
|---|---|---|
| WebSocket | `ws://host:port/ws` | `?roomId=&types=chat,gift` |
| SSE | `GET /api/events` | `?roomId=&types=chat,gift` |

---

## DanmakuEvent 事件协议

所有事件共享基础字段：

```typescript
{
  id: string;           // 稳定事件 ID（去重/幂等用）
  roomId: string;       // 房间号（web_rid，用户可识别的短号）
  platform: "douyin";   // 平台标识
  type: string;         // 事件类型
  ts: number;           // 事件发生时间（毫秒）
  receivedAt: number;   // 中台接收时间（毫秒）
  user?: {              // 发送者
    id: string;
    nickname: string;
    avatar?: string;
    secUid?: string;
  };
  rawMethod?: string;   // 原始消息方法名（调试用）
}
```

### 各类型 data 字段

**chat（弹幕）**
```json
{ "data": { "content": "主播好厉害" } }
```

**gift（礼物）**
```json
{
  "data": {
    "giftId": "1",
    "giftName": "小心心",
    "giftIcon": "https://p3.douyinpic.com/...",
    "diamondCount": 1,
    "repeatCount": 5,
    "comboCount": 5,
    "groupCount": 1,
    "repeatEnd": true,
    "groupId": "abc123",
    "combo": true
  }
}
```

**member（进场）**
```json
{ "data": { "memberCount": 1500 } }
```

**like（点赞）**
```json
{ "data": { "count": 1, "total": 9999 } }
```

**follow（关注）**
```json
{ "data": { "action": 1 } }
```

**room（房间统计）**
```json
{ "data": { "total": 1500, "popularity": 8000, "totalUser": 50000 } }
```

---

## 常见 Agent 工作流

### 工作流 1：AI 自动回复弹幕

```
1. [REST]  连接房间 → POST /api/rooms/connect
2. [Webhook] 注册 webhook → POST /api/webhooks（types: ["chat"]）
3. [Agent]  收到 chat 事件 → LLM 分析 → 生成回复 → 调用平台 API 发送
```

### 工作流 2：实时情感分析

```
1. [REST]  连接房间 → POST /api/rooms/connect
2. [Webhook] 注册 webhook → POST /api/webhooks（types: ["chat"]）
3. [Agent]  收到 chat 事件 → 情感打分 → 聚合统计 → 输出报告
```

### 工作流 3：礼物感谢自动化

```
1. [REST]  设置登录 cookie → POST /api/cookie（含 sessionid）
2. [REST]  连接房间 → POST /api/rooms/connect
3. [Webhook] 注册 webhook → POST /api/webhooks（types: ["gift"]）
4. [Agent]  收到 gift 事件 → 匹配话术模板 → 自动感谢
```

### 工作流 4：多房间巡检

```
1. [REST]  批量连接 → 多次 POST /api/rooms/connect
2. [WebSocket] 连接 ws://host/ws?types=chat（不指定 roomId，收全部）
3. [Agent]  按事件 roomId 分流处理
4. [REST]  巡检完毕 → 逐个 POST /api/rooms/:roomId/disconnect
```

### 工作流 5：弹幕 moderation

```
1. [REST]  连接房间
2. [Webhook] 注册 webhook（types: ["chat"]）
3. [Agent]  收到 chat → 检测违规/ spam → 告警或调用平台禁言 API
```

---

## Cookie 获取方法

礼物事件需要登录态 cookie。获取方式：

1. 浏览器打开 `live.douyin.com`，登录抖音
2. F12 → Application → Cookies → 复制全部 cookie
3. 注入 DyHub：

```bash
curl -X POST http://localhost:8757/api/cookie \
  -H 'Content-Type: application/json' \
  -d '{"cookie": "ttwid=xxx; sessionid=yyy; ...", "persist": true}'
```

也可为单个房间设置独立 cookie（多账号多房间互不干扰）：

```bash
curl -X PUT http://localhost:8757/api/rooms/708764876300/cookie \
  -H 'Content-Type: application/json' \
  -d '{"cookie": "ttwid=aaa; sessionid=bbb; ..."}'
```

---

## 采集内核选择

| 内核 | 环境变量 | 特点 | 适用场景 |
|---|---|---|---|
| `browser`（默认） | `DYHUB_COLLECTOR=browser` | 真实浏览器 + CDP 帧截获，最稳、抗风控 | 生产环境、长期运行 |
| `lightweight` | `DYHUB_COLLECTOR=lightweight` | 纯代码 wss 直连，连接快、零浏览器进程 | 低资源环境、短期采集 |

容器 IP 易被风控时，用 `browser` 内核或通过 `DYHUB_COOKIE` 直接注入 cookie。

---

## 控制帧说明

WebSocket / SSE 连接时会先收到控制帧（`type` 以 `__` 开头）：

| 控制帧 | 说明 |
|---|---|
| `__hello` | WS 连接成功（仅 WebSocket） |
| `__connecting` | 房间正在自动连接 |
| `__connected` | 房间已连接，即将开始推送事件 |
| `__error` | 房间连接失败（随后 WS 会关闭） |

Agent 处理事件时应跳过控制帧：`if (event.type.startsWith('__')) return;`

---

## 故障排查

| 问题 | 原因 | 解决 |
|---|---|---|
| 连接房间失败 | 直播间未开播 / roomId 错误 | 确认直播间在线，roomId 为纯数字 |
| 收不到礼物事件 | 无登录态 cookie | 设置含 `sessionid` 的 cookie |
| 轻量内核被风控 | 容器 IP 被抖音限流 | 切换 `DYHUB_COLLECTOR=browser` 或注入 `DYHUB_COOKIE` |
| Docker Chromium 崩溃 | 共享内存不足 | 确认 `--shm-size=2g`（compose 已内置） |
| 签名失效 | 抖音更新签名算法 | 更新 `third_party/douyin-sign/` 或回退 browser 内核 |

---

## 安装本 Skill

### 全局安装（所有项目可用）

```bash
cp -r .claude/skills/dyhub ~/.claude/skills/dyhub
```

### 项目内安装

Skill 已在 `.claude/skills/dyhub/` 目录，Claude Code 自动加载项目内 Skill。

### 验证安装

在 Claude Code 中输入 `/skills` 或直接提到 dyhub / 抖音弹幕，Skill 应自动触发。
