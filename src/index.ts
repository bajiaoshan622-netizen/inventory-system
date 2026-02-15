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

// Outbound create (admin only, direct effective)
app.post('/api/v2/outbound', async (c) => {
  const actor = await requireActor(c, ['admin']);
  if (actor instanceof Response) return actor;
  const db = c.env.DB;
  const body = await c.req.json();

  const tenantId = Number(body.tenant_id || 1);
  const categoryId = Number(body.category_id);
  const batchNo = String(body.batch_no || '').trim();
  const outboundQty = Number(body.outbound_qty || 0);
  const outboundWeight = Number(body.outbound_weight || 0);

  if (!categoryId || !batchNo || outboundQty <= 0) {
    return c.json({ error: 'category_id, batch_no, outbound_qty are required' }, 400);
  }

  const bal = await db.prepare(
    'SELECT available_qty, available_weight FROM inventory_balance WHERE tenant_id = ? AND category_id = ? AND batch_no = ?'
  ).bind(tenantId, categoryId, batchNo).first<any>();

  const availableQty = Number(bal?.available_qty || 0);
  const availableWeight = Number(bal?.available_weight || 0);
  if (outboundQty > availableQty || outboundWeight > availableWeight) {
    return c.json({ error: 'Outbound exceeds available inventory' }, 409);
  }

  const r = await db.prepare(`
    INSERT INTO inventory_outbound (
      tenant_id, category_id, batch_no, outbound_date, outbound_qty, outbound_weight,
      remarks, status, source, created_by, approved_by, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 'admin', ?, ?, ?)
  `).bind(
    tenantId,
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
  await addHistory(db, tenantId, 'outbound', id, 'create', null, body, actor.id);

  return c.json({ id, status: 'approved' }, 201);
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

          <div class="toolbar">
            <strong>v2 出库登记</strong>
            <input type="number" id="v2TenantId" placeholder="tenant" value="1" style="width:90px;">
            <input type="number" id="v2CategoryId" placeholder="category" style="width:100px;">
            <input type="text" id="v2BatchNo" placeholder="batch_no">
            <input type="number" id="v2OutboundQty" placeholder="出库件数" style="width:110px;">
            <input type="number" id="v2OutboundWeight" placeholder="出库吨数" style="width:110px;">
            <button class="btn" onclick="createOutboundV2()">提交出库</button>
            <button class="btn" onclick="loadPendingV2()">刷新待审批</button>
          </div>

          <div class="table-container" style="margin-bottom:16px;">
            <table>
              <thead><tr><th colspan="7">v2 待审批入库（Agent）</th></tr></thead>
              <thead>
                <tr><th>ID</th><th>tenant</th><th>category</th><th>batch</th><th>件数</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody id="pendingBody"></tbody>
            </table>
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
      loadPendingV2();
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
          <td>\${row.status}</td>
          <td>
            <button class="btn btn-success" style="padding:4px 8px;font-size:12px;" onclick="approveV2(\${row.id})">通过</button>
            <button class="btn btn-danger" style="padding:4px 8px;font-size:12px;" onclick="rejectV2(\${row.id})">驳回</button>
          </td>
        </tr>
      \`).join('');
    }

    async function approveV2(id) {
      await fetch(\`\${API_BASE}/v2/inbound/\${id}/approve\`, {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      loadPendingV2();
    }

    async function rejectV2(id) {
      await fetch(\`\${API_BASE}/v2/inbound/\${id}/reject\`, {
        method: 'POST',
        headers: { 'Authorization': \`Bearer \${token}\` }
      });
      loadPendingV2();
    }

    async function createOutboundV2() {
      const tenant_id = Number(document.getElementById('v2TenantId')?.value || 1);
      const category_id = Number(document.getElementById('v2CategoryId')?.value || 0);
      const batch_no = document.getElementById('v2BatchNo')?.value || '';
      const outbound_qty = Number(document.getElementById('v2OutboundQty')?.value || 0);
      const outbound_weight = Number(document.getElementById('v2OutboundWeight')?.value || 0);

      const res = await fetch(\`\${API_BASE}/v2/outbound\`, {
        method: 'POST',
        headers: {
          'Authorization': \`Bearer \${token}\`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tenant_id, category_id, batch_no, outbound_qty, outbound_weight })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '提交失败');
        return;
      }
      alert(\`出库成功，ID: \${data.id}\`);
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
