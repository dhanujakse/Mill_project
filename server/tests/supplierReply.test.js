// Run: cd server && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAvailability, parseDeliveryDate, todayInIndia } from '../supplierReply.js';

// Thursday 22 Oct 2026, 11:30 in India.
const NOW = new Date('2026-10-22T06:00:00Z');

test('availability: yes in the ways suppliers write it', () => {
  for (const reply of ['Available', 'yes', 'Yes sir available', 'ok', 'Okk', 'haan ji', 'irukku', 'stock undu',
    'seri', 'In stock', 'ready', '👍', 'No problem', 'yes no problem', 'Available ✅']) {
    assert.equal(parseAvailability(reply), 'available', reply);
  }
});

test('availability: no in the ways suppliers write it', () => {
  for (const reply of ['Not available', 'no', 'No sir', 'illa', 'stock illa', 'nahi hai', 'out of stock',
    'unavailable', 'sorry', "can't", 'not in stock', '👎']) {
    assert.equal(parseAvailability(reply), 'unavailable', reply);
  }
});

test('availability: unclear replies are not guessed', () => {
  for (const reply of ['', 'call me', 'which item?', 'price?']) {
    assert.equal(parseAvailability(reply), null, reply);
  }
});

test('India date is used, not the UTC server date', () => {
  // 20:00 UTC on 21 Oct is already 22 Oct 01:30 in India.
  assert.equal(todayInIndia(new Date('2026-10-21T20:00:00Z')).toISOString().slice(0, 10), '2026-10-22');
});

test('dates: numeric, day first', () => {
  assert.equal(parseDeliveryDate('25/10/2026', NOW), '2026-10-25');
  assert.equal(parseDeliveryDate('25-10-26', NOW), '2026-10-25');
  assert.equal(parseDeliveryDate('Delivery on 5.11.2026', NOW), '2026-11-05');
  assert.equal(parseDeliveryDate('25/10', NOW), '2026-10-25');
  assert.equal(parseDeliveryDate('2026-11-03', NOW), '2026-11-03');
  // 10/01 is 10 Jan, already past in 2026, so it means next year.
  assert.equal(parseDeliveryDate('10/01', NOW), '2027-01-10');
});

test('dates: month names', () => {
  assert.equal(parseDeliveryDate('25th Oct', NOW), '2026-10-25');
  assert.equal(parseDeliveryDate('25 october 2026', NOW), '2026-10-25');
  assert.equal(parseDeliveryDate('Nov 3', NOW), '2026-11-03');
  assert.equal(parseDeliveryDate('can deliver by 2nd Nov', NOW), '2026-11-02');
});

test('dates: words', () => {
  assert.equal(parseDeliveryDate('today', NOW), '2026-10-22');
  assert.equal(parseDeliveryDate('Tomorrow', NOW), '2026-10-23');
  assert.equal(parseDeliveryDate('naalai', NOW), '2026-10-23');
  assert.equal(parseDeliveryDate('day after tomorrow', NOW), '2026-10-24');
  assert.equal(parseDeliveryDate('in 3 days', NOW), '2026-10-25');
  assert.equal(parseDeliveryDate('2 weeks', NOW), '2026-11-05');
  assert.equal(parseDeliveryDate('next week', NOW), '2026-10-29');
  assert.equal(parseDeliveryDate('Monday', NOW), '2026-10-26');
  assert.equal(parseDeliveryDate('next thursday', NOW), '2026-10-29');
});

test('dates: past, impossible and missing dates are rejected', () => {
  assert.equal(parseDeliveryDate('20/10/2026', NOW), null); // already past
  assert.equal(parseDeliveryDate('31/02/2027', NOW), null); // no such day
  assert.equal(parseDeliveryDate('soon', NOW), null);
  assert.equal(parseDeliveryDate('will inform', NOW), null);
  assert.equal(parseDeliveryDate('10.30 am', NOW), null); // a time, not a date
  assert.equal(parseDeliveryDate('', NOW), null);
});
