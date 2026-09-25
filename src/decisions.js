import { SIGN_ROLE_VALUES, SIGN_ROLES } from "./contracts.js";
import { contentHash, makeEvent } from "./events.js";

// mapping_decision 聚合：一条裁决把"医院编码 → 国家目录项 + 地方支付结论"固定下来，
// 绑定五维精确版本，经编码专家与支付政策人员双职责签署后，在生效区间内有效。
//
// 关键不变量：
// 1. 机器相似度只能产出候选证据（CANDIDATE_SUGGESTED / MAPPING_PROPOSED.candidates）；
// 2. 缺任一职责签署不得激活；冲突候选只标记（MAPPING_CONFLICT_FLAGGED），当前结论不被覆盖；
// 3. 紧急停用（MAPPING_HALTED）只阻断尚未结算的请求，事件流与已结算引用不动；
// 4. 更正以差异进入争议（MAPPING_DISPUTE_OPENED），复核通过后另立后继并关闭旧区间（MAPPING_CORRECTED）。

export function decisionAggregateId(decisionId) {
  return `mapping_decision:${decisionId}`;
}

export function replayDecision(events) {
  const state = {
    decisionId: null,
    status: "new", // new | proposed | active | dispute | halted | superseded | corrected
    version: events.length,
    selector: null, // { province, hospital_ref, pricing_unit_ref, population_ref }
    mapping: null, // { national_ref, conclusion, billing_category, notes }
    boundRevisions: null, // 五维精确版本快照
    effectiveFrom: null,
    effectiveTo: null,
    candidates: [], // 候选证据（机器 + 人工录入均可）
    signatures: [], // [{ role, by, at, note }]
    conflicts: [], // 对当前结论的冲突候选（仅记录，不覆盖）
    disputes: [], // 争议/差异事件
    halt: null, // { at, by, reason }
    successorId: null,
    correctionOf: null,
    chain: [], // 更正链上先后出现的 decisionId
    source: null, // { source_system, source_version, content_hash, import_batch_id, line_key }
    diffs: [],
  };

  for (const e of events) {
    const p = e.payload;
    state.decisionId = p.decision_id ?? state.decisionId;
    switch (e.event_type) {
      case "CANDIDATE_SUGGESTED":
        state.candidates.push(...(p.candidates ?? []));
        break;
      case "MAPPING_PROPOSED":
        state.status = "proposed";
        state.selector = { ...p.selector };
        state.mapping = { ...p.mapping };
        state.boundRevisions = { ...p.bound_revisions };
        state.effectiveFrom = p.effective_from;
        state.effectiveTo = p.effective_to ?? null;
        state.source = p.source ?? null;
        state.correctionOf = p.correction_of ?? null;
        state.candidates.push(...(p.candidates ?? []));
        if (p.correction_of) state.chain.push(p.correction_of);
        state.chain.push(state.decisionId);
        break;
      case "MAPPING_SIGNED":
        state.signatures = state.signatures.filter((s) => s.role !== p.role);
        state.signatures.push({ role: p.role, by: p.by, at: e.occurred_at, note: p.note ?? null });
        break;
      case "MAPPING_ACTIVATED":
        state.status = "active";
        state.effectiveFrom = p.effective_from ?? state.effectiveFrom;
        state.effectiveTo = p.effective_to ?? null;
        break;
      case "MAPPING_CONFLICT_FLAGGED":
        state.conflicts.push({
          at: e.occurred_at,
          by: p.by ?? null,
          challenger_decision_id: p.challenger_decision_id ?? null,
          candidate: p.candidate ?? null,
          reason: p.reason,
        });
        break;
      case "MAPPING_DISPUTE_OPENED":
        state.status = "dispute";
        state.disputes.push({
          at: e.occurred_at,
          by: p.by ?? null,
          reason: p.reason,
          diff: p.diff ?? null,
          review_key: p.review_key ?? null,
        });
        break;
      case "MAPPING_HALTED":
        state.status = "halted";
        state.halt = { at: e.occurred_at, by: p.by ?? null, reason: p.reason };
        break;
      case "MAPPING_SUPERSEDED":
        state.status = "superseded";
        state.successorId = p.successor_id;
        if (p.effective_to) state.effectiveTo = p.effective_to;
        state.chain.push(p.successor_id);
        break;
      case "MAPPING_CORRECTED":
        state.status = "corrected";
        state.successorId = p.successor_id;
        if (p.effective_to) state.effectiveTo = p.effective_to;
        state.diffs.push({ at: e.occurred_at, diff: p.diff ?? null, successor_id: p.successor_id, review_key: p.review_key ?? null });
        state.chain.push(p.successor_id);
        break;
      default:
        break;
    }
  }
  return state;
}

