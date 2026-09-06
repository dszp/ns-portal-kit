-- An E911 address is a fact about a PLACE, and a place can be billed by more than one account: users
-- on four sites of a split domain can reference one address, and two of those accounts each buy an
-- E911 bundle for it. Manual assignment on an address is therefore ADDITIVE, with a per-account
-- remove — so the current-state row is keyed by the ACCOUNT as well as by the item.
--
-- SQLite cannot alter a primary key, so the table is rebuilt: same columns, wider key, rows copied
-- across, old table dropped, new one renamed into its place. The history table is untouched — it was
-- already one row per action, which is the right grain either way.
--
-- ALSO CHANGED, WITHOUT A SCHEMA CHANGE: `billing_item_assignment_history.account_number` on a `clear`
-- row now names the account the item LEFT, where it used to be NULL. 0003's inline comment on that
-- column ("NULL on a clear") predates this and is true only of rows written before this migration. With
-- a set of placements a clear that names nobody cannot say which of three was undone, which is the one
-- question that table exists to answer.
--
-- Every other kind still holds at most one row per (domain, item_key). That is the ROUTE's rule now
-- rather than the schema's: an assign on a non-address key clears the existing row in the same batch,
-- exactly as the old upsert did. A wider key cannot express "one of these, but several of those".
CREATE TABLE billing_item_assignment_v2 (
  domain         TEXT NOT NULL,
  item_key       TEXT NOT NULL,      -- the BARE key (ext:100), never domain-qualified: domain is beside it
  account_number TEXT NOT NULL,
  label          TEXT NOT NULL,
  note           TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL,
  PRIMARY KEY (domain, item_key, account_number)
);
INSERT INTO billing_item_assignment_v2 SELECT domain, item_key, account_number, label, note, decided_by, decided_at FROM billing_item_assignment;
DROP TABLE billing_item_assignment;
ALTER TABLE billing_item_assignment_v2 RENAME TO billing_item_assignment;
