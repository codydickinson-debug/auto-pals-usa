# Auto Pals USA — Retell AI phone agent setup

The homepage AI line answers basic questions and books intro calls. It talks
to our own booking system through the webhook at **`/api/voice`** so a phone
booking lands exactly like a website booking (DB row → Google Calendar →
confirmation email → staff notifications → automatic 1‑hour SMS reminder).

Per owner decision (2026‑07‑09): the agent **never live‑transfers** — when a
caller wants a real person, it books a callback slot.

---

## 1. Environment variable (Vercel → Production)

| Var | Value |
| --- | --- |
| `VOICE_WEBHOOK_SECRET` | a long random string you generate; also goes in the Retell function headers below |
| `PUBLIC_BASE_URL` | *(optional)* defaults to `https://www.autopalsusa.com` |

Generate a secret, e.g. `openssl rand -hex 24`, add it in Vercel, redeploy.

---

## 2. Buy a dedicated number

In Retell → **Phone Numbers → Buy a number** (a *new* local number — do **not**
reuse the Salesmsg texting line 561‑709‑3747). Assign it to this agent as an
**inbound** agent.

---

## 3. Custom functions (Retell → your agent → Functions)

Both call the same URL. Add this header to **each** function so the webhook
accepts it:

```
Authorization: Bearer <VOICE_WEBHOOK_SECRET>
```

Webhook URL (both functions): `https://www.autopalsusa.com/api/voice`
Method: `POST`

### Function 1 — `check_availability`
Description: *"Look up open 30‑minute intro‑call slots. Call this before offering times. Pass a specific date if the caller named one; otherwise omit `date` to get the next available days."*

Parameters (JSON schema):
```json
{
  "type": "object",
  "properties": {
    "date": {
      "type": "string",
      "description": "Specific date the caller asked about, in YYYY-MM-DD format. Omit to get the next available weekdays."
    }
  }
}
```

### Function 2 — `book_call`
Description: *"Book the intro call once you have the caller's name, email, phone, and a specific date + time you confirmed is open. Times must be on the half hour between 9:00 AM and 4:30 PM Eastern, weekdays only."*

Parameters (JSON schema):
```json
{
  "type": "object",
  "properties": {
    "firstName": { "type": "string", "description": "Caller's first name" },
    "lastName":  { "type": "string", "description": "Caller's last name" },
    "email":     { "type": "string", "description": "Caller's email for the calendar invite and confirmation" },
    "phone":     { "type": "string", "description": "Caller's callback number with area code" },
    "date":      { "type": "string", "description": "Chosen date, YYYY-MM-DD" },
    "time":      { "type": "string", "description": "Chosen time exactly as offered, e.g. '10:30 AM'" },
    "vehicle":   { "type": "string", "description": "What vehicle they're after, if mentioned" }
  },
  "required": ["firstName", "lastName", "email", "phone", "date", "time"]
}
```

The webhook always returns a `message` string you can speak, plus a
`success` boolean and structured fields. If `success` is false, read the
`message` and adjust (offer another slot, re‑collect a field, etc.).

---

## 4. Agent system prompt (paste into Retell → Prompt)

> You are the friendly phone assistant for **Auto Pals USA** (Automotivation
> Enterprises LLC), a licensed Florida used‑car dealer that sources vehicles
> for clients through dealer‑only auctions. Alex and Josh run it. You answer
> basic questions and book free 30‑minute intro calls. Keep replies short and
> natural — you're on a phone call.
>
> **Start every call with this disclosure, once:** "Thanks for calling Auto
> Pals USA — you're speaking with our automated assistant, and this call may
> be recorded. How can I help?"
>
> **What we do (answer questions from this — do not make anything up):**
> - We find clients the right used vehicle by sourcing from dealer‑only
>   auctions they can't access on their own.
> - How it works: a quick intro call → an $850 deposit to start the search →
>   we hunt auctions for up to 60 days → when we find a candidate we send the
>   full details, an AutoCheck history report, and our in‑house mechanic's
>   inspection → **you approve it before we ever buy** → we handle purchase and
>   delivery.
> - The $850 deposit is taken up front, before the search begins.
> - We deliver anywhere in the contiguous US (lower 48). Not Hawaii or Alaska.
> - Intro calls run Monday–Friday, 9:00 AM to 4:30 PM Eastern.
>
> **Booking a call:** When someone wants to book — or wants to talk to a real
> person — book them an intro call (that's how they reach the team). First call
> `check_availability` and offer real open times. Collect first name, last
> name, email, and callback number. Confirm the email back letter by letter.
> Then call `book_call` with the exact date and time you offered. Read back the
> confirmation the webhook returns.
>
> **Guardrails — very important:**
> - Never quote a specific savings amount or percentage, never promise a
>   specific price, and never discuss financing terms, rates, or approvals.
> - Don't give legal advice or make guarantees about a vehicle.
> - If you're unsure about anything, say the team will cover it on the intro
>   call and offer to book one.
> - Only offer times that `check_availability` returned. Never invent a slot.
> - We can't book same‑day — earliest is the next business day.

---

## 5. Homepage number

Add the new number to the homepage with a short line, e.g.:
> **Questions? Call our AI assistant:** (XXX) XXX‑XXXX — answers common
> questions and books your intro call 24/7.

*(Tell me the number once you have it and I'll wire it into the homepage.)*

---

## Notes / future enhancements
- **Compliance:** the opening disclosure covers Florida's all‑party recording
  consent and AI disclosure. Keep it.
- **SMS reminder:** phone bookings automatically get the 1‑hour SMS reminder
  (from `api/call-reminders.js`) since it reads the `bookings` table. The
  reminder treats a phone booking's number as implicit transactional consent;
  if you want the agent to explicitly ask "OK to text you a reminder?", we can
  add a consent field later.
- **Optional:** an immediate "you're booked" SMS right after the call — easy to
  add if you want it (new `client_call_booked` template).
