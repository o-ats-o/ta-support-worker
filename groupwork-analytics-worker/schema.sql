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