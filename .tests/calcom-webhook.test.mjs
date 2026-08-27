// Tests for functions/api/calcom-webhook.js — run with:  node --test .tests/
// Zero dependencies; Node 20+ (Web Crypto + fetch globals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  verifyCalSignature,
  resolvePackage,
  computeDueDate,
  handleEvent,
  onRequestPost,
} from '../functions/api/calcom-webhook.js';

const SECRET = 'test-webhook-secret';
const ENV = { CAL_WEBHOOK_SECRET: SECRET, STRIPE_API_KEY: 'rk_test_abc' };

const sign = (body) => createHmac('sha256', SECRET).update(body).digest('hex');

// A future event start: 2026-09-12T15:00:00Z, "now" fixed well before it.
const START = '2026-09-12T15:00:00.000Z';
const NOW_MS = Date.parse('2026-08-27T00:00:00.000Z');

function booking(overrides = {}) {
  return {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid: 'bk_uid_1',
      type: 'the-mini-package-175',
      eventTypeId: 5560604,
      title: 'The Mini Package - $175 between Paula Meyers and Jane Doe',
      startTime: START,
      endTime: '2026-09-12T16:00:00.000Z',
      attendees: [{ email: 'jane@example.com', name: 'Jane Doe', timeZone: 'America/Chicago' }],
      ...overrides,
    },
  };
}

