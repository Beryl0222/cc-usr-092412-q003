import assert from "node:assert/strict";
import test from "node:test";

import { PENDING_REASONS } from "../src/service.js";
import { makeProposal, makeService, registerBaseDimensions, signBoth } from "./helpers.js";

function setupEffectiveDecision(service, refs, { region = "广东", recordId = "REC-1", from = "2026-02-01T00:00:00+08:00" } = {}) {
  const { candidate_id } = service.proposeCandidate(
    makeProposal(refs, {
      source: { system: "similarity-engine", record_id: recordId, version: "v1" },
      region,
      proposed_interval: { from, to: null },
    }),
  );
  return signBoth(service, candidate_id);
}

test("结算接口按就诊发生地和日期选出唯一映射", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);
  const gd = setupEffectiveDecision(service, refs, { region: "广东", recordId: "REC-GD" });
  const zj = setupEffectiveDecision(service, refs, {
    region: "浙江",
    recordId: "REC-ZJ",
    from: "2026-03-01T00:00:00+08:00",
  });

  // 同一医院编码，按就诊发生地分流到不同裁决
  const inGd = service.resolveMapping({ region: "广东", service_date: "2026-03-15T00:00:00+08:00", hospital_code: "H1001" });
  assert.equal(inGd.status, "resolved");
  assert.equal(inGd.decision.decision_id, gd.decision_id);

  const inZj = service.resolveMapping({ region: "浙江", service_date: "2026-03-15T00:00:00+08:00", hospital_code: "H1001" });
  assert.equal(inZj.status, "resolved");
  assert.equal(inZj.decision.decision_id, zj.decision_id);

  // 就诊日期落在生效区间之外，返回可解释待审原因
  const tooEarly = service.resolveMapping({ region: "浙江", service_date: "2026-02-15T00:00:00+08:00", hospital_code: "H1001" });
  assert.equal(tooEarly.status, "pending");
  assert.equal(tooEarly.reasons[0].code, PENDING_REASONS.NO_EFFECTIVE_MAPPING);
  assert.match(tooEarly.reasons[0].message, /浙江/);
  assert.match(tooEarly.reasons[0].message, /H1001/);
});

test("已结算记录固定当时版本，后续更正通过差异事件进入复核", () => {
  const { service, setNow } = makeService();
  const refs = registerBaseDimensions(service);
  const decision = setupEffectiveDecision(service, refs);

  setNow("2026-03-02T09:00:00+08:00");
  const claim = service.settleClaim({
    claim_id: "CLM-10",
    region: "广东",
    service_date: "2026-02-20T00:00:00+08:00",
    hospital_code: "H1001",
    detail: { amount: 12800 },
  });
  assert.equal(claim.status, "settled");

  // 旧裁决关闭、新裁决生效，都不改写已结算记录
  service.closeDecision(decision.decision_id, { effective_to: "2026-04-01T00:00:00+08:00", by: "policy-wang", reason: "口径调整" });
  const replacement = setupEffectiveDecision(service, refs, { recordId: "REC-1B", from: "2026-04-01T00:00:00+08:00" });

  const pinned = service.claim("CLM-10");
  assert.equal(pinned.decision_id, decision.decision_id);
  assert.equal(pinned.decision_version, 1);
  assert.deepEqual(pinned.decision_interval, { from: "2026-02-01T00:00:00+08:00", to: null });

  // 更正以差异事件进入复核队列，原结算不被改写
  const difference = service.raiseDifference({
    claim_id: "CLM-10",
    correction: { suggested_decision_id: replacement.decision_id, note: "应按新口径核算" },
    reason: "支付政策口径更正",
    by: "policy-wang",
  });
  assert.equal(difference.status, "open");
  assert.ok(service.reviewQueue().differences.some((d) => d.difference_id === difference.difference_id));
  assert.equal(service.claim("CLM-10").decision_id, decision.decision_id);

  const reviewed = service.resolveDifference(difference.difference_id, {
    by: "auditor-chen",
    note: "复核确认，仅影响后续结算",
    resulting_decision_id: replacement.decision_id,
  });
  assert.equal(reviewed.status, "reviewed");
  assert.equal(service.reviewQueue().differences.length, 0);
});

test("同一结算单相同请求幂等返回，不同内容重复结算视为冲突", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);
  setupEffectiveDecision(service, refs);

  const request = { claim_id: "CLM-20", region: "广东", service_date: "2026-02-20T00:00:00+08:00", hospital_code: "H1001" };
  const first = service.settleClaim(request);
  const again = service.settleClaim(request);
  assert.equal(again.claim_id, first.claim_id);
  assert.equal(again.settled_at, first.settled_at);

  assert.throws(() => service.settleClaim({ ...request, service_date: "2026-02-21T00:00:00+08:00" }), /不得以不同内容重复结算/);
});

test("无法唯一判断的结算进入待审并出现在复核队列", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);

  const result = service.settleClaim({
    claim_id: "CLM-30",
    region: "广东",
    service_date: "2026-02-20T00:00:00+08:00",
    hospital_code: "H1001",
  });
  assert.equal(result.status, "pending");
  assert.equal(result.reasons[0].code, PENDING_REASONS.NO_EFFECTIVE_MAPPING);
  assert.equal(service.claim("CLM-30"), null);

  const queue = service.reviewQueue();
  assert.equal(queue.pending_claims.length, 1);
  assert.equal(queue.pending_claims[0].claim_id, "CLM-30");
  assert.equal(queue.pending_claims[0].reasons[0].code, PENDING_REASONS.NO_EFFECTIVE_MAPPING);
});
