import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrencyError } from "../src/event-store.js";
import { SIGN_ROLES, PENDING_REASONS } from "../src/contracts.js";
import { buildWorld, AT, seedDimensions, seedLocalRestriction, makeActiveDecision } from "./helpers.js";

test("五个维度各自独立版本化，历史 revision 永久保留", () => {
  const { registry } = buildWorld();
  seedDimensions(registry);

  registry.publishRevision({
    dimension: "national_item",
    refId: "N-330701",
    content: { code: "330701", name: "经皮冠状动脉药物洗脱支架置入术", aliases: [], category: "治疗" },
    by: "national-catalog",
    at: AT,
    reason: "国家目录年度调整",
  });

  const r1 = registry.getRevision("national_item", "N-330701", 1);
  const r2 = registry.getRevision("national_item", "N-330701", 2);
  assert.equal(r1.content.name, "经皮冠状动脉支架置入术");
  assert.equal(r2.content.name, "经皮冠状动脉药物洗脱支架置入术");
  assert.equal(registry.current("national_item", "N-330701").revision, 2);

  // 其他维度版本号互不影响。
  assert.equal(registry.current("hospital_code", "H-SVC-1001").revision, 1);
  assert.equal(registry.current("pricing_unit", "U-SESSION").revision, 1);
});

test("机器相似度只产出候选证据，不形成任何结论", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  const candidates = world.similarity.suggestCandidates({
    hospitalRef: "H-SVC-1001",
    nationalRefs: ["N-330701"],
    at: AT,
  });
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].score > 0);
  assert.ok(candidates[0].signals.length > 0);
  // 没有任何裁决聚合被创建。
  assert.deepEqual(world.store.aggregateIds("mapping_decision:"), []);
});

test("编码专家与支付政策人员双职责签署齐备后裁决才可生效", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "按治疗项目支付" });

  const bound = {
    hospital_code: 1,
    national_item: 1,
    local_restriction: 1,
    pricing_unit: 1,
    eligible_population: 1,
  };
  const { decisionId: half } = world.decisions.propose({
    at: AT,
    selector: { province: "33", hospital_ref: "H-SVC-1001", local_restriction_ref: "LR-33", pricing_unit_ref: "U-SESSION", population_ref: "P-ADULT" },
    mapping: { national_ref: "N-330701", conclusion: "self_paid_auxiliary", billing_category: "self_paid_auxiliary" },
    boundRevisions: bound,
    effectiveFrom: "2027-01-01",
  });
  world.decisions.sign(half, { role: SIGN_ROLES.CODING_EXPERT, by: "expert-zhang", at: AT });
  assert.throws(
    () => world.decisions.activate(half, { at: AT }),
    (err) => err.code === "MISSING_REQUIRED_SIGNATURE" && err.missingRoles.includes("payment_policy"),
  );

  // 补齐支付政策签署后可以激活。
  world.decisions.sign(half, { role: SIGN_ROLES.PAYMENT_POLICY, by: "policy-li", at: AT });
  assert.equal(world.decisions.activate(half, { at: AT }).status, "active");
});

test("两个省份对同一医院编码分别映射为可报销治疗与自费辅助，结算按发生地各自选取", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "纳入甲类支付" });
  seedLocalRestriction(world.registry, "44", { province: "44", rule: "按辅助项目自费" });

  const zj = makeActiveDecision(world, { province: "33", conclusion: "reimbursable_treatment" });
  const gd = makeActiveDecision(world, { province: "44", conclusion: "self_paid_auxiliary" });

  const inZhejiang = world.settlement.resolve({
    province: "33",
    hospital_ref: "H-SVC-1001",
    local_restriction_ref: "LR-33",
    pricing_unit_ref: "U-SESSION",
    population_ref: "P-ADULT",
    service_date: "2026-05-01",
  });
  const inGuangdong = world.settlement.resolve({
    province: "44",
    hospital_ref: "H-SVC-1001",
    local_restriction_ref: "LR-44",
    pricing_unit_ref: "U-SESSION",
    population_ref: "P-ADULT",
    service_date: "2026-05-01",
  });
  assert.equal(inZhejiang.kind, "resolved");
  assert.equal(inZhejiang.decision_id, zj);
  assert.equal(inZhejiang.mapping.conclusion, "reimbursable_treatment");
  assert.equal(inGuangdong.kind, "resolved");
  assert.equal(inGuangdong.decision_id, gd);
  assert.equal(inGuangdong.mapping.conclusion, "self_paid_auxiliary");
});

