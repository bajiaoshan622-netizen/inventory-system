# 部署文档

## 1. 前置资源

- Cloudflare Worker（服务本体）
- D1 数据库（`inventory_db`）
- R2 Bucket（`inventory-images`）

## 2. 本地部署（推荐开发）

```bash
npm install
npx wrangler d1 execute inventory_db --file=./schema.sql
npx wrangler deploy
```

## 3. Dashboard 手动部署（推荐无 CI 场景）

1. Workers & Pages 创建 Worker
2. 粘贴 `dist/worker.js`（或直接用源码+wrangler）
3. 绑定 D1：变量名 `DB`
4. 绑定 R2：变量名 `BUCKET`
5. 配置变量：
   - `JWT_SECRET`
   - `AGENT_API_KEY`
6. 发布并验证 `GET /api/health`

## 4. wrangler.toml 要点

- `[[d1_databases]]` 绑定名必须是 `DB`
- `[[r2_buckets]]` 绑定名必须是 `BUCKET`
- `JWT_SECRET` 与 `AGENT_API_KEY` 必须在生产环境使用强随机值

## 5. 安全建议（必须）

- 不要把真实密钥提交到仓库
- 管理员登录密码当前在 `src/index.ts` 内硬编码，建议尽快改为环境变量并加密存储
- R2 上传建议改为预签名 URL，避免公开写入风险
