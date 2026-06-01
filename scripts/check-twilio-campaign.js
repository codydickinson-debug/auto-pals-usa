// Check the current status of our A2P 10DLC campaign with TCR.
// Run anytime to see whether TCR has approved, is still reviewing,
// or rejected again.
//
// Usage:
//   node --env-file=.env.local scripts/check-twilio-campaign.js
//
// Reads-only. Doesn't change anything. Safe to run repeatedly.

const sid   = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const SVC   = 'MG8d8d4ec21d52995ebcd462faab6228ac';

if (!sid || !token) {
  console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN in environment.');
  console.error('Run with: node --env-file=.env.local scripts/check-twilio-campaign.js');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');

async function tw(url) {
  const r = await fetch(url, { headers: { 'Authorization': auth } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

function statusEmoji(s) {
  switch ((s || '').toUpperCase()) {
    case 'VERIFIED':
    case 'APPROVED':       return '✅';
    case 'IN_PROGRESS':
    case 'PENDING':
    case 'SUBMITTED':      return '⏳';
    case 'FAILED':
    case 'REJECTED':
    case 'EXPIRED':        return '❌';
    default:               return '•';
  }
}

(async () => {
  // List all campaigns under the messaging service (usually just one)
  const list = await tw(`https://messaging.twilio.com/v1/Services/${SVC}/Compliance/Usa2p`);
  const camps = (list.body && (list.body.compliance || list.body.us_app_to_person)) || [];

  if (!Array.isArray(camps) || !camps.length) {
    console.log('⚠️  No A2P campaign found under messaging service', SVC);
    console.log('    Either it was deleted, or this is the wrong service SID.');
    process.exit(1);
  }

  for (const c of camps) {
    console.log('================================================');
    console.log('  A2P 10DLC CAMPAIGN STATUS');
    console.log('================================================');
    console.log('  Campaign SID:  ', c.sid);
    console.log('  Brand SID:     ', c.brand_registration_sid);
    console.log('  Use case:      ', c.us_app_to_person_usecase);
    console.log('  Submitted:     ', c.date_created);
    console.log('  Last updated:  ', c.date_updated);
    console.log('');
    console.log('  Twilio status: ', statusEmoji(c.campaign_status), c.campaign_status || '(no status)');
    console.log('  TCR status:    ', statusEmoji(c.tcr_status), c.tcr_status || '(no TCR status yet)');
    console.log('  Campaign ID:   ', c.campaign_id || '(not yet assigned by TCR)');

    if (c.rejection_reason) {
      console.log('');
      console.log('  ❌ REJECTION REASON:');
      console.log('     ', c.rejection_reason);
    }
    if (c.errors && c.errors.length) {
      console.log('');
      console.log('  ⚠️  ERRORS:');
      c.errors.forEach(e => {
        console.log('     -', e.description);
        if (e.fields) console.log('       fields:', e.fields.join(', '));
        if (e.url)    console.log('       docs:  ', e.url);
      });
    }

    // Carrier-level approval (T-Mobile, AT&T) only shows up after TCR approves
    if (c.rate_limits) {
      console.log('');
      console.log('  Rate limits:');
      console.log('    AT&T:      ', c.rate_limits.att == null ? '(pending)' : c.rate_limits.att + ' msgs/day');
      console.log('    T-Mobile:  ', c.rate_limits.tmobile == null ? '(pending)' : c.rate_limits.tmobile + ' msgs/day');
    }
    console.log('================================================');

    // Plain-English summary
    console.log('');
    const s = (c.campaign_status || '').toUpperCase();
    if (s === 'VERIFIED' || s === 'APPROVED') {
      console.log('🎉 You\'re approved. SMS to clients will land reliably.');
      console.log('   Make sure Vercel has TWILIO_PHONE_NUMBER + TWILIO_MESSAGING_SERVICE_SID set, then redeploy.');
    } else if (s === 'IN_PROGRESS' || s === 'PENDING' || s === 'SUBMITTED') {
      console.log('⏳ Still under review. TCR typically takes 1-7 business days.');
      console.log('   Re-run this script tomorrow to check again.');
    } else if (s === 'FAILED' || s === 'REJECTED') {
      console.log('❌ Rejected again. Read the rejection reason above and adjust.');
    } else {
      console.log('(unknown status — check Twilio Console directly)');
    }
  }
})();
