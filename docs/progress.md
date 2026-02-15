# Progress - Inventory Upgrade

## 📍 当前迭代: Sprint Upgrade-Design
- 周期：2026-02-15 ~ 2026-02-18
- 来源计划：[plan.md](./plan.md)
- 当前阶段：评审补齐稿（待 Team Lead 二次评审）

## 执行摘要
| 指标 | 数值 |
|---|---|
| 总任务数 | 12 |
| 已完成 | 12 |
| 进行中 | 0 |
| 未开始 | 0 |
| 整体进度 | 100% |

## 任务明细
| 任务ID | 任务描述 | 负责人 | 状态 | 计划工时 | 实际工时 | 完成日期 | 备注 |
|---|---|---|---|---|---|---|---|
| D1 | Excel 全Tab梳理 | 光年 | ✅ 已完成 | 1h | 1h | 2026-02-15 | DocSDK读取8个tab，识别字段差异 |
| D2 | 规则归档（可用件数/出库校验/附件/改单） | 光年 | ✅ 已完成 | 1h | 0.8h | 2026-02-15 | 已写入 requirements.md |
| D3 | 数据模型升级设计 | 光年 | ✅ 已完成 | 3h | 2.2h | 2026-02-15 | 已输出 `api-v2.md` |
| D4 | 迁移方案设计 | 光年 | ✅ 已完成 | 2h | 1.2h | 2026-02-15 | 已写入 `api-v2.md` migration |
| D5 | 后台交互方案设计 | 光年 | ✅ 已完成 | 2h | 1.3h | 2026-02-15 | 已输出 `ui-admin-v2.md` |
| D6 | 实施排期与验收清单 | 光年 | ✅ 已完成 | 1h | 0.8h | 2026-02-15 | 已进入编码执行 |
| C1 | DB schema 升级（v2表结构） | 光年 | ✅ 已完成 | 1.5h | 0.8h | 2026-02-15 | schema.sql 已追加 v2 表 |
| C2 | API v2 第二批实现（附件链路/审批列表/分页查询） | 光年 | ✅ 已完成 | 6h | 4.2h | 2026-02-15 | 附件、审批、分页接口收口 |
| C3 | 前端管理台 v2 页面改造（首版） | 光年 | ✅ 已完成 | 4h | 2.2h | 2026-02-15 | 已接入出库登记、待审批列表、附件查看入口 |
| C4 | 上线与回滚文档 + e2e 验收脚本 | 光年 | ✅ 已完成 | 1.5h | 0.8h | 2026-02-15 | 新增 release-checklist-v2 与 e2e-v2.sh |
| C5 | 台账视图与入库-出库关联实现（Excel直观模式） | 光年 | ✅ 已完成 | 3h | 2.1h | 2026-02-15 | 新增 `inbound_id` 关联、`/api/v2/ledger/inbound-outbound` |
| C6 | 出库交互整改：仅从“仍有库存”入库记录发起 | 光年 | ✅ 已完成 | 2h | 1.4h | 2026-02-15 | 新增 `/api/v2/inbound/available`，前端改为下拉选择可出库池 |

## C5/C6 可验收标准（用户直观看）
1. 台账主行可展开/抽屉查看某条入库对应的多条出库明细（至少 2 条）。
2. 未出库记录主行显示“未出库”标签，展开后出现空态卡片（非单一 `-` 占位）。
3. 出库登记必须先选“可出库入库记录”；未选择时提交按钮不可用或提交被阻断。
4. 出库输入超上限时显示明确文案（含“最多可出 X 件/吨，当前输入 Y”）并阻断提交。
5. 出库成功后出现成功回显（含出库ID与剩余库存），并自动定位+高亮刚更新入库行。
6. 台账数据结构可被前端直接消费：包含 `inbound + outbounds[] + outbound_summary + remaining`。

## 阻塞事项
| 问题 | 影响任务 | 跟进人 | 状态 |
|---|---|---|---|
| 需补充线上历史出库数据回填 `inbound_id` 的迁移脚本 | 发布前数据治理 | 光年 | 🟡 待处理 |

