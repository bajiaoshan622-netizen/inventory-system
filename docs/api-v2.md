# API: Inventory v2（多客户 + 通用货类 + 入出库）

## 1. Background
v2 进入 UI/UX 质量整改阶段，目标是与用户 Excel 台账的认知模型对齐：按“入库主记录 + 对应出库信息”直观展示，并保证出库必须从“仍有库存”的入库记录发起。

## 2. Goals / Non-Goals
### Goals
- 多客户（tenant）隔离
- 通用货类（category）
- 入库与出库建立可追溯关联（`inbound_id`）
- 管理员直登入/出库；Agent 提交待审批
- 提供“台账视图”API：未出库时出库字段为空
- 出库只能基于仍有库存的入库记录发起

### Non-Goals
- 不做财务对账系统
- 不做第三方 ERP 同步

## 3. Data Structures & Constraints

### 3.1 主表
- `inventory_inbound`
  - 核心：`tenant_id, category_id, batch_no, inbound_date, actual_qty, actual_weight`
  - 异常：`damage_broken, damage_dirty, damage_wet, shortage_qty, extra_qty, rotten_qty`
  - 状态：`pending_review | approved | rejected`
- `inventory_outbound`
  - 约束字段：`inbound_id`（关联入库记录）
  - 核心：`tenant_id, category_id, batch_no, outbound_date, outbound_qty, outbound_weight`
  - 状态：`approved`

### 3.2 关联与一致性
1. `inventory_outbound.inbound_id` 必须指向同 tenant 下的已审批入库单
2. 出库时 `category_id/batch_no` 必须与被选入库一致（服务端兜底写入）
3. 同一入库允许多次出库（1:N）
4. 入库剩余量：
   - `remaining_qty = inbound.actual_qty - SUM(outbound.outbound_qty)`
   - `remaining_weight = inbound.actual_weight - SUM(outbound.outbound_weight)`

### 3.3 Excel 规则落地
- 台账主视图字段（按 Excel 习惯）：
  - 入库区：入库日期、车号/箱号、包装/批号、实收件数/吨数、破/污/湿/短/多/烂、提单号、合同号、备注
  - 出库区：出库日期、出库件数、出库吨数
  - 结余区：库存件数、库存吨数
- 若无出库记录：`outbounds=[]`，`outbound_summary.total_count=0`，`outbound_summary.first_outbound_date=null`

## 4. Flows & State Machine
1. 入库创建
   - Admin：直接 `approved`，计入库存
   - Agent：`pending_review`，审批后计入库存
2. 出库创建
   - Admin 在“可出库入库池”中选中某条入库（`remaining_qty > 0`）
   - 填写出库日期、件数、吨数、备注后提交
   - 服务端校验剩余量后写入 `inventory_outbound` 并扣减 `inventory_balance`
3. 台账查询
   - 按 tenant/category 返回“inbound 主体 + outbounds[] + outbound_summary + remaining”

## 5. API Contract

### 5.1 Inbound
- `GET /api/v2/inbound?tenantId=&status=&categoryId=&page=&limit=`
- `GET /api/v2/inbound/available?tenantId=&categoryId=`
  - 仅返回可出库入库记录（`status=approved 且 remaining_qty>0`）

### 5.2 Outbound
- `POST /api/v2/outbound`（仅管理员）
  - 请求：`tenant_id, inbound_id, outbound_qty, outbound_weight, outbound_date?, remarks?`
  - 行为：服务端自动继承被选入库 `category_id/batch_no`

### 5.3 Ledger（Excel式台账）
- `GET /api/v2/ledger/inbound-outbound?tenantId=&categoryId=`

### 5.4 多公司视图支撑接口（M4）
- `GET /api/v2/companies/overview`
  - 用途：公司列表页聚合卡片数据（当前库存、今日入库、今日出库）
  - 返回字段：`id/name/stock_qty/stock_weight/today_in_qty/today_in_weight/today_out_qty/today_out_weight`
- `GET /api/v2/stock/summary?tenantId=&categoryId=`
  - 用途：公司详情页“当前库存”分区展示（按货类/批号）
  - 返回字段：`tenant_id/category_id/category_name/batch_no/available_qty/available_weight/updated_at`

