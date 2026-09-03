# SBN Autostyling Tracker — real backend version

This is a real, self-contained web app: Node/Express server + a JSON file database +
a static frontend. It's tested and working end to end (owner setup, employee login,
GoHighLevel webhook creating jobs automatically, employees adding upsells only to
their own jobs, owner dashboard with totals/leaderboard). No Claude account, no
third-party AI builder — just runs.

## What it does
- GoHighLevel sends job data to this app automatically (see "Connecting GoHighLevel"
  below) — date, customer, car, employee, base service, base price. No one types
  this in.
- Employees log in with their own PIN and only ever see their own jobs. They can add
  one or more upsells per job (open text name + price). They never see base price,
  total revenue, or anyone else's numbers — the server enforces this, not just the
  screen.
- The owner logs in with a separate PIN and sees everything: total revenue, total
  upsell revenue, upsell % of revenue, a per-employee breakdown, and a leaderboard of
  every upsell sold with the employee's name attached. The owner also manages the
  employee list and can manually add a job if one ever needs to be entered by hand.

## Running it locally (to test before deploying)
```
npm install
cp .env.example .env      # then edit .env and set real random secrets
npm start
```
Open http://localhost:3000 — first visit walks you through setting the owner PIN.

## Deploying it for real
This needs a host that keeps a persistent disk running (the JSON file has to survive
restarts). Good, cheap options: Railway, Fly.io, Render (on a paid/persistent-disk
tier — their free tier's filesystem is NOT guaranteed to persist), or a small VPS
(DigitalOcean, Linode). Exactly which plans include persistent storage changes over
time, so check the current details on whichever host you pick before committing.

General steps on any of them:
1. Push this folder to a GitHub repo (or upload it directly if the host allows).
2. Set the environment variables from `.env.example` in the host's dashboard —
   generate real random values for `WEBHOOK_SECRET` and `SESSION_SECRET` (don't use
   the placeholder text).
3. Set the start command to `npm start`.
4. Make sure the host's disk is persistent (sometimes called a "volume") and that
   `data.json` is written somewhere on that persistent volume, not a temp folder that
   gets wiped between deploys.
5. Once it's live, you'll have a real URL like `https://sbn-tracker.up.railway.app` —
   that's what you open on your phone and what employees will log into.

## Connecting GoHighLevel
In the GHL workflow that fires when an opportunity moves to "Booked with Deposit"
(or whatever stage means "this job is happening"), add a **Webhook** action:

- URL: `https://YOUR-DEPLOYED-DOMAIN/api/webhook/ghl?secret=YOUR_WEBHOOK_SECRET`
  (use the exact `WEBHOOK_SECRET` value you set in step 2 above)
- Method: POST
- Body (JSON), mapping each value to the matching GHL field/token:
```json
{
  "date": "{{appointment.startTime}}",
  "customerName": "{{contact.name}}",
  "car": "{{opportunity.name}}",
  "employeeName": "{{opportunity.custom_field_for_employee}}",
  "baseService": "{{opportunity.custom_field_for_service}}",
  "basePrice": "{{opportunity.value}}",
  "ghlOpportunityId": "{{opportunity.id}}"
}
```
The exact token names in curly braces depend on your GHL setup — swap in whatever
GHL's own token picker shows you for the appointment date, the opportunity name/value,
and your two custom fields. `ghlOpportunityId` matters most: it's what stops the same
job from being created twice if the opportunity gets updated again later.

**Important:** the `employeeName` sent from GHL must exactly match (case-insensitive)
an employee's name as entered in the Team tab in this app, or the job will show up as
"Unassigned" and you'll need to fix it by hand in the owner "All jobs" tab.

## Owner PIN vs. employee PINs
- The owner PIN is set once, on first launch.
- Employee PINs are set by the owner in the Team tab when adding each person — hand
  each employee their own PIN privately.
- This is real server-side access control: a logged-in employee's requests are
  filtered to their own data at the database query level, not hidden by the
  interface. There's no "PIN bypass via dev tools" issue here like the earlier
  Claude-artifact version had.

## Files
- `server.js` — the whole backend: sessions, the webhook endpoint, all API routes.
- `public/` — the frontend (plain HTML/CSS/JS, no build step needed).
- `data.json` — created automatically on first run; this is your entire database.
  Back it up periodically (it's just a text file — copy it somewhere safe now and then).
