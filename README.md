# Auto Motivation Enterprise — CRM Platform

## For Tomorrow's Presentation

### How to run it locally (no internet needed)

1. Download and unzip this folder
2. Open the `public/` folder
3. Double-click `home.html` to start

That's it. Everything works in demo mode:
- AI recommendations generate automatically (~2 seconds)
- Emails log silently (nothing actually sends)
- All data saves in your browser session
- All pages link to each other

### Demo flow to show your bosses

**Page 1 — Homepage** (home.html)
Show the landing page, reviews, FAQ, then click "Submit a Vehicle Request"

**Page 2 — Client Form** (index.html)
Fill out a request — try both specific car and "Help me find something"
Submit it and watch it land on the dashboard automatically

**Page 3 — Internal Dashboard** (Dashboard tab)
- Request table with AI traffic light scoring
- Click a request to see the detail panel
- Status buttons, internal notes, 3-dot quick actions
- Sold Cars tab with profit calculations
- In Repair tab with cost tracking
- Open Searches tab with AI recommendations

**Page 4 — Client Portal** (portal.html)
Click through the 4 stage buttons to show what clients see at each step

---

## File Structure

public/
  home.html      <- Landing page
  index.html     <- Client form + Internal dashboard
  portal.html    <- Client portal

api/
  ai.js          <- AI backend (needs ANTHROPIC_API_KEY on Vercel)
  email.js       <- Email backend (needs SENDGRID_API_KEY on Vercel)

---

## Deploy to Vercel (when ready)

1. npm install -g vercel
2. vercel login
3. cd auto-motivation && vercel
4. Add environment variables in Vercel dashboard:
   - ANTHROPIC_API_KEY  (from console.anthropic.com)
   - SENDGRID_API_KEY   (from app.sendgrid.com)
   - FROM_EMAIL         (your verified SendGrid sender)
5. vercel --prod

Free services: Vercel (hosting), SendGrid (100 emails/day free)
Paid: Anthropic API (pay per use, very cheap for this volume)

---

## Setting up Google Calendar (for booking)

### Step 1 — Google Cloud Console
1. Go to console.cloud.google.com
2. Create a new project (or use existing)
3. Enable the **Google Calendar API**
4. Go to Credentials → Create Credentials → OAuth 2.0 Client ID
5. Application type: **Web application**
6. Add redirect URI: `https://developers.google.com/oauthplayground`
7. Copy your **Client ID** and **Client Secret**

### Step 2 — Get a Refresh Token
1. Go to developers.google.com/oauthplayground
2. Click settings (gear icon) → check "Use your own OAuth credentials"
3. Enter your Client ID and Client Secret
4. In Step 1, find "Google Calendar API v3" and select `https://www.googleapis.com/auth/calendar.events`
5. Click Authorize → sign in with the Google account that owns the team calendar
6. Click "Exchange authorization code for tokens"
7. Copy the **Refresh Token**

### Step 3 — Get your Calendar ID
1. Go to calendar.google.com
2. Find your team calendar → Settings → Copy the **Calendar ID** (looks like an email address)

### Step 4 — Add to Vercel
Add these environment variables in Vercel dashboard:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- GOOGLE_REFRESH_TOKEN
- GOOGLE_CALENDAR_ID
