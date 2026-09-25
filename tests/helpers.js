import { CatalogMappingService } from "../src/service.js";

/** 可控时钟的服务实例：测试通过 setNow 推进时间。 */
export function makeService(start = "2026-01-01T00:00:00+08:00") {
  let current = start;
  const service = new CatalogMappingService({ now: () => current });
  return {
    service,
    setNow(iso) {
      current = iso;
    },
  };
}

/** 登记一套覆盖五个维度的基础目录版本，返回可直接引用的维度引用。 */
export function registerBaseDimensions(service) {
  const entries = [
    ["hospital_code", "H1001", 1, { name: "经皮冠状动脉支架置入术", hospital: "示例医院" }],
    ["hospital_code", "H1001", 2, { name: "经皮冠状动脉支架置入术（修订）", hospital: "示例医院" }],
    ["national_item", "N500", 1, { name: "冠状动脉支架置入治疗", reimbursable: true }],
    ["national_item", "N900", 1, { name: "术后康复辅助项目", reimbursable: false }],
    ["local_restriction", "LR-GD", 1, { province: "广东", note: "限三级医院" }],
    ["pricing_unit", "PU-CI", 1, { unit: "次" }],
    ["applicable_population", "AP-ADULT", 1, { population: "成人" }],
  ];
  for (const [dimension, key, version, payload] of entries) {
    service.registerDimensionVersion({ dimension, key, version, payload, effective_from: "2026-01-01T00:00:00+08:00" });
  }
  return {
    hospital_code: "hospital_code:H1001@1",
    national_item: "national_item:N500@1",
    local_restriction: "local_restriction:LR-GD@1",
    pricing_unit: "pricing_unit:PU-CI@1",
    applicable_population: "applicable_population:AP-ADULT@1",
  };
}

/** 构造一条机器相似度提案，可按需覆盖字段。 */
export function makeProposal(refs, overrides = {}) {
  return {
    source: { system: "similarity-engine", record_id: "REC-1", version: "v1" },
    region: "广东",
    dimensions: { ...refs },
    similarity: 0.93,
    evidence: { model: "sim-v2", matched_features: ["name", "unit"] },
    proposed_interval: { from: "2026-02-01T00:00:00+08:00", to: null },
    ...overrides,
  };
}

/** 按职责完成双签，返回生效裁决。 */
export function signBoth(service, candidate_id) {
  service.signCandidate(candidate_id, { signer_id: "expert-li", role: "coding_expert", comment: "编码对应关系确认" });
  const result = service.signCandidate(candidate_id, { signer_id: "policy-wang", role: "payment_policy", comment: "支付政策确认" });
  return result.decision;
}
