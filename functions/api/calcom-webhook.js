// POST /api/calcom-webhook — Cal.com booking webhook -> Stripe invoice.
//
// Flow: Paula accepts a booking on Cal.com (events require confirmation, so
// BOOKING_CREATED fires at acceptance) -> this function creates a Stripe
// invoice due 24h before the event start and sends it; Stripe emails the
// customer a hosted payment page (dashboard setting "Send finalized invoices
// to customers" is ON in the Bayou Sips account).
//
// Cancel voids the invoice; reschedule voids and reissues against the new
// start time. Duplicate webhook deliveries are absorbed twice over: a Stripe
// search on metadata cal_booking_uid, plus Idempotency-Key on every write.
//
// Secrets (Pages project env, never in this repo):
//   CAL_WEBHOOK_SECRET  — Cal.com webhook signing secret (x-cal-signature-256)
//   STRIPE_API_KEY      — restricted key, Customers:write + Invoices:write
// Fails closed (503) until both exist. Tests: .tests/calcom-webhook.test.mjs

const STRIPE_API = 'https://api.stripe.com';

// The three live packages. Keyed by Cal.com eventTypeId (survives renames);
// slug is the fallback for payloads that omit the id.
const PACKAGES = {
  5560604: { slug: 'the-mini-package-175', label: 'The Mini Package', amountCents: 17500 },
  5560600: { slug: 'the-original-package-250', label: 'The Original Package', amountCents: 25000 },
  5560590: { slug: 'the-deluxe-package-400', label: 'The Deluxe Package', amountCents: 40000 },
};

// Statuses that mean "this booking already has a live invoice".
const LIVE_STATUSES = ['draft', 'open', 'paid', 'uncollectible'];

export async function verifyCalSignature(secret, rawBody, signatureHex) {
  if (typeof signatureHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(signatureHex)) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  const expected = Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
  const given = signatureHex.toLowerCase();
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export function resolvePackage(payload) {
  const byId = PACKAGES[payload?.eventTypeId];
  const pkg = byId || Object.values(PACKAGES).find(p => p.slug === payload?.type);
  return pkg ? { label: pkg.label, amountCents: pkg.amountCents } : null;
}

export function computeDueDate(startTimeIso, nowMs) {
  const dayBefore = Math.floor((Date.parse(startTimeIso) - 24 * 3600 * 1000) / 1000);
  return Math.max(dayBefore, Math.floor(nowMs / 1000) + 3600);
}

function stripeClient(env, fetchImpl) {
  return async (method, path, params, idemKey) => {
    const headers = { 'Authorization': `Bearer ${env.STRIPE_API_KEY}` };
    if (idemKey) headers['Idempotency-Key'] = idemKey;
    let url = STRIPE_API + path;
    const init = { method, headers };
    if (params && method === 'GET') {
      url += '?' + new URLSearchParams(params).toString();
    } else if (params) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(params).toString();
    }
    const res = await fetchImpl(url, init);
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(`stripe ${method} ${path} failed: ${data.error?.message || `HTTP ${res.status}`}`);
    }
    return data;
  };
}

async function findInvoices(stripe, uid) {
  const found = await stripe('GET', '/v1/invoices/search',
    { query: `metadata['cal_booking_uid']:'${uid}'`, limit: '10' });
  return found.data || [];
}

