import { DIMENSION_VALUES } from "./contracts.js";
import { replayDecision, decisionAggregateId } from "./decisions.js";
import { claimAggregateId } from "./settlement.js";

// 审计反查：从任一结算结果出发，还原当时所用裁决的完整证据链——
// 候选证据（机器分数/信号/快照）、双职责签署人、生效区间、五维精确版本内容，
// 以及该裁决之后发生的争议、停用、冲突标记与更正链。
//
// 已结算记录只追加、不改写：本服务读到的"当时版本"永远等于 CLAIM_ADJUSTED 固定的版本。

export class AuditService {
  constructor(store, registry) {
    this.store = store;
    this.registry = registry;
  }

  // 结算单 → 完整审计卷宗。
  dossier(claimId) {
    const claimEvents = this.store.loadStream(claimAggregateId(claimId));
    if (claimEvents.length === 0) return null;
    const submitted = claimEvents.find((e) => e.event_type === "CLAIM_SUBMITTED");
    const terminal = claimEvents.find((e) =>
      ["CLAIM_ADJUSTED", "CLAIM_BLOCKED", "CLAIM_PENDING_REVIEW"].includes(e.event_type),
    );

    const dossier = {
      claim: {
        claim_id: claimId,
        request: submitted.payload.request,
        submitted_at: submitted.occurred_at,
        outcome: terminal.event_type,
        reason: terminal.payload.reason ?? null,
        explanation: terminal.payload.explanation ?? null,
      },
      fixed_decision: null,
      chain: [],
    };

    const anchorId = terminal.payload.decision_id ?? null;
    if (anchorId) {
      const fixedVersion = terminal.payload.decision_event_version ?? null;
      dossier.fixed_decision = this.#decisionEvidence(anchorId, { fixedVersion, asOf: submitted.occurred_at });
      dossier.chain = this.#correctionChain(anchorId, submitted.occurred_at);
    } else if (Array.isArray(terminal.payload.decision_ids)) {
      dossier.related_decisions = terminal.payload.decision_ids.map((id) =>
        this.#decisionEvidence(id, { fixedVersion: null, asOf: submitted.occurred_at }),
      );
    }
    return dossier;
  }

  // 裁决视角：候选证据、签署、冲突、争议、停用、更正一览。
  #decisionEvidence(decisionId, { fixedVersion, asOf }) {
    const events = this.store.loadStream(decisionAggregateId(decisionId));
    const stateNow = replayDecision(events);
    const stateAtSettlement = fixedVersion ? replayDecision(events.slice(0, fixedVersion)) : replayDecision(events);

    return {
      decision_id: decisionId,
      // 结算固定的就是事件流前 fixedVersion 条；之后追加的事件只出现在 later_events。
      fixed_event_version: fixedVersion,
      status_then: stateAtSettlement.status,
      status_now: stateNow.status,
      selector: stateAtSettlement.selector,
      mapping_then: stateAtSettlement.mapping,
      effective_interval_then: { effective_from: stateAtSettlement.effectiveFrom, effective_to: stateAtSettlement.effectiveTo },
      effective_interval_now: { effective_from: stateNow.effectiveFrom, effective_to: stateNow.effectiveTo },
      bound_revisions: stateAtSettlement.boundRevisions,
      dimension_snapshots: this.#snapshots(stateAtSettlement),
      candidates: stateAtSettlement.candidates.map((c) => ({
        candidate_id: c.candidate_id,
        source: c.source,
        national_ref: c.national_ref,
        national_revision: c.national_revision,
        score: c.score,
        signals: c.signals,
        generated_at: c.generated_at,
        evidence: c.evidence,
      })),
      signers: stateAtSettlement.signatures.map((s) => ({ role: s.role, by: s.by, signed_at: s.at, note: s.note })),
      conflicts: stateNow.conflicts,
      disputes: stateNow.disputes,
      halt: stateNow.halt,
      successor_id: stateNow.successorId,
      correction_of: stateNow.correctionOf,
      // 结算落账之后追加的事件：审计可直接看到"后来发生了什么"。
      later_events: events
        .slice(fixedVersion ?? events.length)
        .map((e) => ({ event_id: e.event_id, event_type: e.event_type, occurred_at: e.occurred_at, by: e.payload.by ?? null, payload: e.payload })),
      events: events.map((e) => ({ event_id: e.event_id, event_type: e.event_type, occurred_at: e.occurred_at, version: e.version, by: e.payload.by ?? null })),
      as_of: asOf ?? null,
    };
  }

  // 沿 correction_of 回溯到链首，再沿 successor_id 顺序展开整条更正链。
  #correctionChain(anchorId, settledAt) {
    const load = (id) => replayDecision(this.store.loadStream(decisionAggregateId(id)));

    const root = (() => {
      let cur = anchorId;
      const guard = new Set();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        const prev = load(cur).correctionOf;
        if (!prev) return cur;
        cur = prev;
      }
      return cur;
    })();

    const ordered = [];
    const guard = new Set();
    let cur = root;
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const state = load(cur);
      ordered.push(state);
      cur = state.successorId;
    }

    return ordered.map((state) => {
      const events = this.store.loadStream(decisionAggregateId(state.decisionId));
      const laterEvents = events
        .filter((e) =>
          ["MAPPING_DISPUTE_OPENED", "MAPPING_CORRECTED", "MAPPING_SUPERSEDED", "MAPPING_HALTED", "MAPPING_CONFLICT_FLAGGED"].includes(
            e.event_type,
          ),
        )
        .filter((e) => e.occurred_at > settledAt)
        .map((e) => ({ event_type: e.event_type, occurred_at: e.occurred_at, by: e.payload.by ?? null, payload: e.payload }));
      return {
        decision_id: state.decisionId,
        status: state.status,
        is_anchor: state.decisionId === anchorId,
        mapping: state.mapping,
        signers: state.signatures.map((s) => ({ role: s.role, by: s.by, signed_at: s.at })),
        bound_revisions: state.boundRevisions,
        effective_interval: { effective_from: state.effectiveFrom, effective_to: state.effectiveTo },
        correction_of: state.correctionOf,
        successor_id: state.successorId,
        events_after_settlement: laterEvents,
      };
    });
  }

  // 按裁决选择器/映射中的维度 ref，取回固定 revision 的内容快照。
  #snapshots(state) {
    if (!state.boundRevisions) return null;
    const refs = {
      hospital_code: state.selector?.hospital_ref,
      national_item: state.mapping?.national_ref,
      local_restriction: state.selector?.local_restriction_ref,
      pricing_unit: state.selector?.pricing_unit_ref,
      eligible_population: state.selector?.population_ref,
    };
    const out = {};
    for (const dimension of DIMENSION_VALUES) {
      const revision = state.boundRevisions[dimension];
      const ref = refs[dimension];
      if (revision === null || revision === undefined || !ref) {
        out[dimension] = { revision: revision ?? null, used: false };
      } else {
        const rev = this.registry.getRevision(dimension, ref, revision);
        out[dimension] = { revision, ref, used: true, content: rev?.content ?? null };
      }
    }
    return out;
  }

  // 反向索引：哪些结算单引用了某条裁决。
  claimsUsingDecision(decisionId) {
    return this.store
      .aggregateIds("claim_line:")
      .map((id) => this.store.loadStream(id))
      .filter((events) =>
        events.some((e) => e.event_type === "CLAIM_ADJUSTED" && e.payload.decision_id === decisionId),
      )
      .map((events) => events[0].aggregate_id.replace("claim_line:", ""));
  }
}
