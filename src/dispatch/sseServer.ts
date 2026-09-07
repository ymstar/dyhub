/**
 * SSE 事件分发 —— 面向浏览器等原生支持 EventSource 的消费端
 *
 * 客户端：new EventSource('/api/events?roomId=xxx&types=chat,gift')
 * 服务端将匹配的标准化事件以 SSE 格式推送。
 */

import type { FastifyInstance } from 'fastify';
import { EventBus } from '../pipeline/eventBus.js';
import { eventMatches, type DanmakuEvent, type EventFilter } from '../types/events.js';

export function registerSseRoute(app: FastifyInstance, bus: EventBus): void {
  app.get('/api/events', (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const roomId = query.roomId ?? undefined;
    const types = (query.types ?? '').split(',').filter(Boolean) as any[];
    const filter: EventFilter = { roomId, type: types.length ? types : undefined };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');
    // 心跳（防止代理断开空闲连接）
    const hb = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(':hb\n\n');
    }, 15000);

    const handler = (ev: DanmakuEvent) => {
      if (!eventMatches(ev, filter)) return;
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    const subId = bus.subscribe(undefined, handler);

    req.raw.on('close', () => {
      bus.unsubscribe(subId);
      clearInterval(hb);
    });
    // 阻止 fastify 默认结束响应
    reply.hijack();
    return reply;
  });
}
