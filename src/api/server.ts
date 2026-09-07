/**
 * 管理 API —— 中台的控制面
 *
 * REST 接口管理采集会话、Webhook、查看统计；SSE 供实时事件订阅。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { Collector } from '../collector/collector.js';
import { EventBus } from '../pipeline/eventBus.js';
import { WebhookDispatcher } from '../dispatch/webhook.js';
import { registerSseRoute } from '../dispatch/sseServer.js';

export interface ApiDeps {
  collector: Collector;
  bus: EventBus;
  wsClientCount: () => number;
  webhookDispatcher: WebhookDispatcher;
  startedAt: number;
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // 控制台静态资源
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
  app.register(fastifyStatic, { root: uiDir, prefix: '/', index: ['dashboard.html'] });
  app.get('/', (_req, reply) => reply.sendFile('dashboard.html'));

  // ---- 房间管理 ----
  app.get('/api/rooms', async () => ({ rooms: deps.collector.getRooms() }));

  app.post('/api/rooms/connect', async (req, reply) => {
    const { roomId } = (req.body ?? {}) as { roomId?: string };
    if (!roomId || !/^\d+$/.test(roomId)) {
      return reply.code(400).send({ error: 'roomId 必须为数字' });
    }
    try {
      const info = await deps.collector.connect(roomId);
      return { ok: true, room: info };
    } catch (e: any) {
      return reply.code(500).send({ error: `连接失败: ${e?.message ?? e}` });
    }
  });

  app.post('/api/rooms/:roomId/disconnect', async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    await deps.collector.disconnect(roomId);
    return { ok: true };
  });

  app.get('/api/rooms/:roomId', async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const info = deps.collector.getRoomInfo(roomId);
    if (!info) return reply.code(404).send({ error: '房间未连接' });
    return { room: info };
  });

  // ---- Webhook 管理 ----
  app.get('/api/webhooks', async () => ({ webhooks: deps.webhookDispatcher.listTargets() }));

  app.post('/api/webhooks', async (req, reply) => {
    const { roomId, url, secret, types } = (req.body ?? {}) as {
      roomId?: string;
      url?: string;
      secret?: string;
      types?: string[];
    };
    if (!roomId || !url) return reply.code(400).send({ error: 'roomId 与 url 必填' });
    const target = {
      id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      roomId,
      url,
      secret,
      types,
    };
    deps.webhookDispatcher.addTarget(target);
    return { ok: true, webhook: target };
  });

  app.delete('/api/webhooks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    deps.webhookDispatcher.removeTarget(id);
    return { ok: true };
  });

  // ---- 统计 ----
  app.get('/api/stats', async () => ({
    uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
    bus: deps.bus.stats(),
    wsClients: deps.wsClientCount(),
    webhooks: deps.webhookDispatcher.stats(),
    rooms: deps.collector.getRooms().map((r) => ({
      roomId: r.roomId,
      status: r.status,
      msgCount: r.stats.msgCount,
      meta: r.meta ?? null,
    })),
  }));

  // ---- SSE 实时事件（/api/events?roomId=&types=chat,gift）----
  registerSseRoute(app, deps.bus);

  return app;
}
