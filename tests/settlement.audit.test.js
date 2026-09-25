import assert from "node:assert/strict";
import test from "node:test";

import { makeEvent } from "../src/events.js";
import { decisionAggregateId } from "../src/decisions.js";
import { PENDING_REASONS } from "../src/contracts.js";
import { buildWorld, DECISION_AT, seedDimensions, seedLocalRestriction } from "./helpers.js";

const REQ = (serviceDate) => ({
  province: "33",
  hospital_ref: "H-SVC-1001",
  local_restriction_ref: "LR-33",
  pricing_unit_ref: "U-SESSION",
  population_ref: "P-ADULT",
  service_date: serviceDate,
});

// 历史系统迁移可能带入两条选择器相同、同时生效的裁决：结算不得任选，必须待审。
test("同一地点日期存在多条生效裁决时返回可解释的待审，而不是任选一条", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "甲类" });

  const proposal = {
    selector: { province: "33", hospital_ref: "H-SVC-1001", local_restriction_ref: "LR-33", pricing_unit_ref: "U-SESSION", population_ref: "P-ADULT" },
    boundRevisions: { hospital_code: 1, national_item: 1, local_restriction: 1, pricing_unit: 1, eligible_population: 1 },
    effectiveFrom: "2026-01-01",
  };
  const { decisionId: a } = world.decisions.propose({
    ...proposal,
    decisionId: "legacy-A",
    at: DECISION_AT,
    mapping: { national_ref: "N-330701", conclusion: "reimbursable_treatment", billing_category: "reimbursable_treatment" },
  });
  const { decisionId: b } = world.decisions.propose({
    ...proposal,
    decisionId: "legacy-B",
    at: DECISION_AT,
    mapping: { national_ref: "N-330701", conclusion: "self_paid_auxiliary", billing_category: "self_paid_auxiliary" },
  });
  // 第一条走正常流程；第二条模拟旧系统迁移直接落入生效事件。
  world.decisions.sign(a, { role: "coding_expert", by: "expert-zhang", at: DECISION_AT });
  world.decisions.sign(a, { role: "payment_policy", by: "policy-li", at: DECISION_AT });
  world.decisions.activate(a, { at: DECISION_AT });
  world.store.append(
    makeEvent({
      eventType: "MAPPING_ACTIVATED",
      aggregateType: "mapping_decision",
      aggregateId: decisionAggregateId(b),
      at: "2025-12-31T00:00:00+08:00",
      payload: { decision_id: b, effective_from: "2026-01-01", effective_to: null },
      summary: "旧系统迁移生效事件",
    }),
    1,
  );

  const resolution = world.settlement.resolve(REQ("2026-05-01"));
  assert.equal(resolution.kind, "pending");
  assert.equal(resolution.reason, PENDING_REASONS.MULTIPLE_ACTIVE_DECISIONS);
  assert.deepEqual(resolution.decision_ids.sort(), ["legacy-A", "legacy-B"]);
  assert.match(resolution.explanation, /2 条同时生效/);
});

test("被紧急停用阻断的结算单可落账为 blocked 且不含支付结论", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "甲类" });
  const id = (() => {
    const { decisionId } = world.decisions.propose({
      at: DECISION_AT,
      selector: REQ("2026-05-01"),
      mapping: { national_ref: "N-330701", conclusion: "reimbursable_treatment", billing_category: "reimbursable_treatment" },
      boundRevisions: { hospital_code: 1, national_item: 1, local_restriction: 1, pricing_unit: 1, eligible_population: 1 },
      effectiveFrom: "2026-01-01",
    });
    world.decisions.sign(decisionId, { role: "coding_expert", by: "expert-zhang", at: DECISION_AT });
    world.decisions.sign(decisionId, { role: "payment_policy", by: "policy-li", at: DECISION_AT });
    world.decisions.activate(decisionId, { at: DECISION_AT });
    return decisionId;
  })();
  world.decisions.halt(id, { by: "policy-li", reason: "违规", at: "2026-06-01T09:00:00+08:00" });

  const { resolution } = world.settlement.settle("CLAIM-BLOCK", REQ("2026-06-10"));
  assert.equal(resolution.kind, "blocked");
  const claim = world.settlement.getClaim("CLAIM-BLOCK");
  assert.equal(claim.status, "blocked");
  assert.equal(claim.terminal.mapping, undefined);
  assert.deepEqual(claim.terminal.decision_ids, [id]);
});

test("审计卷宗含机器候选证据、双职责签署人与五维固定内容", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "甲类" });

  const { decisionId } = world.decisions.propose({
    at: DECISION_AT,
    selector: REQ("2026-05-01"),
    mapping: { national_ref: "N-330701", conclusion: "reimbursable_treatment", billing_category: "reimbursable_treatment" },
    boundRevisions: { hospital_code: 1, national_item: 1, local_restriction: 1, pricing_unit: 1, eligible_population: 1 },
    effectiveFrom: "2026-01-01",
  });
  const candidates = world.similarity.suggestCandidates({
    hospitalRef: "H-SVC-1001",
    nationalRefs: ["N-330701"],
    at: "2026-01-02T07:00:00+08:00",
  });
  world.decisions.attachCandidates(decisionId, candidates);
  world.decisions.sign(decisionId, { role: "coding_expert", by: "expert-zhang", note: "编码与临床描述一致", at: DECISION_AT });
  world.decisions.sign(decisionId, { role: "payment_policy", by: "policy-li", note: "浙丙纳保按甲类", at: DECISION_AT });
  world.decisions.activate(decisionId, { at: DECISION_AT });

  world.settlement.settle("CLAIM-AUD", REQ("2026-05-01"), { at: "2026-05-02T10:00:00+08:00" });
  const dossier = world.audit.dossier("CLAIM-AUD");

  assert.equal(dossier.fixed_decision.decision_id, decisionId);
  const cand = dossier.fixed_decision.candidates[0];
  assert.equal(cand.source, "machine_similarity");
  assert.equal(cand.national_ref, "N-330701");
  assert.equal(typeof cand.score, "number");
  assert.ok(cand.signals.length > 0);
  assert.equal(cand.evidence.hospital_snapshot.code, "H-SVC-1001");

  const byRole = Object.fromEntries(dossier.fixed_decision.signers.map((s) => [s.role, s.by]));
  assert.equal(byRole.coding_expert, "expert-zhang");
  assert.equal(byRole.payment_policy, "policy-li");

  assert.equal(dossier.fixed_decision.dimension_snapshots.hospital_code.content.code, "H-SVC-1001");
  assert.equal(dossier.fixed_decision.dimension_snapshots.national_item.content.code, "330701");
  assert.equal(dossier.fixed_decision.dimension_snapshots.local_restriction.content.rule, "甲类");
  assert.equal(dossier.fixed_decision.dimension_snapshots.eligible_population.content.name, "成人");
  assert.equal(dossier.claim.outcome, "CLAIM_ADJUSTED");
});
