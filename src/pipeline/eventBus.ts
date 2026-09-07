/**
 * 事件总线 —— 中台的"神经系统"
 *
 * 订阅者（WebSocket 分发 / SSE / Webhook / 未来的规则引擎、AI、游戏）通过
 * subscribe(filter, handler) 订阅标准化事件流。解耦采集与消费。
 */

import { eventMatches, type DanmakuEvent, type EventFilter } from '../types/events.js';

type Handler = (ev: DanmakuEvent) => void;

export class EventBus {
  private subscribers = new Map<number, { filter?: EventFilter; handler: Handler }>();
  private nextId = 1;
  private totalPublished = 0;

  subscribe(filter: EventFilter | undefined, handler: Handler): number {
    const id = this.nextId++;
    this.subscribers.set(id, { filter, handler });
    return id;
  }

  unsubscribe(id: number): void {
    this.subscribers.delete(id);
  }

  publish(ev: DanmakuEvent): void {
    this.totalPublished++;
    for (const { filter, handler } of this.subscribers.values()) {
      if (eventMatches(ev, filter)) {
        try {
          handler(ev);
        } catch {
          /* 订阅者异常不影响总线 */
        }
      }
    }
  }

  stats() {
    return { subscribers: this.subscribers.size, totalPublished: this.totalPublished };
  }
}
