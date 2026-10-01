'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../logic.js');

const D = (y, m, d, h = 12) => new Date(y, m - 1, d, h);

test('month helpers wrap across years', () => {
  assert.equal(L.prevMonth('2026-01'), '2025-12');
  assert.equal(L.nextMonth('2026-12'), '2027-01');
  assert.equal(L.dim(2028, 2), 29);
  assert.equal(L.iso(L.parseISO('2026-03-09')), '2026-03-09');
});

test('daysElapsed: full past months, today for the current one', () => {
  const now = D(2026, 10, 7);
  assert.equal(L.daysElapsed('2026-10', now), 7);
  assert.equal(L.daysElapsed('2026-09', now), 30);
  assert.equal(L.daysElapsed('2026-02', now), 28);
  assert.equal(L.daysElapsed('2026-11', now), 0);
});

test('txDelta for every kind', () => {
  const a = 'A', b = 'B';
  assert.equal(L.txDelta({ kind: 'exp', amount: 50, acct: a }, a), -50);
  assert.equal(L.txDelta({ kind: 'inc', amount: 50, acct: a }, a), 50);
  assert.equal(L.txDelta({ kind: 'ref', amount: 50, acct: a }, a), 50);
  assert.equal(L.txDelta({ kind: 'exp', amount: 50, acct: b }, a), 0);
  const trf = { kind: 'trf', amount: 30, acct: a, toAcct: b };
  assert.equal(L.txDelta(trf, a), -30);
  assert.equal(L.txDelta(trf, b), 30);
  assert.equal(L.txDelta(trf, 'C'), 0);
});

test('afterRecon: same-day tx count only if logged after the recon', () => {
  const R = { date: '2026-10-05', at: 1000 };
  assert.equal(L.afterRecon({ date: '2026-10-06', at: 1 }, R), true);
  assert.equal(L.afterRecon({ date: '2026-10-04', at: 9999 }, R), false);
  assert.equal(L.afterRecon({ date: '2026-10-05', at: 999 }, R), false);
  assert.equal(L.afterRecon({ date: '2026-10-05', at: 1001 }, R), true);
  // older recons without `at`: same-day tx belong to the counted period
  assert.equal(L.afterRecon({ date: '2026-10-05', at: 1001 }, { date: '2026-10-05' }), false);
});

test('recurringDue: nothing before the day, then this month', () => {
  const r = { day: 10, lastMonth: '2026-09' };
  assert.deepEqual(L.recurringDue(r, D(2026, 10, 9)), []);
  assert.deepEqual(L.recurringDue(r, D(2026, 10, 10)), [{ month: '2026-10', date: '2026-10-10' }]);
  assert.deepEqual(L.recurringDue({ day: 10, lastMonth: '2026-10' }, D(2026, 10, 20)), []);
});

test('recurringDue: catches up missed months', () => {
  const due = L.recurringDue({ day: 1, lastMonth: '2026-07' }, D(2026, 10, 2));
  assert.deepEqual(due.map(d => d.month), ['2026-08', '2026-09', '2026-10']);
});

test('recurringDue: caps catch-up at 12 months', () => {
  const due = L.recurringDue({ day: 1, lastMonth: '2023-01' }, D(2026, 10, 2));
  assert.equal(due.length, 12);
  assert.equal(due[0].month, '2025-11');
  assert.equal(due[11].month, '2026-10');
});

test('recurringDue: day 31 clamps to short months', () => {
  const due = L.recurringDue({ day: 31, lastMonth: '2026-01' }, D(2026, 3, 31));
  assert.deepEqual(due.map(d => d.date), ['2026-02-28', '2026-03-31']);
});

test('recurringDue: new item starts this month', () => {
  assert.deepEqual(L.recurringDue({ day: 5, lastMonth: '' }, D(2026, 10, 6)).map(d => d.month), ['2026-10']);
});

