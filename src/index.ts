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

// ==========================
// v2 多客户 / 货类 / 入出库
// ==========================

type Actor = {
  role: 'admin' | 'agent';
  id: string;
};

async function resolveActor(c: any): Promise<Actor> {
  const auth = c.req.header('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.replace('Bearer ', '');
    try {
      const payload = await verifyJWT(token, c.env.JWT_SECRET);
      if (payload?.role === 'admin') {
        return { role: 'admin', id: payload.sub || 'admin' };
      }
    } catch {}
  }

  const apiKey = c.req.header('X-API-Key');
  if (apiKey && apiKey === c.env.AGENT_API_KEY) {
    return { role: 'agent', id: 'agent' };
  }

  throw new Error('UNAUTHORIZED');
}

async function requireActor(c: any, allowed: Array<'admin' | 'agent'>): Promise<Actor | Response> {
  try {
    const actor = await resolveActor(c);
    if (!allowed.includes(actor.role)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return actor;
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
}

function createTraceId(): string {
  return (globalThis.crypto as any)?.randomUUID?.() || `t_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function logTrace(level: 'info' | 'error', traceId: string, route: string, detail: Record<string, any>) {
  const payload = { trace_id: traceId, route, ...detail };
  if (level === 'error') {
    console.error('[trace]', JSON.stringify(payload));
  } else {
    console.log('[trace]', JSON.stringify(payload));
  }
}

async function getTableColumns(db: D1Database, tableName: string): Promise<Set<string>> {
  const { results } = await db.prepare(`PRAGMA table_info(${tableName})`).all<any>();
  return new Set((results || []).map((r: any) => String(r.name)));
}

async function upsertBalance(db: D1Database, tenantId: number, categoryId: number, batchNo: string, qtyDelta: number, weightDelta: number) {
  const current = await db.prepare(
    'SELECT id, available_qty, available_weight FROM inventory_balance WHERE tenant_id = ? AND category_id = ? AND batch_no = ?'
  ).bind(tenantId, categoryId, batchNo).first<any>();

  if (!current) {
    await db.prepare(
      'INSERT INTO inventory_balance (tenant_id, category_id, batch_no, available_qty, available_weight) VALUES (?, ?, ?, ?, ?)'
    ).bind(tenantId, categoryId, batchNo, qtyDelta, weightDelta).run();
    return;
  }

  await db.prepare(
    'UPDATE inventory_balance SET available_qty = ?, available_weight = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).bind(
    (current.available_qty || 0) + qtyDelta,
    (current.available_weight || 0) + weightDelta,
    current.id
  ).run();
}

async function addHistory(db: D1Database, tenantId: number, recordType: string, recordId: number, action: string, beforeObj: any, afterObj: any, operator: string) {
  await db.prepare(
    'INSERT INTO record_history (tenant_id, record_type, record_id, action, before_json, after_json, operator) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    tenantId,
    recordType,
    recordId,
    action,
    beforeObj ? JSON.stringify(beforeObj) : null,
    afterObj ? JSON.stringify(afterObj) : null,
    operator
  ).run();
}

// Tenants
app.get('/api/v2/tenants', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const { results } = await c.env.DB.prepare('SELECT * FROM tenants WHERE status = "active" ORDER BY id ASC').all();
  return c.json({ data: results });
});

// Companies overview (for company list)
app.get('/api/v2/companies/overview', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.name,
      COALESCE(SUM(b.available_qty), 0) AS stock_qty,
      COALESCE(SUM(b.available_weight), 0) AS stock_weight,
      COALESCE((SELECT SUM(i.actual_qty) FROM inventory_inbound i WHERE i.tenant_id = t.id AND i.status = 'approved' AND i.inbound_date = ?), 0) AS today_in_qty,
      COALESCE((SELECT SUM(i.actual_weight) FROM inventory_inbound i WHERE i.tenant_id = t.id AND i.status = 'approved' AND i.inbound_date = ?), 0) AS today_in_weight,
      COALESCE((SELECT SUM(o.outbound_qty) FROM inventory_outbound o WHERE o.tenant_id = t.id AND o.outbound_date = ?), 0) AS today_out_qty,
      COALESCE((SELECT SUM(o.outbound_weight) FROM inventory_outbound o WHERE o.tenant_id = t.id AND o.outbound_date = ?), 0) AS today_out_weight
     FROM tenants t
     LEFT JOIN inventory_balance b ON b.tenant_id = t.id
     WHERE t.status = 'active'
     GROUP BY t.id, t.name
     ORDER BY t.id ASC`
  ).bind(today, today, today, today).all<any>();
  return c.json({ data: results });
});

// Stock summary (tenant detail page)
app.get('/api/v2/stock/summary', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const tenantId = Number(c.req.query('tenantId') || 1);
  const categoryId = c.req.query('categoryId');
  let sql = `SELECT b.tenant_id, b.category_id, c.name AS category_name, b.batch_no, b.available_qty, b.available_weight, b.updated_at
    FROM inventory_balance b
    LEFT JOIN categories c ON c.id = b.category_id
    WHERE b.tenant_id = ?`;
  const params: any[] = [tenantId];
  if (categoryId) { sql += ' AND b.category_id = ?'; params.push(Number(categoryId)); }
  sql += ' ORDER BY b.updated_at DESC, b.id DESC';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<any>();
  return c.json({ data: results });
});

// Categories
app.get('/api/v2/categories', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const tenantId = parseInt(c.req.query('tenantId') || '1');
  const { results } = await c.env.DB.prepare('SELECT * FROM categories WHERE tenant_id = ? AND active = 1 ORDER BY id ASC').bind(tenantId).all();
  return c.json({ data: results });
});

app.post('/api/v2/categories', async (c) => {
  const actor = await requireActor(c, ['admin']);
  if (actor instanceof Response) return actor;
  const body = await c.req.json();
  const tenantId = Number(body.tenant_id || 1);
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();
  const fieldSchema = body.field_schema_json || null;
  if (!code || !name) return c.json({ error: 'code and name are required' }, 400);

  const r = await c.env.DB.prepare(
    'INSERT INTO categories (tenant_id, code, name, field_schema_json) VALUES (?, ?, ?, ?)'
  ).bind(tenantId, code, name, fieldSchema ? JSON.stringify(fieldSchema) : null).run();

  return c.json({ id: r.meta.last_row_id, created: true }, 201);
});

// Attachments v2
app.post('/api/v2/attachments/upload-url', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const body = await c.req.json();
  const tenantId = Number(body.tenant_id || 1);
  const fileName = sanitizeFilename(String(body.filename || 'upload.jpg'));
  const key = `v2/${tenantId}/${Date.now()}_${fileName}`;

  return c.json({
    uploadUrl: `/api/v2/attachments/upload/${key}`,
    uploadMethod: 'PUT',
    key,
    fileName,
  });
});

