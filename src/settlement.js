import { PENDING_REASONS } from "./contracts.js";
import { makeEvent } from "./events.js";
import { replayDecision } from "./decisions.js";

// 结算接口：按"就诊发生地 + 就诊日期"在裁决集合中选出唯一映射。
// 选不出唯一结果时绝不猜测，返回结构化、可解释的待审原因。
//
// 已结算记录固定当时裁决版本与五维精确 revision；之后任何停用、争议、更正都不改写它。

export function claimAggregateId(claimId) {
  return `claim_line:${claimId}`;
}

// 选择器适用性：裁决未限定的维度（null）视为对该维度普遍适用；
// 裁决限定了而请求未声明的，不允许默认套用（无法判断适用性 → 待审）。
function selectorApplies(selector, request) {
  if (selector.province !== request.province) return false;
  if (selector.hospital_ref !== request.hospital_ref) return false;

  if (selector.pricing_unit_ref !== null) {
    if (!request.pricing_unit_ref) return { applies: false, missing: "pricing_unit_ref" };
    if (selector.pricing_unit_ref !== request.pricing_unit_ref) return { applies: false };
  }
  if (selector.population_ref !== null) {
    if (!request.population_ref) return { applies: false, missing: "population_ref" };
    if (selector.population_ref !== request.population_ref) return { applies: false };
  }
  if (selector.local_restriction_ref !== null) {
    if (!request.local_restriction_ref) return { applies: false, missing: "local_restriction_ref" };
    if (selector.local_restriction_ref !== request.local_restriction_ref) return { applies: false };
  }
  return { applies: true };
}

function inInterval(state, date) {
  if (date < state.effectiveFrom) return false;
  if (state.effectiveTo !== null && date >= state.effectiveTo) return false;
  return true;
}

export class SettlementService {
  constructor(store, decisions, registry, clock = () => new Date().toISOString()) {
    this.store = store;
    this.decisions = decisions;
    this.registry = registry;
    this.clock = clock;
  }

