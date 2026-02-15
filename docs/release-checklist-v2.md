# Release Checklist - Inventory v2

## 1) 上线前
- [ ] 确认代码包含提交：`200deae`, `7e2dc02`, `922c9d2`
- [ ] 备份当前 D1（导出或快照）
- [ ] 准备可用 Cloudflare API Token（D1:Edit）

## 2) 数据库迁移
```bash
cd /home/bajiaoshan/.openclaw/workspace/inventory-system
npx wrangler d1 execute inventory_db --remote --file=./schema.sql
```

## 3) 部署
```bash
npx wrangler deploy
```

## 4) 验收
- [ ] `GET /api/health` 返回 ok
- [ ] 管理员 `POST /api/v2/inbound` 直接 `approved`
- [ ] Agent `POST /api/v2/inbound` 为 `pending_review` 且附件必传
- [ ] 管理员审批后库存增加
- [ ] `POST /api/v2/outbound` 超量返回 409
- [ ] 待审批列表在管理页可见

## 5) 回滚
- 代码回滚到 v1 commit
- D1 不执行 destructive 变更，回滚主要是切回旧 API 路由
- 若 v2 写入已产生，保留表不启用路由（软回滚）
