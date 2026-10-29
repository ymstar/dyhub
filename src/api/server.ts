/**
 * 管理 API —— 中台的控制面
 *
 * REST 接口管理采集会话、Webhook、查看统计；SSE 供实时事件订阅。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { Collector, RoomActionError } from '../collector/collector.js';
import * as cookieStore from '../collector/cookieStore.js';
import * as loginWindow from '../collector/loginWindow.js';
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

/** 发送弹幕后等它出现在推送流里的最长时间 */
const CHAT_ECHO_TIMEOUT_MS = 8000;

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

  app.delete('/api/cookie', async () => {
    cookieStore.clear();
    return { ok: true, ...cookieStore.getStatus() };
  });

  // ---- 网页登录（弹出 Chrome 窗口打开抖音，用户登录后自动写入 cookie）----
  app.post('/api/cookie/login', async () => loginWindow.start());

  app.get('/api/cookie/login', async () => loginWindow.getState());

  app.delete('/api/cookie/login', async () => {
    await loginWindow.cancel();
    return loginWindow.getState();
  });

  // ---- 房间管理 ----
  app.get('/api/rooms', async () => ({ rooms: deps.collector.getRooms() }));

  app.post('/api/rooms/connect', async (req, reply) => {
    const { roomId: rawRoomId, cookie } = (req.body ?? {}) as { roomId?: string; cookie?: string };
    const roomId = normalizeRoomIdInput(rawRoomId);
    if (!roomId) {
      return reply.code(400).send({ error: 'roomId 必须为纯数字（也可直接粘贴 live.douyin.com 直播间链接）' });
    }
    // 传入 cookie 时持久化到 cookieStore，后续重连自动复用
    if (cookie && cookie.trim()) {
      cookieStore.setRoomCookie(roomId, cookie);
    }
    try {
      const info = await deps.collector.connect(roomId, { cookie: cookie?.trim() || undefined });
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

  // ---- 每房间独立 Cookie（多账号多房间互不干扰）----
  app.get('/api/rooms/:roomId/cookie', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
    if (!roomId) return reply.code(400).send({ error: 'roomId 无效' });
    return cookieStore.getRoomCookieStatus(roomId);
  });

  app.put('/api/rooms/:roomId/cookie', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
    if (!roomId) return reply.code(400).send({ error: 'roomId 无效' });
    const { cookie } = (req.body ?? {}) as { cookie?: string };
    if (!cookie || !cookie.trim()) return reply.code(400).send({ error: 'cookie 不能为空' });
    cookieStore.setRoomCookie(roomId, cookie);
    return { ok: true, ...cookieStore.getRoomCookieStatus(roomId) };
  });

  app.delete('/api/rooms/:roomId/cookie', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
    if (!roomId) return reply.code(400).send({ error: 'roomId 无效' });
    cookieStore.clearRoomCookie(roomId);
    return { ok: true };
  });

  // ---- 发送弹幕（以登录账号发言，需浏览器内核 + 网页登录）----
  app.post('/api/rooms/:roomId/chat', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
    const { text: rawText } = (req.body ?? {}) as { text?: unknown };
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (!text) return reply.code(400).send({ error: 'text 必填' });
    // 先订阅再发送，等自己的弹幕从推送流回来，确认抖音收下了
    let subId = 0;
    const echo = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CHAT_ECHO_TIMEOUT_MS);
      subId = deps.bus.subscribe({ roomId, type: 'chat' }, (ev) => {
        if (ev.type === 'chat' && ev.data.content === text) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    try {
      await deps.collector.sendChat(roomId, text);
      const echoed = await echo;
      return { ok: true, echoed };
    } catch (e: any) {
      const code = e instanceof RoomActionError ? e.statusCode : 500;
      return reply.code(code).send({ error: `发送失败: ${e?.message ?? e}` });
    } finally {
      deps.bus.unsubscribe(subId);
    }
  });

  // ---- 直播流地址（浏览器页面播放器请求的 FLV / HLS 地址，可直接给 ffmpeg 拉流）----
  app.get('/api/rooms/:roomId/stream', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
    try {
      const url = deps.collector.getStreamUrl(roomId);
      if (!url) return reply.code(409).send({ error: '播放器尚未请求直播流（可能未开播）' });
      return { url };
    } catch (e: any) {
      const code = e instanceof RoomActionError ? e.statusCode : 500;
      return reply.code(code).send({ error: `获取直播流失败: ${e?.message ?? e}` });
    }
  });

  // ---- 直播画面截图（JPEG）----
  app.get('/api/rooms/:roomId/screenshot', async (req, reply) => {
    const roomId = normalizeRoomIdInput((req.params as { roomId: string }).roomId);
    try {
      const jpeg = await deps.collector.screenshot(roomId);
      return reply.type('image/jpeg').header('Cache-Control', 'no-store').send(jpeg);
    } catch (e: any) {
      const code = e instanceof RoomActionError ? e.statusCode : 500;
      return reply.code(code).send({ error: `截图失败: ${e?.message ?? e}` });
    }
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
    // 订阅房间未活跃时自动触发采集（roomId 为 * 时不针对具体房间，跳过）
    let connecting = false;
    if (roomId !== '*') {
      const info = deps.collector.getRoomInfo(roomId);
      if (!info || info.status === 'stopped') {
        connecting = true;
        deps.collector
          .connect(roomId)
          .catch((e: unknown) =>
            console.error(`[dyhub] webhook 触发房间 ${roomId} 自动连接失败:`, e instanceof Error ? e.message : e),
          );
      }
    }
    return { ok: true, webhook: target, connecting };
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
  registerSseRoute(app, deps.bus, deps.collector);

  return app;
}
