// 目录语义裁决服务统一入口。
export * from "./contracts.js";
export { validateEvent } from "./validator.js";
export { EventStore, ConcurrencyError, InvalidEventError } from "./event-store.js";
export { makeEvent, newEventId, contentHash, canonicalJson } from "./events.js";
export { DimensionRegistry } from "./dimensions.js";
export { SimilarityEngine, defaultSimilarity } from "./similarity.js";
export {
  DecisionService,
  replayDecision,
  decisionAggregateId,
  sameSelector,
  intervalsOverlap,
} from "./decisions.js";
export { ImportService, batchAggregateId, hashLineContent } from "./imports.js";
export { SettlementService, claimAggregateId } from "./settlement.js";
export { AuditService } from "./audit.js";
