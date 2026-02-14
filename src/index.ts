import { Hono } from 'hono';
import { cors } from 'hono/cors';

// 类型定义
type Bindings = {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
  AGENT_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS 配置
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

// ========== 工具函数 ==========

// 简单的 JWT 实现
async function signJWT(payload: any, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const base64Header = btoa(JSON.stringify(header));
  const base64Payload = btoa(JSON.stringify(payload));
  const data = `${base64Header}.${base64Payload}`;
  
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const base64Signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return `${data}.${base64Signature}`;
}

async function verifyJWT(token: string, secret: string): Promise<any> {
  const encoder = new TextEncoder();
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  
  const data = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  
  const signature = Uint8Array.from(atob(parts[2]), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
  if (!valid) throw new Error('Invalid signature');
  
  return JSON.parse(atob(parts[1]));
}

// 生成 R2 预签名 URL
async function getSignedUrl(bucket: R2Bucket, key: string, method: string = 'PUT'): Promise<string> {
  // 简化为直接返回公开 URL，实际生产环境需要实现预签名逻辑
  return `https://inventory-images.r2.cloudflarestorage.com/${key}`;
}

// ========== 认证中间件 ==========

// API Key 认证（Agent 使用）
const apiKeyAuth = async (c: any, next: any) => {
  const apiKey = c.req.header('X-API-Key');
  if (!apiKey || apiKey !== c.env.AGENT_API_KEY) {
    return c.json({ error: 'Invalid API Key' }, 401);
  }
  await next();
};

// JWT 认证（管理员使用）
const jwtAuth = async (c: any, next: any) => {
  const auth = c.req.header('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  const token = auth.replace('Bearer ', '');
  try {
    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    if (payload.role !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403);
    }
    c.set('user', payload);
    await next();
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401);
  }
};

// ========== 公开端点 ==========

// 管理员登录
app.post('/api/auth/login', async (c) => {
  const { password } = await c.req.json();
  const env = c.env;
  
  // 简单密码验证（生产环境应该用 bcrypt）
  if (password !== 'WfrK1nCvpUgpNtj') {
    return c.json({ error: 'Invalid password' }, 401);
  }
  
  const token = await signJWT({ role: 'admin', sub: 'admin' }, env.JWT_SECRET);
  return c.json({ token, role: 'admin' });
});

// ========== Agent API (API Key 认证) ==========

// 新增记录
app.post('/api/agent/records', apiKeyAuth, async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  
  const {
    serial_no, vehicle_id, package_batch, inbound_date,
    actual_quantity, actual_weight, bill_of_lading,
    contract_no, loading_method, remarks, content_percent,
    image_url
  } = body;
  
  const result = await db.prepare(`
    INSERT INTO inventory_records (
      serial_no, vehicle_id, package_batch, inbound_date,
      actual_quantity, actual_weight, bill_of_lading,
      contract_no, loading_method, remarks, content_percent,
      image_url, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', 'agent')
  `).bind(
    serial_no || null, vehicle_id, package_batch, inbound_date,
    actual_quantity, actual_weight, bill_of_lading,
    contract_no, loading_method || '卸车直装', remarks, content_percent || 17,
    image_url || null
  ).run();
  
  return c.json({ 
    id: result.meta.last_row_id, 
    status: 'pending_review',
    message: 'Created successfully' 
  }, 201);
});

