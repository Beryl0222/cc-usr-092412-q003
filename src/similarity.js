import { contentHash } from "./events.js";

// 机器相似度只负责生成候选：对医院服务编码与已发布的国家目录项做文本/编码比对，
// 输出分数、命中字段与原始证据。候选永远不会自动成为当前结论，必须经人工签署流程。

// 可插拔的打分函数；默认实现基于名称字符重合、编码前缀与别名命中，产出 0..1 分数。
export function defaultSimilarity(hospitalContent, nationalContent) {
  const signals = [];
  let score = 0;

  const aName = String(hospitalContent.name ?? "");
  const bName = String(nationalContent.name ?? "");
  if (aName && bName) {
    const overlap = jaccard([...aName], [...bName]);
    signals.push({ signal: "name_char_overlap", value: Number(overlap.toFixed(4)) });
    score += overlap * 0.45;
    if (bName.includes(aName) || aName.includes(bName)) {
      signals.push({ signal: "name_substring", value: 1 });
      score += 0.15;
    }
  }

  const aCode = String(hospitalContent.code ?? "");
  const bCode = String(nationalContent.code ?? "");
  if (aCode && bCode) {
    const prefix = commonPrefix(aCode, bCode);
    const prefixRatio = prefix.length / Math.max(aCode.length, bCode.length);
    signals.push({ signal: "code_prefix_ratio", value: Number(prefixRatio.toFixed(4)) });
    score += prefixRatio * 0.25;
  }

  const aliases = nationalContent.aliases ?? [];
  if (Array.isArray(aliases) && aliases.some((alias) => aName && String(alias).includes(aName.slice(0, 4)))) {
    signals.push({ signal: "alias_hit", value: 1 });
    score += 0.15;
  }

  return { score: Math.min(1, Number(score.toFixed(4))), signals };
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return sa.size + sb.size - inter === 0 ? 0 : inter / (sa.size + sb.size - inter);
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
  return a.slice(0, i);
}

export class SimilarityEngine {
  constructor(registry, { scorer = defaultSimilarity, threshold = 0.3 } = {}) {
    this.registry = registry;
    this.scorer = scorer;
    this.threshold = threshold;
  }

  // 枚举某医院编码当前版本与所有国家目录项当前版本的相似度，按分数降序返回候选证据。
  // 入参全部是已发布的精确 revision；机器不接触历史覆写，也不区分省份支付结论。
  suggestCandidates({ hospitalRef, nationalRefs, at }) {
    const hospital = this.registry.current("hospital_code", hospitalRef);
    if (!hospital) throw new Error(`医院编码尚未发布版本：${hospitalRef}`);

    const candidates = [];
    for (const nationalRef of nationalRefs) {
      const national = this.registry.current("national_item", nationalRef);
      if (!national || (national.retiredAt && national.retiredAt <= (at ?? ""))) continue;
      const { score, signals } = this.scorer(hospital.content, national.content);
      if (score < this.threshold) continue;
      candidates.push({
        candidate_id: `cand-${contentHash({ h: hospitalRef, n: nationalRef, s: score }).slice(0, 12)}`,
        source: "machine_similarity",
        national_ref: nationalRef,
        national_revision: national.revision,
        hospital_ref: hospitalRef,
        hospital_revision: hospital.revision,
        score,
        signals,
        evidence: {
          hospital_snapshot: hospital.content,
          national_snapshot: national.content,
        },
        generated_at: at ?? new Date().toISOString(),
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }
}
