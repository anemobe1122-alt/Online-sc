CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  username TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_registrations (
  id_hash TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  telegram_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS telegram_registrations_expiry_idx
  ON telegram_registrations(status, expires_at);

