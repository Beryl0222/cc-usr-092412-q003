// 领域共享常量：五个独立版本化的裁决维度与两类签署职责。
export const DIMENSIONS = Object.freeze({
  HOSPITAL_CODE: "hospital_code", // 医院服务编码
  NATIONAL_ITEM: "national_item", // 国家目录项
  LOCAL_RESTRICTION: "local_restriction", // 地方限定
  PRICING_UNIT: "pricing_unit", // 计价单位
  ELIGIBLE_POPULATION: "eligible_population", // 适用人群
});

export const DIMENSION_VALUES = Object.freeze(Object.values(DIMENSIONS));

export const SIGN_ROLES = Object.freeze({
  CODING_EXPERT: "coding_expert", // 编码专家：对编码与临床语义负责
  PAYMENT_POLICY: "payment_policy", // 支付政策人员：对支付限定与适用范围负责
});

export const SIGN_ROLE_VALUES = Object.freeze(Object.values(SIGN_ROLES));

// 结算无法唯一判定时的待审原因（可解释、可枚举、可统计）。
export const PENDING_REASONS = Object.freeze({
  NO_DECISION: "NO_DECISION", // 该地点/日期下没有任何裁决
  MULTIPLE_ACTIVE_DECISIONS: "MULTIPLE_ACTIVE_DECISIONS", // 多条生效裁决重叠
  DIMENSION_AMBIGUOUS: "DIMENSION_AMBIGUOUS", // 计价单位/适用人群等维度无法匹配
  MISSING_REQUIRED_SIGNATURE: "MISSING_REQUIRED_SIGNATURE", // 双职责签署未齐
  OUTSIDE_EFFECTIVE_INTERVAL: "OUTSIDE_EFFECTIVE_INTERVAL", // 日期不落在任何生效区间
  DISPUTE_OPEN: "DISPUTE_OPEN", // 已进入争议，等待复核
  UNDER_HALT: "UNDER_HALT", // 紧急停用中，尚未结算的请求被阻断
  IMPORT_LINE_INVALID: "IMPORT_LINE_INVALID", // 批量导入坏行
});

export const AGGREGATE_TYPES = Object.freeze([
  "hospital_code",
  "national_item",
  "provincial_item",
  "pricing_unit",
  "eligible_population",
  "mapping_decision",
  "import_batch",
  "claim_line",
]);

export const EVENT_TYPES = Object.freeze([
  "DIMENSION_VERSION_DRAFTED",
  "DIMENSION_VERSION_PUBLISHED",
  "DIMENSION_VERSION_RETIRED",
  "CANDIDATE_SUGGESTED",
  "MAPPING_PROPOSED",
  "MAPPING_SIGNED",
  "MAPPING_ACTIVATED",
  "MAPPING_CONFLICT_FLAGGED",
  "MAPPING_DISPUTE_OPENED",
  "MAPPING_HALTED",
  "MAPPING_SUPERSEDED",
  "MAPPING_CORRECTED",
  "BATCH_IMPORTED",
  "BATCH_LINE_ACCEPTED",
  "BATCH_LINE_REJECTED",
  "CLAIM_SUBMITTED",
  "CLAIM_PENDING_REVIEW",
  "CLAIM_BLOCKED",
  "CLAIM_ADJUSTED",
  // 基线已有的事件名保持兼容。
  "VERSION_ACTIVATED",
  "CATALOG_DRAFTED",
]);

// 维度聚合 id：维度与业务键组合，版本是该聚合流内的事件序号。
export function dimensionAggregateId(dimension, refId) {
  return `${dimension}:${refId}`;
}
