# API: Inventory v2（多客户 + 通用货类 + 入出库）

## 1. Background
v1 仅覆盖部分入库流程。v2 需要支持：多客户隔离、通用货类、管理员直登入/出库、Agent 提交待审批、库存强校验、异常字段后补与审计。

## 2. Goals / Non-Goals
### Goals
- 多客户（tenant）隔离
- 通用货类（category）
- 入库/出库双流水
- 管理员直登免审批；Agent 需审批
- 坏/污/湿/短/多/烂字段可后补

### Non-Goals
- 不做财务对账系统
- 不做第三方 ERP 同步

## 3. Data Structures

### 3.1 主表
- `tenants(id, name, status, created_at)`
- `categories(id, tenant_id, code, name, field_schema_json, active)`
- `inventory_inbound(id, tenant_id, category_id, batch_no, vehicle_id, inbound_date, actual_qty, actual_weight, damage_broken, damage_dirty, damage_wet, shortage_qty, extra_qty, rotten_qty, status, source, created_by, approved_by, approved_at, updated_at)`
- `inventory_outbound(id, tenant_id, category_id, batch_no, outbound_date, outbound_qty, outbound_weight, status, source, created_by, approved_by, approved_at, updated_at)`
- `inventory_balance(id, tenant_id, category_id, batch_no, available_qty, available_weight, updated_at)`
- `record_history(id, tenant_id, record_type, record_id, action, before_json, after_json, operator, created_at)`
- `attachments(id, tenant_id, record_type, record_id, r2_key, file_name, file_size, uploader, created_at)`

### 3.2 状态机
- 管理员创建：`approved`（直接生效）
- Agent 创建/更新：`pending_review` -> 管理员审批 -> `approved`
- 拒绝：`rejected`

## 4. Core Rules
1. 可用件数：`available_qty = 实收件数累计 - 已出库件数累计`
2. 出库校验：`requested_outbound_qty <= available_qty`
3. 异常字段后补允许，但必须写 `record_history`
4. Agent 入库附件必传；管理员可选

## 5. API Contract（草案）

### 5.1 Tenant / Category
- `GET /api/v2/tenants`
- `GET /api/v2/categories?tenantId=...`
- `POST /api/v2/categories`（管理员）

### 5.2 Inbound
- `POST /api/v2/inbound`（管理员直生效 / Agent待审批）
- `PUT /api/v2/inbound/:id`（管理员可改；Agent改走待审批）
- `GET /api/v2/inbound`
- `POST /api/v2/inbound/:id/approve`（管理员）
- `POST /api/v2/inbound/:id/reject`（管理员）

### 5.3 Outbound
- `POST /api/v2/outbound`（仅管理员）
- `PUT /api/v2/outbound/:id`（管理员）
- `GET /api/v2/outbound`

### 5.4 Balance / History / Attachments
- `GET /api/v2/balance?tenantId=&categoryId=&batchNo=`
- `GET /api/v2/history?recordType=&recordId=`
- `POST /api/v2/attachments/upload-url`
- `PUT /api/v2/attachments/upload/*`

## 6. Error Model
- `400` 参数错误
- `401` 认证失败
- `403` 权限不足
- `404` 资源不存在
- `409` 库存冲突（出库超量 / 并发修改）

## 7. Migration（v1 -> v2）
1. 新建 v2 表，不直接改写 v1 表
2. 将 v1 记录映射到默认 tenant + 对应 category
3. 回填 `inventory_balance`
4. 灰度切流后冻结 v1 写入

## 8. Verification
- [ ] 管理员入库直接可见且计入库存
- [ ] Agent 入库需审批后才计入库存
- [ ] 出库超量返回 409
- [ ] 异常字段后补留痕
- [ ] tenant 数据隔离

## 9. Change Log
| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-02-15 | v2 API 设计初稿 | 光年 |
