import { DIMENSION_VALUES, dimensionAggregateId } from "./contracts.js";
import { makeEvent } from "./events.js";

// 五个裁决维度各自独立版本化：医院编码、国家目录项、地方限定、计价单位、适用人群。
// 每个业务键（refId）是一个聚合流；每次发布产生新的 revision，旧 revision 永久保留，
// 已结算记录固定引用 revision 号，永不被新版本覆盖。

function aggregateTypeFor(dimension) {
  // 地方限定按省级支付政策落地，聚合类型沿用契约中的 provincial_item。
  if (dimension === "local_restriction") return "provincial_item";
  return dimension;
}

function replay(events) {
  const state = {
    dimension: null,
    refId: null,
    draft: null,
    revisions: new Map(), // revision -> { revision, content, publishedAt, by, retiredAt }
    currentRevision: null,
    retired: false,
    version: events.length,
  };
  for (const e of events) {
    const p = e.payload;
    state.dimension = p.dimension;
    state.refId = p.ref_id;
    if (e.event_type === "DIMENSION_VERSION_DRAFTED") {
      state.draft = { content: p.content, draftedAt: e.occurred_at, by: p.by ?? null };
    } else if (e.event_type === "DIMENSION_VERSION_PUBLISHED") {
      state.revisions.set(p.revision, {
        revision: p.revision,
        content: p.content,
        publishedAt: e.occurred_at,
        by: p.by ?? null,
        reason: p.reason ?? null,
        retiredAt: null,
      });
      state.currentRevision = p.revision;
      state.draft = null;
    } else if (e.event_type === "DIMENSION_VERSION_RETIRED") {
      const rev = state.revisions.get(p.revision ?? state.currentRevision);
      if (rev) rev.retiredAt = e.occurred_at;
      if ((p.revision ?? state.currentRevision) === state.currentRevision) state.retired = true;
    }
  }
  return state;
}

export class DimensionRegistry {
  constructor(store) {
    this.store = store;
  }

  #load(dimension, refId) {
    return replay(this.store.loadStream(dimensionAggregateId(dimension, refId)));
  }

  // 登记草案：内容进入事件流但尚不可用于裁决与结算。
  draft({ dimension, refId, content, by, at }) {
    assertDimension(dimension);
    assertRefId(refId);
    assertContent(content);
    const aggregateId = dimensionAggregateId(dimension, refId);
    const expected = this.store.streamVersion(aggregateId);
    const state = this.#load(dimension, refId);
    if (state.currentRevision !== null) {
      throw new Error("该维度项已发布过版本，新版本请使用 publishRevision");
    }
    const event = makeEvent({
      eventType: "DIMENSION_VERSION_DRAFTED",
      aggregateType: aggregateTypeFor(dimension),
      aggregateId,
      at,
      by,
      payload: { dimension, ref_id: refId, content },
      summary: `登记${dimension}草案 ${refId}`,
    });
    return this.store.append(event, expected);
  }

  // 发布（或再版）。revision 由已发布次数推出，禁止跳号、禁止改旧版。
  publishRevision({ dimension, refId, content, by, at, reason = null }) {
    assertDimension(dimension);
    assertRefId(refId);
    assertContent(content);
    const aggregateId = dimensionAggregateId(dimension, refId);
    const state = this.#load(dimension, refId);
    // 旧版本可已停用（作废），新版本照常接替；停用不抹除历史 revision。
    const revision = state.currentRevision === null ? 1 : state.currentRevision + 1;
    const event = makeEvent({
      eventType: "DIMENSION_VERSION_PUBLISHED",
      aggregateType: aggregateTypeFor(dimension),
      aggregateId,
      at,
      by,
      payload: { dimension, ref_id: refId, revision, content, reason },
      summary:
        revision === 1
          ? `首发${dimension} ${refId}@r1`
          : `再版${dimension} ${refId}@r${revision}（r${revision - 1}成为历史版本）`,
    });
    return this.store.append(event, state.version);
  }

  retire({ dimension, refId, revision = null, by, at, reason }) {
    const aggregateId = dimensionAggregateId(dimension, refId);
    const state = this.#load(dimension, refId);
    if (state.currentRevision === null) throw new Error("维度项尚未发布，无法停用");
    const target = revision ?? state.currentRevision;
    if (!state.revisions.has(target)) throw new Error(`版本不存在：r${target}`);
    const event = makeEvent({
      eventType: "DIMENSION_VERSION_RETIRED",
      aggregateType: aggregateTypeFor(dimension),
      aggregateId,
      at,
      by,
      payload: { dimension, ref_id: refId, revision: target, reason },
      summary: `停用${dimension} ${refId}@r${target}：${reason}`,
    });
    return this.store.append(event, state.version);
  }

  getEntry(dimension, refId) {
    const state = this.#load(dimension, refId);
    if (state.version === 0) return null;
    return state;
  }

  // 读取精确历史版本：已结算记录固定的就是这个返回。
  getRevision(dimension, refId, revision) {
    const state = this.#load(dimension, refId);
    const rev = state.revisions.get(revision);
    return rev ? { ...rev, content: structuredClone(rev.content) } : null;
  }

  current(dimension, refId) {
    const state = this.#load(dimension, refId);
    if (state.currentRevision === null) return null;
    return this.getRevision(dimension, refId, state.currentRevision);
  }
}

function assertDimension(dimension) {
  if (!DIMENSION_VALUES.includes(dimension)) throw new Error(`未知裁决维度：${dimension}`);
}

function assertRefId(refId) {
  if (typeof refId !== "string" || refId.length === 0) throw new Error("ref_id 必须是非空字符串");
}

function assertContent(content) {
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("维度内容必须是对象");
  }
}