function eventDateLabel(startTimeIso) {
  return new Date(startTimeIso).toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

async function createInvoiceForBooking(stripe, payload, nowMs) {
  const uid = payload.uid;
  const attendee = payload.attendees?.[0];
  if (!attendee?.email) return { status: 200, body: { ignored: true, reason: 'no attendee email' } };

  const pkg = resolvePackage(payload);
  if (!pkg) return { status: 200, body: { ignored: true, reason: `unknown event type: ${payload.type}` } };

  const existing = (await findInvoices(stripe, uid)).find(i => LIVE_STATUSES.includes(i.status));
  if (existing) return { status: 200, body: { already: true, invoice: existing.id } };

  const customers = await stripe('GET', '/v1/customers', { email: attendee.email, limit: '1' });
  const customer = customers.data?.[0]
    || await stripe('POST', '/v1/customers',
         { email: attendee.email, name: attendee.name || '' }, `cal-cust-${uid}`);

  const due = computeDueDate(payload.startTime, nowMs);
  const invoice = await stripe('POST', '/v1/invoices', {
    customer: customer.id,
    collection_method: 'send_invoice',
    due_date: String(due),
    auto_advance: 'false',
    pending_invoice_items_behavior: 'exclude',
    description: `${pkg.label} — event on ${eventDateLabel(payload.startTime)}. Payment is due 24 hours before your event.`,
    'metadata[cal_booking_uid]': uid,
    'metadata[cal_event_start]': payload.startTime,
  }, `cal-inv-${uid}`);

  await stripe('POST', '/v1/invoiceitems', {
    customer: customer.id,
    invoice: invoice.id,
    amount: String(pkg.amountCents),
    currency: 'usd',
    description: pkg.label,
  }, `cal-item-${uid}`);

  await stripe('POST', `/v1/invoices/${invoice.id}/finalize`, {}, `cal-fin-${uid}`);
  await stripe('POST', `/v1/invoices/${invoice.id}/send`, {}, `cal-send-${uid}`);

  return { status: 200, body: { invoice: invoice.id, due_date: due } };
}

async function cancelInvoiceForBooking(stripe, uid) {
  const invoices = await findInvoices(stripe, uid);
  const results = [];
  for (const inv of invoices) {
    if (inv.status === 'draft') {
      await stripe('DELETE', `/v1/invoices/${inv.id}`);
      results.push({ invoice: inv.id, action: 'deleted' });
    } else if (inv.status === 'open' || inv.status === 'uncollectible') {
      await stripe('POST', `/v1/invoices/${inv.id}/void`, {}, `cal-void-${uid}-${inv.id}`);
      results.push({ invoice: inv.id, action: 'voided' });
    } else if (inv.status === 'paid') {
      // Never touch money: a paid invoice on a cancelled booking is Paula's
      // refund decision, not this webhook's.
      results.push({ invoice: inv.id, action: 'left paid — refund is a manual decision' });
    }
  }
  if (!results.length) return { status: 200, body: { ignored: true, reason: 'no live invoice for booking' } };
  return { status: 200, body: { cancelled: results } };
}

export async function handleEvent(evt, env, fetchImpl, nowMs = Date.now()) {
  const stripe = stripeClient(env, fetchImpl);
  const payload = evt.payload || {};
  switch (evt.triggerEvent) {
    case 'BOOKING_CREATED':
      return createInvoiceForBooking(stripe, payload, nowMs);
    case 'BOOKING_CANCELLED':
      return cancelInvoiceForBooking(stripe, payload.uid);
    case 'BOOKING_RESCHEDULED': {
      if (payload.rescheduleUid && payload.rescheduleUid !== payload.uid) {
        await cancelInvoiceForBooking(stripe, payload.rescheduleUid);
      }
      return createInvoiceForBooking(stripe, payload, nowMs);
    }
    default:
      return { status: 200, body: { ignored: true, reason: `trigger ${evt.triggerEvent} not handled` } };
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.CAL_WEBHOOK_SECRET || !env.STRIPE_API_KEY) {
    return Response.json({ error: 'webhook not configured' }, { status: 503 });
  }
  const rawBody = await request.text();
  const signature = request.headers.get('x-cal-signature-256');
  if (!(await verifyCalSignature(env.CAL_WEBHOOK_SECRET, rawBody, signature))) {
    return Response.json({ error: 'invalid signature' }, { status: 401 });
  }
  let evt;
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  try {
    const result = await handleEvent(evt, env, fetch);
    return Response.json(result.body, { status: result.status });
  } catch (err) {
    // 5xx makes Cal.com retry the delivery; idempotency keys make that safe.
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