## 收口补丁计划（2026-02-15）
| Patch | 目标 | 状态 | 证据 |
|---|---|---|---|
| P0-1 | ledger 改嵌套结构（inbound/outbounds/summary/remaining） | ✅ 已完成 | src/index.ts 接口实现 + 构建通过 |
| P0-2 | UI 主行展开 + 未出库空态卡片 | ✅ 已完成 | src/index.ts 展开行与空态卡片渲染 |
| P0-3 | 超限动态文案（X/Y）+ 成功定位高亮2.5s | ✅ 已完成 | src/index.ts 动态文案 + row-highlight |
| P1-4 | 验收脚本与证据 | ✅ 已完成 | scripts/e2e-c5c6.sh 静态验收通过 |

## 每日记录
### 2026-02-15
- 完成：
  - 用 DocSDK 读取 `updated_inventory.xlsx` 全部 tab
  - 输出需求文档 `requirements.md`
  - 建立 `plan.md` 与本进度表
  - 新增口径：管理员可直接登记入/出库免审批；Agent提交/更新需审批；坏污字段支持后补

### 2026-02-15（UI/UX整改）
- 完成（文档先行）：
  - 更新 `api-v2.md`：补充 inbound_id 关联、可出库池、台账视图规则
  - 更新 `ui-admin-v2.md`：重构为“台账主视图 + 可出库池出库”
- 完成（编码实现）：
  - `schema.sql`：`inventory_outbound` 增加 `inbound_id` 与索引
  - `src/index.ts`：
    - 出库接口改为必须 `inbound_id`
    - 新增 `GET /api/v2/inbound/available`
    - 新增 `GET /api/v2/ledger/inbound-outbound`
    - 管理台前端改造为 Excel 式台账 + 可出库下拉出库流程
  - 语法构建校验：`npx esbuild src/index.ts --bundle --platform=neutral --outfile=/tmp/inventory-bundle.js` 通过

### 2026-02-15（Team Lead 第一轮评审补齐）
- 完成：
  - UI 文档补齐“一对多出库展开/抽屉 + 未出库空态样式 + 防错交互 + 成功定位高亮”
  - API 文档补齐 ledger 返回 JSON 示例（inbound/outbounds/outbound_summary/remaining）
  - progress 增加 C5/C6 6条可验收标准

### 2026-02-15（最终收口补丁执行）
- 完成：
  - P0-1：`/api/v2/ledger/inbound-outbound` 改为嵌套结构输出（inbound/outbounds/outbound_summary/remaining）
  - P0-2：管理台台账支持主行展开查看 outbounds 明细；未出库显示空态卡片
  - P0-3：增加“最多可出X/当前输入Y”动态提示；超限阻断文案；成功后定位并高亮2.5s
  - P1-4：新增 `scripts/e2e-c5c6.sh` 并执行通过
  - 构建验证：`npx esbuild src/index.ts --bundle --platform=neutral --outfile=/tmp/inventory-bundle.js` 通过

### 2026-02-15（Patch-1 并行补位核验）
- 完成：
  - 本地 D1 迁移并注入双样本（有出库 inbound=101；未出库 inbound=102）
  - 启动本地 Worker：`npx wrangler dev --local --port 8787`
  - 实测 `GET /api/v2/ledger/inbound-outbound?tenantId=1&categoryId=3` 返回满足契约：`inbound/outbounds/outbound_summary/remaining`
  - 真实响应片段已产出（含有出库/未出库两种）


### 2026-02-15（新需求方案评审包：稳定性 + 中文化 + 多公司）
- 范围（仅文档草案，不改代码）：
  - `api-v2.md`：补 `/api/v2/ledger/inbound-outbound` 与 `/api/v2/inbound/available` 容错策略、`warnings`、错误码修订、降级响应示例
  - `ui-admin-v2.md`：补全中文化文案规范与“公司列表 -> 公司详情（入库/出库/库存）”信息架构
  - `progress.md`：新增里程碑、验收点、风险与回滚策略
- 里程碑（待 CTO 评审后执行编码）：
  - M1（+1.5h）：500 根因定位与数据体检（历史 `inbound_id` 脏数据巡检）
  - M2（+2h）：`/ledger` 与 `/inbound/available` 容错改造 + 降级响应
  - M3（+1.5h）：UI 全量中文化
  - M4（+2.5h）：多公司首页与公司详情三块视图
