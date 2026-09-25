import assert from "node:assert/strict";
import test from "node:test";

import { buildWorld, AT, seedDimensions, seedLocalRestriction } from "./helpers.js";

function goodLine(overrides = {}) {
  return {
    line_key: "L-1",
    province: "33",
    hospital_ref: "H-SVC-1001",
    national_ref: "N-330701",
    local_restriction_ref: "LR-33",
    conclusion: "reimbursable_treatment",
    pricing_unit_ref: "U-SESSION",
    population_ref: "P-ADULT",
    effective_from: "2026-01-01",
    ...overrides,
  };
}

test("批量导入隔离单条坏数据：坏行被拒绝，同批好行正常受理", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "甲类" });

  const { results } = world.imports.importBatch({
    sourceSystem: "hospital-A-gateway",
    sourceVersion: "2026.09-v3",
    by: "batch-operator",
    at: AT,
    lines: [
      goodLine({ line_key: "BAD-1", conclusion: "whatever-invalid" }), // 结论非法
      goodLine({ line_key: "BAD-2", effective_from: "2026/01/01" }), // 日期格式非法
      goodLine({ line_key: "OK-1" }),
      goodLine({ line_key: "OK-2", province: "44", local_restriction_ref: undefined }), // 另一省、不限定
    ],
  });

  const byKey = Object.fromEntries(results.map((r) => [r.line_key, r]));
  assert.equal(byKey["BAD-1"].outcome, "rejected");
  assert.match(byKey["BAD-1"].reason, /IMPORT_LINE_INVALID/);
  assert.equal(byKey["BAD-2"].outcome, "rejected");
  assert.equal(byKey["OK-1"].outcome, "accepted");
  assert.equal(byKey["OK-2"].outcome, "accepted");

  // 好行形成裁决草案，等待双职责签署（导入不代替人签署）。
  const state = world.decisions.getState(byKey["OK-1"].decision_id);
  assert.equal(state.status, "proposed");
  assert.equal(state.signatures.length, 0);
  assert.equal(state.source.source_version, "2026.09-v3");

  // 批次事件流完整记录每行受理结果。
  const batchEvents = world.store.aggregateIds("import_batch:").flatMap((id) => world.store.loadStream(id));
  assert.equal(batchEvents.filter((e) => e.event_type === "BATCH_LINE_REJECTED").length, 2);
  assert.equal(batchEvents.filter((e) => e.event_type === "BATCH_LINE_ACCEPTED").length, 2);
});

test("同一来源版本的精确重传不重复创建裁决", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "甲类" });

  const first = world.imports.importBatch({
    sourceSystem: "hospital-A-gateway",
    sourceVersion: "2026.09-v3",
    at: AT,
    lines: [goodLine()],
  });
  const firstId = first.results[0].decision_id;

  // 同内容、同行键、同来源版本再传一遍（甚至换新批次）。
  const second = world.imports.importBatch({
    sourceSystem: "hospital-A-gateway",
    sourceVersion: "2026.09-v3",
    at: AT,
    batchId: "batch-retry",
    lines: [goodLine()],
  });
  assert.equal(second.results[0].outcome, "duplicate");
  assert.equal(second.results[0].decision_id, firstId);

  const decisions = world.store.aggregateIds("mapping_decision:");
  assert.equal(decisions.length, 1);
});

test("同来源版本内容变化进入争议，不覆盖当前结论", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "甲类" });

  const first = world.imports.importBatch({
    sourceSystem: "hospital-A-gateway",
    sourceVersion: "2026.09-v3",
    at: AT,
    lines: [goodLine()],
  });
  const decisionId = first.results[0].decision_id;

  // 重传时结论被改成自费辅助（同行键、同来源版本、不同内容）。
  const changed = world.imports.importBatch({
    sourceSystem: "hospital-A-gateway",
    sourceVersion: "2026.09-v3",
    at: AT,
    batchId: "batch-changed",
    lines: [goodLine({ conclusion: "self_paid_auxiliary", billing_category: "self_paid_auxiliary" })],
  });
  assert.equal(changed.results[0].outcome, "dispute_opened");
  assert.equal(changed.results[0].decision_id, decisionId);

  const state = world.decisions.getState(decisionId);
  assert.equal(state.status, "dispute");
  assert.equal(state.mapping.conclusion, "reimbursable_treatment"); // 原结论未被覆盖
  assert.equal(state.disputes[0].diff.changed_fields[0].field, "conclusion");
  assert.equal(state.disputes[0].review_key, "hospital-A-gateway/2026.09-v3/L-1");

  // 争议期间结算不可自动定结。
  const resolution = world.settlement.resolve({
    province: "33",
    hospital_ref: "H-SVC-1001",
    local_restriction_ref: "LR-33",
    pricing_unit_ref: "U-SESSION",
    population_ref: "P-ADULT",
    service_date: "2026-05-01",
  });
  assert.equal(resolution.kind, "pending");
  assert.equal(resolution.reason, "DISPUTE_OPEN");

  // 争议未关闭期间再来一次变化重传：不重复开争议。
  const again = world.imports.importBatch({
    sourceSystem: "hospital-A-gateway",
    sourceVersion: "2026.09-v3",
    at: AT,
    batchId: "batch-changed-2",
    lines: [goodLine({ conclusion: "self_paid_auxiliary", notes: "再次催促" })],
  });
  assert.equal(again.results[0].outcome, "dispute_pending");
  assert.equal(world.decisions.getState(decisionId).disputes.length, 1);
});

test("引用了不存在维度版本的行被隔离，不产生半截裁决", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  // 不发布地方限定 LR-33。
  const { results } = world.imports.importBatch({
    sourceSystem: "hospital-A-gateway",
    sourceVersion: "2026.09-v3",
    at: AT,
    lines: [goodLine()],
  });
  assert.equal(results[0].outcome, "rejected");
  assert.match(results[0].reason, /DIMENSION_AMBIGUOUS/);
  assert.equal(world.store.aggregateIds("mapping_decision:").length, 0);
});
