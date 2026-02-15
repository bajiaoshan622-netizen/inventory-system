# UI: Admin v2（库存管理后台）

## 1. Target Architecture
- 单页管理台（沿用 Worker 内嵌前端）
- 统一筛选维度：tenant / category / batch

## 2. Route / Menu
- `/admin/inbound` 入库管理
- `/admin/outbound` 出库管理
- `/admin/balance` 库存看板
- `/admin/categories` 货类配置
- `/admin/audit` 审批与历史

## 3. 核心页面

### 3.1 入库管理
- 新增入库（管理员）
- 编辑入库（管理员）
- 异常字段：破/污/湿/短/多/烂
- 附件上传（管理员可选，Agent必传）

### 3.2 出库管理
- 选择 tenant/category/batch
- 实时显示可用库存
- 输入出库件数/吨数
- 提交前校验：不可超过可用库存

### 3.3 库存看板
- 按 tenant/category/batch 聚合
- 展示：入库累计、出库累计、可用库存

### 3.4 审批中心
- 仅展示 Agent 提交/更新单据
- 操作：通过 / 驳回

### 3.5 历史审计
- 查看改单历史（字段级 before/after）

## 4. Interaction Rules
1. 管理员创建入/出库：保存即生效
2. Agent 创建/更新：状态“待审批”
3. 后补异常字段：弹窗提示“会生成修订记录”
4. 出库提交前强校验库存，失败给出明确提示

## 5. Permission Mapping
- Admin：全部功能
- Agent：仅提交入库、查看自己记录

## 6. Empty/Error/Loading
- 空库存：显示“暂无可出库库存”
- 超量出库：红色提示“超出可用库存，无法提交”
- 审批失败：提示最新库存或记录状态已变化

## 7. Verification
- [ ] 管理员直登入库后库存即时变化
- [ ] 出库前后库存正确变化
- [ ] Agent 单据在审批中心可见
- [ ] 历史审计可查看字段级变更

## 8. Change Log
| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-02-15 | Admin v2 交互设计初稿 | 光年 |
