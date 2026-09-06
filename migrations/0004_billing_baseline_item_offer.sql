-- Billed-as (spec 2026-09-05). An acceptance now records WHICH offer the operator billed the item as,
-- and a group-row decision records the entitlement it was judged against.
--
-- `offer` on an item is a note ON the decision, never an input to it: onebill-lib's verdict compares
-- counts, and an operator who tags nine seats to a tier that bills eight has recorded something for a
-- reader to act on rather than a discrepancy the engine can adjudicate. NULL is untagged, which every
-- acceptance recorded before this migration is.
--
-- `entitled` on a group row is the other half of `billed`/`observed`/`accepted`: an entitlement that
-- has since gone away invalidates the decision, and a row with no recorded entitlement keeps the
-- pre-entitlement behaviour rather than drifting every old decision at once. NULL means "not recorded".
--
-- Additive only — no data is deleted here, unlike 0002 and 0003: an untagged acceptance is still a
-- true statement about what was reviewed.
ALTER TABLE billing_baseline_item ADD COLUMN offer TEXT;
ALTER TABLE billing_baseline_item_history ADD COLUMN offer TEXT;
ALTER TABLE billing_baseline ADD COLUMN entitled INTEGER;
ALTER TABLE billing_baseline_history ADD COLUMN entitled INTEGER;
