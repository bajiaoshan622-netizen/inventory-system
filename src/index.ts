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

// 获取预签名上传 URL
app.post('/api/upload/url', apiKeyAuth, async (c) => {
  const bucket = c.env.BUCKET;
  const { filename } = await c.req.json();
  
  // 生成唯一文件名
  const key = `images/${Date.now()}_${filename}`;
  
  // 创建 R2 对象（这里简化为直接返回公开访问 URL）
  // 实际生产环境应该实现真正的预签名 URL
  await bucket.put(key, new Uint8Array(0), {
    httpMetadata: { contentType: 'image/jpeg' }
  });
  
  const url = `https://${c.env.BUCKET.name}.r2.cloudflarestorage.com/${key}`;
  
  return c.json({ 
    uploadUrl: url,
    publicUrl: url,
    key 
  });
});

// 健康检查
app.get('/api/health', (c) => c.json({ status: 'ok' }));

export default app;
