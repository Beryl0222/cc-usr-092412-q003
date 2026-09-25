import assert from "node:assert/strict";
import test from "node:test";

import { makeProposal, makeService, registerBaseDimensions, signBoth } from "./helpers.js";

function batchRecord(refs, overrides = {}) {
  const proposal = makeProposal(refs, overrides);
  return {
    record_id: proposal.source.record_id,
    version: proposal.source.version,
    region: proposal.region,
    dimensions: proposal.dimensions,
    similarity: proposal.similarity,
    evidence: proposal.evidence,
    proposed_interval: proposal.proposed_interval,
  };
}

test("批量导入隔离单条坏数据，其余记录正常创建候选", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);

  const batch = service.importBatch({
    system: "similarity-engine",
    records: [
      batchRecord(refs, { source: { system: "similarity-engine", record_id: "R-1", version: "v1" } }),
      { record_id: "R-BAD", version: "v1", region: "广东", dimensions: { ...refs, national_item: "national_item:NOPE@9" }, similarity: 0.8, proposed_interval: { from: "2026-02-01T00:00:00+08:00" } },
      null,
      batchRecord(refs, { source: { system: "similarity-engine", record_id: "R-2", version: "v1" } }),
    ],
  });

  assert.equal(batch.counts.created, 2);
  assert.equal(batch.counts.error, 2);
  assert.equal(batch.results[0].outcome, "created");
  assert.equal(batch.results[1].outcome, "error");
  assert.equal(batch.results[1].code, "UNKNOWN_DIMENSION_REF");
  assert.equal(batch.results[2].outcome, "error");
  assert.equal(batch.results[3].outcome, "created");
});

test("同一来源版本的精确重传不重复创建裁决", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);
  const record = batchRecord(refs);

  const first = service.importBatch({ system: "similarity-engine", records: [record] });
  assert.equal(first.results[0].outcome, "created");
  const candidateId = first.results[0].candidate_id;

  // 精确重传：不新增候选，返回既有候选标识
  const second = service.importBatch({ system: "similarity-engine", records: [record] });
  assert.equal(second.results[0].outcome, "duplicate");
  assert.equal(second.results[0].candidate_id, candidateId);

  // 候选完成双签形成裁决后再重传，依然不重复创建
  const decision = signBoth(service, candidateId);
  const third = service.importBatch({ system: "similarity-engine", records: [record] });
  assert.equal(third.results[0].outcome, "duplicate");
  assert.equal(service.events().filter((e) => e.event_type === "MAPPING_CANDIDATE_PROPOSED").length, 1);
  assert.equal(service.events().filter((e) => e.event_type === "MAPPING_DECISION_EFFECTIVE").length, 1);
  assert.equal(service.decision(decision.decision_id).status, "active");
});

test("同一来源版本内容变化进入争议，争议中候选不可签署", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);
  const record = batchRecord(refs);

  const first = service.importBatch({ system: "similarity-engine", records: [record] });
  const candidateId = first.results[0].candidate_id;

  // 同一来源版本，内容被改动（映射成自费辅助项目）
  const changed = { ...record, dimensions: { ...record.dimensions, national_item: "national_item:N900@1" } };
  const second = service.importBatch({ system: "similarity-engine", records: [changed] });
  assert.equal(second.results[0].outcome, "disputed");
  assert.equal(second.results[0].candidate_id, candidateId);

  assert.equal(service.candidate(candidateId).status, "disputed");
  assert.throws(() => service.signCandidate(candidateId, { signer_id: "expert-li", role: "coding_expert" }), /不可签署/);
  assert.equal(service.reviewQueue().disputes.length, 1);

  // 处置一：维持原结论，原候选恢复可签署
  const disputeId = second.results[0].dispute_id;
  service.resolveDispute(disputeId, { action: "keep_original", by: "expert-li" });
  assert.equal(service.candidate(candidateId).status, "proposed");
  assert.equal(service.reviewQueue().disputes.length, 0);
});

test("争议处置接受新内容时生成全新候选，原候选标记被取代", () => {
  const { service } = makeService();
  const refs = registerBaseDimensions(service);
  const record = batchRecord(refs);

  service.importBatch({ system: "similarity-engine", records: [record] });
  const changed = { ...record, similarity: 0.61 };
  const disputed = service.importBatch({ system: "similarity-engine", records: [changed] });
  const { candidate_id: oldCandidate, dispute_id } = disputed.results[0];

  const { new_candidate_id } = service.resolveDispute(dispute_id, { action: "accept_new", by: "policy-wang" });
  assert.ok(new_candidate_id);
  assert.equal(service.candidate(oldCandidate).status, "superseded");
  assert.equal(service.candidate(new_candidate_id).status, "proposed");
  assert.equal(service.candidate(new_candidate_id).similarity, 0.61);

  // 新候选仍需重新走双签流程才能生效
  const decision = signBoth(service, new_candidate_id);
  assert.equal(decision.status, "active");
});
