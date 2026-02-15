# API 文档

Base URL：`https://<your-worker-domain>`

## 1. 公开接口

- `POST /api/auth/login`
  - body: `{ "password": "..." }`
  - 200: `{ token, role }`
- `GET /api/health`
  - 200: `{ "status": "ok" }`

## 2. Agent 接口（Header: `X-API-Key`）

- `POST /api/agent/records`
  - 创建记录，默认 `pending_review`
- `PUT /api/agent/records/:id`
  - 仅可编辑自己创建且待复核记录
- `GET /api/agent/records`
  - 查询自己记录（支持 `page`、`limit`）
- `GET /api/agent/records/:id`
  - 查询单条（自己创建）
- `POST /api/upload/url`
  - body: `{ "filename": "xx.jpg" }`
  - 返回上传地址和公开地址

## 3. Admin 接口（Header: `Authorization: Bearer <jwt>`）

- `GET /api/admin/records`
  - 支持过滤：`status` `batch` `vehicle` `startDate` `endDate`
  - 分页：`page` `limit`
- `GET /api/admin/records/:id`
- `POST /api/admin/records/:id/approve`
- `POST /api/admin/records/:id/reject`
- `DELETE /api/admin/records/:id`
- `POST /api/admin/import`
  - body: `{ "records": [...] }`
- `GET /api/admin/export`
  - query: `status`（默认 `approved`）
  - 返回 CSV 文件
- `GET /api/admin/stats`

## 4. 错误返回约定

- 认证失败：`401 { error: "..." }`
- 权限不足：`403 { error: "..." }`
- 资源不存在：`404 { error: "..." }`
- 参数错误：`400 { error: "..." }`
