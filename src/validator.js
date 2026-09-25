import { AGGREGATE_TYPES, EVENT_TYPES } from "./contracts.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// 信封级校验：结构、枚举、时间格式、版本号。负载校验由各聚合模块负责，
// 以保证机器候选与人工签署的约束在领域层强制，而不是由数据格式兜住。
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if (errors.length > 0) return errors;

  if (!EVENT_TYPES.includes(record.event_type)) errors.push(`event_type 不在契约枚举内：${record.event_type}`);
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`aggregate_type 不在契约枚举内：${record.aggregate_type}`);
  if (typeof record.event_id !== "string" || record.event_id.length === 0) errors.push("event_id 必须是非空字符串");
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0) errors.push("aggregate_id 必须是非空字符串");
  if (typeof record.summary !== "string" || record.summary.length === 0) errors.push("summary 必须是非空字符串");
  if (!Number.isInteger(record.version) || record.version < 1) errors.push("version 必须是正整数");
  if (typeof record.occurred_at !== "string" || !ISO_DATE_TIME.test(record.occurred_at)) {
    errors.push("occurred_at 必须是带时区偏移的 ISO-8601 日期时间");
  } else if (Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 无法解析为有效时间");
  }
  if ("payload" in record && (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload))) {
    errors.push("payload 必须是对象");
  }
  if ("causation_id" in record && (typeof record.causation_id !== "string" || record.causation_id.length === 0)) {
    errors.push("causation_id 必须是非空字符串");
  }
  if ("correlation_id" in record && (typeof record.correlation_id !== "string" || record.correlation_id.length === 0)) {
    errors.push("correlation_id 必须是非空字符串");
  }
  return errors;
}