app.put('/api/v2/attachments/upload/*', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const key = c.req.path.replace('/api/v2/attachments/upload/', '');
  if (!key) return c.json({ error: 'Invalid upload key' }, 400);

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const body = await c.req.raw.arrayBuffer();
  if (!body || body.byteLength === 0) return c.json({ error: 'Empty file body' }, 400);

  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType } });
  return c.json({ uploaded: true, key, size: body.byteLength });
});

app.get('/api/v2/attachments/file/*', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const key = c.req.path.replace('/api/v2/attachments/file/', '');
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.json({ error: 'File not found' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  return new Response(obj.body, { headers });
});

app.get('/api/v2/attachments', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const tenantId = Number(c.req.query('tenantId') || 1);
  const recordType = c.req.query('recordType');
  const recordId = Number(c.req.query('recordId') || 0);

  if (!recordType || !recordId) return c.json({ error: 'recordType and recordId are required' }, 400);

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM attachments WHERE tenant_id = ? AND record_type = ? AND record_id = ? ORDER BY id DESC'
  ).bind(tenantId, recordType, recordId).all();

  return c.json({ data: results });
});

// Inbound create
app.post('/api/v2/inbound', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const db = c.env.DB;
  const body = await c.req.json();

  const tenantId = Number(body.tenant_id || 1);
  const categoryId = Number(body.category_id);
  const batchNo = String(body.batch_no || '').trim();
  const actualQty = Number(body.actual_qty || 0);
  const actualWeight = Number(body.actual_weight || 0);
  const status = actor.role === 'admin' ? 'approved' : 'pending_review';

  if (!categoryId || !batchNo) return c.json({ error: 'category_id and batch_no are required' }, 400);
  if (actor.role === 'agent' && !body.attachment_key) {
    return c.json({ error: 'attachment_key is required for agent inbound' }, 400);
  }

  const r = await db.prepare(`
    INSERT INTO inventory_inbound (
      tenant_id, category_id, batch_no, vehicle_id, inbound_date,
      actual_qty, actual_weight, damage_broken, damage_dirty, damage_wet,
      shortage_qty, extra_qty, rotten_qty, remarks, status, source, created_by,
      approved_by, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    tenantId,
    categoryId,
    batchNo,
    body.vehicle_id || null,
    body.inbound_date || null,
    actualQty,
    actualWeight,
    Number(body.damage_broken || 0),
    Number(body.damage_dirty || 0),
    Number(body.damage_wet || 0),
    Number(body.shortage_qty || 0),
    Number(body.extra_qty || 0),
    Number(body.rotten_qty || 0),
    body.remarks || null,
    status,
    actor.role,
    actor.id,
    actor.role === 'admin' ? actor.id : null,
    actor.role === 'admin' ? new Date().toISOString() : null,
  ).run();

  const id = Number(r.meta.last_row_id || 0);

  if (body.attachment_key) {
    await db.prepare(
      'INSERT INTO attachments (tenant_id, record_type, record_id, r2_key, file_name, file_size, uploader) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      tenantId,
      'inbound',
      id,
      String(body.attachment_key),
      body.attachment_name || null,
      Number(body.attachment_size || 0),
      actor.id
    ).run();
  }

  await addHistory(db, tenantId, 'inbound', id, 'create', null, body, actor.id);

  if (status === 'approved') {
    await upsertBalance(db, tenantId, categoryId, batchNo, actualQty, actualWeight);
  }

  return c.json({ id, status }, 201);
});

// Inbound update
app.put('/api/v2/inbound/:id', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const body = await c.req.json();

  const current = await db.prepare('SELECT * FROM inventory_inbound WHERE id = ?').bind(id).first<any>();
  if (!current) return c.json({ error: 'Not found' }, 404);

  // Agent 更新已审批记录：进入待审批，不调整库存（保持当前已生效库存）
  const nextStatus = actor.role === 'admin' ? 'approved' : 'pending_review';

  const newActualQty = Number(body.actual_qty ?? current.actual_qty ?? 0);
  const newActualWeight = Number(body.actual_weight ?? current.actual_weight ?? 0);
  const newBatchNo = String(body.batch_no ?? current.batch_no ?? '');
  const newCategoryId = Number(body.category_id ?? current.category_id ?? 0);
  const newTenantId = Number(body.tenant_id ?? current.tenant_id ?? 1);

  await db.prepare(`
    UPDATE inventory_inbound SET
      tenant_id = ?, category_id = ?, batch_no = ?, vehicle_id = ?, inbound_date = ?,
      actual_qty = ?, actual_weight = ?, damage_broken = ?, damage_dirty = ?, damage_wet = ?,
      shortage_qty = ?, extra_qty = ?, rotten_qty = ?, remarks = ?, status = ?,
      approved_by = ?, approved_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    newTenantId,
    newCategoryId,
    newBatchNo,
    body.vehicle_id ?? current.vehicle_id,
    body.inbound_date ?? current.inbound_date,
    newActualQty,
    newActualWeight,
    Number(body.damage_broken ?? current.damage_broken ?? 0),
    Number(body.damage_dirty ?? current.damage_dirty ?? 0),
    Number(body.damage_wet ?? current.damage_wet ?? 0),
    Number(body.shortage_qty ?? current.shortage_qty ?? 0),
    Number(body.extra_qty ?? current.extra_qty ?? 0),
    Number(body.rotten_qty ?? current.rotten_qty ?? 0),
    body.remarks ?? current.remarks,
    nextStatus,
    actor.role === 'admin' ? actor.id : null,
    actor.role === 'admin' ? new Date().toISOString() : null,
    id
  ).run();

  await addHistory(db, current.tenant_id, 'inbound', id, 'update', current, body, actor.id);

  if (actor.role === 'admin' && current.status === 'approved') {
    // 回滚旧库存，再应用新库存
    await upsertBalance(db, Number(current.tenant_id), Number(current.category_id), String(current.batch_no), -Number(current.actual_qty || 0), -Number(current.actual_weight || 0));
    await upsertBalance(db, newTenantId, newCategoryId, newBatchNo, newActualQty, newActualWeight);
  }

  return c.json({ id, status: nextStatus, updated: true });
});

