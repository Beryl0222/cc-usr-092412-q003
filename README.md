# 医保服务目录映射台

跨省结算场景下的**目录语义裁决与生效映射**服务：医院上报的新服务编码，经机器相似度
产生候选、编码专家与支付政策人员按职责签署后，才形成带生效区间的映射；结算按就诊发生地
与日期选取唯一结论，全部依据版本化、可审计、可更正但不可改写。

## 核心规则

1. **五维独立版本化**：医院编码、国家目录项、地方限定、计价单位、适用人群各自是独立聚合，
   每次发布产生递增 revision；旧 revision 永久保留，已结算记录固定的是精确 revision 号。
2. **机器只给候选**：相似度引擎输出分数、命中信号与原始快照证据，不产生任何结论。
3. **双职责签署**：`coding_expert`（编码专家，对编码/临床语义负责）与 `payment_policy`
   （支付政策人员，对支付限定负责）缺一不可，签署齐备才能激活。
4. **生效区间**：映射在 `[effective_from, effective_to)` 内有效，结束日为 `null` 表示至今。
5. **冲突不覆盖**：新的双签裁决与当前生效裁决区间重叠时，只在现任裁决上登记
   `MAPPING_CONFLICT_FLAGGED`，现任结论保留，等待人工裁决。
6. **紧急停用**：`MAPPING_HALTED` 只阻断尚未结算的请求；已结算病例固定当时事件版本，
   不受影响。
7. **更正走差异事件**：同来源版本内容变化或人工发现错误，先 `MAPPING_DISPUTE_OPENED`
   进入复核；复核通过后另立后继裁决（`correction_of`）重新双签，旧裁决以
   `MAPPING_CORRECTED` 关闭区间——不抹旧账，只接新链。
8. **批量导入**：逐行隔离，单条坏数据只产生 `BATCH_LINE_REJECTED`；同一来源版本 + 内容
   哈希的精确重传识别为 `duplicate`，不重复创建裁决；同行键内容变化则 `dispute_opened`。
9. **结算唯一判定**：按就诊发生地 + 就诊日期选择；选不出唯一结果时返回结构化待审原因
   （无裁决 / 区间外 / 维度无法匹配 / 缺签署 / 争议中 / 停用中 / 多条重叠），绝不猜测。
10. **审计可反查**：从任一结算单可还原候选证据、签署人、五维固定内容、生效区间，以及
    该裁决之后的停用、争议、冲突标记与整条更正链。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `contracts/domain.schema.json` | 领域事件信封、事件/聚合枚举、维度、签署职责与待审原因契约 |
| `src/contracts.js` | 枚举常量（五维、双角色、待审原因） |
| `src/validator.js` | 事件信封校验（结构、枚举、ISO 时间、版本号） |
| `src/event-store.js` | 仅追加事件存储：乐观并发、版本落号、按聚合流读取 |
| `src/events.js` | 事件工厂、规范 JSON 与内容哈希（重传幂等依据） |
| `src/dimensions.js` | 五维版本注册表：草案/发布/再版/停用，历史 revision 可读 |
| `src/similarity.js` | 机器相似度：只产候选证据（分数、信号、快照），可插拔打分 |
| `src/decisions.js` | 裁决聚合：提案、双职责签署、激活、冲突登记、停用、争议、更正链 |
| `src/imports.js` | 批量导入：坏行隔离、精确重传幂等、内容变化进争议 |
| `src/settlement.js` | 结算接口：地点+日期唯一选取、待审/阻断落账、版本固定 |
| `src/audit.js` | 审计反查：结算卷宗、候选证据、签署人、后续更正链 |
| `tests/` | 18 项场景测试（含双省份分歧、停用、历史版本、更正全链路） |

## 事件流概览

```
维度：  DIMENSION_VERSION_DRAFTED → DIMENSION_VERSION_PUBLISHED →（再版/RETIRED）
裁决：  CANDIDATE_SUGGESTED*
        MAPPING_PROPOSED → MAPPING_SIGNED×(两角色) → MAPPING_ACTIVATED
                          ↘ 冲突：MAPPING_CONFLICT_FLAGGED（落在现任裁决上）
        生效后：MAPPING_HALTED（紧急停用）
                MAPPING_DISPUTE_OPENED → 后继 MAPPING_PROPOSED(correction_of)
                                         → 双签 → ACTIVATED → 旧裁决 MAPPING_CORRECTED
导入：  BATCH_IMPORTED → BATCH_LINE_ACCEPTED | BATCH_LINE_REJECTED（逐行）
结算：  CLAIM_SUBMITTED → CLAIM_ADJUSTED（固定版本）
                         | CLAIM_PENDING_REVIEW（可解释原因）
                         | CLAIM_BLOCKED（紧急停用）
```

记录一经接收，`event_id`、`occurred_at` 与 `version` 不得原地改写；更正只追加后继事件。
个人、机构及商业敏感信息仅向履行职责所需的调用方开放。

## 本地检查

```bash
npm run build   # 对 src/ 下全部模块做语法检查
npm test        # node --test，18 项场景测试
```

不需要外部服务或数据库；事件存储为进程内内存实现，接口与持久化无关，可替换为
仅追加的事件日志后端。
