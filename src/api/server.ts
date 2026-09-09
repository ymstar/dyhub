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
import * as cookieStore from '../collector/cookieStore.js';
import { EventBus } from '../pipeline/eventBus.js';
import { WebhookDispatcher } from '../dispatch/webhook.js';
import { registerSseRoute } from '../dispatch/sseServer.js';

/**
 * 房间号归一化：兼容全角数字（中文输入法）、直接粘贴的直播间 URL、
 * 空格 / 零宽字符等噪声；返回纯 ASCII 数字串（无法识别时返回空串）。
 */
function normalizeRoomIdInput(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  // 全角数字 ０-９ → 半角
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 粘贴了直播间链接：取 live.douyin.com/<数字> 尾号
  const fromUrl = s.match(/live\.douyin\.com\/(\d+)/);
  if (fromUrl) return fromUrl[1];
  // 其余只保留数字
  return s.replace(/\D/g, '');
}

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

  // ---- Cookie 管理（运行时注入登录态，使礼物事件可获取）----
  app.get('/api/cookie', async () => cookieStore.getStatus());

  app.post('/api/cookie', async (req, reply) => {
    const { cookie, persist } = (req.body ?? {}) as { cookie?: string; persist?: boolean };
    if (!cookie || !cookie.trim()) return reply.code(400).send({ error: 'cookie 不能为空' });
    cookieStore.setCookie(cookie, { persist: persist ?? false });
    return { ok: true, ...cookieStore.getStatus() };
  });

  app.delete('/api/cookie', async () => {
    cookieStore.clear();
    return { ok: true, ...cookieStore.getStatus() };
  });

  // ---- 房间管理 ----
  app.get('/api/rooms', async () => ({ rooms: deps.collector.getRooms() }));

  app.post('/api/rooms/connect', async (req, reply) => {
    const { roomId: rawRoomId } = (req.body ?? {}) as { roomId?: string };
    const roomId = normalizeRoomIdInput(rawRoomId);
    if (!roomId) {
      return reply.code(400).send({ error: 'roomId 必须为纯数字（也可直接粘贴 live.douyin.com 直播间链接）' });
    }
    try {
      const info = await deps.collector.connect(roomId);
      return { ok: true, room: info };
    } catch (e: any) {
      return reply.code(500).send({ error: `连接失败: ${e?.message ?? e}` });
    }
  });

  app.post('/api/rooms/:roomId/disconnect', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
    await deps.collector.disconnect(roomId);
    return { ok: true };
  });

  app.delete('/api/rooms/:roomId', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
    await deps.collector.removeRoom(roomId);
    return { ok: true };
  });

  app.get('/api/rooms/:roomId', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
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