// Inbound approve/reject
app.post('/api/v2/inbound/:id/approve', async (c) => {
  const actor = await requireActor(c, ['admin']);
  if (actor instanceof Response) return actor;
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db.prepare('SELECT * FROM inventory_inbound WHERE id = ?').bind(id).first<any>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.status === 'approved') return c.json({ approved: true, already: true });

  await db.prepare('UPDATE inventory_inbound SET status = "approved", approved_by = ?, approved_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(actor.id, new Date().toISOString(), id).run();
  await upsertBalance(db, Number(row.tenant_id), Number(row.category_id), String(row.batch_no), Number(row.actual_qty || 0), Number(row.actual_weight || 0));
  await addHistory(db, Number(row.tenant_id), 'inbound', id, 'approve', row, { status: 'approved' }, actor.id);
  return c.json({ approved: true });
});

app.post('/api/v2/inbound/:id/reject', async (c) => {
  const actor = await requireActor(c, ['admin']);
  if (actor instanceof Response) return actor;
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const row = await db.prepare('SELECT * FROM inventory_inbound WHERE id = ?').bind(id).first<any>();
  if (!row) return c.json({ error: 'Not found' }, 404);

  await db.prepare('UPDATE inventory_inbound SET status = "rejected", approved_by = ?, approved_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(actor.id, new Date().toISOString(), id).run();
  await addHistory(db, Number(row.tenant_id), 'inbound', id, 'reject', row, { status: 'rejected' }, actor.id);
  return c.json({ rejected: true });
});

// Outbound create (admin only, direct effective; must select one approved inbound with remaining stock)
app.post('/api/v2/outbound', async (c) => {
  const actor = await requireActor(c, ['admin']);
  if (actor instanceof Response) return actor;
  const db = c.env.DB;
  const body = await c.req.json();

  const tenantId = Number(body.tenant_id || 1);
  const inboundId = Number(body.inbound_id || 0);
  const outboundQty = Number(body.outbound_qty || 0);
  const outboundWeight = Number(body.outbound_weight || 0);

  if (!inboundId || outboundQty <= 0) {
    return c.json({ error: 'inbound_id and outbound_qty are required' }, 400);
  }

  const inbound = await db.prepare(
    'SELECT * FROM inventory_inbound WHERE id = ? AND tenant_id = ? AND status = "approved"'
  ).bind(inboundId, tenantId).first<any>();
  if (!inbound) {
    return c.json({ error: 'Inbound record not found or not approved' }, 404);
  }

  const used = await db.prepare(
    'SELECT COALESCE(SUM(outbound_qty), 0) AS used_qty, COALESCE(SUM(outbound_weight), 0) AS used_weight FROM inventory_outbound WHERE inbound_id = ?'
  ).bind(inboundId).first<any>();

  const remainingQty = Number(inbound.actual_qty || 0) - Number(used?.used_qty || 0);
  const remainingWeight = Number(inbound.actual_weight || 0) - Number(used?.used_weight || 0);

  if (remainingQty <= 0 || outboundQty > remainingQty || outboundWeight > remainingWeight) {
    return c.json({ error: 'Outbound exceeds available inventory of selected inbound' }, 409);
  }

  const categoryId = Number(inbound.category_id);
  const batchNo = String(inbound.batch_no || '');

  const r = await db.prepare(`
    INSERT INTO inventory_outbound (
      tenant_id, inbound_id, category_id, batch_no, outbound_date, outbound_qty, outbound_weight,
      remarks, status, source, created_by, approved_by, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'admin', ?, ?, ?)
  `).bind(
    tenantId,
    inboundId,
    categoryId,
    batchNo,
    body.outbound_date || null,
    outboundQty,
    outboundWeight,
    body.remarks || null,
    actor.id,
    actor.id,
    new Date().toISOString()
  ).run();

  const id = Number(r.meta.last_row_id || 0);
  await upsertBalance(db, tenantId, categoryId, batchNo, -outboundQty, -outboundWeight);
  await addHistory(db, tenantId, 'outbound', id, 'create', null, { ...body, inbound_id: inboundId, category_id: categoryId, batch_no: batchNo }, actor.id);

  return c.json({ id, status: 'approved', remaining_qty: remainingQty - outboundQty, remaining_weight: remainingWeight - outboundWeight }, 201);
});

app.get('/api/v2/inbound', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const tenantId = Number(c.req.query('tenantId') || 1);
  const status = c.req.query('status');
  const categoryId = c.req.query('categoryId');
  const page = Number(c.req.query('page') || 1);
  const limit = Math.min(Number(c.req.query('limit') || 20), 100);
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM inventory_inbound WHERE tenant_id = ?';
  const params: any[] = [tenantId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (categoryId) { sql += ' AND category_id = ?'; params.push(Number(categoryId)); }
  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ data: results, page, limit });
});

app.get('/api/v2/inbound/pending', async (c) => {
  const actor = await requireActor(c, ['admin']);
  if (actor instanceof Response) return actor;
  const tenantId = Number(c.req.query('tenantId') || 1);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM inventory_inbound WHERE tenant_id = ? AND status = "pending_review" ORDER BY id DESC'
  ).bind(tenantId).all();
  return c.json({ data: results });
});

