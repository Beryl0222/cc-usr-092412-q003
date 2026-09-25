import assert from "node:assert/strict";
import test from "node:test";

import { DIMENSIONS, PENDING_REASONS } from "../src/service.js";
import { makeProposal, makeService, registerBaseDimensions, signBoth } from "./helpers.js";

test("五个维度分别版本化，已登记版本不得原地改写", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);

  assert.equal(refs.hospital_code, "hospital_code:H1001@1");
  for (const dimension of DIMENSIONS) {
    const chainKey = `${dimension}:`;
    assert.ok(Object.values(refs).some((ref) => ref.startsWith(chainKey)), `缺少维度 ${dimension}`);
  }

  // 旧版本仍可读取，新版本递增登记
  assert.equal(service.dimensionVersion("hospital_code", "H1001", 1).payload.name, "经皮冠状动脉支架置入术");
  assert.equal(service.dimensionVersion("hospital_code", "H1001", 2).payload.name, "经皮冠状动脉支架置入术（修订）");

  // 同版本或回退版本都是原地改写，必须拒绝
  assert.throws(
    () =>
      service.registerDimensionVersion({
        dimension: "hospital_code",
        key: "H1001",
        version: 2,
        payload: { name: "篡改" },
        effective_from: "2026-01-02T00:00:00+08:00",
      }),
    /不得原地改写或回退/,
  );
  assert.throws(
    () =>
      service.registerDimensionVersion({
        dimension: "hospital_code",
        key: "H1001",
        version: 1,
        payload: { name: "篡改" },
        effective_from: "2026-01-02T00:00:00+08:00",
      }),
    /不得原地改写或回退/,
  );
});

test("机器相似度只能生成候选，未签署前结算解析返回待审", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);

  const { outcome, candidate_id } = service.proposeCandidate(makeProposal(refs, { similarity: 0.99 }));
  assert.equal(outcome, "created");
  assert.equal(service.candidate(candidate_id).status, "proposed");
  assert.equal(service.candidate(candidate_id).origin, "machine_similarity");

  // 相似度再高也不形成裁决：结算解析得不到生效映射
  const resolution = service.resolveMapping({ region: "广东", service_date: "2026-03-01T00:00:00+08:00", hospital_code: "H1001" });
  assert.equal(resolution.status, "pending");
  assert.equal(resolution.reasons[0].code, PENDING_REASONS.NO_EFFECTIVE_MAPPING);
});

test("编码专家与支付政策人员双签后才形成带生效区间的裁决", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);
  const { candidate_id } = service.proposeCandidate(makeProposal(refs));

  // 单一职责签署不足以生效
  const first = service.signCandidate(candidate_id, { signer_id: "expert-li", role: "coding_expert" });
  assert.equal(first.decision, null);
  assert.equal(
    service.resolveMapping({ region: "广东", service_date: "2026-03-01T00:00:00+08:00", hospital_code: "H1001" }).status,
    "pending",
  );

  // 同一职责不得重复签署；同一人不得兼任两职责
  assert.throws(() => service.signCandidate(candidate_id, { signer_id: "expert-zhao", role: "coding_expert" }), /已签署/);
  assert.throws(() => service.signCandidate(candidate_id, { signer_id: "expert-li", role: "payment_policy" }), /不得兼任/);
  assert.throws(() => service.signCandidate(candidate_id, { signer_id: "someone", role: "admin" }), /签署职责/);

  // 第二职责签署完成后裁决生效，生效区间来自候选提案
  const second = service.signCandidate(candidate_id, { signer_id: "policy-wang", role: "payment_policy" });
  const decision = second.decision;
  assert.equal(decision.status, "active");
  assert.deepEqual(decision.interval, { from: "2026-02-01T00:00:00+08:00", to: null });
  assert.equal(service.candidate(candidate_id).status, "effective");

  const resolution = service.resolveMapping({ region: "广东", service_date: "2026-03-01T00:00:00+08:00", hospital_code: "H1001" });
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.decision.decision_id, decision.decision_id);
});

