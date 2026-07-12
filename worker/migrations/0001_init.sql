-- Kindle Todo schema + seed data.
CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO todos (text, done) VALUES
  ('Take out recycling', 0),
  ('Water the plants', 0),
  ('Reply to landlord', 0);