app.get('/api/v2/inbound/available', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;

  const traceId = createTraceId();
  const tenantIdRaw = c.req.query('tenantId') || '1';
  const categoryIdRaw = c.req.query('categoryId') || '0';
  const tenantId = Number(tenantIdRaw);
  const categoryId = Number(categoryIdRaw);
  const warnings: Array<{ code: string; message: string; count?: number }> = [];

  try {
    const outboundCols = await getTableColumns(c.env.DB, 'inventory_outbound');
    const hasInboundId = outboundCols.has('inbound_id');
    if (!hasInboundId) {
      warnings.push({ code: 'OUTBOUND_INBOUND_ID_MISSING', message: 'inventory_outbound 缺少 inbound_id，已降级为空结果' });
      logTrace('error', traceId, '/api/v2/inbound/available', { tenantIdRaw, categoryIdRaw, degraded: true, reason: 'missing inbound_id column' });
      return c.json({ data: [], meta: { tenant_id: tenantId, degraded: true }, warnings, trace_id: traceId });
    }

    let sql = `
      SELECT
        i.id AS inbound_id,
        i.tenant_id,
        i.category_id,
        COALESCE(c.name, '未分类') AS category_name,
        i.batch_no,
        i.inbound_date,
        i.actual_qty,
        i.actual_weight,
        COALESCE(SUM(o.outbound_qty), 0) AS used_qty,
        COALESCE(SUM(o.outbound_weight), 0) AS used_weight,
        (i.actual_qty - COALESCE(SUM(o.outbound_qty), 0)) AS remaining_qty,
        (i.actual_weight - COALESCE(SUM(o.outbound_weight), 0)) AS remaining_weight
      FROM inventory_inbound i
      LEFT JOIN inventory_outbound o ON o.inbound_id = i.id
      LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.tenant_id = ? AND i.status = 'approved'
    `;
    const params: any[] = [tenantId];
    if (categoryId) {
      sql += ' AND i.category_id = ?';
      params.push(categoryId);
    }
    sql += ' GROUP BY i.id HAVING remaining_qty > 0 OR remaining_weight > 0 ORDER BY i.inbound_date DESC, i.id DESC';

    const { results } = await c.env.DB.prepare(sql).bind(...params).all();

    const dirty1 = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM inventory_outbound WHERE inbound_id IS NULL').first<any>();
    const dirty2 = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM inventory_outbound o LEFT JOIN inventory_inbound i ON i.id = o.inbound_id WHERE o.inbound_id IS NOT NULL AND i.id IS NULL').first<any>();
    const dirty3 = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM inventory_outbound o JOIN inventory_inbound i ON i.id = o.inbound_id WHERE o.tenant_id != i.tenant_id').first<any>();
    if (Number(dirty1?.c || 0) > 0) warnings.push({ code: 'OUTBOUND_INBOUND_ID_NULL', message: '存在出库记录缺少 inbound_id', count: Number(dirty1?.c || 0) });
    if (Number(dirty2?.c || 0) > 0) warnings.push({ code: 'OUTBOUND_ORPHAN_REF', message: '存在出库记录关联不存在的入库', count: Number(dirty2?.c || 0) });
    if (Number(dirty3?.c || 0) > 0) warnings.push({ code: 'OUTBOUND_CROSS_TENANT', message: '存在跨租户关联的出库记录', count: Number(dirty3?.c || 0) });

    logTrace('info', traceId, '/api/v2/inbound/available', {
      tenantIdRaw, categoryIdRaw, tenantId, categoryId,
      result_count: (results || []).length,
      degraded: warnings.length > 0,
      warnings_count: warnings.length,
    });
    return c.json({ data: results, meta: { tenant_id: tenantId, degraded: warnings.length > 0 }, warnings, trace_id: traceId });
  } catch (error: any) {
    logTrace('error', traceId, '/api/v2/inbound/available', {
      tenantIdRaw, categoryIdRaw, tenantId, categoryId,
      error: String(error?.message || error),
    });
    return c.json({ data: [], meta: { tenant_id: tenantId, degraded: true }, warnings: [{ code: 'AVAILABLE_QUERY_FAILED', message: '可出库查询失败，已降级返回空结果' }], trace_id: traceId }, 200);
  }
});

app.get('/api/v2/outbound', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const tenantId = Number(c.req.query('tenantId') || 1);
  const page = Number(c.req.query('page') || 1);
  const limit = Math.min(Number(c.req.query('limit') || 20), 100);
  const offset = (page - 1) * limit;
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM inventory_outbound WHERE tenant_id = ? ORDER BY id DESC LIMIT ? OFFSET ?'
  ).bind(tenantId, limit, offset).all();
  return c.json({ data: results, page, limit });
});

app.get('/api/v2/balance', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const tenantId = Number(c.req.query('tenantId') || 1);
  const categoryId = c.req.query('categoryId');
  const batchNo = c.req.query('batchNo');

  let sql = 'SELECT * FROM inventory_balance WHERE tenant_id = ?';
  const params: any[] = [tenantId];
  if (categoryId) {
    sql += ' AND category_id = ?';
    params.push(Number(categoryId));
  }
  if (batchNo) {
    sql += ' AND batch_no = ?';
    params.push(batchNo);
  }
  sql += ' ORDER BY category_id, batch_no';

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ data: results });
});

