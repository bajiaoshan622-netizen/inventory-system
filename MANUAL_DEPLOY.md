# 📦 手动部署指南

由于 API Token 权限问题，推荐手动在 Dashboard 部署。

## 方案：直接在 Cloudflare Dashboard 部署

### 步骤 1：打包代码

代码已经打包好了，在 `dist/worker.js`。

### 步骤 2：登录 Dashboard 创建 Worker

1. 访问 https://dash.cloudflare.com
2. 左侧菜单 → **Workers & Pages**
3. 点击 **"Create application"**
4. 选择 **"Create Worker"**
5. 输入名称：`inventory-system`
6. 点击 **"Deploy"**

### 步骤 3：编辑代码

1. 在 Worker 详情页，点击 **"Edit code"**
2. 删除默认代码
3. 复制 `dist/worker.js` 的全部内容，粘贴进去
4. 点击 **"Save and deploy"**

### 步骤 4：绑定 D1 数据库

1. 在 Worker 详情页，点击 **"Settings"** 标签
2. 找到 **"Variables"** 区域
3. 点击 **"Add binding"**
4. 选择类型：**D1 Database**
5. 设置：
   - Variable name: `DB`
   - D1 database: `inventory_db` (选择已创建的数据库)
6. 点击 **"Save"**

### 步骤 5：绑定 R2 Bucket

1. 继续点击 **"Add binding"**
2. 选择类型：**R2 Bucket**
3. 设置：
   - Variable name: `BUCKET`
   - R2 bucket: `inventory-images`
4. 点击 **"Save"**

### 步骤 6：设置环境变量

1. 点击 **"Add variable"**
2. 添加以下变量：

| Variable name | Value |
|--------------|-------|
| `JWT_SECRET` | `inv-sys-jwt-secret-2026-change-me` |
| `AGENT_API_KEY` | `e50a4620c6d7804a7bd4fd2f4a4a3058fa9df0ccf91caa289618e667fa75966e` |

3. 点击 **"Save"**

### 步骤 7：上传静态文件（前端）

1. 在 Worker 详情页，点击 **"Triggers"** 标签
2. 找到 **"Custom Domains"** 或 **"Routes"**
3. 如果使用默认域名，直接访问：
   ```
   https://inventory-system.your-account.workers.dev
   ```

### 步骤 8：绑定自定义域名（可选）

1. 在 **Triggers** 标签
2. 点击 **"Add Custom Domain"**
3. 输入你的域名，如：`inventory.yourdomain.com`
4. 点击 **"Add Custom Domain"**

---

## 替代方案：使用 Cloudflare Pages（推荐前端）

如果只部署前端界面：

1. 访问 https://dash.cloudflare.com
2. 左侧 **Workers & Pages** → **Create application**
3. 选择 **Pages** → **Upload assets**
4. 拖拽 `public/` 文件夹上传
5. 设置环境变量（同上）
6. 绑定自定义域名

---

## 验证部署

部署完成后，访问：
```
https://inventory-system.your-account.workers.dev/api/health
```

应该返回：
```json
{"status": "ok"}
```

---

## 登录信息

- **密码**: `WfrK1nCvpUgpNtj`
- **Agent API Key**: `e50a4620c6d7804a7bd4fd2f4a4a3058fa9df0ccf91caa289618e667fa75966e`
