# 医保服务目录映射台

本仓库记录该项目已确认的领域对象、事件名称和基础校验方式，便于不同系统交换一致的数据。

## 资料范围

- `contracts/domain.schema.json`：领域事件信封、聚合类型与事件名称。
- `data/sample.json`：一条用于本地联调的中文样例。
- `src/`：事件信封的最小校验代码，以及目录语义裁决服务。
- `tests/`：验证样例符合基础约定，并覆盖裁决、结算、批量导入与审计场景。

当前资料覆盖目录版本、语义映射和跨省结算。记录一经接收，标识、发生时间与版本不得原地改写；更正使用新的后继记录。个人、机构及商业敏感信息仅向履行职责所需的调用方开放。

## 目录语义裁决能力

`src/service.js` 的 `CatalogMappingService` 承载跨省结算的目录语义裁决，核心规则如下：

- **维度分别版本化**：医院编码、国家目录项、地方限定、计价单位、适用人群各自维护严格递增的版本链，已登记版本不得原地改写。
- **机器只产候选**：机器相似度（`proposeCandidate`）无论得分多高都只生成候选；裁决只能由候选经双签形成，不存在机器直接生效的入口。
- **双角色签署**：编码专家（`coding_expert`）与支付政策人员（`payment_policy`）按职责签署，缺一不可，同一人不得兼任；双签完成后裁决才带生效区间生效。
- **冲突不自动覆盖**：新裁决与现行裁决在就诊发生地和生效区间上重叠时，双方均保留，结算接口在重叠期返回可解释的待审原因（`CONFLICTING_MAPPINGS`），只能由人工显式关闭旧裁决来消解。
- **紧急停用只阻断未结算请求**：`deactivateDecision` 按请求到达时间阻断尚未结算的请求；已结算记录固定当时的裁决版本与维度快照，依据不变。
- **更正走差异事件**：已结算记录的后续更正通过 `raiseDifference` 生成差异事件进入复核队列，原结算不被改写。
- **批量导入容错与幂等**：`importBatch` 隔离单条坏数据（其余记录照常处理）；同一来源版本精确重传返回既有候选，不重复创建裁决；内容变化则进入争议，争议中的候选不可签署，需人工处置。
- **结算唯一映射**：`resolveMapping` 按就诊发生地、就诊日期与医院编码选出唯一生效裁决；无法唯一判断时返回带原因码的待审结果（`NO_EFFECTIVE_MAPPING` / `CONFLICTING_MAPPINGS` / `EMERGENCY_DEACTIVATED`）。
- **审计反查**：`auditClaim` 从任一结算结果反查机器候选证据、两位签署人、争议与后来的更正事件。

```js
import { CatalogMappingService } from "./src/service.js";

const service = new CatalogMappingService();
service.registerDimensionVersion({ dimension: "hospital_code", key: "H1001", version: 1, payload: { name: "经皮冠状动脉支架置入术" }, effective_from: "2026-01-01T00:00:00+08:00" });
// …登记其余维度后：机器提案 → 双角色签署 → 裁决生效 → 结算解析
const { candidate_id } = service.proposeCandidate(/* 机器相似度提案 */);
service.signCandidate(candidate_id, { signer_id: "expert-li", role: "coding_expert" });
service.signCandidate(candidate_id, { signer_id: "policy-wang", role: "payment_policy" });
service.resolveMapping({ region: "广东", service_date: "2026-03-01T00:00:00+08:00", hospital_code: "H1001" });
```

## 本地检查

```bash
node --test
```

## 测试与构建

测试命令：

```bash
npm test
```

编译或构建命令：

```bash
npm run build
```

这些命令可在单个 Linux 应用容器内执行，不需要另行启动外部服务。
