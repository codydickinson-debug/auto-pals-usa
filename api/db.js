// ── db.js — Supabase database API ─────────────────────────────────
// Handles all CRUD for requests, repairs, sales, and messages
// SUPABASE_URL and SUPABASE_KEY come from Vercel environment variables.
// The hardcoded fallbacks exist so the app doesn't break if env vars are missing,
// but in production these MUST be set (and the hardcoded values should be rotated).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://phbdpvfdnxvzxpybfgbr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoYmRwdmZkbnh2enhweWJmZ2JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2ODc4NDAsImV4cCI6MjA5MTI2Mzg0MH0.ne0pU9m-SkN-yBA4qczyiwfWGKgmRHi_lTSnxFBoq1k';

async function query(table, method = 'GET', body = null, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${params}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[DB] Supabase ${method} ${table}${params} → ${res.status}: ${err}`);
    throw new Error(`Supabase error ${res.status}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const { verifyToken } = require('./auth.js');
const sms = require('./_sms.js');
const email = require('./email.js');

const PORTAL_URL  = process.env.PORTAL_URL  || 'https://autopalsusa.com/portal.html';
const BOOKING_URL = process.env.BOOKING_URL || 'https://autopalsusa.com/booking.html';

// Fire-and-forget SMS — never block the DB response on Twilio.
function fireSms(type, data) {
  try {
    Promise.resolve(sms.send(type, data)).catch(err =>
      console.error('[DB→SMS]', type, err && err.message)
    );
  } catch (err) {
    console.error('[DB→SMS sync]', type, err && err.message);
  }
}

// Fire-and-forget email — never block the DB response on SendGrid.
function fireEmail(type, data) {
  try {
    Promise.resolve(email.sendTemplate(type, data)).catch(err =>
      console.error('[DB→EMAIL]', type, err && err.message)
    );
  } catch (err) {
    console.error('[DB→EMAIL sync]', type, err && err.message);
  }
}

// Build the human-readable vehicle/budget/year strings used in notifications.
function vehicleStr(row) {
  if (!row.make) return 'Open Search';
  const yr = (row.year_from && row.year_to)
    ? (row.year_from === row.year_to ? String(row.year_from) : `${row.year_from}–${row.year_to}`)
    : '';
  const v = `${row.make}${row.model ? ' ' + row.model : ''}`.trim();
  return yr ? `${yr} ${v}` : v;
}
function budgetStr(row) {
  if (!row.budget_min && !row.budget_max) return '';
  return `$${Number(row.budget_min || 0).toLocaleString()}–$${Number(row.budget_max || 0).toLocaleString()}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Staff-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  console.log(`[DB] ${req.method} ${req.query.table}`);

  const { table, action } = req.query;
  const body = req.body;

  // ── AUTH GATING ──────────────────────────────────────────────
  // Public (no token needed):
  //   - GET /requests          (portal code lookup)
  //   - POST /requests         (new client submissions from public form)
  //   - GET /bookings          (show booked slots on calendar)
  //   - POST /bookings         (client booking a call)
  //   - POST /messages         (client sending a message through portal)
  //   - GET /messages          (client viewing their own thread)
  //   - PUT /messages          (marking messages read)
  // Everything else (DELETE of anything, PUT on requests, all repairs/sales writes) = staff only.
  const isPublicOp =
    (table === 'requests' && (req.method === 'GET' || req.method === 'POST')) ||
    (table === 'bookings' && (req.method === 'GET' || req.method === 'POST')) ||
    (table === 'messages' && req.method !== 'DELETE');

  if (!isPublicOp) {
    const token = req.headers['x-staff-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(token)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  try {
    // ── REQUESTS ──────────────────────────────────────────────────
    if (table === 'requests') {
      if (req.method === 'GET') {
        const data = await query('requests', 'GET', null, '?order=submitted.desc');
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        const row = {
          id: body.id || Date.now(),
          submitted: body.submitted,
          status: body.status || 'new',
          first_name: body.firstName,
          last_name: body.lastName,
          email: body.email,
          phone: body.phone,
          address: body.address || '',
          city: body.city || '',
          state: body.state || '',
          zip: body.zip || '',
          make: body.make || '',
          model: body.model || '',
          year_from: body.yearFrom || '',
          year_to: body.yearTo || '',
          budget_min: body.budgetMin || 0,
          budget_max: body.budgetMax || 0,
          body: body.body || '',
          mileage: body.mileage || '',
          transmission: body.transmission || '',
          color: body.color || '',
          features: body.features || [],
          notes: body.notes || '',
          internal_notes: body.internalNotes || '',
          search_mode: body.searchMode || 'specific',
          portal_code: body.portalCode || '',
          ai_color: body.aiColor || null,
          ai_reason: body.aiReason || null,
          ai_recs: body.aiRecs || null,
          deposit_paid: body.depositPaid || false,
          deposit_ref: body.depositRef || '',
          deposit_date: body.depositDate || '',
          client_recs: body.clientRecs || null,
          rejection_reason: body.rejectionReason || ''
        };
        const data = await query('requests', 'POST', row);

        // Build common notification payload bits
        const _vehStr   = vehicleStr(row);
        const _budgStr  = budgetStr(row);
        const _name     = `${row.first_name || ''} ${row.last_name || ''}`.trim();

        // Build notification fires. Await ALL of them (Promise.allSettled)
        // before responding — Vercel terminates the lambda right after res.json()
        // and would kill in-flight SendGrid/Twilio HTTP requests if we let
        // them dangle as fire-and-forget.
        const fires = [];

        if (row.status !== 'rejected') {
          fires.push(sms.send('staff_new_request', {
            firstName: row.first_name, lastName: row.last_name,
            email: row.email, phone: row.phone,
            make: row.make, model: row.model,
            budgetMin: row.budget_min, budgetMax: row.budget_max
          }));
          fires.push(email.sendTemplate('staffNewRequest', {
            clientName:  _name,
            clientEmail: row.email,
            clientPhone: row.phone,
            vehicleStr:  _vehStr,
            budgetStr:   _budgStr,
            portalCode:  row.portal_code
          }));
          if (row.phone) {
            fires.push(sms.send('client_book_call', {
              firstName: row.first_name, phone: row.phone
            }));
          }
          if (row.email) {
            fires.push(email.sendTemplate('confirmation', {
              firstName:  row.first_name,
              lastName:   row.last_name,
              email:      row.email,
              make:       row.make,
              model:      row.model,
              yearFrom:   row.year_from,
              yearTo:     row.year_to,
              budgetMin:  row.budget_min,
              budgetMax:  row.budget_max,
              bookingUrl: BOOKING_URL,
              portalUrl:  PORTAL_URL
            }));
          }
        } else {
          fires.push(sms.send('staff_rejected', {
            firstName: row.first_name, lastName: row.last_name,
            budgetMax: row.budget_max
          }));
          if (row.email) {
            fires.push(email.sendTemplate('rejected', {
              firstName: row.first_name,
              lastName:  row.last_name,
              email:     row.email,
              portalUrl: PORTAL_URL
            }));
          }
        }

        const results = await Promise.allSettled(fires);
        results.forEach((r, i) => {
          if (r.status === 'rejected') console.error('[DB→notify]', i, r.reason && r.reason.message);
        });

        return res.json(data);
      }
      if (req.method === 'PUT') {
        const b = body;
        // Only update columns that exist in Supabase — ignore unknown fields
        const mapped = {
          status:            b.status,
          first_name:        b.firstName,
          last_name:         b.lastName,
          email:             b.email,
          phone:             b.phone,
          address:           b.address,
          city:              b.city,
          state:             b.state,
          zip:               b.zip,
          make:              b.make,
          model:             b.model,
          year_from:         b.yearFrom,
          year_to:           b.yearTo,
          budget_min:        b.budgetMin,
          budget_max:        b.budgetMax,
          body:              b.body,
          mileage:           b.mileage,
          transmission:      b.transmission,
          color:             b.color,
          features:          b.features,
          notes:             b.notes,
          internal_notes:    b.internalNotes,
          search_mode:       b.searchMode,
          portal_code:       b.portalCode,
          ai_color:          b.aiColor   || null,
          ai_reason:         b.aiReason  || null,
          ai_recs:           b.aiRecs    || null,
          deposit_paid:      b.depositPaid || false,
          deposit_ref:       b.depositRef  || '',
          deposit_date:      b.depositDate || '',
          client_recs:       b.clientRecs  || null,
          rejection_reason:  b.rejectionReason || '',
          call_completed_at:       b.callCompletedAt,
          booking_confirmed_at:    b.bookingConfirmedAt,
          booking_reminders_sent:  b.bookingRemindersSent,
          deposit_reminders_sent:  b.depositRemindersSent,
          contract_signed_at:         b.contractSignedAt,
          contract_signature_name:    b.contractSignatureName,
          contract_signature_ip:      b.contractSignatureIp
        };
        // Remove undefined values
        Object.keys(mapped).forEach(k => { if (mapped[k] === undefined) delete mapped[k]; });

        // Fetch prior row so we can detect the deposit-paid transition (false→true)
        // and fire deposit notifications exactly once.
        let priorRow = null;
        try {
          const prior = await query('requests', 'GET', null, `?id=eq.${b.id}&limit=1`);
          if (prior && prior.length) priorRow = prior[0];
        } catch (e) { /* best-effort */ }

        await query('requests', 'PATCH', mapped, `?id=eq.${b.id}`);

        // Deposit just flipped: notify staff + push contract-available SMS to client.
        const wasPaid = !!(priorRow && priorRow.deposit_paid);
        const nowPaid = !!mapped.deposit_paid;
        if (!wasPaid && nowPaid && priorRow) {
          const depositFires = [
            sms.send('staff_deposit_received', {
              firstName: priorRow.first_name, lastName: priorRow.last_name,
              depositRef: mapped.deposit_ref || priorRow.deposit_ref || ''
            })
          ];
          if (priorRow.phone) {
            depositFires.push(sms.send('client_contract_available', {
              firstName: priorRow.first_name, phone: priorRow.phone
            }));
          }
          await Promise.allSettled(depositFires);
        }

        return res.json({ ok: true });
      }
      if (req.method === 'DELETE') {
        await query('requests', 'DELETE', null, `?id=eq.${body.id}`);
        return res.json({ ok: true });
      }
    }

    // ── REPAIRS ───────────────────────────────────────────────────
    if (table === 'repair_cars') {
      if (req.method === 'GET') {
        const data = await query('repair_cars', 'GET', null, '?order=id.desc');
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        const row = {
          id: body.id || Date.now(),
          client: body.client,
          vehicle: body.vehicle,
          vin: body.vin || '',
          notes: body.notes || '',
          repairs: body.repairs || [],
          parts: body.parts || []
        };
        const data = await query('repair_cars', 'POST', row);
        return res.json(data);
      }
      if (req.method === 'PUT') {
        const { id, ...updates } = body;
        await query('repair_cars', 'PATCH', updates, `?id=eq.${id}`);
        return res.json({ ok: true });
      }
      if (req.method === 'DELETE') {
        await query('repair_cars', 'DELETE', null, `?id=eq.${body.id}`);
        return res.json({ ok: true });
      }
    }

    // ── SALES ─────────────────────────────────────────────────────
    if (table === 'sales') {
      if (req.method === 'GET') {
        const data = await query('sales', 'GET', null, '?order=date.desc');
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        const data = await query('sales', 'POST', { id: body.id || Date.now(), ...body });
        return res.json(data);
      }
      if (req.method === 'DELETE') {
        await query('sales', 'DELETE', null, `?id=eq.${body.id}`);
        return res.json({ ok: true });
      }
    }

    // ── MESSAGES ──────────────────────────────────────────────────
    if (table === 'messages') {
      if (req.method === 'GET') {
        const reqId = req.query.request_id;
        const params = reqId ? `?request_id=eq.${reqId}&order=ts.asc` : '?order=ts.asc';
        const data = await query('messages', 'GET', null, params);
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        const row = {
          request_id: body.requestId,
          from_role: body.from,
          text: body.text,
          ts: body.ts || new Date().toISOString(),
          read: body.read || false
        };
        const data = await query('messages', 'POST', row);

        // Notify the client via SMS when a staff member sends a message.
        // Look up the linked request to get the client's phone.
        if (row.from_role === 'team' || row.from_role === 'staff') {
          try {
            const reqRow = await query('requests', 'GET', null, `?id=eq.${row.request_id}&limit=1`);
            if (reqRow && reqRow.length && reqRow[0].phone) {
              await sms.send('client_portal_message', {
                phone: reqRow[0].phone,
                staffName: body.staffName || 'Auto Pals USA'
              });
            }
          } catch (e) { /* best-effort, don't fail the message post */ }
        }

        return res.json(data);
      }
      if (req.method === 'PUT') {
        // Mark messages as read
        await query('messages', 'PATCH', { read: true }, `?request_id=eq.${body.requestId}&from_role=eq.client`);
        return res.json({ ok: true });
      }
      if (req.method === 'DELETE') {
        // Delete all messages for a given request_id (used when deleting a request)
        const reqId = body.requestId || body.request_id || body.id;
        await query('messages', 'DELETE', null, `?request_id=eq.${reqId}`);
        return res.json({ ok: true });
      }
    }

    // ── BOOKINGS ──────────────────────────────────────────────────
    if (table === 'bookings') {
      if (req.method === 'GET') {
        // Get bookings for a specific date to check cap
        const date = req.query.date;
        const params = date ? `?date=eq.${date}&order=ts.asc` : '?order=ts.desc&limit=100';
        const data = await query('bookings', 'GET', null, params);
        return res.json(data || []);
      }
      if (req.method === 'POST') {
        // First check if day is already at cap (5 bookings)
        const existing = await query('bookings', 'GET', null, `?date=eq.${body.date}`);
        if (existing && existing.length >= 5) {
          return res.status(409).json({ error: 'day_full', count: existing.length });
        }
        // Check if specific time slot is taken
        const slotTaken = existing && existing.find(b => b.time === body.time);
        if (slotTaken) {
          return res.status(409).json({ error: 'slot_taken' });
        }
        const row = {
          id: Date.now(),
          date: body.date,
          time: body.time,
          first_name: body.firstName,
          last_name: body.lastName,
          email: body.email,
          phone: body.phone || '',
          vehicle: body.vehicle || '',
          ts: new Date().toISOString()
        };
        const data = await query('bookings', 'POST', row);

        // Cross-link: if the booker's email matches a pending request, mark that
        // request as booked so the cron stops sending booking reminders.
        if (body.email) {
          try {
            const matches = await query(
              'requests',
              'GET',
              null,
              `?email=eq.${encodeURIComponent(body.email)}&booking_confirmed_at=is.null&order=submitted.desc&limit=1`
            );
            if (matches && matches.length) {
              await query(
                'requests',
                'PATCH',
                { booking_confirmed_at: new Date().toISOString() },
                `?id=eq.${matches[0].id}`
              );
            }
          } catch(e) { /* best-effort, don't fail booking on this */ }
        }

        return res.json(data);
      }
    }

    return res.status(400).json({ error: 'Unknown table' });
  } catch (err) {
    console.error('DB error:', err);
    return res.status(500).json({ error: err.message });
  }
}
