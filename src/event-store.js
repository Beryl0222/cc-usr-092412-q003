import { validateEvent } from "./validator.js";

export class ConcurrencyError extends Error {
  constructor(aggregateId, expected, actual) {
    super(`聚合 ${aggregateId} 版本冲突：期望 ${expected}，实际 ${actual}`);
    this.name = "ConcurrencyError";
    this.expectedVersion = expected;
    this.actualVersion = actual;
  }
}

export class InvalidEventError extends Error {
  constructor(errors) {
    super(`事件未通过信封校验：${errors.join("；")}`);
    this.name = "InvalidEventError";
    this.errors = errors;
  }
}

// 仅追加事件存储。记录一经接收，event_id / occurred_at / version 不得原地改写；
// 所有状态都从事件流重放得到，更正只能追加后继事件。
export class EventStore {
  #streams = new Map();
  #all = [];
  #idIndex = new Set();

  // expectedVersion 为聚合当前已知版本号（0 表示新聚合），乐观并发控制。
  append(event, expectedVersion) {
    const stream = this.#streams.get(event.aggregate_id) ?? [];
    const currentVersion = stream.length;
    if (expectedVersion !== currentVersion) {
      throw new ConcurrencyError(event.aggregate_id, expectedVersion, currentVersion);
    }

    // 版本号由存储按序落定，随后再做信封校验。
    const stored = { ...event, version: currentVersion + 1 };
    const errors = validateEvent(stored);
    if (errors.length > 0) throw new InvalidEventError(errors);
    if (this.#idIndex.has(stored.event_id)) {
      throw new InvalidEventError([`event_id 重复：${stored.event_id}`]);
    }

    stream.push(stored);
    this.#streams.set(event.aggregate_id, stream);
    this.#all.push(stored);
    this.#idIndex.add(stored.event_id);
    return stored;
  }

  appendAll(events, expectedVersion) {
    if (events.length === 0) return [];
    // 同一聚合的一批事件整体提交：逐条按序落版本号，任何一条失败整批不落（调用方先自行校验）。
    const aggregateId = events[0].aggregate_id;
    if (events.some((e) => e.aggregate_id !== aggregateId)) {
      throw new InvalidEventError(["一批事件必须属于同一聚合"]);
    }
    const draft = events.map((event, index) => ({ ...event, version: expectedVersion + index + 1 }));
    for (const event of draft) {
      const errors = validateEvent(event);
      if (errors.length > 0) throw new InvalidEventError(errors);
      if (this.#idIndex.has(event.event_id)) throw new InvalidEventError([`event_id 重复：${event.event_id}`]);
    }
    const current = (this.#streams.get(aggregateId) ?? []).length;
    if (expectedVersion !== current) throw new ConcurrencyError(aggregateId, expectedVersion, current);

    const stream = this.#streams.get(aggregateId) ?? [];
    for (const event of draft) {
      stream.push(event);
      this.#all.push(event);
      this.#idIndex.add(event.event_id);
    }
    this.#streams.set(aggregateId, stream);
    return draft;
  }

  loadStream(aggregateId) {
    return (this.#streams.get(aggregateId) ?? []).map((e) => ({ ...e, payload: { ...e.payload } }));
  }

  aggregateIds(prefix = null) {
    const ids = [...this.#streams.keys()];
    return prefix === null ? ids : ids.filter((id) => id.startsWith(prefix));
  }

  streamVersion(aggregateId) {
    return (this.#streams.get(aggregateId) ?? []).length;
  }

  // 截至某时刻的全部事件（审计/时间旅行重放用）。
  loadAll(asOf = null) {
    const events = asOf === null ? this.#all : this.#all.filter((e) => e.occurred_at <= asOf);
    return events.map((e) => ({ ...e, payload: { ...e.payload } }));
  }
}
