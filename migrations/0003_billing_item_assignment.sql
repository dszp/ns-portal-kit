-- Manual item→account assignment (spec 2026-09-05). Keyed by DOMAIN and ITEM, not by account: the
-- assignment is a fact about the item. Acceptances stay keyed by account; a reassignment clears the
-- acceptance on the account the item leaves (onebillAccount.applyAssignment), in the same batch.
CREATE TABLE billing_item_assignment (
  domain         TEXT NOT NULL,
  item_key       TEXT NOT NULL,      -- the BARE key (ext:100), never domain-qualified: domain is beside it
  account_number TEXT NOT NULL,
  label          TEXT NOT NULL,
  note           TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL,
  PRIMARY KEY (domain, item_key)
);
CREATE TABLE billing_item_assignment_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  domain         TEXT NOT NULL,
  item_key       TEXT NOT NULL,
  account_number TEXT,               -- NULL on a clear
  label          TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('assign', 'clear')),
  note           TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL
);
CREATE INDEX billing_item_assignment_history_domain ON billing_item_assignment_history (domain, item_key, decided_at);
-- Item keys inside an account comparison become domain-qualified with this slice (acme.example/ext:100),
-- so every acceptance recorded under a bare key would read as stale. Dev-only data at the time of this
-- migration; history is kept.
DELETE FROM billing_baseline_item;
DELETE FROM billing_baseline;
