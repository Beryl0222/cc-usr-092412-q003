import { DomainError, EventStore, contentHash, timestampOf } from "./store.js";

/** 分别版本化的五个目录维度。 */
export const DIMENSIONS = ["hospital_code", "national_item", "local_restriction", "pricing_unit", "applicable_population"];

/** 裁决所需的两类签署职责，缺一不可，且不得由同一人兼任。 */
export const SIGNING_ROLES = ["coding_expert", "payment_policy"];

/** 结算解析返回的待审原因码。 */
export const PENDING_REASONS = {
  NO_EFFECTIVE_MAPPING: "NO_EFFECTIVE_MAPPING",
  CONFLICTING_MAPPINGS: "CONFLICTING_MAPPINGS",
  EMERGENCY_DEACTIVATED: "EMERGENCY_DEACTIVATED",
};

function assertPresent(fields, source) {
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      throw new DomainError("MISSING_FIELD", `${source}缺少字段：${name}`);
    }
  }
}

function intervalsOverlap(a, b) {
  const aTo = a.to === null ? Infinity : timestampOf(a.to);
  const bTo = b.to === null ? Infinity : timestampOf(b.to);
  return timestampOf(a.from) < bTo && timestampOf(b.from) < aTo;
}

/**
 * 医保目录语义裁决服务。
 *
 * 核心不变量：
 * 1. 机器相似度只能生成候选，裁决必须经编码专家与支付政策人员双角色签署后形成；
 * 2. 冲突候选不得自动覆盖当前结论，重叠期间由结算接口返回可解释的待审原因；
 * 3. 紧急停用只阻断尚未结算的请求，已结算记录固定当时版本；
 * 4. 后续更正通过差异事件进入复核，不改写历史记录。
 */
export class CatalogMappingService {
  #now;
  #store;
  #ids = new Map();
  #dimensions = new Map(); // `${dimension}:${key}` -> 版本数组（按 version 升序）
  #candidates = new Map();
  #decisions = new Map();
  #claims = new Map();
  #differences = new Map();
  #disputes = new Map();
  #sourceIndex = new Map(); // `${system}:${record_id}:${version}` -> { content_hash, candidate_id }

  constructor({ now } = {}) {
    this.#now = now ?? (() => new Date().toISOString());
    this.#store = new EventStore();
  }

  #nextId(prefix) {
    const seq = (this.#ids.get(prefix) ?? 0) + 1;
    this.#ids.set(prefix, seq);
    return `${prefix}-${seq}`;
  }

