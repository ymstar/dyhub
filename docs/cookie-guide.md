# Cookie 配置指南

## 为什么需要 Cookie

抖音 webcast 推送服务端对不同身份的连接推送不同事件：

| 身份 | 弹幕 | 进场 | 点赞 | 关注 | 房间统计 | **礼物** |
|------|:----:|:----:|:----:|:----:|:-------:|:------:|
| 游客（仅 `ttwid`） | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| 已登录（含 `sessionid_ss`） | ✓ | ✓ | ✓ | ✓ | ✓ | **✓** |

**礼物事件（`WebcastGiftMessage`）只推送给已登录的 WebSocket 连接。** 如果不配置登录态 Cookie，弹幕、进场、点赞等事件正常，但礼物事件不会出现。

此外，轻量内核在容器 / 数据中心 IP 环境下容易被风控拦截，注入浏览器复制的 Cookie 可以绕过。

## 需要哪些 Cookie

一段有效的登录态 Cookie 至少包含以下键：

| Cookie 键 | 作用 | 必需 |
|-----------|------|:----:|
| `ttwid` | 设备追踪标识，wss 握手必需 | ✅ |
| `sessionid_ss` | 登录会话令牌（主） | ✅（获取礼物） |
| `sid_tt` | 登录会话令牌（备） | 可选 |
| `__ac_nonce` | 反爬 nonce，页面加载用 | 可选 |
| `__ac_signature` | 反爬签名，页面加载用 | 可选 |

> 只需要从浏览器复制整行 Cookie 即可，DyHub 会自动解析其中的各个字段。

## 如何获取 Cookie

1. 在浏览器（Chrome / Edge）中打开 [抖音直播](https://live.douyin.com) 并**登录账号**
2. 进入任意直播间页面
3. 按 `F12` 打开开发者工具，切到 **Network** 面板
4. 在地址栏刷新页面，在 Network 列表中找到对 `live.douyin.com` 的请求（或任意 `douyin.com` 域名下的请求）
5. 点击该请求 → **Headers** → 找到 **Request Headers** 中的 `Cookie` 字段
6. **整行复制** Cookie 的值（一长串 `key=value; key=value; ...`）

```
ttwid=xxxxxxxx; sessionid_ss=xxxxxxxx; sid_tt=xxxxxxxx; __ac_nonce=xxxxxxxx; ...
```

> **注意**：Cookie 包含登录凭据，等同于账号会话。请勿公开分享或提交到代码仓库。

## 如何配置

有三种方式，效果相同，按场景选择：

### 方式一：控制台填写（推荐）

服务启动后、连接房间前，在控制台操作：

1. 打开 `http://localhost:8757`
2. 左侧栏「登录 Cookie」面板 → 文本框粘贴 Cookie
3. 点击「保存」
4. 状态标签变为 **已设置（登录态 ✓）** 即可
5. 连接直播间，礼物事件将正常出现

> 支持运行时随时更新：修改 Cookie 后保存，新连接的房间会使用新 Cookie；已连接的房间需断开重连生效。

### 方式二：API 调用

```bash
# 设置 Cookie
curl -X POST http://localhost:8757/api/cookie \
  -H 'Content-Type: application/json' \
  -d '{"cookie":"ttwid=xxx; sessionid_ss=xxx; sid_tt=xxx; ..."}'

# 查看状态（不返回 Cookie 值）
curl http://localhost:8757/api/cookie
# → {"set":true,"hasLogin":true,"keys":["ttwid","sessionid_ss","sid_tt",...]}

# 清除 Cookie
curl -X DELETE http://localhost:8757/api/cookie
```

### 方式三：环境变量（适合 Docker / 无界面部署）

启动前设置 `DYHUB_COOKIE` 环境变量：

```bash
# 本地
DYHUB_COOKIE="ttwid=xxx; sessionid_ss=xxx; sid_tt=xxx" npm run dev

# Docker Compose（docker-compose.yml）
environment:
  DYHUB_COOKIE: "ttwid=xxx; sessionid_ss=xxx; sid_tt=xxx"

# Docker run
docker run -d -p 8757:8757 -e DYHUB_COOKIE="ttwid=xxx; sessionid_ss=xxx" dyhub
```

> 环境变量在启动时读入。如需运行时更新，用方式一或方式二。

## 两种采集内核的注入方式

| 内核 | 注入方式 |
|------|---------|
| **轻量内核**（`DYHUB_COLLECTOR=lightweight`） | Cookie 拼入 wss 握手 HTTP 头，webcast 服务端据此判断登录态并推送礼物事件 |
| **浏览器内核**（`DYHUB_COLLECTOR=browser`，默认） | Cookie 通过 `context.addCookies` 注入浏览器上下文，页面以登录态加载，页面内 webcast wss 自动携带登录 Cookie |

两种内核均支持上述三种配置方式。

## 常见问题

**Q：保存了 Cookie 但礼物事件还是不出现？**

- 确认状态标签显示「登录态 ✓」而非「游客」——说明 Cookie 中含 `sessionid_ss` 等登录键
- 确认直播间确实有观众在送礼
- Cookie 可能已过期，重新从浏览器复制
- 断开房间重新连接，Cookie 变更对已连接的房间不自动生效

**Q：Cookie 会过期吗？**

会。抖音登录态有效期通常数天到数周，过期后需重新获取。过期的表现是：弹幕正常但礼物消失，或连接被拒。

**Q：不配置 Cookie 能用吗？**

能。游客态下弹幕、进场、点赞、关注、房间统计均正常，仅礼物事件不推送。不需要礼物的场景无需配置。

**Q：Cookie 安全吗？**

Cookie 包含登录凭据，等同于账号会话权限。DyHub 的 `GET /api/cookie` 只返回键名列表和状态，不返回 Cookie 值。请勿将含 Cookie 的配置文件提交到 Git 仓库。
