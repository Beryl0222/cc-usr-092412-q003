import { createHash } from "node:crypto";

/** 领域错误：携带稳定的错误码，便于调用方按码处理而不是匹配文案。 */
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

/** 稳定序列化：对象键排序后输出，同一内容必得同一字符串。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/** 内容指纹：用于识别"同一来源版本的精确重传"与"内容变化"。 */
export function contentHash(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/** 解析 ISO 时间为毫秒；非法输入抛出领域错误而不是静默返回 NaN。 */
export function timestampOf(iso, field = "时间") {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new DomainError("INVALID_TIME", `${field}不是合法的 ISO 时间：${iso}`);
  return ms;
}

/**
 * 只追加的领域事件日志。
 * 记录一经写入不得原地改写；更正只能以新的后继事件进入日志。
 */
export class EventStore {
  #events = [];
  #sequences = new Map();

  append({ event_type, aggregate_type, aggregate_id, occurred_at, summary, data = {} }) {
    const key = `${aggregate_type}:${aggregate_id}`;
    const version = (this.#sequences.get(key) ?? 0) + 1;
    this.#sequences.set(key, version);
    const event = {
      event_id: `evt-${this.#events.length + 1}`,
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at,
      version,
      summary,
      data,
    };
    this.#events.push(event);
    return event;
  }

  all() {
    return this.#events.map((event) => ({ ...event }));
  }

  byAggregate(aggregate_type, aggregate_id) {
    return this.all().filter((event) => event.aggregate_type === aggregate_type && event.aggregate_id === aggregate_id);
  }
}