test("冲突候选不得自动覆盖当前结论：第二条生效区间重叠的裁决只登记冲突", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "纳入甲类支付" });

  const incumbent = makeActiveDecision(world, { province: "33", conclusion: "reimbursable_treatment" });

  const { decisionId: challenger } = world.decisions.propose({
    at: AT,
    selector: { province: "33", hospital_ref: "H-SVC-1001", local_restriction_ref: "LR-33", pricing_unit_ref: "U-SESSION", population_ref: "P-ADULT" },
    mapping: { national_ref: "N-330701", conclusion: "self_paid_auxiliary", billing_category: "self_paid_auxiliary" },
    boundRevisions: { hospital_code: 1, national_item: 1, local_restriction: 1, pricing_unit: 1, eligible_population: 1 },
    effectiveFrom: "2026-01-01",
  });
  world.decisions.sign(challenger, { role: "coding_expert", by: "expert-wang", at: AT });
  world.decisions.sign(challenger, { role: "payment_policy", by: "policy-zhao", at: AT });
  const result = world.decisions.activate(challenger, { at: AT });

  assert.equal(result.status, "conflict_flagged");
  assert.equal(result.incumbent, incumbent);
  // 现任裁决保持生效，结算仍取现任。
  assert.equal(world.decisions.getState(incumbent).status, "active");
  assert.equal(world.decisions.getState(challenger).status, "proposed");
  assert.equal(world.decisions.getState(incumbent).conflicts[0].challenger_decision_id, challenger);
  const resolved = world.settlement.resolve({
    province: "33",
    hospital_ref: "H-SVC-1001",
    local_restriction_ref: "LR-33",
    pricing_unit_ref: "U-SESSION",
    population_ref: "P-ADULT",
    service_date: "2026-05-01",
  });
  assert.equal(resolved.decision_id, incumbent);
});

test("紧急停用只阻断尚未结算的请求；已结算病例固定当时版本不变", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "纳入甲类支付" });
  const id = makeActiveDecision(world, { province: "33", conclusion: "reimbursable_treatment" });

  const req = {
    province: "33",
    hospital_ref: "H-SVC-1001",
    local_restriction_ref: "LR-33",
    pricing_unit_ref: "U-SESSION",
    population_ref: "P-ADULT",
    service_date: "2026-05-01",
  };
  world.settlement.settle("CLAIM-1", req, { at: "2026-05-02T10:00:00+08:00" });

  world.decisions.halt(id, { by: "policy-li", reason: "国家飞检发现违规使用", at: "2026-06-01T09:00:00+08:00" });

  // 停用之后新来的请求被阻断。
  const blocked = world.settlement.resolve({ ...req, service_date: "2026-06-02" });
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.reason, PENDING_REASONS.UNDER_HALT);

  // 已结算记录原样保留，仍能反查到 active 时的结论与固定版本。
  const claim = world.settlement.getClaim("CLAIM-1");
  assert.equal(claim.status, "adjusted");
  assert.equal(claim.terminal.decision_id, id);
  assert.equal(claim.terminal.mapping.conclusion, "reimbursable_treatment");
  assert.equal(claim.terminal.decision_event_version, 4); // proposed + 2 signed + activated
  const dossier = world.audit.dossier("CLAIM-1");
  assert.equal(dossier.fixed_decision.status_then, "active");
  assert.equal(dossier.fixed_decision.status_now, "halted");
  assert.ok(dossier.fixed_decision.later_events.some((e) => e.event_type === "MAPPING_HALTED"));
});

