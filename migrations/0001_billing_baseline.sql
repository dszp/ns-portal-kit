-- The per-account record of which billing-vs-inventory gaps an operator has accepted.
--
-- Keyed by OneBill ACCOUNT rather than by NetSapiens domain, on purpose: a domain can be relinked to a
-- different account, or an account's domain renamed, and the decision belongs to the customer, not to
-- the string that currently identifies their PBX.
--
-- ns-portal-kit owns this schema. sv-dashboard binds the same database and READS billing_* until it has
-- a reason to write, at which point ownership moves as a deliberate step - never by both repos carrying
-- migrations for one table.
CREATE TABLE billing_baseline (
  account_number TEXT NOT NULL,
  group_key      TEXT NOT NULL,
  billed         INTEGER NOT NULL,
  observed       INTEGER NOT NULL,
  accepted       INTEGER NOT NULL,
  note           TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL,
  PRIMARY KEY (account_number, group_key)
);

-- Append-only. "What did I accept last March" is a query, not an archaeology exercise.
CREATE TABLE billing_baseline_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL,
  group_key      TEXT NOT NULL,
  billed         INTEGER NOT NULL,
  observed       INTEGER NOT NULL,
  accepted       INTEGER NOT NULL,
  note           TEXT,
  decided_by     TEXT NOT NULL,
  decided_at     TEXT NOT NULL
);

CREATE INDEX billing_baseline_history_account ON billing_baseline_history (account_number, group_key, decided_at);
