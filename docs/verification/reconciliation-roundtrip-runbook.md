# Reconciliation round-trip runbook (Part F of the 2026-08-14 follow-up plan)

**STATUS: NOT EXECUTED.** This is the operator runbook for the live exercise, not its
record. The exercise requires a running VS Code extension host and a real provider
round; no headless implementation round can perform it. When executed, fill in every
`_observed:_` slot below in place — this file then becomes the verification record the
plan's Part F requires. Until every slot is filled, Part F remains open and its seven
checklist items, plus the related Verification item, in
`.ensemble/2026-08-11_task_1/plan-final.md` stay unticked.

Why this exists: the latch half of `checklistProgressUnreliable` is field-proven
(`.ensemble/2026-08-12_task_1` carried it across multiple rounds). The **clearing**
half — **Ensemble: Mark Plan Checklist Reconciled** restoring the completeness gate —
has only unit coverage (`reconcilePlanChecklistCommand.test.ts`). This exercise is what
distinguishes the round trip from that unit coverage, so record observations, not
expectations.

## Preconditions

- Extension built from a commit containing the Part A menu gating
  (`package.json` reconcile entry `when` requires `/-checklistUnreliable/`).
- A real provider CLI signed in and working (record which one below).
- A scratch workspace — do not run this on a task carrying real work.

## Steps and record slots

1. **Create a scratch task** with a plan whose `plan-final.md` has a checklist.
   - _provider used:_
   - _scratch task folder:_
2. **Land a round whose checklist state goes unrecorded** (either a runner-authored
   summary or one rejected by the shape gate), so the latch sets.
   - _exact scenario that left the round unrecorded:_
   - _observed: `checklistProgressUnreliable` latched (check `progress` record):_
3. **Confirm the surfaced state on the latched task, in order:**
   - _observed: task tree tooltip warns:_
   - _observed: completeness gate stands down (`effectiveReviewProgress`):_
   - _observed: reconcile entry present in the task context menu:_
   - _observed: reconcile entry absent on a healthy task's context menu:_
4. **Tick the missed items** in the scratch task's `plan-final.md` by hand.
   - _observed: ticks applied:_
5. **Run "Ensemble: Mark Plan Checklist Reconciled"** from the task context menu
   (not the palette — the menu path is the one Part A gated).
   - _observed: command outcome message:_
6. **Confirm the clear, in order:**
   - _observed: latch cleared:_
   - _observed: menu entry gone:_
   - _observed: completeness gate governs advancement again:_

## On completion

Replace the STATUS line above with `**STATUS: EXECUTED <date> by <operator>.**`,
tick the seven Part F items and the related Verification item in
`.ensemble/2026-08-11_task_1/plan-final.md` (they are the only remaining unticked
items), and leave this file in place as the durable record.
