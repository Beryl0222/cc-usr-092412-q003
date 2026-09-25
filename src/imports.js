import { randomUUID } from "node:crypto";

import { DIMENSIONS } from "./contracts.js";
import { contentHash, makeEvent } from "./events.js";

// 批量导入：
// - 逐行独立处理，单条坏数据只拒绝该行（BATCH_LINE_REJECTED），不影响同批其他行；
// - 同一来源版本 + 内容哈希精确重传：识别为重复，不重复创建裁决；
// - 同一来源版本 + 同一行键但内容变化：不覆盖，向既有裁决追加差异事件进入争议复核。

export function batchAggregateId(batchId) {
  return `import_batch:${batchId}`;
}

// 参与幂等判定的行内容（剔除行键本身与传输元数据）。
export function hashLineContent(line) {
  return contentHash({
    province: line.province,
    hospital_ref: line.hospital_ref,
    national_ref: line.national_ref,
    local_restriction_ref: line.local_restriction_ref ?? null,
    conclusion: line.conclusion,
    pricing_unit_ref: line.pricing_unit_ref ?? null,
    population_ref: line.population_ref ?? null,
    billing_category: line.billing_category ?? null,
    notes: line.notes ?? null,
    effective_from: line.effective_from,
    effective_to: line.effective_to ?? null,
  });
}

const CONCLUSIONS = new Set(["reimbursable_treatment", "self_paid_auxiliary", "other"]);

export class ImportService {
  constructor(store, decisions, registry, clock = () => new Date().toISOString()) {
    this.store = store;
    this.decisions = decisions;
    this.registry = registry;
    this.clock = clock;
  }

  importBatch({ sourceSystem, sourceVersion, lines, by, at = null, batchId = null }) {
    if (!sourceSystem || !sourceVersion) throw new Error("sourceSystem 与 sourceVersion 必填");
    const id = batchId ?? `batch-${randomUUID()}`;
    const aggregateId = batchAggregateId(id);
    const now = at ?? this.clock();

    const started = makeEvent({
      eventType: "BATCH_IMPORTED",
      aggregateType: "import_batch",
      aggregateId,
      at: now,
      by,
      payload: {
        batch_id: id,
        source_system: sourceSystem,
        source_version: sourceVersion,
        total_lines: lines.length,
      },
      summary: `接收批次 ${id}：来源 ${sourceSystem}@${sourceVersion}，共 ${lines.length} 行`,
    });
    let streamVersion = this.store.append(started, this.store.streamVersion(aggregateId)).version;

    const results = [];
    for (const line of lines) {
      // 任何单行异常都被隔离为该行拒绝，绝不能让一条坏数据中断整批。
      let outcome;
      try {
        outcome = this.#processLine({ id, sourceSystem, sourceVersion, line, by, now });
      } catch (err) {
        outcome = {
          line_key: line?.line_key ?? "(unknown)",
          outcome: "rejected",
          reason: `IMPORT_LINE_INVALID:${err.message}`,
        };
      }
      // rejected 才是坏数据；duplicate / dispute_* 都是本行已被正常处理的结论。
      const eventType = outcome.outcome === "rejected" ? "BATCH_LINE_REJECTED" : "BATCH_LINE_ACCEPTED";
      const lineEvent = makeEvent({
        eventType,
        aggregateType: "import_batch",
        aggregateId,
        at: now,
        by,
        payload: {
          batch_id: id,
          line_key: outcome.line_key,
          decision_id: outcome.decision_id ?? null,
          outcome: outcome.outcome,
          reason: outcome.reason ?? null,
          content_hash: outcome.content_hash ?? null,
        },
        summary:
          outcome.outcome === "accepted"
            ? `批次 ${id} 行 ${outcome.line_key} 已受理为裁决 ${outcome.decision_id}`
            : `批次 ${id} 行 ${outcome.line_key} 未自动受理：${outcome.reason}`,
      });
      streamVersion = this.store.append(lineEvent, streamVersion).version;
      results.push(outcome);
    }
    return { batchId: id, results };
  }

  #processLine({ id, sourceSystem, sourceVersion, line, by, now }) {
    const lineKey = line.line_key;
    const invalid = validateLine(line);

    // 1) 坏数据隔离：拒绝该行，给出可解释原因，其他行继续。
    if (invalid) {
      return { line_key: lineKey, outcome: "rejected", reason: `IMPORT_LINE_INVALID:${invalid}` };
    }

    const hash = hashLineContent(line);

    // 2) 精确重传：同来源版本、同内容哈希 → 幂等，不重复创建裁决。
    const exact = this.decisions.findBySourceFingerprint({
      sourceSystem,
      sourceVersion,
      hash,
    });
    if (exact) {
      return {
        line_key: lineKey,
        outcome: "duplicate",
        decision_id: exact,
        content_hash: hash,
        reason: "EXACT_RETRANSMISSION",
      };
    }

    // 3) 同来源版本、同行键但内容变化：差异进入争议，绝不用新内容覆盖当前结论。
    const prior = this.decisions.findBySourceLine({ sourceSystem, sourceVersion, lineKey });
    if (prior) {
      if (prior.status === "dispute") {
        return {
          line_key: lineKey,
          outcome: "dispute_pending",
          decision_id: prior.decisionId,
          content_hash: hash,
          reason: "CONTENT_CHANGED_DISPUTE_ALREADY_OPEN",
        };
      }
      const diff = diffLine(this.decisions.getState(prior.decisionId), line);
      this.decisions.openDispute(prior.decisionId, {
        by: by ?? "import-batch",
        reason: `同来源版本 ${sourceVersion} 的行 ${lineKey} 重传内容与首次不同，进入争议复核`,
        diff: { previous_hash: prior.contentHash, new_hash: hash, changed_fields: diff },
        reviewKey: `${sourceSystem}/${sourceVersion}/${lineKey}`,
        at: now,
      });
      return {
        line_key: lineKey,
        outcome: "dispute_opened",
        decision_id: prior.decisionId,
        content_hash: hash,
        reason: "CONTENT_CHANGED_DISPUTE",
      };
    }

