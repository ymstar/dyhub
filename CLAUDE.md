# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

DyHub 是抖音直播弹幕采集与分发中台。双采集内核（浏览器 CDP 旁观 + 纯代码直连）产出统一 `DanmakuEvent`，经管道（标准化→去重→总线）后通过 WebSocket / SSE / Webhook 三通道分发。上游改协议不碰消费端，下游只认一种事件协议。

## 常用命令

```bash
npm install              # 安装依赖
npm run dev              # 开发模式（tsx 直接运行 TS，免编译）
npm run build            # 编译 TS + 拷贝 UI 到 dist/
npm start                # 生产模式（node dist/index.js）
npm run typecheck        # 仅类型检查，不产出文件
```

Docker 部署：

```bash
docker compose up -d --build   # 一键启动（内置 Chromium + 中文字体）
```

无测试框架；验证改动靠 `npm run typecheck` + 启动后连接直播间观察控制台事件流。

## 架构

### 主数据流

```
采集内核 → normalize() → dedupe → EventBus → WS/SSE/Webhook 分发
```

入口 `src/index.ts` 装配整条链路。采集内核产出 `RawProtoMessage`，经 `normalize()` 翻译为 `DanmakuEvent`，去重后发布到 `EventBus`，三个分发器各自订阅总线并按 filter 推送给消费端。

### 分层职责

- **`src/types/events.ts`** — 统一事件协议（`DanmakuEvent` 联合类型）。这是消费端唯一依赖；改协议只影响此文件 + normalizer。
- **`src/proto/douyin.proto.ts`** — protobuf 解码器。帧结构：`PushFrame → gzip 解压 → Response → Message[]`。用 `protobufjs` 内联定义 schema（非 .proto 文件），`pako` 解压。`decodeFrame` / `decodeMessageBody` / `decodeAckInfo` 三个导出函数分别用于帧解码、消息体解码、ack 信息提取。
- **`src/collector/`** — 采集层。`Collector` 是门面，管理多房间会话的生命周期（connect / disconnect 保留 / removeRoom 彻底删除）。两种内核实现同一 `SessionLike` 接口：
  - `browser.ts` + `liveSession.ts` — 浏览器内核（默认）：`BrowserManager` 启动系统 Chrome（playwright-core），每房间开一个 page，通过 CDP `Network.webSocketFrameReceived` 旁观弹幕 wss 帧。无头模式需点击手势触发播放器初始化。
  - `lightweightSession.ts` — 轻量内核：纯代码直连 wss。链路为 cookie 三件套 → room_id 解析 → a_bogus/X-Bogus 签名 → wss 直连 → 心跳(5s)+ack。签名脚本在 `third_party/douyin-sign/`（AGPL，通过 `vm` 沙箱加载，勿修改）。
  - `roomMeta.ts` — 主播信息解析，从直播间 HTML 提取昵称/头像/标题，仅供展示，失败不影响采集。
- **`src/pipeline/`** — 事件管道。
  - `normalizer.ts` — 翻译层：按 `method` 匹配 `WebcastChatMessage` / `WebcastGiftMessage` 等，映射为统一事件。未识别消息透传为 `unknown` 类型。**抖音改协议只影响此文件及解码器**。
  - `dedupe.ts` — 基于事件 id 的滑动窗口去重（容量 200k）。
  - `eventBus.ts` — 发布/订阅总线，解耦采集与消费。订阅者带 `EventFilter`（按 roomId / type 过滤）。
- **`src/dispatch/`** — 分发层。三个分发器各自订阅 EventBus：
  - `wsServer.ts` — WebSocket 实时推送（`/ws?roomId=&types=`），复用 Fastify 的 HTTP server。
  - `sseServer.ts` — SSE 推送（`/api/events?roomId=&types=`），15s 心跳防代理断开。
  - `webhook.ts` — Webhook 投递，HMAC-SHA256 签名（`X-DyHub-Signature` 头），5s 超时。
- **`src/api/server.ts`** — Fastify 管理 API（控制面）。房间管理、Webhook 管理、统计、SSE 路由注册、控制台静态资源。`normalizeRoomIdInput` 兼容全角数字 / 直播间 URL / 噪声输入。
- **`src/ui/dashboard.html`** — 控制台单页应用（纯 HTML，无框架）。

### 关键设计决策

- **roomId 统一为 web_rid**（用户可识别的房间短号），非消息体内的内部 webcast roomId。避免房间管理与订阅过滤失配。事件 `roomId` 取自采集会话的 `meta.roomId`，不取消息体。
- **两种内核产出相同的 `RawProtoMessage`**，管道与分发层无感知。切换内核只需改 `DYHUB_COLLECTOR` 环境变量。
- **轻量内核共享 cookie**（模块级 `sharedJar`，TTL 15min），多房间并发只跑一次 cookie 链，避免高频请求触发风控。`DYHUB_COOKIE` 环境变量可直接注入浏览器复制的 cookie，绕过 cookie 链请求（解决容器 IP 被风控）。
- **Cookie 持久化**（`cookieStore.ts`）：Dashboard 勾选"记住我"后 cookie 写入 `data/cookie.json`，Docker 重新部署后自动恢复，直到过期或手动清除。启动时 `DYHUB_COOKIE` 环境变量优先于磁盘文件。解析器同时支持 Cookie 请求头（`k=v; k=v`）与 Set-Cookie 响应头（含 `Expires`/`Max-Age`）两种格式，后者可提取并展示过期时间。
- **ESM 项目**（`"type": "module"`），所有内部 import 用 `.js` 扩展名（NodeNext moduleResolution 要求）。TypeScript 7 + Node ≥ 20。
- **`long` 库处理 protobuf 64 位整数**，`longToStr()` 工具函数避免精度丢失，所有 id 字段用字符串。

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DYHUB_PORT` | 管理端口 | `8757` |
| `DYHUB_HOST` | 监听地址 | `0.0.0.0` |
| `DYHUB_CHROME` | Chrome/Chromium 路径 | 自动探测 |
| `DYHUB_HEADED` | `1`/`true` 开有头浏览器（调试） | 无头 |
| `DYHUB_COLLECTOR` | `browser`（默认）/ `lightweight` | `browser` |
| `DYHUB_COOKIE` | 轻量内核直用 cookie（`ttwid=…; __ac_nonce=…`） | 自动获取 |

### 扩展点

- **多平台**：新增 `collector/<platform>.ts` 实现 `SessionLike` 接口，复用同一事件协议与分发层。`DanmakuEvent.platform` 字段已预留。
- **新事件类型**：在 `types/events.ts` 加类型 → `normalizer.ts` 加 case → 消费端即可使用。
- **新分发通道**：订阅 `EventBus`，按 `EventFilter` 过滤推送。

## 注意事项

- `third_party/douyin-sign/` 下的 `a_bogus.js` / `sign.js` 为 AGPL-3.0 第三方资产，通过 `vm` 沙箱加载执行，**不修改、不并入 MIT 代码**。抖音签名算法更新失效时，更新这两个文件或回退 `DYHUB_COLLECTOR=browser`。
- `spike/` 为本地研究脚本（含真实抓包参数），已 gitignore，不入库。
- Docker 部署需 `--shm-size=2g`（Chromium 渲染依赖共享内存），compose 已内置。
- `DYHUB_HEADED` 仅当显式等于 `1`/`true` 时开有头；不能用 `!process.env.DYHUB_HEADED` 判断（字符串 `"0"`/`"false"` 也是 truthy）。