- 验收点：
  1. 两个接口在无数据/脏数据/缺字段场景不再返回 500
  2. 返回可消费的 `warnings` 与 `meta.degraded` 字段
  3. 前端业务文案全中文且术语统一
  4. 支持“公司列表 -> 公司详情（入库/出库/库存）”主路径
- 风险与应对：
  - 风险：历史出库未回填 `inbound_id` 导致脏关联规模大
  - 应对：先隔离脏数据并降级展示，再补迁移脚本做数据治理
  - 回滚：接口变更加 feature flag，必要时回切旧查询逻辑

### 2026-02-15（M1执行完成：500复现与可观测性）
- 完成：
  - 已复现“已登录场景”两个接口 500：`/api/v2/ledger/inbound-outbound`、`/api/v2/inbound/available`
  - 复现条件为历史 schema 漂移（`inventory_outbound` 缺少 `inbound_id` 列），D1 抛错：`no such column: inbound_id` / `no such column: o.inbound_id`
  - 已在 `src/index.ts` 为两个接口增加最小可观测日志：`trace_id` 生成、成功日志、异常日志、500 响应返回 `trace_id`
  - 已补 SQL 体检样本并验证可检测脏数据：
    - `cnt_missing_inbound_id = 1`
    - `cnt_orphan_ref = 1`
    - `cnt_cross_tenant = 1`
- 结论：
  - 线上 500 高概率由历史数据治理/迁移不完整引发（与既有风险“回填 inbound_id 脚本待处理”一致）
  - M2 将落地容错与降级响应，确保脏数据不再触发 500

### 2026-02-15（M2执行完成：缺列/脏数据降级防500）
- 完成：
  - `/api/v2/inbound/available` 增加列探测（`PRAGMA table_info(inventory_outbound)`）+ 动态降级分支
  - `/api/v2/ledger/inbound-outbound` 增加列探测与降级分支，缺 `inbound_id` 时不再关联出库但保持台账主结构可读
  - 两接口返回结构统一：`data + meta.degraded + warnings + trace_id`
  - 异常场景由 500 改为 200 降级返回（历史缺列可复现）
- 验收结果：
  - 修复前：两接口在“outbound缺inbound_id列”场景均为 500
  - 修复后：两接口同场景均为 200，且 `meta.degraded=true`、`warnings` 含 `OUTBOUND_INBOUND_ID_MISSING`


### 2026-02-15（M3执行完成：UI全量中文化）
- 完成：
  - 主界面可见英文文案清零（保留技术白名单：ID/API）
  - 出库区标签与占位统一中文（租户ID、货类ID、批号等）
  - 待审批表头英文字段中文化（tenant/category/batch -> 租户/货类/批号）
  - 审批状态显示中文映射（待审核/已通过/已驳回）
  - 后端英文错误增加前端中文兜底提示
  - 统计区状态文案统一：待复核/已确认 -> 待审核/已通过
- 验收结果：
  - 页面业务文案英文清零（白名单除外）
  - 构建通过，前端主流程可用

### 2026-02-15（M4执行完成：多公司视图）
- 完成：
  - 新增“公司列表”首页：公司名、当前库存、今日入库、今日出库、进入详情
  - 新增“公司详情”页：入库台账、出库明细、当前库存三块区域
  - 支持公司搜索、公司详情返回、公司维度货类筛选
  - 新增后端接口：`/api/v2/companies/overview`、`/api/v2/stock/summary`
- 验收结果：
  - 实现“公司列表 -> 公司详情（入库/出库/库存）”主路径
  - 构建通过，接口与前端联调通过

### 2026-02-15（M3_FIX返工完成：前端可见文案英文清零复核）
- 完成：
  - 状态兜底由英文原值改为中文“未知状态”
  - 错误兜底由后端英文透传改为中文“提交失败，请稍后重试”
  - 关键词复核改为“仅扫描前端可见文案（模板文本+提示文案）”
- 验收结果：
  - 关键词扫描 `found=[]`
  - 构建通过

## 归档历史
| 迭代 | 周期 | 文件 | 状态 |
|---|---|---|---|
| - | - | - | - |
