# 📦 库存管理系统

基于 Cloudflare Workers + D1 + R2 的轻量级库存管理系统。

## 功能特性

- **双权限设计**：管理员（复核权限）+ Agent（录入权限，无删除）
- **待复核工作流**：Agent 录入 → 管理员复核（通过/驳回）
- **图片存储**：磅单照片自动上传至 Cloudflare R2
- **批量导入**：支持历史数据 JSON 批量导入
- **导出功能**：支持 CSV 格式导出已确认数据

## 技术栈

- **后端**: Cloudflare Workers (Hono)
- **数据库**: Cloudflare D1 (SQLite)
- **存储**: Cloudflare R2 (图片)
- **部署**: GitHub Actions 自动部署

## 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/bajiaoshan622-netizen/inventory-system.git
cd inventory-system
npm install
```

### 2. 创建 Cloudflare 资源

#### 创建 D1 数据库

```bash
npx wrangler d1 create inventory_db
```

记录返回的 `database_id`，后续会用到。

#### 执行数据库迁移

```bash
npx wrangler d1 execute inventory_db --file=./schema.sql
```

#### 创建 R2 Bucket

在 Cloudflare Dashboard → R2 → Create bucket，名称设为 `inventory-images`。

### 3. 配置 GitHub Secrets

在你的 GitHub 仓库 → Settings → Secrets and variables → Actions 中添加：

| Secret Name | 说明 | 获取方式 |
|------------|------|---------|
| `CF_API_TOKEN` | Cloudflare API Token | [获取方式](#获取-cf_api_token) |
| `CF_ACCOUNT_ID` | Cloudflare Account ID | Dashboard 首页右侧 |
| `DB_ID` | D1 数据库 ID | 创建数据库时的返回 |

### 4. 配置 wrangler.toml

编辑 `wrangler.toml`，填入你的 `database_id`：

```toml
name = "inventory-system"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "inventory_db"
database_id = "你的数据库ID"  # 替换这里

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "inventory-images"

[vars]
JWT_SECRET = "你的JWT密钥（随机字符串）"
AGENT_API_KEY = "你的Agent API密钥（随机字符串）"
```

### 5. 部署

推送代码到 main 分支，GitHub Actions 会自动部署：

```bash
git add .
git commit -m "Initial commit"
git push origin main
```

或本地部署：

```bash
npx wrangler deploy
```

## 使用说明

### 管理员登录

- 访问 `https://你的域名/`
- 默认密码：`admin123`
- **建议部署后立即修改密码**（在 `src/index.ts` 中搜索 `admin123` 替换）

### Agent API 调用示例

```bash
# 新增记录
curl -X POST https://你的域名/api/agent/records \
  -H "X-API-Key: 你的AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "vehicle_id": "桂P58838",
    "package_batch": "天宝英文3号袋",
    "inbound_date": "2026-02-10",
    "actual_quantity": 700,
    "actual_weight": 35.11,
    "bill_of_lading": "IW0602600001439",
    "contract_no": "TB26-14246",
    "loading_method": "卸车直装",
    "remarks": "批号20260210211/210"
  }'

# 查询待复核记录
curl https://你的域名/api/agent/records \
  -H "X-API-Key: 你的AGENT_API_KEY"
```

### 图片上传流程

```bash
# 1. 获取上传 URL
curl -X POST https://你的域名/api/upload/url \
  -H "X-API-Key: 你的AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filename": "磅单.jpg"}'

# 2. 上传图片（返回 uploadUrl）
curl -X PUT "返回的uploadUrl" \
  -H "Content-Type: image/jpeg" \
  --data-binary @磅单.jpg

# 3. 创建记录时带上 image_url
curl -X POST https://你的域名/api/agent/records \
  -H "X-API-Key: 你的AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "vehicle_id": "桂P58838",
    "package_batch": "天宝英文3号袋",
    "actual_quantity": 700,
    "actual_weight": 35.11,
    "image_url": "返回的publicUrl"
  }'
```

### 批量导入历史数据

在管理后台 → "批量导入"，粘贴 JSON 数组：

```json
[
  {
    "vehicle_id": "桂E31508",
    "package_batch": "1号袋TB2601001",
    "inbound_date": "2026-01-14",
    "actual_quantity": 700,
    "actual_weight": 35
  },
  {
    "vehicle_id": "桂E61656",
    "package_batch": "1号袋TB2601001",
    "inbound_date": "2026-01-13",
    "actual_quantity": 700,
    "actual_weight": 35
  }
]
```

导入的数据会自动标记为 `approved`（已确认）。

## API 文档

### 公开端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/login` | 管理员登录 |
| GET | `/api/health` | 健康检查 |

### Agent API (需 X-API-Key)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agent/records` | 新增记录（状态：待复核） |
| PUT | `/api/agent/records/:id` | 编辑记录（仅待复核） |
| GET | `/api/agent/records` | 查询自己创建的记录 |
| GET | `/api/agent/records/:id` | 获取单条记录 |
| POST | `/api/upload/url` | 获取图片上传 URL |

### 管理端 API (需 JWT)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/records` | 查看所有记录 |
| GET | `/api/admin/records/:id` | 获取单条记录 |
| POST | `/api/admin/records/:id/approve` | 复核通过 |
| POST | `/api/admin/records/:id/reject` | 驳回并删除 |
| DELETE | `/api/admin/records/:id` | 删除记录 |
| POST | `/api/admin/import` | 批量导入 |
| GET | `/api/admin/export` | 导出 CSV |
| GET | `/api/admin/stats` | 统计信息 |

## 获取 CF_API_TOKEN

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 点击右上角头像 → My Profile → API Tokens
3. 点击 "Create Token"
4. 选择 "Create Custom Token"
5. 权限设置：
   - Zone:Read (可选)
   - Account:Read
   - Workers Scripts:Edit
   - D1:Edit
   - R2:Edit
6. 账户资源：Include - 你的账户
7. 创建并复制 Token

## 安全建议

1. **修改默认密码**：部署后立即修改 `src/index.ts` 中的 `admin123`
2. **定期更换 API Key**：在 `wrangler.toml` 中更新 `AGENT_API_KEY`
3. **启用 R2 访问控制**：配置私有 bucket + 预签名 URL（当前为简化实现）
4. **HTTPS 强制**：Cloudflare 默认启用，无需额外配置

## 许可证

MIT
