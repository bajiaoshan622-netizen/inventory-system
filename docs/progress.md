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

## 归档历史
| 迭代 | 周期 | 文件 | 状态 |
|---|---|---|---|
| - | - | - | - |
