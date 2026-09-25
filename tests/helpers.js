import { EventStore } from "../src/event-store.js";
import { DimensionRegistry } from "../src/dimensions.js";
import { DecisionService } from "../src/decisions.js";
import { SettlementService } from "../src/settlement.js";
import { ImportService } from "../src/imports.js";
import { AuditService } from "../src/audit.js";
import { SimilarityEngine } from "../src/similarity.js";

// 测试世界：固定时钟 + 内存事件存储 + 全部领域服务。
export function buildWorld() {
  const store = new EventStore();
  const clock = () => "2026-09-25T08:00:00+08:00";
  const registry = new DimensionRegistry(store);
  const decisions = new DecisionService(store, clock);
  const settlement = new SettlementService(store, decisions, registry, clock);
  const imports = new ImportService(store, decisions, registry, clock);
  const audit = new AuditService(store, registry);
  const similarity = new SimilarityEngine(registry);
  return { store, registry, decisions, settlement, imports, audit, similarity, clock };
}

export const AT = "2026-09-25T08:00:00+08:00";
// 需要在历史日期结算的场景，裁决生命周期统一放在年初，早于所有就诊日期。
export const DECISION_AT = "2026-01-02T08:00:00+08:00";

export function seedDimensions(registry, overrides = {}) {
  const at = "2025-12-01T00:00:00+08:00";
  registry.publishRevision({
    dimension: "hospital_code",
    refId: "H-SVC-1001",
    content: { code: "H-SVC-1001", name: "经皮冠状动脉支架置入术", aliases: ["冠脉支架"], department: "心内科" },
    by: "hospital-etl",
    at,
    ...overrides.hospital,
  });
  registry.publishRevision({
    dimension: "national_item",
    refId: "N-330701",
    content: { code: "330701", name: "经皮冠状动脉支架置入术", aliases: ["冠脉支架置入"], category: "治疗" },
    by: "national-catalog",
    at,
    ...overrides.national,
  });
  registry.publishRevision({
    dimension: "pricing_unit",
    refId: "U-SESSION",
    content: { code: "U-SESSION", name: "次", definition: "按手术次数计价" },
    by: "pricing-office",
    at,
    ...overrides.unit,
  });
  registry.publishRevision({
    dimension: "eligible_population",
    refId: "P-ADULT",
    content: { code: "P-ADULT", name: "成人", min_age: 18 },
    by: "policy-office",
    at,
    ...overrides.population,
  });
}

export function seedLocalRestriction(registry, province, content, overrides = {}) {
  return registry.publishRevision({
    dimension: "local_restriction",
    refId: `LR-${province}`,
    content,
    by: `${province}-policy`,
    at: "2025-12-01T00:00:00+08:00",
    ...overrides,
  });
}

// 建一条裁决并走完双签 + 激活。
export function makeActiveDecision(world, {
  province,
  conclusion,
  hospitalRef = "H-SVC-1001",
  nationalRef = "N-330701",
  localRestrictionRef = `LR-${province}`,
  unitRef = "U-SESSION",
  populationRef = "P-ADULT",
  effectiveFrom = "2026-01-01",
  effectiveTo = null,
  source = null,
  correctionOf = null,
  decisionId = undefined,
  notes = null,
}) {
  const { decisions, registry } = world;
  const bound = {
    hospital_code: registry.current("hospital_code", hospitalRef).revision,
    national_item: registry.current("national_item", nationalRef).revision,
    local_restriction: localRestrictionRef ? registry.current("local_restriction", localRestrictionRef).revision : null,
    pricing_unit: unitRef ? registry.current("pricing_unit", unitRef).revision : null,
    eligible_population: populationRef ? registry.current("eligible_population", populationRef).revision : null,
  };
  const { decisionId: id } = decisions.propose({
    decisionId,
    at: DECISION_AT,
    selector: {
      province,
      hospital_ref: hospitalRef,
      local_restriction_ref: localRestrictionRef,
      pricing_unit_ref: unitRef,
      population_ref: populationRef,
    },
    mapping: { national_ref: nationalRef, conclusion, billing_category: conclusion, notes },
    boundRevisions: bound,
    effectiveFrom,
    effectiveTo,
    source,
    correctionOf,
  });
  decisions.sign(id, { role: "coding_expert", by: "expert-zhang", at: DECISION_AT });
  decisions.sign(id, { role: "payment_policy", by: "policy-li", at: DECISION_AT });
  decisions.activate(id, { at: DECISION_AT });
  return id;
}