返回结构示例（必须遵循）：
```json
{
  "data": [
    {
      "inbound": {
        "inbound_id": 101,
        "tenant_id": 1,
        "category_id": 3,
        "category_name": "50KG氢钙3号袋",
        "inbound_date": "2026-02-15",
        "vehicle_id": "桂E31508",
        "batch_no": "TB2601001",
        "actual_qty": 700,
        "actual_weight": 35,
        "damage_broken": 0,
        "damage_dirty": 0,
        "damage_wet": 0,
        "shortage_qty": 0,
        "extra_qty": 0,
        "rotten_qty": 0,
        "remarks": null,
        "status": "approved"
      },
      "outbounds": [
        {
          "outbound_id": 501,
          "outbound_date": "2026-02-16",
          "outbound_qty": 400,
          "outbound_weight": 20,
          "remarks": "一柜",
          "created_by": "admin"
        },
        {
          "outbound_id": 502,
          "outbound_date": "2026-02-18",
          "outbound_qty": 200,
          "outbound_weight": 10,
          "remarks": "二柜",
          "created_by": "admin"
        }
      ],
      "outbound_summary": {
        "total_count": 2,
        "total_qty": 600,
        "total_weight": 30,
        "first_outbound_date": "2026-02-16",
        "last_outbound_date": "2026-02-18"
      },
      "remaining": {
        "qty": 100,
        "weight": 5
      }
    },
    {
      "inbound": {
        "inbound_id": 102,
        "tenant_id": 1,
        "category_id": 3,
        "category_name": "50KG氢钙3号袋",
        "inbound_date": "2026-02-20",
        "vehicle_id": "桂E61656",
        "batch_no": "TB2601002",
        "actual_qty": 700,
        "actual_weight": 35,
        "status": "approved"
      },
      "outbounds": [],
      "outbound_summary": {
        "total_count": 0,
        "total_qty": 0,
        "total_weight": 0,
        "first_outbound_date": null,
        "last_outbound_date": null
      },
      "remaining": {
        "qty": 700,
        "weight": 35
      }
    }
  ]
}
```

## 6. Error Model
- `400` 参数错误（缺 inbound_id、出库件数<=0 等）
- `401` 认证失败
- `403` 权限不足
- `404` 入库记录不存在
- `409` 库存冲突（出库超量 / 入库不在可出库状态）

## 7. Verification
- [ ] 每条入库记录可追溯其出库记录（含 0 条）
- [ ] ledger 返回含 `inbound/outbounds/outbound_summary/remaining`
- [ ] 可出库列表仅显示仍有库存入库
- [ ] 出库接口仅允许从可出库入库发起
- [ ] 超量出库返回 409
- [ ] UI 可直接消费 outbounds[] 渲染主行展开明细

## 8. 容错与降级策略（新增）

### 8.1 目标接口
- `GET /api/v2/ledger/inbound-outbound?tenantId=&categoryId=`
- `GET /api/v2/inbound/available?tenantId=&categoryId=`

### 8.2 数据异常分类
- 无数据：指定 tenant/category 下不存在记录
- 脏关联：`inventory_outbound.inbound_id` 缺失、指向不存在入库、或跨 tenant 关联
- 缺字段：`category` 缺失、备注为空、日期为空
- 数值异常：件数/吨数为 `NULL`、非数值、负数

### 8.3 /ledger 容错规则
1. 无数据返回 `200`：`{ data: [], meta, warnings: [] }`
2. 以 inbound 为主表输出，脏 outbound 不阻断主流程；异常记录计入 `warnings`
3. 数值统一安全转换：`safeNumber(x, 0)`，避免 `NaN` 污染
4. 缺分类时回退：`category_name = "未分类"`
5. `remaining` 小于 0 时按 0 返回并写入 `warnings`（避免前端崩溃）

### 8.4 /inbound/available 容错规则
1. 无可出库记录返回 `200`：`{ data: [], meta, warnings: [] }`
2. 仅返回 `remaining_qty > 0 或 remaining_weight > 0` 的入库
3. 发现脏出库导致负库存时，当前入库不入结果集，并写入 `warnings`
4. 缺分类字段不阻断，按默认值返回

### 8.5 错误码策略（修订）
- `400`：参数错误（如 tenantId 非法）
- `401`：认证失败
- `403`：权限不足
- `404`：指定资源不存在（按 ID 查询场景）
- `409`：库存冲突（超量出库/状态冲突）
- `500`：系统异常（仅不可预期错误），必须返回 `trace_id`

### 8.6 降级响应示例
```json
{
  "data": [],
  "meta": {
    "tenant_id": 1,
    "total": 0,
    "degraded": true
  },
  "warnings": [
    { "code": "ORPHAN_OUTBOUND_IGNORED", "count": 12 },
    { "code": "CATEGORY_MISSING_FALLBACK", "count": 3 }
  ]
}
```


### 8.7 统一降级响应约定（M2执行补充）
- `/api/v2/ledger/inbound-outbound` 与 `/api/v2/inbound/available` 返回体统一包含：
  - `data`: 业务数据（可为空数组）
  - `meta.degraded`: 是否触发降级（`true/false`）
  - `warnings`: 降级/脏数据告警数组
  - `trace_id`: 请求追踪ID
- 当检测到历史 schema 缺列（如 `inventory_outbound.inbound_id`）时：
  - 必须返回 `200`
  - 不抛 500
  - `meta.degraded = true`
  - `warnings` 至少包含 `OUTBOUND_INBOUND_ID_MISSING`

## 9. Change Log
| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-02-15 | 实现收口：ledger 接口输出嵌套结构并供 UI 展开消费 | 光年 |
| 2026-02-15 | M2落地：/ledger 与 /inbound/available 增加缺列探测与降级返回（meta.degraded + warnings + trace_id） | 光年 |
| 2026-02-15 | 增加 ledger JSON 结构示例（inbound/outbounds/summary/remaining） | 光年 |
| 2026-02-15 | 补充 inbound-outbound 关联与台账视图规则；明确可出库池与校验 | 光年 |
| 2026-02-15 | v2 API 设计初稿 | 光年 |