  #candidates(request) {
    return this.decisions
      .listByProvince(request.province)
      .filter((s) => s.selector.hospital_ref === request.hospital_ref)
      .map((s) => ({ state: s, applicability: selectorApplies(s.selector, request) }));
  }

  // 纯解析，不落事件：返回 { kind: "resolved"| "pending" | "blocked", ... }。
  resolve(request) {
    assertRequest(request);
    const related = this.#candidates(request);
    const applicable = related.filter(({ applicability }) => applicability.applies);

    // 优先选取当前生效且日期落入区间的唯一裁决。存在唯一结论时，
    // 其他已停用/争议中的旧裁决不再影响本次结算。
    const active = applicable.filter(({ state }) => state.status === "active" && inInterval(state, request.service_date));
    if (active.length === 1) {
      const state = active[0].state;
      return {
        kind: "resolved",
        decision_id: state.decisionId,
        decision_event_version: state.version,
        mapping: state.mapping,
        selector: state.selector,
        bound_revisions: state.boundRevisions,
        effective_from: state.effectiveFrom,
        effective_to: state.effectiveTo,
      };
    }

    if (active.length > 1) {
      return {
        kind: "pending",
        reason: PENDING_REASONS.MULTIPLE_ACTIVE_DECISIONS,
        explanation: `就诊地 ${request.province} 在 ${request.service_date} 存在 ${active.length} 条同时生效且选择器重叠的裁决，需人工指定唯一结论`,
        decision_ids: active.map(({ state }) => state.decisionId),
      };
    }

    // 没有唯一生效裁决时，紧急停用阻断尚未结算的请求。
    const halted = applicable.filter(
      ({ state }) => state.status === "halted" && inInterval(state, request.service_date),
    );
    if (halted.length > 0) {
      return {
        kind: "blocked",
        reason: PENDING_REASONS.UNDER_HALT,
        explanation: `匹配裁决处于紧急停用：${halted.map((h) => h.state.decisionId).join("、")}；停用仅阻断未结算请求`,
        decision_ids: halted.map((h) => h.state.decisionId),
      };
    }

    // 无唯一生效裁决：按优先级给出可解释原因。
    const dispute = applicable.find(({ state }) => state.status === "dispute" && inInterval(state, request.service_date));
    if (dispute) {
      return {
        kind: "pending",
        reason: PENDING_REASONS.DISPUTE_OPEN,
        explanation: `裁决 ${dispute.state.decisionId} 正在争议复核中，现有结论暂不可用于自动结算`,
        decision_ids: [dispute.state.decisionId],
      };
    }

    const unsigned = applicable.find(
      ({ state }) => state.status === "proposed" && inInterval(state, request.service_date),
    );
    if (unsigned) {
      return {
        kind: "pending",
        reason: PENDING_REASONS.MISSING_REQUIRED_SIGNATURE,
        explanation: `裁决 ${unsigned.state.decisionId} 尚未完成编码专家与支付政策人员双职责签署`,
        decision_ids: [unsigned.state.decisionId],
      };
    }

    const dated = applicable.find(({ state }) => state.status === "active" && !inInterval(state, request.service_date));
    if (dated) {
      return {
        kind: "pending",
        reason: PENDING_REASONS.OUTSIDE_EFFECTIVE_INTERVAL,
        explanation: `裁决 ${dated.state.decisionId} 的生效区间不覆盖就诊日期 ${request.service_date}`,
        decision_ids: [dated.state.decisionId],
      };
    }

    const missingDim = related.find(({ applicability }) => applicability.applies === false && applicability.missing);
    if (missingDim) {
      return {
        kind: "pending",
        reason: PENDING_REASONS.DIMENSION_AMBIGUOUS,
        explanation: `裁决 ${missingDim.state.decisionId} 限定了 ${missingDim.applicability.missing}，结算请求未声明，无法判断适用性`,
        decision_ids: [missingDim.state.decisionId],
      };
    }

    return {
      kind: "pending",
      reason: PENDING_REASONS.NO_DECISION,
      explanation: `就诊地 ${request.province}、日期 ${request.service_date}、医院编码 ${request.hospital_ref} 下没有可用裁决`,
      decision_ids: [],
    };
  }

  // 结算落账：resolved 才产生 CLAIM_ADJUSTED，并固定全部版本依据。
  // blocked / pending 分别落 CLAIM_BLOCKED / CLAIM_PENDING_REVIEW，不产生支付结论。
  settle(claimId, request, { at = null } = {}) {
    assertRequest(request);
    const now = at ?? this.clock();
    const aggregateId = claimAggregateId(claimId);
    if (this.store.streamVersion(aggregateId) > 0) throw new Error(`结算单已存在：${claimId}`);

    const resolution = this.resolve(request);
    const submit = makeEvent({
      eventType: "CLAIM_SUBMITTED",
      aggregateType: "claim_line",
      aggregateId,
      at: now,
      payload: { claim_id: claimId, request: { ...request } },
      summary: `接收跨省结算请求 ${claimId}：${request.province} / ${request.service_date} / ${request.hospital_ref}`,
    });
    this.store.append(submit, 0);

    let outcomeEvent;
    if (resolution.kind === "resolved") {
      outcomeEvent = makeEvent({
        eventType: "CLAIM_ADJUSTED",
        aggregateType: "claim_line",
        aggregateId,
        at: now,
        payload: {
          claim_id: claimId,
          decision_id: resolution.decision_id,
          decision_event_version: resolution.decision_event_version,
          bound_revisions: resolution.bound_revisions,
          mapping: resolution.mapping,
          resolved_by: { province: request.province, service_date: request.service_date },
        },
        summary: `结算单 ${claimId} 按裁决 ${resolution.decision_id}（事件版本 v${resolution.decision_event_version}）定结：${resolution.mapping.conclusion}`,
      });
    } else if (resolution.kind === "blocked") {
      outcomeEvent = makeEvent({
        eventType: "CLAIM_BLOCKED",
        aggregateType: "claim_line",
        aggregateId,
        at: now,
        payload: { claim_id: claimId, reason: resolution.reason, explanation: resolution.explanation, decision_ids: resolution.decision_ids },
        summary: `结算单 ${claimId} 被紧急停用阻断，等待处理`,
      });
    } else {
      outcomeEvent = makeEvent({
        eventType: "CLAIM_PENDING_REVIEW",
        aggregateType: "claim_line",
        aggregateId,
        at: now,
        payload: { claim_id: claimId, reason: resolution.reason, explanation: resolution.explanation, decision_ids: resolution.decision_ids },
        summary: `结算单 ${claimId} 转入人工待审：${resolution.reason}`,
      });
    }
    this.store.append(outcomeEvent, 1);
    return { claimId, resolution };
  }

  getClaim(claimId) {
    const events = this.store.loadStream(claimAggregateId(claimId));
    if (events.length === 0) return null;
    const submitted = events.find((e) => e.event_type === "CLAIM_SUBMITTED");
    const terminal = events.find(
      (e) => ["CLAIM_ADJUSTED", "CLAIM_BLOCKED", "CLAIM_PENDING_REVIEW"].includes(e.event_type),
    );
    return {
      claimId,
      request: submitted.payload.request,
      submittedAt: submitted.occurred_at,
      status: terminal.event_type.replace("CLAIM_", "").toLowerCase(),
      terminal: terminal.payload,
      events,
    };
  }
}

function assertRequest(request) {
  const errors = [];
  if (!request || typeof request.province !== "string" || request.province.length === 0) errors.push("province（就诊发生地）必填");
  if (!request || typeof request.hospital_ref !== "string" || request.hospital_ref.length === 0) errors.push("hospital_ref 必填");
  if (!request || !/^\d{4}-\d{2}-\d{2}$/.test(request.service_date ?? "")) errors.push("service_date 必须是 YYYY-MM-DD（就诊日期）");
  if (errors.length > 0) throw new Error(`结算请求不合法：${errors.join("；")}`);
}
