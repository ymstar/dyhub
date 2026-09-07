/**
 * 事件去重器 —— 防止同一消息被重复投递（重连补拉 / 多路采集场景）
 *
 * 基于事件 id（平台 msgId）的滑动窗口去重。简单高效，适合单机高吞吐场景。
 */

export class EventDeduplicator {
  private seen = new Set<string>();
  private queue: string[] = [];
  private readonly capacity: number;

  constructor(capacity = 100000) {
    this.capacity = capacity;
  }

  /** 返回 true 表示事件已见过（应丢弃） */
  isDuplicate(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.queue.push(id);
    if (this.queue.length > this.capacity) {
      const oldest = this.queue.shift()!;
      this.seen.delete(oldest);
    }
    return false;
  }

  reset(): void {
    this.seen.clear();
    this.queue = [];
  }
}
