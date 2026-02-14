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