export class DecisionService {
  constructor(store, clock = () => new Date().toISOString()) {
    this.store = store;
    this.clock = clock;
  }

  #load(decisionId) {
    return replayDecision(this.store.loadStream(decisionAggregateId(decisionId)));
  }

  #allDecisionStates() {
    return this.store
      .aggregateIds("mapping_decision:")
      .map((id) => replayDecision(this.store.loadStream(id)))
      .filter((s) => s.status !== "new");
  }

  // 同一来源版本 + 同一内容哈希只允许一条裁决：精确重传直接返回既有裁决，不重复创建。
  findBySourceFingerprint({ sourceSystem, sourceVersion, hash }) {
    const found = this.#allDecisionStates().find(
      (s) =>
        s.source &&
        s.source.source_system === sourceSystem &&
        s.source.source_version === sourceVersion &&
        s.source.content_hash === hash,
    );
    return found ? found.decisionId : null;
  }

  // 按来源行键定位：同一来源版本内行键相同但内容哈希变化，即"内容变化进入争议"。
  findBySourceLine({ sourceSystem, sourceVersion, lineKey }) {
    const found = this.#allDecisionStates().find(
      (s) =>
        s.source &&
        s.source.source_system === sourceSystem &&
        s.source.source_version === sourceVersion &&
        s.source.line_key === lineKey,
    );
    return found
      ? { decisionId: found.decisionId, contentHash: found.source.content_hash, status: found.status }
      : null;
  }

  // 追加机器候选证据（不改变任何结论）。
  attachCandidates(decisionId, candidates, { correlationId = null } = {}) {
    const state = this.#load(decisionId);
    const event = makeEvent({
      eventType: "CANDIDATE_SUGGESTED",
      aggregateType: "mapping_decision",
      aggregateId: decisionAggregateId(decisionId),
      at: this.clock(),
      correlationId,
      payload: { decision_id: decisionId, candidates },
      summary: `机器相似度为裁决 ${decisionId} 追加 ${candidates.length} 条候选证据`,
    });
    return this.store.append(event, state.version);
  }

  // 提出裁决草案。candidates 是证据而非结论；冲突检测在激活时进行。
  propose(input) {
    const decisionId = input.decisionId ?? this.#generateId(input);
    const state = this.#load(decisionId);
    if (state.status !== "new") throw new Error(`裁决已存在：${decisionId}`);
    validateProposal(input);

    const at = input.at ?? this.clock();
    const hash = input.source?.content_hash ?? contentHash({ mapping: input.mapping, bound: input.boundRevisions });
    const event = makeEvent({
      eventType: "MAPPING_PROPOSED",
      aggregateType: "mapping_decision",
      aggregateId: decisionAggregateId(decisionId),
      at,
      by: input.by ?? null,
      correlationId: input.correlationId ?? null,
      payload: {
        decision_id: decisionId,
        selector: input.selector,
        mapping: input.mapping,
        bound_revisions: input.boundRevisions,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo ?? null,
        candidates: input.candidates ?? [],
        source: input.source ? { ...input.source, content_hash: hash } : null,
        correction_of: input.correctionOf ?? null,
      },
      summary: `提出裁决 ${decisionId}：${input.selector.province} 将 ${input.selector.hospital_ref} 映射为 ${input.mapping.conclusion}`,
    });
    this.store.append(event, 0);
    return { decisionId, event };
  }

  // 按职责签署：编码专家与支付政策人员各自签，缺一则不可激活。
  sign(decisionId, { role, by, note = null, at }) {
    const state = this.#load(decisionId);
    if (state.status === "new") throw new Error("裁决尚未提出，无法签署");
    if (!SIGN_ROLE_VALUES.includes(role)) throw new Error(`未知签署职责：${role}`);
    if (typeof by !== "string" || by.length === 0) throw new Error("签署人必须是非空字符串");
    const event = makeEvent({
      eventType: "MAPPING_SIGNED",
      aggregateType: "mapping_decision",
      aggregateId: decisionAggregateId(decisionId),
      at: at ?? this.clock(),
      by,
      payload: { decision_id: decisionId, role, note },
      summary: `${role === SIGN_ROLES.CODING_EXPERT ? "编码专家" : "支付政策人员"}${by}签署裁决 ${decisionId}`,
    });
    return this.store.append(event, state.version);
  }

  // 激活：双签齐备 + 无重叠生效裁决才可激活。
  // 若与当前生效裁决冲突，只在既有裁决上登记冲突候选并返回 conflict，绝不自动覆盖。
  activate(decisionId, { at, effectiveFrom = null, effectiveTo = null } = {}) {
    const state = this.#load(decisionId);
    if (state.status !== "proposed" && state.status !== "dispute") {
      throw new Error(`裁决状态 ${state.status} 不可激活`);
    }
    const missing = SIGN_ROLE_VALUES.filter((role) => !state.signatures.some((s) => s.role === role));
    if (missing.length > 0) {
      const err = new Error(`缺少职责签署：${missing.join("、")}`);
      err.code = "MISSING_REQUIRED_SIGNATURE";
      err.missingRoles = missing;
      throw err;
    }

    const from = effectiveFrom ?? state.effectiveFrom;
    const to = effectiveTo ?? state.effectiveTo;
    const overlap = this.#findOverlap(state, from, to, decisionId);
    if (overlap) {
      const flagged = makeEvent({
        eventType: "MAPPING_CONFLICT_FLAGGED",
        aggregateType: "mapping_decision",
        aggregateId: decisionAggregateId(overlap.decisionId),
        at: at ?? this.clock(),
        payload: {
          decision_id: overlap.decisionId,
          challenger_decision_id: decisionId,
          candidate: { mapping: state.mapping, selector: state.selector, bound_revisions: state.boundRevisions },
          reason: `与生效区间重叠的替代裁决 ${decisionId} 竞争同一选择器，等待人工裁决`,
        },
        summary: `裁决 ${overlap.decisionId} 出现冲突候选 ${decisionId}，当前结论保留`,
      });
      this.store.append(flagged, overlap.version);
      return { status: "conflict_flagged", incumbent: overlap.decisionId, challenger: decisionId };
    }

    const event = makeEvent({
      eventType: "MAPPING_ACTIVATED",
      aggregateType: "mapping_decision",
      aggregateId: decisionAggregateId(decisionId),
      at: at ?? this.clock(),
      payload: { decision_id: decisionId, effective_from: from, effective_to: to },
      summary: `裁决 ${decisionId} 生效，区间 [${from}, ${to ?? "至今"})`,
    });
    this.store.append(event, state.version);
    return { status: "active", decisionId };
  }

  #findOverlap(state, from, to, excludeDecisionId) {
    for (const other of this.#allDecisionStates()) {
      if (other.decisionId === excludeDecisionId || other.decisionId === state.correctionOf) continue;
      if (other.status !== "active") continue;
      if (!sameSelector(other.selector, state.selector)) continue;
      if (intervalsOverlap(from, to, other.effectiveFrom, other.effectiveTo)) {
        return other;
      }
    }
    return null;
  }

  // 紧急停用：立即阻断尚未结算的请求；已结算记录固定的是历史事件，不受影响。
  halt(decisionId, { by, reason, at }) {
    const state = this.#load(decisionId);
    if (state.status !== "active" && state.status !== "dispute" && state.status !== "proposed") {
      throw new Error(`裁决状态 ${state.status} 不可紧急停用`);
    }
    const event = makeEvent({
      eventType: "MAPPING_HALTED",
      aggregateType: "mapping_decision",
      aggregateId: decisionAggregateId(decisionId),
      at: at ?? this.clock(),
      by,
      payload: { decision_id: decisionId, reason },
      summary: `紧急停用裁决 ${decisionId}：${reason}（仅阻断未结算请求）`,
    });
    return this.store.append(event, state.version);
  }

  // 内容变化（同来源版本重传但哈希不同，或人工发现错误）：差异事件进入争议复核，
  // 现有结论不自动改变。
  openDispute(decisionId, { by, reason, diff, reviewKey, at }) {
    const state = this.#load(decisionId);
    if (["superseded", "corrected"].includes(state.status)) throw new Error("裁决已结案，不能再开争议");
    const event = makeEvent({
      eventType: "MAPPING_DISPUTE_OPENED",
      aggregateType: "mapping_decision",
      aggregateId: decisionAggregateId(decisionId),
      at: at ?? this.clock(),
      by,
      payload: { decision_id: decisionId, reason, diff: diff ?? null, review_key: reviewKey ?? null },
      summary: `裁决 ${decisionId} 进入争议复核：${reason}`,
    });
    return this.store.append(event, state.version);
  }

  // 复核通过后的更正：另立后继裁决（correction_of），重新走双签与生效；
  // 后继激活时旧裁决按 MAPPING_CORRECTED 关闭区间，已结算病例仍固定旧版本。
  proposeCorrection(incumbentId, input) {
    const incumbent = this.#load(incumbentId);
    if (incumbent.status === "new") throw new Error("被更正裁决不存在");
    if (input.correctionOf) throw new Error("correctionOf 由系统填入");
    return this.propose({
      ...input,
      selector: input.selector ?? incumbent.selector,
      boundRevisions: input.boundRevisions ?? incumbent.boundRevisions,
      effectiveFrom: input.effectiveFrom ?? incumbent.effectiveFrom,
      correctionOf: incumbentId,
    });
  }

  // 后继裁决激活成功后，旧裁决收口。kind=correction 走差异事件链，routine 走普通替代。
  closeIncumbent(incumbentId, successorId, { kind = "routine", diff = null, reviewKey = null, effectiveTo, at } = {}) {
    const incumbent = this.#load(incumbentId);
    if (!["active", "dispute", "halted"].includes(incumbent.status)) {
      throw new Error(`旧裁决状态 ${incumbent.status} 不可收口`);
    }
    const eventType = kind === "correction" ? "MAPPING_CORRECTED" : "MAPPING_SUPERSEDED";
    const event = makeEvent({
      eventType,
      aggregateType: "mapping_decision",
      aggregateId: decisionAggregateId(incumbentId),
      at: at ?? this.clock(),
      payload: {
        decision_id: incumbentId,
        successor_id: successorId,
        effective_to: effectiveTo ?? this.clock().slice(0, 10),
        diff,
        review_key: reviewKey ?? null,
      },
      summary:
        kind === "correction"
          ? `裁决 ${incumbentId} 经差异复核由 ${successorId} 更正，旧区间关闭，已结算记录固定旧版本`
          : `裁决 ${incumbentId} 由 ${successorId} 替代，旧区间关闭`,
    });
    return this.store.append(event, incumbent.version);
  }

  getState(decisionId) {
    const state = this.#load(decisionId);
    return state.status === "new" ? null : state;
  }

  // 结算选择器视角：某地点当前全部处于生效/争议/停用状态的裁决。
  listByProvince(province) {
    return this.#allDecisionStates().filter((s) => s.selector?.province === province);
  }

  #generateId(input) {
    return `dec-${contentHash({
      s: input.selector,
      m: input.mapping,
      f: input.effectiveFrom,
      src: input.source?.source_version ?? null,
      h: input.source?.content_hash ?? null,
    }).slice(0, 16)}`;
  }
}

