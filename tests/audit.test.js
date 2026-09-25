import assert from "node:assert/strict";
import test from "node:test";

import { makeProposal, makeService, registerBaseDimensions, signBoth } from "./helpers.js";
import { validateEvent } from "../src/validator.js";

function fullFlow() {
  const { service, setNow } = makeService();
  const refs = registerBaseDimensions(service);
  const { candidate_id } = service.proposeCandidate(makeProposal(refs));
  const decision = signBoth(service, candidate_id);

  setNow("2026-03-02T09:00:00+08:00");
  service.settleClaim({ claim_id: "CLM-100", region: "广东", service_date: "2026-02-20T00:00:00+08:00", hospital_code: "H1001" });

  setNow("2026-03-20T09:00:00+08:00");
  const difference = service.raiseDifference({
    claim_id: "CLM-100",
    correction: { note: "计价单位应为床日" },
    reason: "病案复核发现计价单位口径偏差",
    by: "expert-li",
  });
  service.resolveDifference(difference.difference_id, { by: "auditor-chen", note: "已复核" });
  return { service, candidate_id, decision, difference };
}

test("审计人员可从结算结果反查候选证据、签署人与后来更正", () => {
  const { service, candidate_id, decision, difference } = fullFlow();

  const trace = service.auditClaim("CLM-100");

  // 结算结果固定的当时版本
  assert.equal(trace.claim.decision_id, decision.decision_id);
  assert.equal(trace.decision.version, 1);
  assert.deepEqual(trace.decision.interval, { from: "2026-02-01T00:00:00+08:00", to: null });

  // 候选证据：机器来源、相似度与证据明细
  assert.equal(trace.candidate.candidate_id, candidate_id);
  assert.equal(trace.candidate.origin, "machine_similarity");
  assert.equal(trace.candidate.similarity, 0.93);
  assert.deepEqual(trace.candidate.evidence, { model: "sim-v2", matched_features: ["name", "unit"] });
  assert.deepEqual(trace.candidate.source, { system: "similarity-engine", record_id: "REC-1", version: "v1" });

  // 签署人：两类职责齐全，签名对应当时内容指纹
  const roles = trace.signatures.map((sig) => sig.role).sort();
  assert.deepEqual(roles, ["coding_expert", "payment_policy"]);
  assert.deepEqual(trace.signatures.map((sig) => sig.signer_id).sort(), ["expert-li", "policy-wang"]);
  assert.ok(trace.signatures.every((sig) => sig.content_hash));

  // 后来更正：差异事件及其复核结论
  assert.equal(trace.corrections.length, 1);
  assert.equal(trace.corrections[0].difference_id, difference.difference_id);
  assert.equal(trace.corrections[0].status, "reviewed");
  assert.equal(trace.corrections[0].review.by, "auditor-chen");

  // 结算聚合上的事件轨迹完整可查
  const types = trace.events.map((event) => event.event_type);
  assert.ok(types.includes("CLAIM_SETTLED"));
  assert.ok(types.includes("DIFFERENCE_RAISED"));
  assert.ok(types.includes("DIFFERENCE_REVIEWED"));
});

test("紧急停用后审计仍呈现结算当时的依据与停用事实", () => {
  const { service, setNow } = makeService();
  const refs = registerBaseDimensions(service);
  const { candidate_id } = service.proposeCandidate(makeProposal(refs));
  const decision = signBoth(service, candidate_id);

  setNow("2026-03-05T10:00:00+08:00");
  service.settleClaim({ claim_id: "CLM-101", region: "广东", service_date: "2026-03-01T00:00:00+08:00", hospital_code: "H1001" });
  setNow("2026-03-10T10:00:00+08:00");
  service.deactivateDecision(decision.decision_id, { by: "policy-wang", reason: "重大口径错误" });

  const trace = service.auditClaim("CLM-101");
  assert.equal(trace.claim.status, "settled");
  assert.equal(trace.decision.decision_id, decision.decision_id);
  assert.equal(trace.decision.deactivated_at, "2026-03-10T10:00:00+08:00");
  assert.equal(trace.decision.deactivation.reason, "重大口径错误");
});

test("全流程产生的领域事件均符合既有信封校验", () => {
  const { service } = fullFlow();
  service.importBatch({
    system: "similarity-engine",
    records: [{ record_id: "REC-X", version: "v1", region: "广东", dimensions: {}, similarity: 0.5, proposed_interval: { from: "2026-02-01T00:00:00+08:00" } }],
  });

  const events = service.events();
  assert.ok(events.length > 10);
  for (const event of events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 不符合信封约定`);
  }
});
