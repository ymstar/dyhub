/**
 * DyHub 抖音直播弹幕中台 —— 入口
 *
 * 装配：采集内核 → 事件管道（标准化→去重→总线）→ 分发层（WS/SSE/Webhook）→ 管理 API + 控制台
 *
 * 环境变量：
 *   DYHUB_PORT       管理端口（默认 8757）
 *   DYHUB_HOST       监听地址（默认 0.0.0.0）
 *   DYHUB_CHROME     Chrome 可执行文件路径（缺省自动探测）
 */

import { EventBus } from './pipeline/eventBus.js';
import { EventDeduplicator } from './pipeline/dedupe.js';
import { normalize } from './pipeline/normalizer.js';
import { BrowserManager } from './collector/browser.js';
import { Collector } from './collector/collector.js';
import { WsDispatcher } from './dispatch/wsServer.js';
import { WebhookDispatcher } from './dispatch/webhook.js';
import { buildApi } from './api/server.js';

const PORT = Number(process.env.DYHUB_PORT ?? 8757);
const HOST = process.env.DYHUB_HOST ?? '0.0.0.0';
const startedAt = Date.now();

async function main() {
  // 1. 事件管道
  const bus = new EventBus();
  const dedupe = new EventDeduplicator(200_000);

  // 2. 采集内核
  const browser = new BrowserManager({
    executablePath: process.env.DYHUB_CHROME || undefined,
    headless: !process.env.DYHUB_HEADED,
  });
  await browser.init();
  console.log(`[dyhub] 采集浏览器就绪（headless=${!process.env.DYHUB_HEADED}）`);

  const collector = new Collector({
    browser,
    onMessage: (msg, meta) => {
      const ev = normalize(msg, meta);
      if (!ev) return;
      // 去重：未知类型消息量大且易重复，统一过窗口
      if (dedupe.isDuplicate(ev.id)) return;
      bus.publish(ev);
    },
  });

  // 3. 分发层
  const webhooks = new WebhookDispatcher(bus);

  // 4. 管理 API（WS 分发器复用 Fastify 的 HTTP server，先建 app 再绑 ws）
  let wsDispatcher: WsDispatcher | null = null;
  const app = buildApi({
    collector,
    bus,
    wsClientCount: () => wsDispatcher?.clientCount() ?? 0,
    webhookDispatcher: webhooks,
    startedAt,
  });
  wsDispatcher = new WsDispatcher(app.server, bus);

  await app.listen({ port: PORT, host: HOST });
  console.log(`[dyhub] 管理台就绪: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`[dyhub] WS 事件流: ws://localhost:${PORT}/ws?roomId=xxx&types=chat,gift`);
  console.log(`[dyhub] SSE 事件流: http://localhost:${PORT}/api/events?types=chat,gift`);
  console.log(`[dyhub] 连接直播间示例: curl -X POST http://localhost:${PORT}/api/rooms/connect -d '{"roomId":"708764876300"}'`);

  // 5. 优雅退出
  const shutdown = async () => {
    console.log('\n[dyhub] 正在关闭...');
    await collector.disconnectAll();
    wsDispatcher?.close();
    webhooks.close();
    await browser.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[dyhub] 启动失败:', e);
  process.exit(1);
});
