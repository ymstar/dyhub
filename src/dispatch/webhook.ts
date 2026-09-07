/**
 * Webhook 事件投递 —— 面向服务端消费端（BFF / 机器人 / 外部系统）
 *
 * 为每个直播间配置 webhook URL，事件按房间异步 POST 到目标地址。
 * 支持签名（HMAC-SHA256，secret 配置）以校验来源。
 */

import { createHmac } from 'node:crypto';
import { EventBus } from '../pipeline/eventBus.js';
import { eventMatches, type DanmakuEvent, type EventFilter } from '../types/events.js';

export interface WebhookTarget {
  id: string;
  roomId: string;          // 订阅哪个房间（* 表示全部）
  url: string;
  secret?: string;
  types?: string[];        // 订阅哪些事件类型
}

export class WebhookDispatcher {
  private bus: EventBus;
  private targets: WebhookTarget[] = [];
  private busSub: number;
  private delivered = 0;

  constructor(bus: EventBus) {
    this.bus = bus;
    this.busSub = bus.subscribe(undefined, (ev) => this.deliver(ev));
  }

  addTarget(target: WebhookTarget): void {
    this.targets.push(target);
  }

  removeTarget(id: string): void {
    this.targets = this.targets.filter((t) => t.id !== id);
  }

  listTargets(): WebhookTarget[] {
    return this.targets;
  }

  private deliver(ev: DanmakuEvent): void {
    for (const t of this.targets) {
      if (t.roomId !== '*' && t.roomId !== ev.roomId) continue;
      if (t.types && t.types.length && !t.types.includes(ev.type)) continue;
      this.post(t, ev);
    }
  }

  private post(t: WebhookTarget, ev: DanmakuEvent): void {
    const body = JSON.stringify(ev);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (t.secret) {
      const sig = createHmac('sha256', t.secret).update(body).digest('hex');
      headers['X-DyHub-Signature'] = `sha256=${sig}`;
    }
    fetch(t.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    })
      .then((r) => {
        if (r.ok) this.delivered++;
      })
      .catch(() => {
        /* 投递失败静默，可扩展重试/死信 */
      });
  }

  stats() {
    return { targets: this.targets.length, delivered: this.delivered };
  }

  close(): void {
    this.bus.unsubscribe(this.busSub);
  }
}
