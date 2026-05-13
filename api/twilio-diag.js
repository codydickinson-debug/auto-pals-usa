// ── twilio-diag.js — staff-only Twilio delivery diagnostic ─────────
// Returns:
//   - env-var presence flags (booleans only, never values)
//   - last 10 outbound messages: status, error_code, error_message,
//     direction, date_sent (to-phone masked to last 4)
//   - Messaging Service info (if TWILIO_MESSAGING_SERVICE_SID set):
//     friendly_name, sender pool phone numbers (masked), use_case
//
// Built to debug the "Twilio returns ok but phone never buzzes" case.
// Safe to keep deployed (staff-gated) or delete once SMS rollout is verified.

const { verifyToken } = require('./auth.js');
const sms = require('./_sms.js');

function maskPhone(p) {
  if (!p) return null;
  const s = String(p);
  return s.length <= 4 ? s : `***${s.slice(-4)}`;
}

async function twilioGet(path) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { error: 'no_twilio_creds' };
  const credentials = Buffer.from(`${sid}:${token}`).toString('base64');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    headers: { 'Authorization': `Basic ${credentials}` }
  });
  const data = await r.json();
  if (!r.ok) return { error: 'twilio_api_error', status: r.status, detail: data.message };
  return data;
}

async function getMessagingService(svcSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !svcSid) return null;
  const credentials = Buffer.from(`${sid}:${token}`).toString('base64');
  const [svc, phones] = await Promise.all([
    fetch(`https://messaging.twilio.com/v1/Services/${svcSid}`, {
      headers: { 'Authorization': `Basic ${credentials}` }
    }).then(r => r.json()).catch(e => ({ error: e.message })),
    fetch(`https://messaging.twilio.com/v1/Services/${svcSid}/PhoneNumbers`, {
      headers: { 'Authorization': `Basic ${credentials}` }
    }).then(r => r.json()).catch(e => ({ error: e.message }))
  ]);
  return {
    friendly_name: svc.friendly_name,
    use_case: svc.use_case,
    status: svc.status,
    sender_phone_count: Array.isArray(phones.phone_numbers) ? phones.phone_numbers.length : null,
    sender_phones_masked: Array.isArray(phones.phone_numbers)
      ? phones.phone_numbers.map(p => maskPhone(p.phone_number))
      : null,
    error: svc.error || phones.error || null
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Staff-Token,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers['x-staff-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return res.status(401).json({ error: 'unauthorized' });

  const envPresence = {
    TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
    TWILIO_MESSAGING_SERVICE_SID: !!process.env.TWILIO_MESSAGING_SERVICE_SID,
    TWILIO_PHONE_NUMBER: !!process.env.TWILIO_PHONE_NUMBER,
    STAFF_PHONE_NUMBERS: !!process.env.STAFF_PHONE_NUMBERS,
    TEAM_PHONE_NUMBER: !!process.env.TEAM_PHONE_NUMBER
  };

  const teamNumsRaw = process.env.STAFF_PHONE_NUMBERS || process.env.TEAM_PHONE_NUMBER || '';
  const teamNumsCount = teamNumsRaw.split(',').map(s => s.trim()).filter(Boolean).length;

  const messages = await twilioGet('/Messages.json?PageSize=10');
  const messagesSummary = messages.messages
    ? messages.messages.map(m => ({
        sid: m.sid,
        date_sent: m.date_sent,
        date_created: m.date_created,
        to: maskPhone(m.to),
        from: m.from,
        messaging_service_sid: m.messaging_service_sid,
        status: m.status,
        error_code: m.error_code,
        error_message: m.error_message,
        direction: m.direction
      }))
    : messages;

  const svcInfo = process.env.TWILIO_MESSAGING_SERVICE_SID
    ? await getMessagingService(process.env.TWILIO_MESSAGING_SERVICE_SID)
    : null;

  // Pull A2P 10DLC registration state. Brands are account-level (Trust Hub),
  // campaigns are per-Messaging-Service. Both need to be Approved/Registered
  // for carriers to stop bouncing with 30034.
  const sidCreds = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')
    : null;
  const svcSid = process.env.TWILIO_MESSAGING_SERVICE_SID;

  const twilioHeaders = sidCreds ? { 'Authorization': `Basic ${sidCreds}` } : null;

  const [brandsRaw, campaignsRaw, allServicesRaw] = sidCreds
    ? await Promise.all([
        fetch('https://messaging.twilio.com/v1/a2p/BrandRegistrations', { headers: twilioHeaders })
          .then(r => r.json()).catch(e => ({ error: e.message })),
        svcSid
          ? fetch(`https://messaging.twilio.com/v1/Services/${svcSid}/Compliance/Usa2p`, { headers: twilioHeaders })
              .then(r => r.json()).catch(e => ({ error: e.message }))
          : { skipped: 'no_service_sid' },
        fetch('https://messaging.twilio.com/v1/Services?PageSize=20', { headers: twilioHeaders })
          .then(r => r.json()).catch(e => ({ error: e.message }))
      ])
    : [{ skipped: 'no_creds' }, { skipped: 'no_creds' }, { skipped: 'no_creds' }];

  const brands = Array.isArray(brandsRaw.results)
    ? brandsRaw.results.map(b => ({
        sid: b.sid,
        status: b.status,
        brand_type: b.brand_type,
        brand_score: b.brand_score,
        identity_status: b.identity_status,
        russell_3000: b.russell_3000,
        tcr_id: b.tcr_id,
        failure_reason: b.failure_reason,
        date_created: b.date_created,
        date_updated: b.date_updated
      }))
    : brandsRaw;

  // Dump the campaign object verbatim so any TCR-level feedback fields
  // (errors, rejection_reason, mock, etc.) that Twilio adds during review
  // come through without us having to know each field name up-front.
  const campaigns = Array.isArray(campaignsRaw.compliance) || Array.isArray(campaignsRaw.results)
    ? (campaignsRaw.compliance || campaignsRaw.results)
    : campaignsRaw;

  const allServices = Array.isArray(allServicesRaw.services)
    ? allServicesRaw.services.map(s => ({
        sid: s.sid,
        friendly_name: s.friendly_name,
        is_pointed_to_by_env: s.sid === svcSid
      }))
    : allServicesRaw;

  // Optional one-off test send — ?test=PHONE[&body=TEXT]
  // Single recipient (no staff fan-out) so we don't spam the team while
  // probing A2P state. Returns the raw Twilio response inline so we see
  // status + error_code immediately (e.g., 30034 = unregistered campaign).
  let testSendResult = null;
  const testPhone = req.query.test;
  if (testPhone) {
    const body = req.query.body || 'Auto Pals SMS test — if you got this, A2P is delivering.';
    testSendResult = await sms.sendOne(testPhone, body);
  }

  // Trust Hub inspection — ?inspect=trusthub
  // Pulls customer profiles AND trust products (where A2P bundle lives),
  // with entity assignments so we can see which end-user resources hold
  // the PRIVACY_POLICY_URL / TERMS_AND_CONDITIONS_URL attributes.
  let trustHub = null;
  if (req.query.inspect === 'trusthub' && twilioHeaders) {
    const trGet = (path) =>
      fetch(`https://trusthub.twilio.com${path}`, { headers: twilioHeaders })
        .then(r => r.json())
        .catch(e => ({ error: e.message, path }));

    const [profiles, trustProducts, endUsers, docs] = await Promise.all([
      trGet('/v1/CustomerProfiles?PageSize=50'),
      trGet('/v1/TrustProducts?PageSize=50'),
      trGet('/v1/EndUsers?PageSize=50'),
      trGet('/v1/SupportingDocuments?PageSize=50')
    ]);

    const expand = async (kind, p) => ({
      bundle: p,
      assignments: await trGet(`/v1/${kind}/${p.sid}/EntityAssignments?PageSize=50`)
    });

    const profileDetails = Array.isArray(profiles.results)
      ? await Promise.all(profiles.results.map(p => expand('CustomerProfiles', p)))
      : null;

    const trustProductDetails = Array.isArray(trustProducts.results)
      ? await Promise.all(trustProducts.results.map(p => expand('TrustProducts', p)))
      : null;

    trustHub = {
      customer_profiles: profileDetails || profiles,
      trust_products:    trustProductDetails || trustProducts,
      end_users:         endUsers,
      supporting_documents: docs
    };
  }

  // Action: update campaign's privacy_policy_url + terms_and_conditions_url
  // to www variants and re-submit for TCR review. Only legal while the
  // campaign is IN_PROGRESS (Twilio locks URL changes after TCR approval).
  // POST as application/x-www-form-urlencoded per Twilio API conventions.
  let fixResult = null;
  if (req.query.fix === 'campaign_urls' && twilioHeaders && svcSid) {
    const campaignSid = Array.isArray(campaigns) && campaigns[0] ? campaigns[0].sid : null;
    if (!campaignSid) {
      fixResult = { ok: false, error: 'no_campaign_found' };
    } else {
      const newPrivacy = req.query.privacy_url || 'https://www.autopalsusa.com/privacy.html';
      const newTerms   = req.query.terms_url   || 'https://www.autopalsusa.com/terms.html';
      const body = new URLSearchParams({
        privacy_policy_url:       newPrivacy,
        terms_and_conditions_url: newTerms
      }).toString();

      const r = await fetch(
        `https://messaging.twilio.com/v1/Services/${svcSid}/Compliance/Usa2p/${campaignSid}`,
        {
          method: 'POST',
          headers: { ...twilioHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        }
      );
      let respBody = null;
      try { respBody = await r.json(); } catch (_) { respBody = await r.text().catch(() => null); }
      fixResult = {
        ok: r.ok,
        status: r.status,
        campaign_sid: campaignSid,
        new_privacy_policy_url: newPrivacy,
        new_terms_and_conditions_url: newTerms,
        twilio_response: respBody
      };
    }
  }

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    env_presence: envPresence,
    team_recipient_count: teamNumsCount,
    messaging_service: svcInfo,
    a2p_brand_registrations: brands,
    a2p_campaigns_on_this_service: campaigns,
    all_messaging_services: allServices,
    last_messages: messagesSummary,
    test_send: testSendResult,
    trust_hub: trustHub,
    fix_result: fixResult
  });
};