    // 4) 新行：固定五维当前已发布版本，缺版本不允许凭空建裁决（坏行隔离）。
    const bound = this.#bindRevisions(line);
    if (bound.error) {
      return { line_key: lineKey, outcome: "rejected", reason: bound.error, content_hash: hash };
    }

    const { decisionId } = this.decisions.propose({
      by: by ?? "import-batch",
      at: now,
      selector: {
        province: line.province,
        hospital_ref: line.hospital_ref,
        local_restriction_ref: line.local_restriction_ref ?? null,
        pricing_unit_ref: line.pricing_unit_ref ?? null,
        population_ref: line.population_ref ?? null,
      },
      mapping: {
        national_ref: line.national_ref,
        conclusion: line.conclusion,
        billing_category: line.billing_category ?? line.conclusion,
        notes: line.notes ?? null,
      },
      boundRevisions: bound.revisions,
      effectiveFrom: line.effective_from,
      effectiveTo: line.effective_to ?? null,
      correlationId: id,
      source: {
        source_system: sourceSystem,
        source_version: sourceVersion,
        content_hash: hash,
        import_batch_id: id,
        line_key: lineKey,
      },
    });

    return { line_key: lineKey, outcome: "accepted", decision_id: decisionId, content_hash: hash };
  }

  #bindRevisions(line) {
    const hospital = this.registry.current(DIMENSIONS.HOSPITAL_CODE, line.hospital_ref);
    if (!hospital) return { error: `DIMENSION_AMBIGUOUS:医院编码 ${line.hospital_ref} 尚无已发布版本` };
    const national = this.registry.current(DIMENSIONS.NATIONAL_ITEM, line.national_ref);
    if (!national) return { error: `DIMENSION_AMBIGUOUS:国家目录项 ${line.national_ref} 尚无已发布版本` };
    const revisions = {
      hospital_code: hospital.revision,
      national_item: national.revision,
      local_restriction: null,
      pricing_unit: null,
      eligible_population: null,
    };
    if (line.local_restriction_ref) {
      const restriction = this.registry.current(DIMENSIONS.LOCAL_RESTRICTION, line.local_restriction_ref);
      if (!restriction) {
        return { error: `DIMENSION_AMBIGUOUS:地方限定 ${line.local_restriction_ref} 尚无已发布版本` };
      }
      revisions.local_restriction = restriction.revision;
    }
    if (line.pricing_unit_ref) {
      const unit = this.registry.current(DIMENSIONS.PRICING_UNIT, line.pricing_unit_ref);
      if (!unit) return { error: `DIMENSION_AMBIGUOUS:计价单位 ${line.pricing_unit_ref} 尚无已发布版本` };
      revisions.pricing_unit = unit.revision;
    }
    if (line.population_ref) {
      const pop = this.registry.current(DIMENSIONS.ELIGIBLE_POPULATION, line.population_ref);
      if (!pop) return { error: `DIMENSION_AMBIGUOUS:适用人群 ${line.population_ref} 尚无已发布版本` };
      revisions.eligible_population = pop.revision;
    }
    return { revisions };
  }
}

function validateLine(line) {
  if (!line || typeof line !== "object") return "行不是对象";
  if (typeof line.line_key !== "string" || line.line_key.length === 0) return "line_key 缺失";
  if (typeof line.province !== "string" || line.province.length === 0) return "province 缺失";
  if (typeof line.hospital_ref !== "string" || line.hospital_ref.length === 0) return "hospital_ref 缺失";
  if (typeof line.national_ref !== "string" || line.national_ref.length === 0) return "national_ref 缺失";
  if (!CONCLUSIONS.has(line.conclusion)) return `conclusion 非法：${line.conclusion}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(line.effective_from ?? "")) return "effective_from 不是 YYYY-MM-DD";
  if (line.effective_to && (!/^\d{4}-\d{2}-\d{2}$/.test(line.effective_to) || line.effective_to <= line.effective_from)) {
    return "effective_to 非法或早于 effective_from";
  }
  return null;
}

function diffLine(state, line) {
  const before = {
    province: state.selector.province,
    hospital_ref: state.selector.hospital_ref,
    national_ref: state.mapping.national_ref,
    local_restriction_ref: state.selector.local_restriction_ref ?? null,
    conclusion: state.mapping.conclusion,
    pricing_unit_ref: state.selector.pricing_unit_ref,
    population_ref: state.selector.population_ref,
    billing_category: state.mapping.billing_category,
    notes: state.mapping.notes,
    effective_from: state.effectiveFrom,
    effective_to: state.effectiveTo,
  };
  const after = {
    province: line.province,
    hospital_ref: line.hospital_ref,
    national_ref: line.national_ref,
    local_restriction_ref: line.local_restriction_ref ?? null,
    conclusion: line.conclusion,
    pricing_unit_ref: line.pricing_unit_ref ?? null,
    population_ref: line.population_ref ?? null,
    billing_category: line.billing_category ?? line.conclusion,
    notes: line.notes ?? null,
    effective_from: line.effective_from,
    effective_to: line.effective_to ?? null,
  };
  return Object.keys(after)
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ field: k, from: before[k], to: after[k] }));
}
