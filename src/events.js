import { createHash, randomUUID } from "node:crypto";

import { validateEvent } from "./validator.js";

export function newEventId() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

// 规范哈希：同一来源版本的精确重传据此判定为同一条内容。
export function contentHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

// 构造一条领域事件。version 是聚合流内的序号，由 EventStore.append 在写入时落定。
export function makeEvent({
  eventType,
  aggregateType,
  aggregateId,
  payload,
  at,
  by = null,
  causationId = null,
  correlationId = null,
  summary,
}) {
  const event = {
    event_id: newEventId(),
    event_type: eventType,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: at ?? nowIso(),
    version: 0,
    summary: summary ?? defaultSummary(eventType, aggregateId),
    payload: payload ?? {},
  };
  if (by) event.payload.by = by;
  if (causationId) event.causation_id = causationId;
  if (correlationId) event.correlation_id = correlationId;
  return event;
}

function defaultSummary(eventType, aggregateId) {
  return `${eventType} / ${aggregateId}`;
}

export { validateEvent };
