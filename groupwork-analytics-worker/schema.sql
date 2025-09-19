-- D1 (SQLite) schema for transcription-worker

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  utterance_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_utterances_session_group_created
  ON utterances(session_id, group_id, created_at);

CREATE INDEX IF NOT EXISTS idx_utterances_created
  ON utterances(created_at);

CREATE TABLE IF NOT EXISTS session_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  utterance_count INTEGER NOT NULL DEFAULT 0,
  sentiment_score REAL NOT NULL DEFAULT 0,
  last_updated_at TEXT NOT NULL,
  UNIQUE(session_id, group_id)
);

-- schema.sql
DROP TABLE IF EXISTS utterances;
DROP TABLE IF EXISTS session_summary;

-- 個々の発話データを格納するテーブル
CREATE TABLE utterances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  utterance_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  speaker INTEGER
);

-- セッションごとの集計データを格納するサマリーテーブル
CREATE TABLE session_summary (
  session_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  utterance_count INTEGER NOT NULL DEFAULT 0,
  sentiment_score REAL NOT NULL DEFAULT 0.0,
  last_updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, group_id)
);

-- 検索を高速化するためのインデックス
CREATE INDEX idx_utterances_session_group_id ON utterances (session_id, group_id);

-- Miro グループとボードの対応表
CREATE TABLE IF NOT EXISTS miro_board_map (
  group_id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_miro_board_map_board ON miro_board_map (board_id);

-- Miro 連携: ボード上のアイテム最新状態を保持
CREATE TABLE IF NOT EXISTS miro_items (
  board_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  hash TEXT NOT NULL,
  data TEXT NOT NULL, -- JSON文字列
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (board_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_miro_items_board ON miro_items (board_id);
CREATE INDEX IF NOT EXISTS idx_miro_items_deleted ON miro_items (board_id, deleted_at);

-- Miro 連携: 取得ごとの差分履歴
CREATE TABLE IF NOT EXISTS miro_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  diff_at TEXT NOT NULL,
  added TEXT NOT NULL,   -- JSON配列文字列
  updated TEXT NOT NULL, -- JSON配列文字列
  deleted TEXT NOT NULL, -- JSON配列文字列
  UNIQUE (board_id, diff_at)
);

CREATE INDEX IF NOT EXISTS idx_miro_diffs_board_time ON miro_diffs (board_id, diff_at);