// Scripted fetch double: routes = [[method, urlRegex, responder], ...].
// Records every call as {method, url, params, headers}.
function makeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const params = init.body ? new URLSearchParams(init.body) : new URLSearchParams();
    calls.push({ method, url, params, headers: init.headers || {} });
    for (const [m, re, responder] of routes) {
      if (m === method && re.test(url)) {
        const out = typeof responder === 'function' ? responder({ url, params }) : responder;
        return new Response(JSON.stringify(out), { status: 200 });
      }
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const emptySearch = ['GET', /\/v1\/invoices\/search/, { data: [] }];
const noCustomers = ['GET', /\/v1\/customers\?/, { data: [] }];
const createCustomer = ['POST', /\/v1\/customers$/, { id: 'cus_new' }];
const createInvoice = ['POST', /\/v1\/invoices$/, { id: 'in_new' }];
const createItem = ['POST', /\/v1\/invoiceitems$/, { id: 'ii_new' }];
const finalizeInv = ['POST', /\/v1\/invoices\/in_new\/finalize$/, { id: 'in_new', status: 'open' }];
const sendInv = ['POST', /\/v1\/invoices\/in_new\/send$/, { id: 'in_new', status: 'open' }];
const happyRoutes = [emptySearch, noCustomers, createCustomer, createInvoice, createItem, finalizeInv, sendInv];

// --- signature -------------------------------------------------------------

test('verifyCalSignature accepts a valid HMAC-SHA256 hex signature', async () => {
  const body = JSON.stringify(booking());
  assert.equal(await verifyCalSignature(SECRET, body, sign(body)), true);
});

test('verifyCalSignature rejects a signature for a different body', async () => {
  const body = JSON.stringify(booking());
  assert.equal(await verifyCalSignature(SECRET, body + 'tamper', sign(body)), false);
});

test('verifyCalSignature rejects garbage/missing signatures', async () => {
  assert.equal(await verifyCalSignature(SECRET, 'x', 'not-hex'), false);
  assert.equal(await verifyCalSignature(SECRET, 'x', ''), false);
  assert.equal(await verifyCalSignature(SECRET, 'x', null), false);
});

// --- package mapping -------------------------------------------------------

test('resolvePackage maps the three live eventTypeIds to the right amounts', () => {
  assert.deepEqual(resolvePackage({ eventTypeId: 5560604, type: 'x' }),
    { label: 'The Mini Package', amountCents: 17500 });
  assert.deepEqual(resolvePackage({ eventTypeId: 5560600, type: 'x' }),
    { label: 'The Original Package', amountCents: 25000 });
  assert.deepEqual(resolvePackage({ eventTypeId: 5560590, type: 'x' }),
    { label: 'The Deluxe Package', amountCents: 40000 });
});

test('resolvePackage falls back to the slug when the id is unknown', () => {
  assert.deepEqual(resolvePackage({ eventTypeId: 999, type: 'the-deluxe-package-400' }),
    { label: 'The Deluxe Package', amountCents: 40000 });
});

test('resolvePackage returns null for unknown packages', () => {
  assert.equal(resolvePackage({ eventTypeId: 999, type: 'mystery-event' }), null);
});

// --- due date --------------------------------------------------------------

test('computeDueDate is event start minus 24h (unix seconds)', () => {
  const due = computeDueDate(START, NOW_MS);
  assert.equal(due, Math.floor((Date.parse(START) - 24 * 3600 * 1000) / 1000));
});

test('computeDueDate clamps to now+1h when booked inside the 24h window', () => {
  const soonStart = new Date(NOW_MS + 10 * 3600 * 1000).toISOString();
  assert.equal(computeDueDate(soonStart, NOW_MS), Math.floor(NOW_MS / 1000) + 3600);
});

// --- BOOKING_CREATED orchestration ----------------------------------------

test('BOOKING_CREATED creates, finalizes and sends a correctly-shaped invoice', async () => {
  const fetchImpl = makeFetch(happyRoutes);
  const res = await handleEvent(booking() && { ...booking() }, ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.equal(res.body.invoice, 'in_new');

  const inv = fetchImpl.calls.find(c => c.method === 'POST' && /\/v1\/invoices$/.test(c.url));
  assert.ok(inv, 'invoice create call missing');
  assert.equal(inv.params.get('customer'), 'cus_new');
  assert.equal(inv.params.get('collection_method'), 'send_invoice');
  assert.equal(inv.params.get('due_date'), String(computeDueDate(START, NOW_MS)));
  assert.equal(inv.params.get('metadata[cal_booking_uid]'), 'bk_uid_1');
  assert.ok(inv.headers['Idempotency-Key'], 'invoice create should carry an idempotency key');
  assert.equal(inv.headers['Authorization'], 'Bearer rk_test_abc');

  const item = fetchImpl.calls.find(c => c.method === 'POST' && /\/v1\/invoiceitems$/.test(c.url));
  assert.equal(item.params.get('amount'), '17500');
  assert.equal(item.params.get('currency'), 'usd');
  assert.equal(item.params.get('invoice'), 'in_new');

  assert.ok(fetchImpl.calls.some(c => /\/v1\/invoices\/in_new\/finalize$/.test(c.url)));
  assert.ok(fetchImpl.calls.some(c => /\/v1\/invoices\/in_new\/send$/.test(c.url)));
});

test('BOOKING_CREATED reuses an existing Stripe customer by email', async () => {
  const fetchImpl = makeFetch([
    emptySearch,
    ['GET', /\/v1\/customers\?/, { data: [{ id: 'cus_existing' }] }],
    createInvoice, createItem, finalizeInv, sendInv,
  ]);
  const res = await handleEvent(booking(), ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.ok(!fetchImpl.calls.some(c => c.method === 'POST' && /\/v1\/customers$/.test(c.url)),
    'must not create a duplicate customer');
  const inv = fetchImpl.calls.find(c => c.method === 'POST' && /\/v1\/invoices$/.test(c.url));
  assert.equal(inv.params.get('customer'), 'cus_existing');
});

test('BOOKING_CREATED is idempotent: an existing live invoice for the uid short-circuits', async () => {
  const fetchImpl = makeFetch([
    ['GET', /\/v1\/invoices\/search/, { data: [{ id: 'in_prior', status: 'open' }] }],
  ]);
  const res = await handleEvent(booking(), ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.equal(res.body.already, true);
  assert.ok(!fetchImpl.calls.some(c => c.method === 'POST'), 'no writes on duplicate delivery');
});

test('a void prior invoice does NOT block re-invoicing the same uid', async () => {
  const fetchImpl = makeFetch([
    ['GET', /\/v1\/invoices\/search/, { data: [{ id: 'in_prior', status: 'void' }] }],
    noCustomers, createCustomer, createInvoice, createItem, finalizeInv, sendInv,
  ]);
  const res = await handleEvent(booking(), ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.equal(res.body.invoice, 'in_new');
});

test('BOOKING_CREATED for an unknown package is acknowledged and ignored', async () => {
  const fetchImpl = makeFetch([]);
  const res = await handleEvent(booking({ eventTypeId: 999, type: 'mystery' }), ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(fetchImpl.calls.length, 0);
});

test('BOOKING_CREATED with no attendee email is acknowledged and ignored', async () => {
  const fetchImpl = makeFetch([]);
  const res = await handleEvent(booking({ attendees: [] }), ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(fetchImpl.calls.length, 0);
});

// --- cancel / reschedule ---------------------------------------------------

test('BOOKING_CANCELLED voids the open invoice for that booking', async () => {
  const fetchImpl = makeFetch([
    ['GET', /\/v1\/invoices\/search/, { data: [{ id: 'in_2', status: 'open' }] }],
    ['POST', /\/v1\/invoices\/in_2\/void$/, { id: 'in_2', status: 'void' }],
  ]);
  const evt = { ...booking(), triggerEvent: 'BOOKING_CANCELLED' };
  const res = await handleEvent(evt, ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.ok(fetchImpl.calls.some(c => /\/v1\/invoices\/in_2\/void$/.test(c.url)));
});

test('BOOKING_CANCELLED deletes a still-draft invoice', async () => {
  const fetchImpl = makeFetch([
    ['GET', /\/v1\/invoices\/search/, { data: [{ id: 'in_3', status: 'draft' }] }],
    ['DELETE', /\/v1\/invoices\/in_3$/, { id: 'in_3', deleted: true }],
  ]);
  const evt = { ...booking(), triggerEvent: 'BOOKING_CANCELLED' };
  const res = await handleEvent(evt, ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.ok(fetchImpl.calls.some(c => c.method === 'DELETE' && /\/v1\/invoices\/in_3$/.test(c.url)));
});

test('BOOKING_RESCHEDULED voids the old invoice and issues a fresh one', async () => {
  const fetchImpl = makeFetch([
    ['GET', /\/v1\/invoices\/search/, ({ url }) =>
      decodeURIComponent(url).includes("'bk_uid_old'")
        ? { data: [{ id: 'in_old', status: 'open' }] }
        : { data: [] }],
    ['POST', /\/v1\/invoices\/in_old\/void$/, { id: 'in_old', status: 'void' }],
    noCustomers, createCustomer, createInvoice, createItem, finalizeInv, sendInv,
  ]);
  const evt = { ...booking({ uid: 'bk_uid_new', rescheduleUid: 'bk_uid_old' }), triggerEvent: 'BOOKING_RESCHEDULED' };
  const res = await handleEvent(evt, ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.equal(res.body.invoice, 'in_new');
  assert.ok(fetchImpl.calls.some(c => /\/v1\/invoices\/in_old\/void$/.test(c.url)));
  const inv = fetchImpl.calls.find(c => c.method === 'POST' && /\/v1\/invoices$/.test(c.url));
  assert.equal(inv.params.get('metadata[cal_booking_uid]'), 'bk_uid_new');
});

test('other trigger events are acknowledged without touching Stripe', async () => {
  const fetchImpl = makeFetch([]);
  const evt = { ...booking(), triggerEvent: 'BOOKING_REQUESTED' };
  const res = await handleEvent(evt, ENV, fetchImpl, NOW_MS);
  assert.equal(res.status, 200);
  assert.equal(res.body.ignored, true);
  assert.equal(fetchImpl.calls.length, 0);
});

// --- HTTP layer ------------------------------------------------------------

function postContext(bodyStr, sig, env) {
  return {
    env,
    request: new Request('https://bayousips.com/api/calcom-webhook', {
      method: 'POST',
      headers: sig == null ? {} : { 'x-cal-signature-256': sig },
      body: bodyStr,
    }),
  };
}

test('onRequestPost fails closed with 503 when secrets are not configured', async () => {
  const body = JSON.stringify(booking());
  const r1 = await onRequestPost(postContext(body, sign(body), { STRIPE_API_KEY: 'rk' }));
  assert.equal(r1.status, 503);
  const r2 = await onRequestPost(postContext(body, sign(body), { CAL_WEBHOOK_SECRET: SECRET }));
  assert.equal(r2.status, 503);
});

test('onRequestPost rejects a bad or missing signature with 401', async () => {
  const body = JSON.stringify(booking());
  const bad = await onRequestPost(postContext(body, 'deadbeef', ENV));
  assert.equal(bad.status, 401);
  const missing = await onRequestPost(postContext(body, null, ENV));
  assert.equal(missing.status, 401);
});

test('onRequestPost accepts a signed unknown trigger with 200', async () => {
  const body = JSON.stringify({ triggerEvent: 'PING', payload: {} });
  const res = await onRequestPost(postContext(body, sign(body), ENV));
  assert.equal(res.status, 200);
});