test("历史病案引用旧版目录：目录再版后已结算记录固定的仍是当时 revision", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "纳入甲类支付" });
  const id = makeActiveDecision(world, { province: "33", conclusion: "reimbursable_treatment" });

  world.settlement.settle(
    "CLAIM-OLD",
    {
      province: "33",
      hospital_ref: "H-SVC-1001",
      local_restriction_ref: "LR-33",
      pricing_unit_ref: "U-SESSION",
      population_ref: "P-ADULT",
      service_date: "2026-03-01",
    },
    { at: "2026-03-02T10:00:00+08:00" },
  );

  // 国家目录项与医院编码随后再版。
  world.registry.publishRevision({
    dimension: "national_item",
    refId: "N-330701",
    content: { code: "330701", name: "经皮冠状动脉药物洗脱支架置入术", aliases: [], category: "治疗" },
    by: "national-catalog",
    at: "2026-07-01T00:00:00+08:00",
  });
  world.registry.publishRevision({
    dimension: "hospital_code",
    refId: "H-SVC-1001",
    content: { code: "H-SVC-1001", name: "经皮冠状动脉支架置入术（修订名称）", aliases: [], department: "心内科" },
    by: "hospital-etl",
    at: "2026-07-01T00:00:00+08:00",
  });

  const dossier = world.audit.dossier("CLAIM-OLD");
  assert.equal(dossier.fixed_decision.bound_revisions.national_item, 1);
  assert.equal(dossier.fixed_decision.bound_revisions.hospital_code, 1);
  assert.equal(dossier.fixed_decision.dimension_snapshots.national_item.content.name, "经皮冠状动脉支架置入术");
  assert.equal(world.registry.current("national_item", "N-330701").revision, 2);
  assert.ok(world.audit.claimsUsingDecision(id).includes("CLAIM-OLD"));
});

test("后续更正通过差异事件进入复核：旧裁决收口但区间外已结算不动，新请求走后继", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "纳入甲类支付" });
  const old = makeActiveDecision(world, { province: "33", conclusion: "reimbursable_treatment" });

  world.settlement.settle(
    "CLAIM-HIST",
    {
      province: "33",
      hospital_ref: "H-SVC-1001",
      local_restriction_ref: "LR-33",
      pricing_unit_ref: "U-SESSION",
      population_ref: "P-ADULT",
      service_date: "2026-05-01",
    },
    { at: "2026-05-02T10:00:00+08:00" },
  );

  // 发现当初结论错误：差异事件进入争议。
  world.decisions.openDispute(old, {
    by: "auditor-chen",
    reason: "飞检复核：该服务在地方限定下应按自费辅助项目",
    diff: [{ field: "conclusion", from: "reimbursable_treatment", to: "self_paid_auxiliary" }],
    reviewKey: "review/2026-09/007",
    at: "2026-09-10T09:00:00+08:00",
  });

  // 复核通过：另立后继裁决，重新双签；旧裁决在后继生效日收口为 corrected。
  const { decisionId: successor } = world.decisions.proposeCorrection(old, {
    at: "2026-09-11T09:00:00+08:00",
    by: "review-board",
    selector: { province: "33", hospital_ref: "H-SVC-1001", local_restriction_ref: "LR-33", pricing_unit_ref: "U-SESSION", population_ref: "P-ADULT" },
    mapping: { national_ref: "N-330701", conclusion: "self_paid_auxiliary", billing_category: "self_paid_auxiliary", notes: "复核更正" },
    boundRevisions: { hospital_code: 1, national_item: 1, local_restriction: 1, pricing_unit: 1, eligible_population: 1 },
    effectiveFrom: "2026-09-15",
  });
  world.decisions.sign(successor, { role: "coding_expert", by: "expert-zhang", at: "2026-09-11T10:00:00+08:00" });
  world.decisions.sign(successor, { role: "payment_policy", by: "policy-li", at: "2026-09-11T10:00:00+08:00" });
  world.decisions.activate(successor, { at: "2026-09-11T10:00:00+08:00" });
  world.decisions.closeIncumbent(old, successor, {
    kind: "correction",
    diff: [{ field: "conclusion", from: "reimbursable_treatment", to: "self_paid_auxiliary" }],
    reviewKey: "review/2026-09/007",
    effectiveTo: "2026-09-15",
    at: "2026-09-11T10:00:00+08:00",
  });

  // 旧区间内的历史病例仍固定旧结论；后继生效日后的请求取后继。
  const dossier = world.audit.dossier("CLAIM-HIST");
  assert.equal(dossier.fixed_decision.decision_id, old);
  assert.equal(dossier.fixed_decision.mapping_then.conclusion, "reimbursable_treatment");
  assert.equal(dossier.fixed_decision.status_now, "corrected");
  assert.equal(dossier.chain.length, 2);
  assert.equal(dossier.chain[1].decision_id, successor);
  assert.ok(
    dossier.chain[0].events_after_settlement.some((e) => e.event_type === "MAPPING_DISPUTE_OPENED") &&
      dossier.chain[0].events_after_settlement.some((e) => e.event_type === "MAPPING_CORRECTED"),
  );

  const after = world.settlement.resolve({
    province: "33",
    hospital_ref: "H-SVC-1001",
    local_restriction_ref: "LR-33",
    pricing_unit_ref: "U-SESSION",
    population_ref: "P-ADULT",
    service_date: "2026-09-20",
  });
  assert.equal(after.kind, "resolved");
  assert.equal(after.decision_id, successor);
  assert.equal(after.mapping.conclusion, "self_paid_auxiliary");
});

