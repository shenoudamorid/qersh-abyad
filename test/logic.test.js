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
  await t.test('a category keyword picks it and stays in the note', () => {
    const c = { ...ctx, expCats: [ctx.expCats[0], { id: 'trans', name: 'مواصلات', words: ['اوبر', 'بنزين'] },
      { id: 'bills', name: 'فواتير', words: ['كهربا', 'كارت شحن'] }, { id: 'home', name: 'بيت', words: ['كهربائي'] }] };
    let p = L.parseSentence('٣٠ اوبر فيزا', c);
    assert.equal(p.cat, 'trans'); assert.equal(p.acct, 'visa'); assert.equal(p.note, 'اوبر');
    assert.equal(L.parseSentence('120 كهربا', c).cat, 'bills');
    assert.equal(L.parseSentence('50 كارت شحن', c).cat, 'bills');
    assert.equal(L.parseSentence('50 شحن', c).cat, 'food'); // a phrase needs all its words
  });
  await t.test('guessCat reads a note', () => {
    const cats = [{ id: 'food', name: 'أكل وشرب', words: ['شاورما'] }, { id: 'trans', name: 'مواصلات', words: ['بنزين'] }];
    assert.equal(L.guessCat('بنزين العربية', cats).id, 'trans');
    assert.equal(L.guessCat('الأكل', cats).id, 'food');
    assert.equal(L.guessCat('حاجة', cats), null);
  });
  await t.test('default keywords cover the default categories', () => {
    for (const n of ['أكل وشرب', 'مواصلات', 'فواتير', 'صحة', 'تسوق', 'المرتب']) assert.ok(L.CAT_WORDS[n].length);
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

test('budgetCross', () => {
  assert.equal(L.budgetCross(700, 900, 1000), 'near');
  assert.equal(L.budgetCross(900, 1100, 1000), 'over');
  assert.equal(L.budgetCross(500, 1100, 1000), 'over');
  assert.equal(L.budgetCross(1100, 1200, 1000), '');   // already over: no repeat nag
  assert.equal(L.budgetCross(850, 900, 1000), '');     // already past 80%
  assert.equal(L.budgetCross(100, 200, 0), '');        // no budget
  assert.equal(L.budgetCross(900, 800, 1000), '');     // went down (refund)
});

test('recurringDue weekly', () => {
  // 2026-10-01 is a Thursday (dow 4)
  const now = D(2026, 10, 15);
  const fresh = L.recurringDue({ freq: 'week', dow: 4, since: '2026-10-01' }, now);
  assert.deepEqual(fresh.map(d => d.date), ['2026-10-01', '2026-10-08', '2026-10-15']);
  const later = L.recurringDue({ freq: 'week', dow: 4, since: '2026-10-01', lastDate: '2026-10-08' }, now);
  assert.deepEqual(later.map(d => d.date), ['2026-10-15']);
  assert.deepEqual(L.recurringDue({ freq: 'week', dow: 4, lastDate: '2026-10-15' }, now), []);
  // capped at 12 months back
  const old = L.recurringDue({ freq: 'week', dow: 4, lastDate: '2020-01-02' }, now);
  assert.equal(old[0].date >= '2025-11-01', true);
  assert.ok(old.length <= 53);
});

test('recurringDue yearly', () => {
  const now = D(2026, 10, 1);
  // new item created today for a date already passed this year: waits for next year
  assert.deepEqual(L.recurringDue({ freq: 'year', mon: 3, day: 15, since: '2026-10-01' }, now), []);
  // created earlier in the year, date has now arrived
  assert.deepEqual(L.recurringDue({ freq: 'year', mon: 9, day: 20, since: '2026-01-01' }, now).map(d => d.date), ['2026-09-20']);
  // last posted 2025, this year's date arrived
  assert.deepEqual(L.recurringDue({ freq: 'year', mon: 3, day: 15, lastDate: '2025-03-15' }, now).map(d => d.date), ['2026-03-15']);
  // day 29 in February clamps to the 28th in non-leap years
  assert.deepEqual(L.recurringDue({ freq: 'year', mon: 2, day: 29, lastDate: '2026-02-28' }, D(2027, 3, 1)).map(d => d.date), ['2027-02-28']);
  assert.deepEqual(L.recurringDue({ freq: 'year', mon: 2, day: 29, lastDate: '2027-02-28' }, D(2028, 3, 1)).map(d => d.date), ['2028-02-29']);
});

test('rent partial payments', () => {
  const r = { amount: 1000, dueDay: 5, paid: ['2026-08'], part: { '2026-09': 400 } };
  assert.equal(L.rentPaid(r, '2026-08'), 1000);
  assert.equal(L.rentLeft(r, '2026-08'), 0);
  assert.equal(L.rentPaid(r, '2026-09'), 400);
  assert.equal(L.rentLeft(r, '2026-09'), 600);
  assert.equal(L.rentLeft(r, '2026-10'), 1000);
  assert.equal(L.rentDueDate({ dueDay: 31 }, '2026-02'), '2026-02-28');
});

test('debt partial payments', () => {
  const d = { amount: 500, pays: [{ date: '2026-09-01', amount: 200 }, { date: '2026-09-10', amount: 50 }] };
  assert.equal(L.debtPaid(d), 250);
  assert.equal(L.debtLeft(d), 250);
  assert.equal(L.debtLeft({ ...d, settledAt: '2026-09-11' }), 0);
  assert.equal(L.debtLeft({ amount: 100 }), 100);
});

test('dueItems', () => {
  const now = D(2026, 10, 10);
  const items = L.dueItems({
    debts: [
      { id: 'd1', person: 'A', dir: 'out', amount: 300, due: '2026-10-05', pays: [{ amount: 100 }] },
      { id: 'd2', person: 'B', dir: 'in', amount: 50, due: '2026-10-15' },
      { id: 'd3', person: 'C', dir: 'in', amount: 50, due: '2026-11-15' },
      { id: 'd4', person: 'D', dir: 'in', amount: 50, due: '2026-10-01', settledAt: '2026-10-02' },
      { id: 'd5', person: 'E', dir: 'in', amount: 50 }
    ],
    plans: [{ id: 'p1', name: 'school', amount: 900, date: '2026-10-12' }, { id: 'p2', name: 'x', amount: 1, date: '2026-10-12', done: true }],
    rents: [{ id: 'r1', tenant: 'T', amount: 1000, dueDay: 5, start: '2026-09-01', paid: [], part: { '2026-09': 400 } }]
  }, now);
  // sorted by date: rent's oldest unpaid month (Sep 5) comes first
  assert.deepEqual(items.map(i => i.id), ['r1', 'd1', 'p1', 'd2']);
  assert.equal(items[1].amount, 200);
  assert.equal(items[1].late, true);
  const rent = items[0];
  assert.equal(rent.months, 2);
  assert.equal(rent.amount, 1600);
  assert.equal(rent.late, true);
  assert.equal(items[3].late, false);
});

test('debtFlows moves money through the chosen accounts', () => {
  const sumFor = (d, id) => L.debtFlows(d).filter(f => f.acct === id).reduce((s, f) => s + f.amount, 0);
  // lent 500 cash, got 200 back by bank and 300 back in cash
  const lent = { dir: 'out', amount: 500, date: '2026-09-01', acct: 'cash',
    pays: [{ date: '2026-09-05', amount: 200, acct: 'bank' }, { date: '2026-09-09', amount: 300, acct: 'cash' }] };
  assert.equal(sumFor(lent, 'cash'), -200);
  assert.equal(sumFor(lent, 'bank'), 200);
  // borrowed 1000 into the bank, repaid 400 from cash
  const owed = { dir: 'in', amount: 1000, date: '2026-09-01', acct: 'bank', pays: [{ date: '2026-09-02', amount: 400, acct: 'cash' }] };
  assert.equal(sumFor(owed, 'bank'), 1000);
  assert.equal(sumFor(owed, 'cash'), -400);
  // no account (older debts) leaves balances alone
  assert.deepEqual(L.debtFlows({ dir: 'out', amount: 50, date: '2026-09-01', pays: [{ amount: 50, date: '2026-09-02' }] }), []);
});

test('nightly stays', async t => {
  const st = { from: '2026-09-29', nights: 3, total: 3000, fee: 450, channel: 'booking', paidOn: '2026-10-02' };
  await t.test('checkout and net', () => {
    assert.equal(L.stayOut(st), '2026-10-02');
    assert.equal(L.stayNet(st), 2550);
    assert.equal(L.stayNet({ total: 500 }), 500);
  });
  await t.test('nights split across months', () => {
    assert.equal(L.stayNightsIn(st, '2026-09'), 2);
    assert.equal(L.stayNightsIn(st, '2026-10'), 1);
    assert.equal(L.stayNightsIn(st, '2026-11'), 0);
  });
  await t.test('month summary by channel, pending payouts', () => {
    const direct = { from: '2026-10-10', nights: 2, total: 1600, fee: 0, channel: 'direct', paidOn: '2026-10-10' };
    const airbnb = { from: '2026-10-20', nights: 4, total: 4000, fee: 600, channel: 'airbnb' };
    const s = L.staySummary([st, direct, airbnb], '2026-10');
    assert.equal(s.nights, 7); assert.equal(s.count, 3);
    assert.equal(s.by.booking.nights, 1); assert.equal(s.by.booking.net, 850);
    assert.equal(s.by.direct.net, 1600); assert.equal(s.by.airbnb.net, 3400);
    assert.equal(s.net, 850 + 1600 + 3400); assert.equal(s.fees, 150 + 600);
    assert.equal(s.pending, 3400); assert.equal(s.pendingN, 1);
  });
  await t.test('deposits: paid and left', () => {
    const dep = { from: '2026-10-03', nights: 3, total: 1500, fee: 0, channel: 'direct',
      pays: [{ amount: 500, date: '2026-09-29', acct: 'bank', pre: true }] };
    assert.equal(L.stayPaid(dep), 500); assert.equal(L.stayLeft(dep), 1000);
    const s = L.staySummary([dep], '2026-10');
    assert.equal(s.pending, 1000); assert.equal(s.pendingN, 1); assert.equal(s.net, 1500);
    dep.pays.push({ amount: 1000, date: '2026-10-03', acct: 'cash' });
    assert.equal(L.stayLeft(dep), 0); assert.equal(L.staySummary([dep], '2026-10').pending, 0);
    assert.equal(L.stayPaid({ total: 800, paidOn: '2026-10-01' }), 800);  // older single-payment bookings
    assert.equal(L.stayPaid({ total: 800 }), 0);
  });
  await t.test('backups with stays', () => {
    const base = { tx: [], cats: [] };
    assert.equal(L.checkBackup({ ...base, stay: [{ id: 'a', ...st }] }), '');
    assert.notEqual(L.checkBackup({ ...base, stay: [{ id: 'a', from: 'x', total: 1 }] }), '');
    assert.notEqual(L.checkBackup({ ...base, stay: {} }), '');
  });
});
