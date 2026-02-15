# 运维与排障

## 1. 日常检查

- 健康检查：`GET /api/health`
- 统计检查：`GET /api/admin/stats`
- 待复核积压：`pending_count`

## 2. 常见问题

### 2.1 401 Unauthorized

- Agent 场景：检查 `X-API-Key` 是否与环境变量一致
- Admin 场景：检查 JWT 是否过期/格式错误

### 2.2 D1 报错（表不存在）

- 未执行 `schema.sql` 或执行到错误库
- 重新执行：

```bash
npx wrangler d1 execute inventory_db --file=./schema.sql
```

### 2.3 图片上传后无法访问

- 检查 R2 bucket 名称是否匹配 `wrangler.toml`
- 检查 URL 生成逻辑与 bucket 权限

## 3. 数据导入与导出

- 导入：`POST /api/admin/import`
  - 用于历史数据补录，导入后状态为 `approved`
- 导出：`GET /api/admin/export?status=approved`
  - 返回 CSV，可用于财务/仓储对账

## 4. 建议的后续改进

- 增加操作日志表（谁在何时审批了什么）
- 增加软删除而非物理删除
- 增加字段级校验与统一错误码
- 增加自动化测试（API 与权限边界）