app.get('/api/v2/ledger/inbound-outbound', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;

  const traceId = createTraceId();
  const db = c.env.DB;
  const tenantIdRaw = c.req.query('tenantId') || '1';
  const categoryIdRaw = c.req.query('categoryId') || '0';
  const tenantId = Number(tenantIdRaw);
  const categoryId = Number(categoryIdRaw);
  const warnings: Array<{ code: string; message: string; count?: number }> = [];

  try {
    let inboundSql = `
      SELECT
        i.id AS inbound_id,
        i.tenant_id,
        i.category_id,
        COALESCE(c.name, '未分类') AS category_name,
        i.inbound_date,
        i.vehicle_id,
        i.batch_no,
        i.actual_qty,
        i.actual_weight,
        i.damage_broken,
        i.damage_dirty,
        i.damage_wet,
        i.shortage_qty,
        i.extra_qty,
        i.rotten_qty,
        i.remarks,
        i.status
      FROM inventory_inbound i
      LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.tenant_id = ?
    `;
    const inboundParams: any[] = [tenantId];
    if (categoryId) {
      inboundSql += ' AND i.category_id = ?';
      inboundParams.push(categoryId);
    }
    inboundSql += ' ORDER BY i.inbound_date DESC, i.id DESC';

    const inboundRows = (await db.prepare(inboundSql).bind(...inboundParams).all()).results || [];
    if (!inboundRows.length) {
      return c.json({ data: [], meta: { tenant_id: tenantId, degraded: false }, warnings, trace_id: traceId });
    }

    const outboundCols = await getTableColumns(db, 'inventory_outbound');
    const hasInboundId = outboundCols.has('inbound_id');

    let outbounds: any[] = [];
    if (!hasInboundId) {
      warnings.push({ code: 'OUTBOUND_INBOUND_ID_MISSING', message: 'inventory_outbound 缺少 inbound_id，已降级不关联出库' });
    } else {
      const inboundIds = inboundRows.map((r: any) => Number(r.inbound_id));
      const placeholders = inboundIds.map(() => '?').join(', ');
      outbounds = (await db.prepare(
        `SELECT id AS outbound_id, inbound_id, outbound_date, outbound_qty, outbound_weight, remarks, created_by
         FROM inventory_outbound
         WHERE inbound_id IN (${placeholders})
         ORDER BY outbound_date DESC, id DESC`
      ).bind(...inboundIds).all()).results || [];

      const dirty1 = await db.prepare('SELECT COUNT(*) AS c FROM inventory_outbound WHERE inbound_id IS NULL').first<any>();
      const dirty2 = await db.prepare('SELECT COUNT(*) AS c FROM inventory_outbound o LEFT JOIN inventory_inbound i ON i.id = o.inbound_id WHERE o.inbound_id IS NOT NULL AND i.id IS NULL').first<any>();
      const dirty3 = await db.prepare('SELECT COUNT(*) AS c FROM inventory_outbound o JOIN inventory_inbound i ON i.id = o.inbound_id WHERE o.tenant_id != i.tenant_id').first<any>();
      if (Number(dirty1?.c || 0) > 0) warnings.push({ code: 'OUTBOUND_INBOUND_ID_NULL', message: '存在出库记录缺少 inbound_id', count: Number(dirty1?.c || 0) });
      if (Number(dirty2?.c || 0) > 0) warnings.push({ code: 'OUTBOUND_ORPHAN_REF', message: '存在出库记录关联不存在的入库', count: Number(dirty2?.c || 0) });
      if (Number(dirty3?.c || 0) > 0) warnings.push({ code: 'OUTBOUND_CROSS_TENANT', message: '存在跨租户关联的出库记录', count: Number(dirty3?.c || 0) });
    }

    const outMap = new Map<number, any[]>();
    for (const o of outbounds as any[]) {
      const key = Number(o.inbound_id);
      if (!outMap.has(key)) outMap.set(key, []);
      outMap.get(key)!.push(o);
    }

    const data = (inboundRows as any[]).map((inb) => {
      const list = outMap.get(Number(inb.inbound_id)) || [];
      const totalQty = list.reduce((s, x) => s + Number(x.outbound_qty || 0), 0);
      const totalWeight = list.reduce((s, x) => s + Number(x.outbound_weight || 0), 0);
      const sortedAsc = [...list].sort((a, b) => String(a.outbound_date || '').localeCompare(String(b.outbound_date || '')));
      const firstOutboundDate = sortedAsc.length ? sortedAsc[0].outbound_date : null;
      const lastOutboundDate = sortedAsc.length ? sortedAsc[sortedAsc.length - 1].outbound_date : null;

      return {
        inbound: {
          inbound_id: inb.inbound_id,
          tenant_id: inb.tenant_id,
          category_id: inb.category_id,
          category_name: inb.category_name,
          inbound_date: inb.inbound_date,
          vehicle_id: inb.vehicle_id,
          batch_no: inb.batch_no,
          actual_qty: Number(inb.actual_qty || 0),
          actual_weight: Number(inb.actual_weight || 0),
          damage_broken: Number(inb.damage_broken || 0),
          damage_dirty: Number(inb.damage_dirty || 0),
          damage_wet: Number(inb.damage_wet || 0),
          shortage_qty: Number(inb.shortage_qty || 0),
          extra_qty: Number(inb.extra_qty || 0),
          rotten_qty: Number(inb.rotten_qty || 0),
          remarks: inb.remarks,
          status: inb.status,
        },
        outbounds: list.map((o) => ({
          outbound_id: o.outbound_id,
          outbound_date: o.outbound_date,
          outbound_qty: Number(o.outbound_qty || 0),
          outbound_weight: Number(o.outbound_weight || 0),
          remarks: o.remarks,
          created_by: o.created_by,
        })),
        outbound_summary: {
          total_count: list.length,
          total_qty: totalQty,
          total_weight: totalWeight,
          first_outbound_date: firstOutboundDate,
          last_outbound_date: lastOutboundDate,
        },
        remaining: {
          qty: Number(inb.actual_qty || 0) - totalQty,
          weight: Number(inb.actual_weight || 0) - totalWeight,
        },
      };
    });

    logTrace('info', traceId, '/api/v2/ledger/inbound-outbound', {
      tenantIdRaw, categoryIdRaw, tenantId, categoryId,
      inbound_count: inboundRows.length,
      outbound_count: (outbounds || []).length,
      degraded: warnings.length > 0,
      warnings_count: warnings.length,
    });

    return c.json({ data, meta: { tenant_id: tenantId, degraded: warnings.length > 0 }, warnings, trace_id: traceId });
  } catch (error: any) {
    logTrace('error', traceId, '/api/v2/ledger/inbound-outbound', {
      tenantIdRaw, categoryIdRaw, tenantId, categoryId,
      error: String(error?.message || error),
    });
    return c.json({ data: [], meta: { tenant_id: tenantId, degraded: true }, warnings: [{ code: 'LEDGER_QUERY_FAILED', message: '台账查询失败，已降级返回空结果' }], trace_id: traceId }, 200);
  }
});

app.get('/api/v2/history', async (c) => {
  const actor = await requireActor(c, ['admin', 'agent']);
  if (actor instanceof Response) return actor;
  const recordType = c.req.query('recordType');
  const recordId = c.req.query('recordId');
  if (!recordType || !recordId) return c.json({ error: 'recordType and recordId are required' }, 400);

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM record_history WHERE record_type = ? AND record_id = ? ORDER BY id DESC'
  ).bind(recordType, Number(recordId)).all();

  return c.json({ data: results });
});