// 编辑记录（仅待复核且自己创建的）
app.put('/api/agent/records/:id', apiKeyAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json();
  
  // 先检查记录状态
  const record = await db.prepare(
    'SELECT status, created_by FROM inventory_records WHERE id = ?'
  ).bind(id).first();
  
  if (!record) {
    return c.json({ error: 'Record not found' }, 404);
  }
  
  if (record.status !== 'pending_review' || record.created_by !== 'agent') {
    return c.json({ error: 'Cannot edit this record' }, 403);
  }
  
  // 构建更新语句
  const allowedFields = [
    'serial_no', 'vehicle_id', 'package_batch', 'inbound_date',
    'actual_quantity', 'actual_weight', 'bill_of_lading',
    'contract_no', 'loading_method', 'remarks', 'content_percent', 'image_url'
  ];
  
  const updates: string[] = [];
  const values: any[] = [];
  
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(body[field]);
    }
  }
  
  if (updates.length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }
  
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  
  await db.prepare(`
    UPDATE inventory_records 
    SET ${updates.join(', ')} 
    WHERE id = ? AND status = 'pending_review' AND created_by = 'agent'
  `).bind(...values).run();
  
  return c.json({ updated: true });
});

// 查看自己创建的待复核记录
app.get('/api/agent/records', apiKeyAuth, async (c) => {
  const db = c.env.DB;
  const { page = '1', limit = '20' } = c.req.query();
  
  const offset = (parseInt(page) - 1) * parseInt(limit);
  
  const { results } = await db.prepare(`
    SELECT * FROM inventory_records 
    WHERE created_by = 'agent' 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).bind(parseInt(limit), offset).all();
  
  return c.json({ data: results });
});

// 获取单条记录
app.get('/api/agent/records/:id', apiKeyAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  const record = await db.prepare(
    'SELECT * FROM inventory_records WHERE id = ? AND created_by = "agent"'
  ).bind(id).first();
  
  if (!record) {
    return c.json({ error: 'Not found' }, 404);
  }
  
  return c.json(record);
});

// ========== 管理端 API (JWT 认证) ==========

// 查看所有记录
app.get('/api/admin/records', jwtAuth, async (c) => {
  const db = c.env.DB;
  const { 
    status, 
    batch, 
    vehicle, 
    startDate, 
    endDate,
    page = '1', 
    limit = '20' 
  } = c.req.query();
  
  let sql = 'SELECT * FROM inventory_records WHERE 1=1';
  const params: any[] = [];
  
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (batch) {
    sql += ' AND package_batch LIKE ?';
    params.push(`%${batch}%`);
  }
  if (vehicle) {
    sql += ' AND vehicle_id LIKE ?';
    params.push(`%${vehicle}%`);
  }
  if (startDate) {
    sql += ' AND inbound_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND inbound_date <= ?';
    params.push(endDate);
  }
  
  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const countResult = await db.prepare(countSql).bind(...params).first();
  
  const offset = (parseInt(page) - 1) * parseInt(limit);
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);
  
  const { results } = await db.prepare(sql).bind(...params).all();
  
  return c.json({
    data: results,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: countResult?.total || 0
    }
  });
});

// 获取单条记录
app.get('/api/admin/records/:id', jwtAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  const record = await db.prepare(
    'SELECT * FROM inventory_records WHERE id = ?'
  ).bind(id).first();
  
  if (!record) {
    return c.json({ error: 'Not found' }, 404);
  }
  
  return c.json(record);
});

// 复核通过
app.post('/api/admin/records/:id/approve', jwtAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const user = c.get('user');
  
  const result = await db.prepare(`
    UPDATE inventory_records 
    SET status = 'approved', 
        reviewed_by = ?, 
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'pending_review'
  `).bind(user.sub, id).run();
  
  if (result.meta.changes === 0) {
    return c.json({ error: 'Record not found or not in pending status' }, 404);
  }
  
  return c.json({ approved: true });
});

// 驳回（直接删除）
app.post('/api/admin/records/:id/reject', jwtAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  // 先获取记录（为了删除关联的图片）
  const record = await db.prepare(
    'SELECT image_url FROM inventory_records WHERE id = ? AND status = "pending_review"'
  ).bind(id).first();
  
  if (!record) {
    return c.json({ error: 'Record not found or not in pending status' }, 404);
  }
  
  // 删除记录
  await db.prepare('DELETE FROM inventory_records WHERE id = ?').bind(id).run();
  
  // 如果有图片，可以在这里添加删除 R2 图片的逻辑
  
  return c.json({ rejected: true, deleted: true });
});

// 删除任意记录
app.delete('/api/admin/records/:id', jwtAuth, async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  
  await db.prepare('DELETE FROM inventory_records WHERE id = ?').bind(id).run();
  return c.json({ deleted: true });
});

// 批量导入历史数据（status=approved）
app.post('/api/admin/import', jwtAuth, async (c) => {
  const db = c.env.DB;
  const { records } = await c.req.json();
  
  if (!Array.isArray(records) || records.length === 0) {
    return c.json({ error: 'Invalid records array' }, 400);
  }
  
  const imported: number[] = [];
  
  for (const record of records) {
    const result = await db.prepare(`
      INSERT INTO inventory_records (
        serial_no, vehicle_id, package_batch, inbound_date,
        actual_quantity, actual_weight, bill_of_lading,
        contract_no, loading_method, remarks, content_percent,
        status, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'admin')
    `).bind(
      record.serial_no || null,
      record.vehicle_id,
      record.package_batch,
      record.inbound_date,
      record.actual_quantity,
      record.actual_weight,
      record.bill_of_lading || null,
      record.contract_no || null,
      record.loading_method || '卸车直装',
      record.remarks || null,
      record.content_percent || 17
    ).run();
    
    imported.push(result.meta.last_row_id as number);
  }
  
  return c.json({ imported: imported.length, ids: imported });
});

// 导出 Excel（CSV 格式）
app.get('/api/admin/export', jwtAuth, async (c) => {
  const db = c.env.DB;
  const { status = 'approved' } = c.req.query();
  
  const { results } = await db.prepare(`
    SELECT * FROM inventory_records 
    WHERE status = ?
    ORDER BY inbound_date DESC
  `).bind(status).all();
  
  // 生成 CSV
  const headers = [
    '序号', '发车日期', '入库日期', '车号/箱号', '包装/批号', '发货含量',
    '发车件数', '发车吨数', '实收件数', '实收吨数', '破包', '污包', '湿包', '短少',
    '提单号', '合同号', '装柜方式', '装柜总件数', '装柜总吨数', '出库日期',
    '库存件数', '库存吨数', '备注', '状态', '创建人', '复核人', '创建时间'
  ];
  
  const rows = results.map((r: any) => [
    r.serial_no, r.dispatch_date, r.inbound_date, r.vehicle_id, r.package_batch, r.content_percent,
    r.dispatch_quantity, r.dispatch_weight, r.actual_quantity, r.actual_weight,
    r.broken_bags, r.dirty_bags, r.wet_bags, r.shortage,
    r.bill_of_lading, r.contract_no, r.loading_method, r.loaded_quantity, r.loaded_weight,
    r.outbound_date, r.stock_quantity, r.stock_weight, r.remarks,
    r.status, r.created_by, r.reviewed_by, r.created_at
  ]);
  
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv;charset=utf-8',
      'Content-Disposition': `attachment; filename="inventory_${status}_${new Date().toISOString().split('T')[0]}.csv"`
    }
  });
});

// 获取统计信息
app.get('/api/admin/stats', jwtAuth, async (c) => {
  const db = c.env.DB;
  
  const stats = await db.prepare(`
    SELECT 
      COUNT(*) as total_records,
      SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) as pending_count,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_count,
      SUM(actual_weight) as total_weight,
      SUM(CASE WHEN status = 'approved' THEN actual_weight ELSE 0 END) as approved_weight
    FROM inventory_records
  `).first();
  
  return c.json(stats);
});

// ========== 图片上传 ==========

function sanitizeFilename(filename: string): string {
  return (filename || 'upload.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
}

// 获取上传 URL（由 Worker 代理写入 R2，避免伪“预签名”）
app.post('/api/upload/url', apiKeyAuth, async (c) => {
  const { filename } = await c.req.json();
  const safeFilename = sanitizeFilename(filename);
  const key = `images/${Date.now()}_${safeFilename}`;

  return c.json({
    uploadUrl: `/api/upload/${key}`,
    uploadMethod: 'PUT',
    publicUrl: `/api/files/${key}`,
    key
  });
});

// 通过 Worker 上传到 R2（Agent 使用）
app.put('/api/upload/*', apiKeyAuth, async (c) => {
  const bucket = c.env.BUCKET;
  const key = c.req.path.replace('/api/upload/', '');

  if (!key) {
    return c.json({ error: 'Invalid upload key' }, 400);
  }

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const body = await c.req.raw.arrayBuffer();

  if (!body || body.byteLength === 0) {
    return c.json({ error: 'Empty file body' }, 400);
  }

  await bucket.put(key, body, {
    httpMetadata: { contentType }
  });

  return c.json({
    uploaded: true,
    key,
    publicUrl: `/api/files/${key}`
  });
});

// 通过 Worker 读取 R2 文件
app.get('/api/files/*', async (c) => {
  const bucket = c.env.BUCKET;
  const key = c.req.path.replace('/api/files/', '');

  if (!key) {
    return c.json({ error: 'Invalid file key' }, 400);
  }

  const obj = await bucket.get(key);
  if (!obj) {
    return c.json({ error: 'File not found' }, 404);
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
});

// 健康检查
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// 前端页面 - 根路径返回 HTML
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>库存管理系统 - 管理员</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header { background: white; padding: 16px 24px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .header h1 { font-size: 20px; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
    .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .stat-value { font-size: 28px; font-weight: 600; color: #1890ff; }
    .stat-label { font-size: 14px; color: #666; margin-top: 4px; }
    .toolbar { background: white; padding: 16px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 12px; flex-wrap: wrap; }
    input, select, button { padding: 8px 12px; border: 1px solid #d9d9d9; border-radius: 4px; }
    .btn { background: #1890ff; color: white; border: none; cursor: pointer; }
    .btn-danger { background: #ff4d4f; }
    .btn-success { background: #52c41a; }
    .table-container { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #f0f0f0; }
    th { background: #fafafa; }
    .tag { padding: 2px 8px; border-radius: 4px; font-size: 12px; background: #e6f7ff; color: #1890ff; }
    .tag.pending { background: #fff7e6; color: #fa8c16; }
    .tag.approved { background: #f6ffed; color: #52c41a; }
    .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 100; }
    .modal.show { display: flex; align-items: center; justify-content: center; }
    .modal-content { background: white; padding: 24px; border-radius: 8px; width: 90%; max-width: 600px; max-height: 90vh; overflow-y: auto; }
    .login-container { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .login-box { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const API_BASE = '/api';
    let token = localStorage.getItem('admin_token');
    
    // 简单的路由
    if (!token) {
      showLogin();
    } else {
      showMain();
    }
    
    function showLogin() {
      document.getElementById('app').innerHTML = \`
        <div class="login-container">
          <div class="login-box">
            <h2 style="margin-bottom: 24px; text-align: center;">🔐 管理员登录</h2>
            <form id="loginForm">
              <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-size: 14px; color: #666;">密码</label>
                <input type="password" id="password" placeholder="请输入密码" required style="width: 100%;">
              </div>
              <button type="submit" class="btn" style="width: 100%;">登录</button>
            </form>
          </div>
        </div>
      \`;
      
      document.getElementById('loginForm').onsubmit = async (e) => {
        e.preventDefault();
        const password = document.getElementById('password').value;
        const res = await fetch(\`\${API_BASE}/auth/login\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        const data = await res.json();
        if (data.token) {
          token = data.token;
          localStorage.setItem('admin_token', token);
          showMain();
        } else {
          alert('密码错误');
        }
      };
    }
    
    function showMain() {
      document.getElementById('app').innerHTML = \`
        <div class="container">
          <div class="header">
            <h1>📦 库存管理系统</h1>
            <div>
              <button class="btn btn-danger" onclick="logout()">退出</button>
            </div>
          </div>
          <div class="stats">
            <div class="stat-card"><div class="stat-value" id="totalCount">-</div><div class="stat-label">总记录数</div></div>
            <div class="stat-card"><div class="stat-value" id="pendingCount" style="color: #fa8c16;">-</div><div class="stat-label">待复核</div></div>
            <div class="stat-card"><div class="stat-value" id="approvedCount" style="color: #52c41a;">-</div><div class="stat-label">已确认</div></div>
            <div class="stat-card"><div class="stat-value" id="totalWeight">-</div><div class="stat-label">总重量(吨)</div></div>
          </div>
          <div class="toolbar">
            <input type="text" id="searchVehicle" placeholder="搜索车牌号...">
            <select id="filterBatch">
              <option value="">全部包装</option>
              <option value="1号袋">1号袋</option>
              <option value="2号袋">2号袋</option>
              <option value="3号袋">3号袋</option>
            </select>
            <button class="btn" onclick="loadData()">🔍 查询</button>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr><th>ID</th><th>入库日期</th><th>车号</th><th>包装</th><th>实收件数</th><th>实收吨数</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody id="tableBody"></tbody>
            </table>
          </div>
        </div>
      \`;
      loadStats();
      loadData();
    }
    
    async function loadStats() {
      const res = await fetch(\`\${API_BASE}/admin/stats\`, {
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      const data = await res.json();
      document.getElementById('totalCount').textContent = data.total_records || 0;
      document.getElementById('pendingCount').textContent = data.pending_count || 0;
      document.getElementById('approvedCount').textContent = data.approved_count || 0;
      document.getElementById('totalWeight').textContent = (data.total_weight || 0).toFixed(2);
    }
    
    async function loadData() {
      const vehicle = document.getElementById('searchVehicle')?.value?.trim() || '';
      const batch = document.getElementById('filterBatch')?.value || '';
      const params = new URLSearchParams();
      if (vehicle) params.set('vehicle', vehicle);
      if (batch) params.set('batch', batch);

      const url = \`\${API_BASE}/admin/records\${params.toString() ? ('?' + params.toString()) : ''}\`;
      const res = await fetch(url, {
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      const { data } = await res.json();
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = data.map(row => \`
        <tr>
          <td>\${row.id}</td>
          <td>\${row.inbound_date || '-'}</td>
          <td>\${row.vehicle_id}</td>
          <td><span class="tag">\${row.package_batch}</span></td>
          <td>\${row.actual_quantity}</td>
          <td>\${row.actual_weight}</td>
          <td><span class="tag \${row.status}">\${row.status === 'pending_review' ? '待复核' : '已确认'}</span></td>
          <td>
            \${row.status === 'pending_review' ? 
              \`<button class="btn btn-success" onclick="approve(\${row.id})" style="padding: 4px 8px; font-size: 12px;">通过</button>
                <button class="btn btn-danger" onclick="reject(\${row.id})" style="padding: 4px 8px; font-size: 12px;">驳回</button>\` : 
              '-'
            }
          </td>
        </tr>
      \`).join('');
    }
    
    async function approve(id) {
      if (!confirm('确认通过？')) return;
      await fetch(\`\${API_BASE}/admin/records/\${id}/approve\`, {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      loadData();
      loadStats();
    }
    
    async function reject(id) {
      if (!confirm('确认驳回？这将删除记录。')) return;
      await fetch(\`\${API_BASE}/admin/records/\${id}/reject\`, {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      loadData();
      loadStats();
    }
    
    function logout() {
      localStorage.removeItem('admin_token');
      location.reload();
    }
  </script>
</body>
</html>`);
});

export default app;