export function sameSelector(a, b) {
  if (!a || !b) return false;
  return (
    a.province === b.province &&
    a.hospital_ref === b.hospital_ref &&
    (a.local_restriction_ref ?? null) === (b.local_restriction_ref ?? null) &&
    (a.pricing_unit_ref ?? null) === (b.pricing_unit_ref ?? null) &&
    (a.population_ref ?? null) === (b.population_ref ?? null)
  );
}

export function intervalsOverlap(fromA, toA, fromB, toB) {
  const aEnd = toA ?? "9999-12-31";
  const bEnd = toB ?? "9999-12-31";
  return fromA < bEnd && fromB < aEnd;
}

function validateProposal(input) {
  const errors = [];
  if (!input.selector || typeof input.selector.province !== "string" || input.selector.province.length === 0) {
    errors.push("selector.province 必填（就诊发生地）");
  }
  if (!input.selector || typeof input.selector.hospital_ref !== "string" || input.selector.hospital_ref.length === 0) {
    errors.push("selector.hospital_ref 必填");
  }
  if (!input.mapping || typeof input.mapping.national_ref !== "string") errors.push("mapping.national_ref 必填");
  if (!input.mapping || !["reimbursable_treatment", "self_paid_auxiliary", "other"].includes(input.mapping.conclusion)) {
    errors.push("mapping.conclusion 必须是 reimbursable_treatment / self_paid_auxiliary / other");
  }
  if (!input.boundRevisions || !Number.isInteger(input.boundRevisions.hospital_code)) {
    errors.push("bound_revisions.hospital_code 必须固定为精确版本号");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom ?? "")) errors.push("effectiveFrom 必须是 YYYY-MM-DD");
  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) errors.push("生效区间结束日必须晚于开始日");
  if (errors.length > 0) {
    const err = new Error(`裁决草案不合法：${errors.join("；")}`);
    err.code = "INVALID_PROPOSAL";
    err.errors = errors;
    throw err;
  }
}