// 健康检查
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// 前端页面 - 根路径返回 HTML
app.get("/", (c) => {
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
    .row-highlight { animation: rowFlash 2.5s ease; }
    .status-badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; background:#f5f5f5; color:#666; }
    @keyframes rowFlash {
      0% { background-color: #fff7e6; }
      100% { background-color: transparent; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const API_BASE = '/api';
    let token = localStorage.getItem('admin_token');
    let lastUpdatedInboundId = null;
    
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
    
    let currentCompanyId = null;
    let currentCompanyName = '';

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
            <div class="stat-card"><div class="stat-value" id="pendingCount" style="color: #fa8c16;">-</div><div class="stat-label">待审核</div></div>
            <div class="stat-card"><div class="stat-value" id="approvedCount" style="color: #52c41a;">-</div><div class="stat-label">已通过</div></div>
            <div class="stat-card"><div class="stat-value" id="totalWeight">-</div><div class="stat-label">总重量(吨)</div></div>
          </div>

          <div id="companyListView">
            <div class="toolbar">
              <strong>公司列表</strong>
              <input type="text" id="companySearch" placeholder="输入公司名称搜索" style="min-width:220px;" oninput="renderCompanyList()">
              <button class="btn" onclick="loadCompanyList()">刷新公司列表</button>
            </div>
            <div class="table-container" style="margin-bottom:16px;">
              <table>
                <thead>
                  <tr><th>公司名称</th><th>当前库存（件/吨）</th><th>今日入库（件/吨）</th><th>今日出库（件/吨）</th><th>操作</th></tr>
                </thead>
                <tbody id="companyBody"></tbody>
              </table>
            </div>
          </div>

          <div id="companyDetailView" style="display:none;">
            <div class="toolbar">
              <button class="btn" onclick="backToCompanyList()">返回公司列表</button>
              <strong id="companyTitle">公司详情</strong>
              <input type="hidden" id="v2TenantId" value="1">
              <select id="v2CategoryId" style="min-width:170px;" onchange="reloadV2Data()"><option value="">全部货类</option></select>
              <input type="date" id="filterStartDate" onchange="reloadV2Data()">
              <input type="date" id="filterEndDate" onchange="reloadV2Data()">
              <button class="btn" onclick="reloadV2Data()">刷新详情</button>
            </div>

            <div class="toolbar">
              <strong>出库登记（从仍有库存入库中选择）</strong>
              <select id="v2InboundSelect" style="min-width:340px;"></select>
              <input type="date" id="v2OutboundDate" style="width:150px;">
              <input type="number" id="v2OutboundQty" placeholder="出库件数" style="width:110px;">
              <input type="number" id="v2OutboundWeight" placeholder="出库吨数" style="width:110px;">
              <button class="btn" id="v2SubmitBtn" onclick="createOutboundV2()">提交出库</button>
            </div>
            <div class="toolbar" id="v2InboundHint" style="color:#666; font-size:13px;">加载中...</div>
            <div class="toolbar" id="v2LimitHint" style="color:#999; font-size:13px;">请选择入库记录后录入出库数量</div>

            <div class="table-container" style="margin-bottom:16px;">
              <table>
                <thead><tr><th colspan="7">待审批入库（采集端）</th></tr></thead>
                <thead><tr><th>ID</th><th>租户</th><th>货类</th><th>批号</th><th>件数</th><th>状态</th><th>操作</th></tr></thead>
                <tbody id="pendingBody"></tbody>
              </table>
            </div>

            <div class="table-container" style="margin-bottom:16px;">
              <table>
                <thead><tr><th>操作</th><th>入库ID</th><th>入库日期</th><th>车号</th><th>批号</th><th>实收件数</th><th>实收吨数</th><th>出库汇总</th><th>库存件数</th><th>库存吨数</th></tr></thead>
                <tbody id="ledgerBody"></tbody>
              </table>
            </div>

            <div class="table-container" style="margin-bottom:16px;">
              <table>
                <thead><tr><th colspan="6">出库明细</th></tr></thead>
                <thead><tr><th>出库ID</th><th>入库ID</th><th>出库日期</th><th>件数</th><th>吨数</th><th>备注</th></tr></thead>
                <tbody id="outboundBody"></tbody>
              </table>
            </div>

            <div class="table-container">
              <table>
                <thead><tr><th colspan="5">当前库存（按货类/批号）</th></tr></thead>
                <thead><tr><th>货类</th><th>批号</th><th>库存件数</th><th>库存吨数</th><th>更新时间</th></tr></thead>
                <tbody id="stockBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      \`;
      document.getElementById('v2OutboundQty')?.addEventListener('input', updateLimitHint);
      document.getElementById('v2OutboundWeight')?.addEventListener('input', updateLimitHint);
      loadStats();
      loadCompanyList();
    }

    async function loadStats() {
      const res = await fetch(\`\${API_BASE}/admin/stats\`, { headers: { 'Authorization': \`Bearer \${token}\` } });
      const data = await res.json();
      document.getElementById('totalCount').textContent = data.total_records || 0;
      document.getElementById('pendingCount').textContent = data.pending_count || 0;
      document.getElementById('approvedCount').textContent = data.approved_count || 0;
      document.getElementById('totalWeight').textContent = (data.total_weight || 0).toFixed(2);
    }

    let companyList = [];
    async function loadCompanyList() {
      const res = await fetch(\`\${API_BASE}/v2/companies/overview\`, { headers: { 'Authorization': \`Bearer \${token}\` } });
      const payload = await res.json();
      companyList = payload.data || [];
      renderCompanyList();
    }

    function renderCompanyList() {
      const keyword = String(document.getElementById('companySearch')?.value || '').trim().toLowerCase();
      const tbody = document.getElementById('companyBody');
      if (!tbody) return;
      const list = keyword ? companyList.filter(x => String(x.name || '').toLowerCase().includes(keyword)) : companyList;
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">暂无公司数据</td></tr>';
        return;
      }
      tbody.innerHTML = list.map(row => \`
        <tr>
          <td>\${row.name || '-'}（ID: \${row.id}）</td>
          <td>\${row.stock_qty || 0} 件 / \${row.stock_weight || 0} 吨</td>
          <td>\${row.today_in_qty || 0} 件 / \${row.today_in_weight || 0} 吨</td>
          <td>\${row.today_out_qty || 0} 件 / \${row.today_out_weight || 0} 吨</td>
          <td><button class="btn" style="padding:4px 10px;font-size:12px;" onclick="openCompanyDetail(\${row.id}, '\${String(row.name || '').replace(/'/g, "\'")}')">进入</button></td>
        </tr>
      \`).join('');
    }

    async function openCompanyDetail(companyId, companyName) {
      currentCompanyId = Number(companyId);
      currentCompanyName = String(companyName || \`公司#\${companyId}\`);
      document.getElementById('v2TenantId').value = String(companyId);
      document.getElementById('companyTitle').textContent = \`公司详情：\${currentCompanyName}\`;
      document.getElementById('companyListView').style.display = 'none';
      document.getElementById('companyDetailView').style.display = '';
      await loadCategoryOptions(companyId);
      await reloadV2Data();
      await loadPendingV2();
    }

    function backToCompanyList() {
      currentCompanyId = null;
      currentCompanyName = '';
      document.getElementById('companyDetailView').style.display = 'none';
      document.getElementById('companyListView').style.display = '';
      loadCompanyList();
    }

    async function loadCategoryOptions(tenantId) {
      const select = document.getElementById('v2CategoryId');
      if (!select) return;
      const res = await fetch(\`\${API_BASE}/v2/categories?tenantId=\${tenantId}\`, { headers: { 'Authorization': \`Bearer \${token}\` } });
      const payload = await res.json();
      const data = payload.data || [];
      select.innerHTML = \`<option value="">全部货类</option>\` + data.map(x => \`<option value="\${x.id}">\${x.name || x.code || ('货类' + x.id)}</option>\`).join('');
    }

    async function reloadV2Data() {
      if (!currentCompanyId) return;
      await Promise.all([loadAvailableInboundV2(), loadLedgerV2(), loadOutboundListV2(), loadStockSummaryV2()]);
    }

    async function loadAvailableInboundV2() {
      const tenantId = document.getElementById('v2TenantId')?.value || '1';
      const categoryId = document.getElementById('v2CategoryId')?.value || '';
      const params = new URLSearchParams({ tenantId });
      if (categoryId) params.set('categoryId', categoryId);
      const res = await fetch(\`\${API_BASE}/v2/inbound/available?\${params.toString()}\`, { headers: { 'Authorization': \`Bearer \${token}\` } });
      const payload = await res.json();
      const data = payload.data || [];
      const select = document.getElementById('v2InboundSelect');
      const hint = document.getElementById('v2InboundHint');
      const btn = document.getElementById('v2SubmitBtn');
      if (!select || !hint || !btn) return;
      if (!data.length) {
        select.innerHTML = '<option value="">暂无可出库库存</option>';
        hint.textContent = '当前无可出库库存，请先完成入库或审批。';
        const limitHint = document.getElementById('v2LimitHint');
        if (limitHint) limitHint.textContent = '当前无可出库库存，无法录入出库数量';
        btn.disabled = true;
        return;
      }
      select.innerHTML = data.map(row => {
        const label = \`#\${row.inbound_id} \${row.batch_no || '-'} | 剩余 \${row.remaining_qty || 0}件/\${row.remaining_weight || 0}吨\`;
        return \`<option value="\${row.inbound_id}" data-qty="\${row.remaining_qty || 0}" data-weight="\${row.remaining_weight || 0}">\${label}</option>\`;
      }).join('');
      const first = data[0];
      hint.textContent = \`已加载 \${data.length} 条可出库入库记录，当前选择 #\${first.inbound_id}，剩余 \${first.remaining_qty || 0} 件 / \${first.remaining_weight || 0} 吨。\`;
      btn.disabled = false;
      select.onchange = () => {
        const opt = select.options[select.selectedIndex];
        hint.textContent = \`当前选择入库 #\${opt.value}，剩余 \${opt.dataset.qty || 0} 件 / \${opt.dataset.weight || 0} 吨。\`;
        updateLimitHint();
      };
      updateLimitHint();
    }

    function toggleOutboundDetails(inboundId) {
      const row = document.getElementById(\`detail-row-\${inboundId}\`);
      if (!row) return;
      row.style.display = row.style.display === 'none' ? '' : 'none';
    }

    function focusInboundRow(inboundId) {
      const row = document.getElementById(\`inbound-row-\${inboundId}\`);
      if (!row) return;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('row-highlight');
      setTimeout(() => row.classList.remove('row-highlight'), 2500);
    }

    function updateLimitHint() {
      const hint = document.getElementById('v2LimitHint');
      const option = document.getElementById('v2InboundSelect')?.selectedOptions?.[0];
      if (!hint || !option) return;
      const maxQty = Number(option.dataset.qty || 0);
      const maxWeight = Number(option.dataset.weight || 0);
      const inputQty = Number(document.getElementById('v2OutboundQty')?.value || 0);
      const inputWeight = Number(document.getElementById('v2OutboundWeight')?.value || 0);
      hint.textContent = \`本入库最多可出 \${maxQty} 件 / \${maxWeight} 吨；当前输入 \${inputQty} 件 / \${inputWeight} 吨\`;
    }

    async function loadLedgerV2() {
      const tenantId = document.getElementById('v2TenantId')?.value || '1';
      const categoryId = document.getElementById('v2CategoryId')?.value || '';
      const params = new URLSearchParams({ tenantId });
      if (categoryId) params.set('categoryId', categoryId);
      const res = await fetch(\`\${API_BASE}/v2/ledger/inbound-outbound?\${params.toString()}\`, { headers: { 'Authorization': \`Bearer \${token}\` } });
      const payload = await res.json();
      const data = payload.data || [];
      const tbody = document.getElementById('ledgerBody');
      if (!tbody) return;
      if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#999;">暂无入库数据</td></tr>';
        return;
      }
      tbody.innerHTML = data.map(item => {
        const inbound = item.inbound || {};
        const outbounds = item.outbounds || [];
        const summary = item.outbound_summary || {};
        const remaining = item.remaining || {};
        const hasOutbound = outbounds.length > 0;
        const summaryText = hasOutbound ? \`\${summary.total_count || 0}笔 / \${summary.total_qty || 0}件 / \${summary.total_weight || 0}吨\` : '<span class="status-badge">未出库</span>';
        const detailHtml = hasOutbound ? \`
            <table style="width:100%; border-collapse:collapse; margin-top:8px; font-size:12px;">
              <thead><tr style="background:#fafafa;"><th style="padding:8px;">出库ID</th><th style="padding:8px;">出库日期</th><th style="padding:8px;">件数</th><th style="padding:8px;">吨数</th><th style="padding:8px;">备注</th><th style="padding:8px;">操作人</th></tr></thead>
              <tbody>
                \${outbounds.map(o => \`<tr><td style="padding:8px; border-top:1px solid #f0f0f0;">\${o.outbound_id}</td><td style="padding:8px; border-top:1px solid #f0f0f0;">\${o.outbound_date || '-'}</td><td style="padding:8px; border-top:1px solid #f0f0f0;">\${o.outbound_qty || 0}</td><td style="padding:8px; border-top:1px solid #f0f0f0;">\${o.outbound_weight || 0}</td><td style="padding:8px; border-top:1px solid #f0f0f0;">\${o.remarks || '-'}</td><td style="padding:8px; border-top:1px solid #f0f0f0;">\${o.created_by || '-'}</td></tr>\`).join('')}
              </tbody>
            </table>
          \` : \`<div style="margin:8px 0; padding:12px; border:1px dashed #d9d9d9; border-radius:8px; background:#fcfcfc; color:#666;"><div style="font-weight:600; margin-bottom:6px;">该入库记录暂未关联出库记录</div><div style="font-size:12px; color:#999;">可在上方“出库登记”中选择本入库发起出库</div></div>\`;
        return \`
          <tr id="inbound-row-\${inbound.inbound_id}">
            <td><button class="btn" style="padding:4px 8px;font-size:12px;" onclick="toggleOutboundDetails(\${inbound.inbound_id})">展开</button></td>
            <td>\${inbound.inbound_id}</td><td>\${inbound.inbound_date || '-'}</td><td>\${inbound.vehicle_id || '-'}</td><td><span class="tag">\${inbound.batch_no || '-'}</span></td><td>\${inbound.actual_qty || 0}</td><td>\${inbound.actual_weight || 0}</td><td>\${summaryText}</td><td>\${remaining.qty || 0}</td><td>\${remaining.weight || 0}</td>
          </tr>
          <tr id="detail-row-\${inbound.inbound_id}" style="display:none; background:#fff;"><td colspan="10" style="padding:8px 12px;">\${detailHtml}</td></tr>
        \`;
      }).join('');
      if (lastUpdatedInboundId) {
        focusInboundRow(lastUpdatedInboundId);
        lastUpdatedInboundId = null;
      }
    }

    async function loadOutboundListV2() {
      const tenantId = document.getElementById('v2TenantId')?.value || '1';
      const res = await fetch(\`\${API_BASE}/v2/outbound?tenantId=\${tenantId}&page=1&limit=100\`, { headers: { 'Authorization': \`Bearer \${token}\` } });
      const payload = await res.json();
      const data = payload.data || [];
      const tbody = document.getElementById('outboundBody');
      if (!tbody) return;
      if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;">暂无出库数据</td></tr>';
        return;
      }
      tbody.innerHTML = data.map(row => \`<tr><td>\${row.id}</td><td>\${row.inbound_id || '-'}</td><td>\${row.outbound_date || '-'}</td><td>\${row.outbound_qty || 0}</td><td>\${row.outbound_weight || 0}</td><td>\${row.remarks || '-'}</td></tr>\`).join('');
    }

    async function loadStockSummaryV2() {
      const tenantId = document.getElementById('v2TenantId')?.value || '1';
      const categoryId = document.getElementById('v2CategoryId')?.value || '';
      const params = new URLSearchParams({ tenantId });
      if (categoryId) params.set('categoryId', categoryId);
      const res = await fetch(\`\${API_BASE}/v2/stock/summary?\${params.toString()}\`, { headers: { 'Authorization': \`Bearer \${token}\` } });
      const payload = await res.json();
      const data = payload.data || [];
      const tbody = document.getElementById('stockBody');
      if (!tbody) return;
      if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">暂无库存数据</td></tr>';
        return;
      }
      tbody.innerHTML = data.map(row => \`<tr><td>\${row.category_name || ('货类#' + row.category_id)}</td><td>\${row.batch_no || '-'}</td><td>\${row.available_qty || 0}</td><td>\${row.available_weight || 0}</td><td>\${row.updated_at || '-'}</td></tr>\`).join('');
    }

    function mapStatusText(status) {
      const map = {
        pending_review: '待审核',
        approved: '已通过',
        rejected: '已驳回'
      };
      return map[status] || '未知状态';
    }

    function mapErrorText(errorText) {
      const text = String(errorText || '');
      if (!text) return '提交失败，请稍后重试';
      if (text.includes('Outbound exceeds available inventory')) return '出库数量超出可用库存';
      if (text.includes('inbound_id and outbound_qty are required')) return '缺少必要参数：入库ID或出库件数';
      if (text.includes('Inbound record not found')) return '未找到可用的入库记录';
      return '提交失败，请稍后重试';
    }

    async function loadPendingV2() {
      const tenantId = document.getElementById('v2TenantId')?.value || '1';
      const res = await fetch(\`\${API_BASE}/v2/inbound/pending?tenantId=\${tenantId}\`, {
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      const payload = await res.json();
      const data = payload.data || [];
      const tbody = document.getElementById('pendingBody');
      if (!tbody) return;
      tbody.innerHTML = data.map(row => \`
        <tr>
          <td>\${row.id}</td>
          <td>\${row.tenant_id}</td>
          <td>\${row.category_id}</td>
          <td>\${row.batch_no || '-'}</td>
          <td>\${row.actual_qty || 0}</td>
          <td>\${mapStatusText(row.status)}</td>
          <td>
            <button class="btn" style="padding:4px 8px;font-size:12px;" onclick="viewAttachmentsV2(\${row.id}, \${row.tenant_id})">附件</button>
            <button class="btn btn-success" style="padding:4px 8px;font-size:12px;" onclick="approveV2(\${row.id})">通过</button>
            <button class="btn btn-danger" style="padding:4px 8px;font-size:12px;" onclick="rejectV2(\${row.id})">驳回</button>
          </td>
        </tr>
      \`).join('');
    }

    async function viewAttachmentsV2(id, tenantId) {
      const res = await fetch(\`\${API_BASE}/v2/attachments?tenantId=\${tenantId}&recordType=inbound&recordId=\${id}\`, {
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      const payload = await res.json();
      const data = payload.data || [];
      if (!data.length) {
        alert('该记录暂无附件');
        return;
      }
      const urls = data.map(a => \`\${API_BASE}/v2/attachments/file/\${a.r2_key}\`);
      alert(\`附件数量: \${data.length}\\n\` + urls.join('\\n'));
    }

    async function approveV2(id) {
      await fetch(\`\${API_BASE}/v2/inbound/\${id}/approve\`, {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      await Promise.all([loadPendingV2(), reloadV2Data(), loadStats()]);
    }

    async function rejectV2(id) {
      await fetch(\`\${API_BASE}/v2/inbound/\${id}/reject\`, {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      await loadPendingV2();
    }

    async function createOutboundV2() {
      const tenant_id = Number(document.getElementById('v2TenantId')?.value || 1);
      const inbound_id = Number(document.getElementById('v2InboundSelect')?.value || 0);
      const outbound_date = document.getElementById('v2OutboundDate')?.value || null;
      const outbound_qty = Number(document.getElementById('v2OutboundQty')?.value || 0);
      const outbound_weight = Number(document.getElementById('v2OutboundWeight')?.value || 0);

      if (!inbound_id) {
        alert('请先从可出库列表选择一条入库记录');
        return;
      }

      const option = document.getElementById('v2InboundSelect')?.selectedOptions?.[0];
      const maxQty = Number(option?.dataset?.qty || 0);
      const maxWeight = Number(option?.dataset?.weight || 0);
      if (outbound_qty <= 0) {
        alert('出库数量必须大于 0');
        return;
      }
      if (outbound_qty > maxQty) {
        alert(\`出库数量超出上限：最多可出 \${maxQty} 件，当前输入 \${outbound_qty} 件\`);
        return;
      }
      if (outbound_weight > maxWeight) {
        alert(\`出库吨数超出上限：最多可出 \${maxWeight} 吨，当前输入 \${outbound_weight} 吨\`);
        return;
      }

      const res = await fetch(\`\${API_BASE}/v2/outbound\`, {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${token}\`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tenant_id, inbound_id, outbound_qty, outbound_weight, outbound_date })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(mapErrorText(data.error));
        return;
      }
      alert(\`出库登记成功（出库ID: \${data.id}），剩余 \${data.remaining_qty} 件 / \${data.remaining_weight} 吨\`);
      document.getElementById('v2OutboundQty').value = '';
      document.getElementById('v2OutboundWeight').value = '';
      lastUpdatedInboundId = inbound_id;
      await Promise.all([reloadV2Data(), loadStats()]);
      updateLimitHint();
    }

    function logout() {
      localStorage.removeItem('admin_token');
      location.reload();
    }
  </script>
</body>
</html>`);
});

// app.get('/')
export default app;