test("待审原因矩阵：无裁决 / 区间外 / 缺维度声明 / 争议中 / 多条重叠", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  seedLocalRestriction(world.registry, "33", { province: "33", rule: "纳入甲类支付" });

  const baseReq = {
    province: "33",
    hospital_ref: "H-SVC-1001",
    local_restriction_ref: "LR-33",
    pricing_unit_ref: "U-SESSION",
    population_ref: "P-ADULT",
  };

  assert.equal(world.settlement.resolve({ ...baseReq, service_date: "2026-05-01" }).reason, PENDING_REASONS.NO_DECISION);

  makeActiveDecision(world, { province: "33", conclusion: "reimbursable_treatment", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-01" });
  assert.equal(world.settlement.resolve({ ...baseReq, service_date: "2026-06-15" }).reason, PENDING_REASONS.OUTSIDE_EFFECTIVE_INTERVAL);

  // 请求漏声明裁决限定的计价单位 → 维度无法判断。
  const { pricing_unit_ref: _omit, ...missingUnit } = baseReq;
  assert.equal(world.settlement.resolve({ ...missingUnit, service_date: "2026-05-01" }).reason, PENDING_REASONS.DIMENSION_AMBIGUOUS);

  // 争议中。
  const id = world.decisions.listByProvince("33")[0].decisionId;
  world.decisions.openDispute(id, { by: "auditor-chen", reason: "有人举报", at: "2026-05-03T00:00:00+08:00" });
  assert.equal(world.settlement.resolve({ ...baseReq, service_date: "2026-05-01" }).reason, PENDING_REASONS.DISPUTE_OPEN);

  // settle 落 pending 事件，包含可解释说明。
  const { resolution } = world.settlement.settle("CLAIM-PEND", { ...baseReq, service_date: "2026-05-01" });
  assert.equal(resolution.kind, "pending");
  assert.match(resolution.explanation, /争议复核/);
  assert.equal(world.settlement.getClaim("CLAIM-PEND").status, "pending_review");
});

test("乐观并发：过期版本号追加被拒绝，事件不可原地改写", () => {
  const world = buildWorld();
  seedDimensions(world.registry);
  const events = world.store.loadStream("national_item:N-330701");
  assert.throws(
    () =>
      world.store.append(
        {
          event_id: "dup-test",
          event_type: "DIMENSION_VERSION_DRAFTED",
          aggregate_type: "national_item",
          aggregate_id: "national_item:N-330701",
          occurred_at: AT,
          version: 1,
          summary: "过期写入",
          payload: {},
        },
        0,
      ),
    ConcurrencyError,
  );
  assert.equal(events.length, world.store.loadStream("national_item:N-330701").length);
});
