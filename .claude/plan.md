# 计划：Dashboard 运行时 Cookie 注入 + 礼物事件修复

## 背景

Issue #1 反馈礼物事件获取不到，需要登录态。根因有二：
1. 轻量内核 wss 握手只发 `ttwid`，登录 cookie 被丢弃；浏览器内核无 cookie 注入路径
2. `GiftMessage` proto 中 `repeat_count`/`combo_count` 声明为 `string`，实际是 `int64`，解码错误

本计划让用户在 Dashboard 填写 cookie（服务启动后、连接房间前），建立连接时注入；同时修正 proto 字段类型。

## 改动清单（5 文件）

### 1. 新建 `src/collector/cookieStore.ts` — 运行时 cookie 存储

模块级单例，两种内核共用：
- 初始化时从 `process.env.DYHUB_COOKIE` 读入
- `setCookie(str)` — 解析 `k=v; k=v` 格式存入 Map
- `getCookieStr()` — 拼成 `k=v; k=v` 用于 HTTP/wss Cookie 头
- `getCookieMap()` — 返回 Map，供浏览器内核逐条注入
- `clear()` — 清空
- `getStatus()` — 返回 `{ set, hasLogin, keys }`，`hasLogin` 检查 `sessionid`/`sessionid_ss`/`sid_tt`/`sid_guard` 是否存在

### 2. 改 `src/collector/lightweightSession.ts` — 发完整 cookie 到 wss

**`ensureSharedCookies()`（~L131-176）**：
- 将 `process.env.DYHUB_COOKIE` 读取改为从 `cookieStore` 读取
- 如果 cookieStore 有 cookie，直接解析进 `sharedJar`，仍自动补 `__ac_signature`（若缺）
- 其余逻辑不变（无 cookie 时走 HTTP cookie 链获取游客 cookie）

**`startInternal()` wss 握手（L332）**：
```diff
- headers: { 'User-Agent': UA, Cookie: `ttwid=${ttwid}` },
+ headers: { 'User-Agent': UA, Cookie: sharedCookieStr() },
```
发送完整 cookie（含登录态），使 webcast 服务端推送礼物事件。

### 3. 改 `src/collector/browser.ts` — 浏览器 context 注入 cookie

**`openRoom()`（~L123-146）**：在 `page.goto()` 之前，从 `cookieStore` 读取 cookie，通过 `context.addCookies()` 注入：
- 解析 cookie 字符串为 `{name, value, domain: '.douyin.com', path: '/'}` 数组
- 注入后页面以登录态加载，页面内 webcast wss 自然携带登录 cookie
- 无 cookie 时跳过注入，行为与当前一致

### 4. 改 `src/api/server.ts` — Cookie 管理 API

新增三个端点：
- `GET /api/cookie` → `{ set, hasLogin, keys }`（不返回 cookie 值，安全）
- `POST /api/cookie` body `{ cookie: string }` → 调 `cookieStore.setCookie()`，返回状态
- `DELETE /api/cookie` → 调 `cookieStore.clear()`，返回状态

### 5. 改 `src/ui/dashboard.html` — Cookie 输入 UI

在侧边栏"连接直播间"上方新增"登录 Cookie"面板：
- `<textarea>` 用于粘贴 cookie（placeholder 提示从浏览器 F12 复制）
- "保存"按钮 → `POST /api/cookie`；"清除"按钮 → `DELETE /api/cookie`
- 状态标签：未设置 / 已设置（游客）/ 已设置（登录态 ✓）
- 一行帮助文字："含 sessionid_ss 等登录 cookie 可获取礼物事件"
- 页面加载时 `GET /api/cookie` 初始化状态

### 6. 改 `src/proto/douyin.proto.ts` — 修正 GiftMessage 字段类型

```diff
 message GiftMessage {
   Common common = 1;
   int64 gift_id = 2;
-  string repeat_count = 5;
-  string combo_count = 6;
+  int64 repeat_count = 5;
+  int64 combo_count = 6;
   User user = 7;
   int32 repeat_end = 9;
   GiftStruct gift = 15;
 }
```

## 验证

- `npm run typecheck` 通过
- 启动后在 Dashboard 填入含 `sessionid_ss` 的 cookie → 状态显示"登录态"
- 连接直播间 → 礼物事件出现在事件流中
- 不填 cookie → 行为不变（游客态，弹幕/进场/点赞正常）
