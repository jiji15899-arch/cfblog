-- =============================================
-- CF Blog CMS - D1 Database Schema
-- =============================================

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  slug TEXT UNIQUE NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  excerpt TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('publish','draft','trash','scheduled')),
  category_id INTEGER DEFAULT 0,
  thumbnail_url TEXT DEFAULT '',
  seo_title TEXT DEFAULT '',
  meta_desc TEXT DEFAULT '',
  focus_keyword TEXT DEFAULT '',
  custom_slug TEXT DEFAULT '',
  schemas TEXT DEFAULT '[]',
  header_code TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER,
  scheduled_at INTEGER
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  slug TEXT UNIQUE NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  post_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL DEFAULT '',
  page TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS adsense_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL DEFAULT '',
  click_count INTEGER DEFAULT 0,
  first_click INTEGER DEFAULT (unixepoch()),
  last_click INTEGER DEFAULT (unixepoch()),
  blocked INTEGER DEFAULT 0,
  blocked_at INTEGER,
  unblock_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at);
CREATE INDEX IF NOT EXISTS idx_stats_date ON stats(date);
CREATE INDEX IF NOT EXISTS idx_stats_ip ON stats(ip);
CREATE INDEX IF NOT EXISTS idx_adsense_ip ON adsense_clicks(ip);

-- Default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_title', 'My Blog'),
  ('site_description', 'A blog powered by Cloudflare'),
  ('adsense_client', ''),
  ('adsense_slot', ''),
  ('adsense_max_clicks', '5'),
  ('adsense_time_window', '60'),
  ('header_code', ''),
  ('toc_enabled', '1'),
  ('gemini_api_key', ''),
  ('ai_horde_api_key', ''),
  ('naver_verification', ''),
  ('google_verification', ''),
  ('analytics_id', '');
