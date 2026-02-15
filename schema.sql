CREATE TABLE IF NOT EXISTS inventory_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_no INTEGER,
  dispatch_date TEXT,
  inbound_date TEXT,
  vehicle_id TEXT,
  package_batch TEXT,
  content_percent REAL,
  dispatch_quantity INTEGER,
  dispatch_weight REAL,
  actual_quantity INTEGER,
  actual_weight REAL,
  broken_bags INTEGER DEFAULT 0,
  dirty_bags INTEGER DEFAULT 0,
  wet_bags INTEGER DEFAULT 0,
  shortage INTEGER DEFAULT 0,
  bill_of_lading TEXT,
  contract_no TEXT,
  loading_method TEXT,
  loaded_quantity INTEGER,
  loaded_weight REAL,
  outbound_date TEXT,
  stock_quantity INTEGER,
  stock_weight REAL,
  remarks TEXT,
  -- 审计字段
  status TEXT DEFAULT 'pending_review',
  created_by TEXT,
  reviewed_by TEXT,
  reviewed_at DATETIME,
  review_note TEXT,
  -- 图片
  image_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_status ON inventory_records(status);
CREATE INDEX IF NOT EXISTS idx_inbound_date ON inventory_records(inbound_date);
CREATE INDEX IF NOT EXISTS idx_vehicle ON inventory_records(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_created_by ON inventory_records(created_by);

-- =========================
-- v2 multi-tenant inventory
-- =========================

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  field_schema_json TEXT,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, code)
);

CREATE TABLE IF NOT EXISTS inventory_inbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  batch_no TEXT,
  vehicle_id TEXT,
  inbound_date TEXT,
  actual_qty INTEGER DEFAULT 0,
  actual_weight REAL DEFAULT 0,
  damage_broken INTEGER DEFAULT 0,
  damage_dirty INTEGER DEFAULT 0,
  damage_wet INTEGER DEFAULT 0,
  shortage_qty INTEGER DEFAULT 0,
  extra_qty INTEGER DEFAULT 0,
  rotten_qty INTEGER DEFAULT 0,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  source TEXT NOT NULL DEFAULT 'agent',
  created_by TEXT,
  approved_by TEXT,
  approved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_outbound (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  inbound_id INTEGER,
  category_id INTEGER NOT NULL,
  batch_no TEXT,
  outbound_date TEXT,
  outbound_qty INTEGER DEFAULT 0,
  outbound_weight REAL DEFAULT 0,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'approved',
  source TEXT NOT NULL DEFAULT 'admin',
  created_by TEXT,
  approved_by TEXT,
  approved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_balance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  batch_no TEXT NOT NULL,
  available_qty INTEGER DEFAULT 0,
  available_weight REAL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, category_id, batch_no)
);

CREATE TABLE IF NOT EXISTS record_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  record_type TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  operator TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  record_type TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  uploader TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_categories_tenant ON categories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inbound_tenant_category ON inventory_inbound(tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_inbound_status ON inventory_inbound(status);
CREATE INDEX IF NOT EXISTS idx_outbound_tenant_category ON inventory_outbound(tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_outbound_inbound ON inventory_outbound(inbound_id);
CREATE INDEX IF NOT EXISTS idx_balance_tenant_category ON inventory_balance(tenant_id, category_id);
CREATE INDEX IF NOT EXISTS idx_history_record ON record_history(record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_attachments_record ON attachments(record_type, record_id);

INSERT INTO tenants (id, name, status)
SELECT 1, 'default', 'active'
WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = 1);