  #emit(event_type, aggregate_type, aggregate_id, summary, data) {
    return this.#store.append({ event_type, aggregate_type, aggregate_id, occurred_at: this.#now(), summary, data });
  }

  events() {
    return this.#store.all();
  }

  // ---------------------------------------------------------------------------
  // 一、目录维度版本化：医院编码、国家目录项、地方限定、计价单位、适用人群分别版本化
  // ---------------------------------------------------------------------------

  /**
   * 登记某维度的一个新版本。版本号必须严格递增，已登记的版本不得原地改写。
   * @returns 维度引用，形如 "hospital_code:H1001@1"
   */
  registerDimensionVersion({ dimension, key, version, payload, effective_from }) {
    assertPresent({ dimension, key, version, payload, effective_from }, "维度版本");
    if (!DIMENSIONS.includes(dimension)) {
      throw new DomainError("UNKNOWN_DIMENSION", `未知维度：${dimension}，仅支持 ${DIMENSIONS.join("/")}`);
    }
    if (!Number.isInteger(version) || version < 1) {
      throw new DomainError("INVALID_VERSION", `维度版本必须是正整数：${version}`);
    }
    timestampOf(effective_from, "维度生效时间");

    const chainKey = `${dimension}:${key}`;
    const chain = this.#dimensions.get(chainKey) ?? [];
    const latest = chain.at(-1);
    if (latest && version <= latest.version) {
      throw new DomainError(
        "VERSION_NOT_MONOTONIC",
        `${chainKey} 已存在版本 ${latest.version}，新版本 ${version} 不得原地改写或回退`,
      );
    }
    chain.push({ dimension, key, version, payload, effective_from, registered_at: this.#now() });
    this.#dimensions.set(chainKey, chain);

    const ref = `${chainKey}@${version}`;
    this.#emit("DIMENSION_VERSION_REGISTERED", "catalog_dimension", chainKey, `登记维度版本 ${ref}`, {
      dimension,
      key,
      version,
      payload,
      effective_from,
    });
    return ref;
  }

  dimensionVersion(dimension, key, version) {
    const chain = this.#dimensions.get(`${dimension}:${key}`) ?? [];
    return chain.find((entry) => entry.version === version) ?? null;
  }

  #requireDimensionRef(ref) {
    const match = /^([a-z_]+):([^@]+)@(\d+)$/.exec(ref ?? "");
    if (!match) throw new DomainError("BAD_DIMENSION_REF", `维度引用格式应为 dimension:key@version：${ref}`);
    const [, dimension, key, version] = match;
    const entry = this.dimensionVersion(dimension, key, Number(version));
    if (!entry) throw new DomainError("UNKNOWN_DIMENSION_REF", `维度版本不存在：${ref}`);
    return entry;
  }

  // ---------------------------------------------------------------------------
  // 二、机器相似度生成候选（且只能生成候选）
  // ---------------------------------------------------------------------------

  /**
   * 机器相似度提案入口。无论相似度多高，产物都只是候选，不直接形成裁决。
   * 同一来源版本（system + record_id + version）精确重传时返回既有候选，不重复创建；
   * 内容发生变化则把既有候选置入争议。
   */
  proposeCandidate({ source, region, dimensions, similarity, evidence, proposed_interval }) {
    assertPresent({ source, region, dimensions, similarity, proposed_interval }, "候选提案");
    assertPresent(
      { system: source.system, record_id: source.record_id, version: source.version },
      "候选提案来源",
    );
    assertPresent({ from: proposed_interval.from }, "候选生效区间");
    if (typeof similarity !== "number" || similarity < 0 || similarity > 1) {
      throw new DomainError("BAD_SIMILARITY", `相似度必须落在 [0,1]：${similarity}`);
    }
    timestampOf(proposed_interval.from, "生效起点");
    if (proposed_interval.to != null) timestampOf(proposed_interval.to, "生效终点");

    for (const name of ["hospital_code", "national_item", "pricing_unit", "applicable_population"]) {
      if (!dimensions[name]) throw new DomainError("MISSING_FIELD", `候选提案缺少维度引用：${name}`);
    }
    const resolved = {};
    for (const [name, ref] of Object.entries(dimensions)) {
      if (!DIMENSIONS.includes(name)) throw new DomainError("UNKNOWN_DIMENSION", `候选提案含未知维度：${name}`);
      resolved[name] = ref === null ? null : this.#requireDimensionRef(ref);
    }

    const content = { region, dimensions, proposed_interval, similarity, evidence: evidence ?? null };
    const hash = contentHash(content);
    const sourceKey = `${source.system}:${source.record_id}:${source.version}`;
    const seen = this.#sourceIndex.get(sourceKey);
    if (seen) {
      if (seen.content_hash === hash) {
        return { outcome: "duplicate", candidate_id: seen.candidate_id };
      }
      const dispute = this.#raiseDispute(seen.candidate_id, hash, content, source);
      return { outcome: "disputed", candidate_id: seen.candidate_id, dispute_id: dispute.dispute_id };
    }

    const candidate_id = this.#nextId("cand");
    const candidate = {
      candidate_id,
      origin: "machine_similarity",
      status: "proposed",
      source: { ...source },
      region,
      dimensions: { ...dimensions },
      similarity,
      evidence: evidence ?? null,
      proposed_interval: { from: proposed_interval.from, to: proposed_interval.to ?? null },
      content_hash: hash,
      signatures: [],
      proposed_at: this.#now(),
    };
    this.#candidates.set(candidate_id, candidate);
    this.#sourceIndex.set(sourceKey, { content_hash: hash, candidate_id });
    this.#emit("MAPPING_CANDIDATE_PROPOSED", "mapping_candidate", candidate_id, `机器相似度生成候选 ${candidate_id}`, {
      source: candidate.source,
      region,
      dimensions: candidate.dimensions,
      similarity,
      evidence: candidate.evidence,
      proposed_interval: candidate.proposed_interval,
      content_hash: hash,
    });
    return { outcome: "created", candidate_id };
  }

  candidate(candidate_id) {
    const found = this.#candidates.get(candidate_id);
    if (!found) throw new DomainError("UNKNOWN_CANDIDATE", `候选不存在：${candidate_id}`);
    return found;
  }

  // ---------------------------------------------------------------------------
  // 三、双角色签署：编码专家与支付政策人员按职责签署后才形成带生效区间的裁决
  // ---------------------------------------------------------------------------

  signCandidate(candidate_id, { signer_id, role, comment }) {
    assertPresent({ signer_id, role }, "签署");
    const candidate = this.candidate(candidate_id);
    if (!SIGNING_ROLES.includes(role)) {
      throw new DomainError("UNKNOWN_ROLE", `签署职责必须是 ${SIGNING_ROLES.join(" 或 ")}：${role}`);
    }
    if (candidate.status !== "proposed") {
      throw new DomainError("CANDIDATE_NOT_SIGNABLE", `候选 ${candidate_id} 当前状态 ${candidate.status}，不可签署`);
    }
    if (candidate.signatures.some((sig) => sig.role === role)) {
      throw new DomainError("ROLE_ALREADY_SIGNED", `候选 ${candidate_id} 的 ${role} 职责已签署，不得重复`);
    }
    if (candidate.signatures.some((sig) => sig.signer_id === signer_id)) {
      throw new DomainError("SAME_SIGNER_BOTH_ROLES", `签署人 ${signer_id} 不得兼任两类职责`);
    }

    const signature = { signer_id, role, comment: comment ?? null, signed_at: this.#now(), content_hash: candidate.content_hash };
    candidate.signatures.push(signature);
    this.#emit("MAPPING_CANDIDATE_SIGNED", "mapping_candidate", candidate_id, `${role} 签署候选 ${candidate_id}`, {
      signer_id,
      role,
      comment: signature.comment,
    });

    const signed = new Set(candidate.signatures.map((sig) => sig.role));
    if (SIGNING_ROLES.every((r) => signed.has(r))) {
      return { signed: true, decision: this.#activateDecision(candidate) };
    }
    return { signed: true, decision: null };
  }

  /** 唯一能从候选形成裁决的内部路径；外部不存在"机器直接生效"的入口。 */
  #activateDecision(candidate) {
    const decision_id = this.#nextId("dec");
    const interval = { ...candidate.proposed_interval };
    const decision = {
      decision_id,
      version: 1,
      status: "active",
      origin_candidate_id: candidate.candidate_id,
      region: candidate.region,
      dimensions: { ...candidate.dimensions },
      interval,
      deactivated_at: null,
      deactivation: null,
      activated_at: this.#now(),
    };
    this.#decisions.set(decision_id, decision);
    candidate.status = "effective";
    candidate.decision_id = decision_id;

    const conflicts = this.#conflictingDecisions(decision);
    this.#emit("MAPPING_DECISION_EFFECTIVE", "mapping_decision", decision_id, `裁决 ${decision_id} 生效`, {
      origin_candidate_id: candidate.candidate_id,
      region: decision.region,
      dimensions: decision.dimensions,
      interval,
      signatures: candidate.signatures.map((sig) => ({ ...sig })),
      conflicts: conflicts.map((other) => other.decision_id),
    });
    return decision;
  }

  /** 与既有生效裁决在 地区+医院编码 上区间重叠的冲突列表；只报告，绝不自动关闭对方。 */
  #conflictingDecisions(decision) {
    const hospitalKey = this.#requireDimensionRef(decision.dimensions.hospital_code).key;
    return [...this.#decisions.values()].filter(
      (other) =>
        other.decision_id !== decision.decision_id &&
        other.region === decision.region &&
        this.#requireDimensionRef(other.dimensions.hospital_code).key === hospitalKey &&
        intervalsOverlap(other.interval, decision.interval),
    );
  }

  decision(decision_id) {
    const found = this.#decisions.get(decision_id);
    if (!found) throw new DomainError("UNKNOWN_DECISION", `裁决不存在：${decision_id}`);
    return found;
  }

  /**
   * 人工关闭裁决的生效区间（显式动作，非自动覆盖）。
   * 只影响生效终点之后的解析；已结算记录仍固定当时版本，依据不变。
   */
  closeDecision(decision_id, { effective_to, by, reason }) {
    assertPresent({ effective_to, by }, "关闭裁决");
    const decision = this.decision(decision_id);
    if (decision.status !== "active") throw new DomainError("DECISION_NOT_ACTIVE", `裁决 ${decision_id} 当前状态 ${decision.status}`);
    if (timestampOf(effective_to, "生效终点") <= timestampOf(decision.interval.from, "生效起点")) {
      throw new DomainError("BAD_INTERVAL", `生效终点 ${effective_to} 必须晚于生效起点 ${decision.interval.from}`);
    }
    decision.interval = { ...decision.interval, to: effective_to };
    this.#emit("MAPPING_DECISION_CLOSED", "mapping_decision", decision_id, `裁决 ${decision_id} 于 ${effective_to} 终止生效`, {
      effective_to,
      by,
      reason: reason ?? null,
    });
    return decision;
  }

  /**
   * 紧急停用：只阻断尚未结算的请求（按请求时间判断），
   * 已结算记录保持当时版本，不受停用影响。
   */
  deactivateDecision(decision_id, { by, reason }) {
    assertPresent({ by, reason }, "紧急停用");
    const decision = this.decision(decision_id);
    if (decision.deactivated_at) throw new DomainError("ALREADY_DEACTIVATED", `裁决 ${decision_id} 已停用`);
    const at = this.#now();
    decision.deactivated_at = at;
    decision.deactivation = { by, reason, at };
    this.#emit("MAPPING_DECISION_DEACTIVATED", "mapping_decision", decision_id, `裁决 ${decision_id} 紧急停用`, { by, reason });
    return decision;
  }

  // ---------------------------------------------------------------------------
  // 四、争议：同一来源版本内容变化进入争议，争议中的候选不可签署
  // ---------------------------------------------------------------------------

  #raiseDispute(candidate_id, newHash, newContent, source) {
    const candidate = this.candidate(candidate_id);
    if (candidate.status === "proposed") candidate.status = "disputed";
    const dispute_id = this.#nextId("disp");
    const dispute = {
      dispute_id,
      candidate_id,
      source: { ...source },
      original_hash: candidate.content_hash,
      received_hash: newHash,
      received_content: newContent,
      status: "open",
      raised_at: this.#now(),
    };
    this.#disputes.set(dispute_id, dispute);
    this.#emit("MAPPING_DISPUTE_RAISED", "mapping_candidate", candidate_id, `候选 ${candidate_id} 因来源内容变化进入争议`, {
      dispute_id,
      source: dispute.source,
      original_hash: dispute.original_hash,
      received_hash: newHash,
    });
    return dispute;
  }

  /**
   * 争议处置：accept_new 以来源新内容生成全新候选（需重新双签），原候选标记被取代；
   * keep_original 拒绝新内容，原候选恢复可签署状态。
   */
  resolveDispute(dispute_id, { action, by }) {
    assertPresent({ action, by }, "争议处置");
    const dispute = this.#disputes.get(dispute_id);
    if (!dispute) throw new DomainError("UNKNOWN_DISPUTE", `争议不存在：${dispute_id}`);
    if (dispute.status !== "open") throw new DomainError("DISPUTE_CLOSED", `争议 ${dispute_id} 已处置`);

    const candidate = this.candidate(dispute.candidate_id);
    let new_candidate_id = null;
    if (action === "accept_new") {
      // 先校验并生成新候选，成功后再标记原候选被取代，避免半途留下不一致状态
      const proposal = this.proposeCandidate({
        source: { ...dispute.source, version: `${dispute.source.version}+ruling-${dispute_id}` },
        region: dispute.received_content.region,
        dimensions: dispute.received_content.dimensions,
        similarity: dispute.received_content.similarity,
        evidence: dispute.received_content.evidence,
        proposed_interval: dispute.received_content.proposed_interval,
      });
      new_candidate_id = proposal.candidate_id;
      candidate.status = "superseded";
    } else if (action === "keep_original") {
      if (candidate.status === "disputed") candidate.status = "proposed";
    } else {
      throw new DomainError("BAD_DISPUTE_ACTION", `争议处置动作仅支持 accept_new / keep_original：${action}`);
    }

    dispute.status = "resolved";
    dispute.resolution = { action, by, at: this.#now(), new_candidate_id };
    this.#emit("MAPPING_DISPUTE_RESOLVED", "mapping_candidate", dispute.candidate_id, `争议 ${dispute_id} 以 ${action} 处置`, {
      dispute_id,
      action,
      by,
      new_candidate_id,
    });
    return { dispute, new_candidate_id };
  }

  // ---------------------------------------------------------------------------
  // 五、结算解析与结算：按就诊发生地和日期选出唯一映射
  // ---------------------------------------------------------------------------

  /**
   * 按就诊发生地（region）、就诊日期（service_date）与医院编码解析唯一生效裁决。
   * 无法唯一判断时不猜测，返回可解释的待审原因。
   */
  resolveMapping({ region, service_date, hospital_code, requested_at, pricing_unit, applicable_population }) {
    assertPresent({ region, service_date, hospital_code }, "结算解析");
    const at = timestampOf(service_date, "就诊日期");
    const requestAt = timestampOf(requested_at ?? this.#now(), "请求时间");

    const matches = [...this.#decisions.values()].filter((decision) => {
      if (decision.region !== region) return false;
      if (this.#requireDimensionRef(decision.dimensions.hospital_code).key !== hospital_code) return false;
      if (timestampOf(decision.interval.from) > at) return false;
      if (decision.interval.to !== null && timestampOf(decision.interval.to) <= at) return false;
      if (pricing_unit && this.#requireDimensionRef(decision.dimensions.pricing_unit).key !== pricing_unit) return false;
      if (applicable_population && this.#requireDimensionRef(decision.dimensions.applicable_population).key !== applicable_population) {
        return false;
      }
      return true;
    });

    const usable = matches.filter((decision) => !decision.deactivated_at || requestAt < timestampOf(decision.deactivated_at));
    if (usable.length === 1) return { status: "resolved", decision: usable[0] };

    const reasons = [];
    const deactivated = matches.filter((decision) => decision.deactivated_at && requestAt >= timestampOf(decision.deactivated_at));
    if (deactivated.length > 0) {
      reasons.push({
        code: PENDING_REASONS.EMERGENCY_DEACTIVATED,
        message: `命中裁决已被紧急停用（${deactivated.map((d) => d.decision_id).join("、")}），仅阻断尚未结算的请求`,
        decision_ids: deactivated.map((d) => d.decision_id),
      });
    }
    if (usable.length > 1) {
      reasons.push({
        code: PENDING_REASONS.CONFLICTING_MAPPINGS,
        message: `就诊发生地 ${region} 在 ${service_date} 同时命中 ${usable.length} 条生效裁决，需人工裁决唯一映射`,
        decision_ids: usable.map((d) => d.decision_id),
      });
    }
    if (reasons.length === 0) {
      reasons.push({
        code: PENDING_REASONS.NO_EFFECTIVE_MAPPING,
        message: `就诊发生地 ${region} 在 ${service_date} 没有覆盖医院编码 ${hospital_code} 的生效裁决`,
        decision_ids: [],
      });
    }
    return { status: "pending", reasons };
  }

  /**
   * 结算登记：解析唯一映射后固定当时裁决版本与维度快照。
   * 同一 claim_id 的相同请求幂等返回；内容不同的重复结算视为冲突。
   */
  settleClaim({ claim_id, region, service_date, hospital_code, pricing_unit, applicable_population, detail }) {
    assertPresent({ claim_id, region, service_date, hospital_code }, "结算登记");
    const fingerprint = contentHash({ claim_id, region, service_date, hospital_code, pricing_unit, applicable_population, detail });
    const existing = this.#claims.get(claim_id);
    if (existing) {
      if (existing.request_hash === fingerprint) return existing;
      throw new DomainError("CLAIM_CONFLICT", `结算单 ${claim_id} 已按当时版本登记，不得以不同内容重复结算`);
    }

    const resolution = this.resolveMapping({ region, service_date, hospital_code, pricing_unit, applicable_population });
    if (resolution.status === "pending") {
      this.#emit("CLAIM_PENDING", "claim_line", claim_id, `结算单 ${claim_id} 待审`, {
        region,
        service_date,
        hospital_code,
        reasons: resolution.reasons,
      });
      return { status: "pending", claim_id, reasons: resolution.reasons };
    }

    const decision = resolution.decision;
    const claim = {
      claim_id,
      status: "settled",
      region,
      service_date,
      hospital_code,
      detail: detail ?? null,
      decision_id: decision.decision_id,
      decision_version: decision.version,
      decision_interval: { ...decision.interval },
      dimension_refs: { ...decision.dimensions },
      settled_at: this.#now(),
      request_hash: fingerprint,
    };
    this.#claims.set(claim_id, claim);
    this.#emit("CLAIM_SETTLED", "claim_line", claim_id, `结算单 ${claim_id} 按裁决 ${decision.decision_id} 登记`, {
      decision_id: decision.decision_id,
      decision_version: decision.version,
      decision_interval: claim.decision_interval,
      dimension_refs: claim.dimension_refs,
      region,
      service_date,
      hospital_code,
    });
    return claim;
  }

  claim(claim_id) {
    return this.#claims.get(claim_id) ?? null;
  }

  // ---------------------------------------------------------------------------
  // 六、差异事件：已结算记录的后续更正进入复核，不改写原结算
  // ---------------------------------------------------------------------------

  raiseDifference({ claim_id, correction, reason, by }) {
    assertPresent({ claim_id, correction, reason, by }, "差异事件");
    const claim = this.#claims.get(claim_id);
    if (!claim) throw new DomainError("UNKNOWN_CLAIM", `结算单不存在：${claim_id}`);
    const difference_id = this.#nextId("diff");
    const difference = {
      difference_id,
      claim_id,
      decision_id: claim.decision_id,
      decision_version: claim.decision_version,
      correction,
      reason,
      raised_by: by,
      status: "open",
      raised_at: this.#now(),
    };
    this.#differences.set(difference_id, difference);
    this.#emit("DIFFERENCE_RAISED", "claim_line", claim_id, `结算单 ${claim_id} 的更正以差异事件 ${difference_id} 进入复核`, {
      difference_id,
      decision_id: claim.decision_id,
      decision_version: claim.decision_version,
      correction,
      reason,
      raised_by: by,
    });
    return difference;
  }

  resolveDifference(difference_id, { by, note, resulting_decision_id }) {
    assertPresent({ by }, "差异复核");
    const difference = this.#differences.get(difference_id);
    if (!difference) throw new DomainError("UNKNOWN_DIFFERENCE", `差异事件不存在：${difference_id}`);
    if (difference.status !== "open") throw new DomainError("DIFFERENCE_CLOSED", `差异事件 ${difference_id} 已复核`);
    if (resulting_decision_id) this.decision(resulting_decision_id);
    difference.status = "reviewed";
    difference.review = { by, note: note ?? null, resulting_decision_id: resulting_decision_id ?? null, at: this.#now() };
    this.#emit("DIFFERENCE_REVIEWED", "claim_line", difference.claim_id, `差异事件 ${difference_id} 复核完成`, {
      difference_id,
      review: difference.review,
    });
    return difference;
  }

  /** 复核队列：未复核差异、未处置争议、待审结算尝试。 */
  reviewQueue() {
    return {
      differences: [...this.#differences.values()].filter((d) => d.status === "open"),
      disputes: [...this.#disputes.values()].filter((d) => d.status === "open"),
      pending_claims: this.#store
        .all()
        .filter((event) => event.event_type === "CLAIM_PENDING")
        .map((event) => ({ claim_id: event.aggregate_id, occurred_at: event.occurred_at, reasons: event.data.reasons })),
    };
  }

  // ---------------------------------------------------------------------------
  // 七、批量导入：隔离单条坏数据；精确重传幂等；内容变化进入争议
  // ---------------------------------------------------------------------------

  importBatch({ system, records }) {
    assertPresent({ system, records }, "批量导入");
    if (!Array.isArray(records)) throw new DomainError("BAD_BATCH", "批量导入 records 必须是数组");
    const batch_id = this.#nextId("batch");
    const results = records.map((record, index) => {
      try {
        const source = { system, record_id: record?.record_id, version: record?.version };
        const outcome = this.proposeCandidate({ ...record, source });
        return { index, record_id: record?.record_id ?? null, ...outcome };
      } catch (error) {
        if (error instanceof DomainError) {
          return { index, record_id: record?.record_id ?? null, outcome: "error", code: error.code, message: error.message };
        }
        throw error;
      }
    });
    const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
    this.#emit("BATCH_IMPORT_COMPLETED", "settlement_batch", batch_id, `批量导入 ${batch_id} 完成`, { system, counts });
    return { batch_id, results, counts };
  }

  // ---------------------------------------------------------------------------
  // 八、审计：从任一结算结果反查候选证据、签署人与后来更正
  // ---------------------------------------------------------------------------

  auditClaim(claim_id) {
    const claim = this.#claims.get(claim_id);
    if (!claim) throw new DomainError("UNKNOWN_CLAIM", `结算单不存在：${claim_id}`);
    const decision = this.decision(claim.decision_id);
    const candidate = this.candidate(decision.origin_candidate_id);
    const corrections = [...this.#differences.values()].filter((d) => d.claim_id === claim_id);
    const disputes = [...this.#disputes.values()].filter((d) => d.candidate_id === candidate.candidate_id);
    return {
      claim,
      decision: {
        decision_id: decision.decision_id,
        version: claim.decision_version,
        interval: claim.decision_interval,
        current_status: decision.status,
        deactivated_at: decision.deactivated_at,
        deactivation: decision.deactivation,
      },
      candidate: {
        candidate_id: candidate.candidate_id,
        origin: candidate.origin,
        similarity: candidate.similarity,
        evidence: candidate.evidence,
        source: candidate.source,
        proposed_at: candidate.proposed_at,
      },
      signatures: candidate.signatures.map((sig) => ({ ...sig })),
      disputes: disputes.map((d) => ({ ...d })),
      corrections: corrections.map((d) => ({ ...d })),
      events: this.#store.byAggregate("claim_line", claim_id),
    };
  }
}
