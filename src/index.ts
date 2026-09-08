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
  // DYHUB_COLLECTOR=browser（默认）：真实浏览器 + CDP 帧截获，最稳、抗风控（需系统 Chrome/Chromium）
  // DYHUB_COLLECTOR=lightweight：纯代码 wss 直连，连接快、零浏览器进程，但数据中心/容器 IP 易被风控
  const kernel = (process.env.DYHUB_COLLECTOR ?? 'browser').toLowerCase();

  let collector: Collector;
  let browser: BrowserManager | null = null;
  if (kernel === 'lightweight') {
    const { LightweightSession } = await import('./collector/lightweightSession.js');
    collector = new Collector({
      createSession: (roomId) =>
        new LightweightSession(roomId, {
          onMessage: (msg, meta) => {
            const ev = normalize(msg, meta);
            if (!ev) return;
            if (dedupe.isDuplicate(ev.id)) return;
            bus.publish(ev);
          },
          onError: (err) => console.error(`[dyhub] 房间 ${roomId} 采集错误:`, err.message),
        }),
      onMessage: () => {},
    });
    console.log('[dyhub] 采集内核: lightweight（纯代码直连，连接快 / 低资源）');
  } else {
    // DYHUB_HEADED：仅当显式等于 "1" / "true"（不区分大小写）时开启有头模式，其余一律无头。
    // 注意不能用 !process.env.DYHUB_HEADED：环境变量字符串 "0" / "false" 也是 truthy，会误开有头导致无 XServer 崩溃。
    const headed = ['1', 'true'].includes((process.env.DYHUB_HEADED ?? '').trim().toLowerCase());
    browser = new BrowserManager({
      executablePath: process.env.DYHUB_CHROME || undefined,
      headless: !headed,
    });
    await browser.init();
    console.log(`[dyhub] 采集内核: browser（headless=${!headed}）`);
    collector = new Collector({
      browser,
      onMessage: (msg, meta) => {
        const ev = normalize(msg, meta);
        if (!ev) return;
        if (dedupe.isDuplicate(ev.id)) return;
        bus.publish(ev);
      },
    });
  }

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
    await browser?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[dyhub] 启动失败:', e);
  process.exit(1);
});
