-- Item-level acceptance (spec 2026-09-04). billing_baseline keeps its shape; its meaning narrows to
-- the GROUP ROW: written when a group becomes fully accepted, or to accept a shortfall / an item-less
-- dimension. Item acceptances live here.
CREATE TABLE billing_baseline_item (
  account_number TEXT NOT NULL,
  group_key      TEXT NOT NULL,
  item_key       TEXT NOT NULL,
  label          TEXT NOT NULL,
  note           TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL,
  PRIMARY KEY (account_number, group_key, item_key)
);
CREATE TABLE billing_baseline_item_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL,
  group_key      TEXT NOT NULL,
  item_key       TEXT NOT NULL,
  label          TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('accept', 'clear')),
  note           TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL
);
CREATE INDEX billing_baseline_item_history_account ON billing_baseline_item_history (account_number, group_key, decided_at);
ALTER TABLE billing_baseline_history ADD COLUMN action TEXT NOT NULL DEFAULT 'accept';
-- Count-model rows: an accepted COUNT against unknown items is not the same fact as item acceptances.
-- Dev-only data at the time of this migration.
DELETE FROM billing_baseline;
