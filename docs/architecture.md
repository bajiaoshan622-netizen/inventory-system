# 架构说明

## 1. 技术栈

- 运行时：Cloudflare Workers
- Web 框架：Hono
- 数据库：Cloudflare D1 (SQLite)
- 对象存储：Cloudflare R2
- 前端：Worker 内联 HTML（`GET /`）

## 2. 代码结构

- `src/index.ts`
  - 路由定义（公开 / Agent / Admin）
  - 认证中间件（API Key / JWT）
  - 管理端页面（内联 HTML）
- `schema.sql`
  - `inventory_records` 表结构
  - 常用查询索引
- `wrangler.toml`
  - D1 / R2 绑定
  - 环境变量

## 3. 角色与权限

- Agent（`X-API-Key`）
  - 新增记录
  - 编辑自己提交且待复核记录
  - 查询自己记录
  - 申请图片上传 URL
- Admin（JWT）
  - 查看全部记录
  - 复核通过 / 驳回
  - 删除记录
  - 批量导入
  - 导出 CSV
  - 查看统计

## 4. 核心流程

### 4.1 录入与复核

1. Agent 调用 `POST /api/agent/records` 创建记录（状态 `pending_review`）
2. Admin 在管理端查看待复核记录
3. Admin 执行：
   - `approve`：状态改为 `approved`
   - `reject`：删除待复核记录

### 4.2 图片上传

1. Agent 调用 `POST /api/upload/url`
2. 服务返回 `uploadUrl/publicUrl`
3. Agent 上传图片后，在记录中写入 `image_url`

> 说明：当前实现为简化版 URL 方案，生产环境建议改为真正预签名上传。

## 5. 数据模型（核心字段）

表：`inventory_records`

- 业务字段：`vehicle_id`、`package_batch`、`inbound_date`、`actual_quantity`、`actual_weight`...
- 审计字段：`status`、`created_by`、`reviewed_by`、`reviewed_at`
- 媒体字段：`image_url`
- 时间字段：`created_at`、`updated_at`

状态值：

- `pending_review`：待复核
- `approved`：已确认