test("冲突候选不得自动覆盖当前结论，重叠期间解析返回可解释待审", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);

  const first = service.proposeCandidate(makeProposal(refs));
  const decisionA = signBoth(service, first.candidate_id);

  // 另一来源提案把同一医院编码映射成自费辅助项目，区间与现行裁决重叠
  const second = service.proposeCandidate(
    makeProposal(refs, {
      source: { system: "similarity-engine", record_id: "REC-2", version: "v1" },
      dimensions: { ...refs, national_item: "national_item:N900@1" },
      proposed_interval: { from: "2026-03-01T00:00:00+08:00", to: null },
    }),
  );
  const decisionB = signBoth(service, second.candidate_id);

  // 现行结论未被自动关闭或改写
  assert.equal(service.decision(decisionA.decision_id).status, "active");
  assert.equal(service.decision(decisionA.decision_id).interval.to, null);

  // 生效事件如实记录了冲突对象
  const effectiveEvents = service.events().filter((e) => e.event_type === "MAPPING_DECISION_EFFECTIVE");
  assert.deepEqual(effectiveEvents[1].data.conflicts, [decisionA.decision_id]);

  // 仅 A 覆盖的日期仍可唯一解析；重叠期无法唯一判断，返回可解释原因
  const before = service.resolveMapping({ region: "广东", service_date: "2026-02-15T00:00:00+08:00", hospital_code: "H1001" });
  assert.equal(before.status, "resolved");
  assert.equal(before.decision.decision_id, decisionA.decision_id);

  const overlap = service.resolveMapping({ region: "广东", service_date: "2026-04-01T00:00:00+08:00", hospital_code: "H1001" });
  assert.equal(overlap.status, "pending");
  assert.equal(overlap.reasons[0].code, PENDING_REASONS.CONFLICTING_MAPPINGS);
  assert.deepEqual(overlap.reasons[0].decision_ids.sort(), [decisionA.decision_id, decisionB.decision_id].sort());
  assert.match(overlap.reasons[0].message, /广东/);

  // 人工显式关闭旧裁决后，新裁决才成为唯一映射
  service.closeDecision(decisionA.decision_id, { effective_to: "2026-03-01T00:00:00+08:00", by: "policy-wang", reason: "确认自费口径" });
  const after = service.resolveMapping({ region: "广东", service_date: "2026-04-01T00:00:00+08:00", hospital_code: "H1001" });
  assert.equal(after.status, "resolved");
  assert.equal(after.decision.decision_id, decisionB.decision_id);
});

test("紧急停用只阻断尚未结算的请求，已结算记录固定当时版本", () => {
  const { service, setNow } = makeService();
  const refs = registerBaseDimensions(service);
  const { candidate_id } = service.proposeCandidate(makeProposal(refs));
  const decision = signBoth(service, candidate_id);

  setNow("2026-03-05T10:00:00+08:00");
  const settled = service.settleClaim({
    claim_id: "CLM-1",
    region: "广东",
    service_date: "2026-03-01T00:00:00+08:00",
    hospital_code: "H1001",
  });
  assert.equal(settled.status, "settled");
  assert.equal(settled.decision_id, decision.decision_id);

  setNow("2026-03-10T09:00:00+08:00");
  service.deactivateDecision(decision.decision_id, { by: "policy-wang", reason: "发现重大口径错误" });

  // 停用之后才到达的结算请求被阻断，原因可解释
  const blocked = service.settleClaim({
    claim_id: "CLM-2",
    region: "广东",
    service_date: "2026-03-01T00:00:00+08:00",
    hospital_code: "H1001",
  });
  assert.equal(blocked.status, "pending");
  assert.equal(blocked.reasons[0].code, PENDING_REASONS.EMERGENCY_DEACTIVATED);
  assert.deepEqual(blocked.reasons[0].decision_ids, [decision.decision_id]);

  // 停用之前已到达的请求（按请求时间判断）不受阻断
  const inflight = service.resolveMapping({
    region: "广东",
    service_date: "2026-03-01T00:00:00+08:00",
    hospital_code: "H1001",
    requested_at: "2026-03-09T23:00:00+08:00",
  });
  assert.equal(inflight.status, "resolved");

  // 已结算记录保持当时版本与依据
  const claim = service.claim("CLM-1");
  assert.equal(claim.status, "settled");
  assert.equal(claim.decision_id, decision.decision_id);
  assert.equal(claim.decision_version, 1);
});