test('rentOverdue: this month only after its due day', () => {
  const now = D(2026, 10, 5);
  assert.equal(L.rentOverdue('2026-09', 25, now), true);
  assert.equal(L.rentOverdue('2026-10', 5, now), false);
  assert.equal(L.rentOverdue('2026-10', 4, now), true);
  assert.equal(L.rentOverdue('2026-11', 1, now), false);
  // due day 31 in a 28-day February
  assert.equal(L.rentOverdue('2026-02', 31, D(2026, 2, 28)), false);
});

test('months12 respects the lease start', () => {
  const now = D(2026, 10, 1);
  const all = L.months12(null, now);
  assert.equal(all.length, 12);
  assert.equal(all[0], '2025-11');
  assert.equal(all[11], '2026-10');
  assert.deepEqual(L.months12('2026-08-15', now), ['2026-08', '2026-09', '2026-10']);
});

test('parseSentence', async t => {
  const ctx = {
    accts: [{ id: 'cash', name: 'كاش' }, { id: 'visa', name: 'فيزا' }],
    expCats: [{ id: 'food', name: 'أكل وشرب' }, { id: 'trans', name: 'مواصلات' }],
    incCats: [{ id: 'sal', name: 'المرتب' }, { id: 'oth', name: 'دخل آخر' }],
    pro: true, lastCat: { exp: 'food', inc: 'sal', ref: 'food' }, acct: 'cash'
  };
  await t.test('expense with account', () => {
    const p = L.parseSentence('50 أكل كاش', ctx);
    assert.equal(p.amount, 50); assert.equal(p.kind, 'exp');
    assert.equal(p.cat, 'food'); assert.equal(p.acct, 'cash'); assert.equal(p.note, '');
  });
  await t.test('Arabic digits and income', () => {
    const p = L.parseSentence('٢٠٠٠٠ مرتب فيزا', ctx);
    assert.equal(p.amount, 20000); assert.equal(p.kind, 'inc');
    assert.equal(p.cat, 'sal'); assert.equal(p.acct, 'visa');
  });
  await t.test('refund only in pro mode', () => {
    assert.equal(L.parseSentence('30 مرتجع أكل', ctx).kind, 'ref');
    assert.equal(L.parseSentence('30 مرتجع أكل', { ...ctx, pro: false }).kind, 'exp');
  });
  await t.test('leftover words become the note', () => {
    const p = L.parseSentence('15.5 مواصلات اوبر', ctx);
    assert.equal(p.amount, 15.5); assert.equal(p.cat, 'trans'); assert.equal(p.note, 'اوبر');
  });
  await t.test('falls back to defaults', () => {
    const p = L.parseSentence('100 حاجة', ctx);
    assert.equal(p.cat, 'food'); assert.equal(p.acct, 'cash'); assert.equal(p.note, 'حاجة');
  });
  await t.test('no amount', () => {
    assert.equal(L.parseSentence('أكل', ctx), null);
    assert.equal(L.parseSentence('0 أكل', ctx), null);
  });
});

test('checkBackup', () => {
  const ok = { tx: [{ id: 'a', amount: 5, date: '2026-10-01' }], cats: [{ id: 'c' }] };
  assert.equal(L.checkBackup(ok), '');
  assert.equal(L.checkBackup({ ...ok, acct: [], recon: [{ id: 'r', date: '2026-10-01' }] }), '');
  assert.ok(L.checkBackup(null));
  assert.ok(L.checkBackup({ cats: [] }));
  assert.ok(L.checkBackup({ ...ok, rent: {} }));
  assert.ok(L.checkBackup({ ...ok, tx: [{ amount: 5, date: '2026-10-01' }] }));
  assert.ok(L.checkBackup({ ...ok, tx: [{ id: 'a', amount: '5', date: '2026-10-01' }] }));
  assert.ok(L.checkBackup({ ...ok, tx: [{ id: 'a', amount: 5, date: '1/10/2026' }] }));
});
