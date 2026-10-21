# Texts to sales reps: GHL setup (about 10 minutes)

The tracker decides *when* and *who*. GHL does the actual texting, using one small workflow.
Nothing is sent until you (1) paste the workflow's address into the tracker and (2) press **Turn texts ON**.

## What the tracker sends to GHL

A POST with JSON like this (one per text):

```json
{
  "source": "sbn-tracker",
  "location": "NJ",
  "kind": "missed_appointment",
  "toName": "Firdavs K",
  "toPhone": "+18565550142",
  "message": "SBN NJ: MISSED - Alex Rivera, 2025 TOYOTA 4RUNNER 2Front Windows, was due 1:30 PM today. Call (856) 555-0177.",
  "customerName": "Alex Rivera",
  "customerPhone": "+18565550177",
  "car": "2025 TOYOTA 4RUNNER 2Front Windows",
  "appointmentTime": "2026-10-13T17:30:00.000Z",
  "appointmentTimeEastern": "1:30 PM",
  "saleId": "…"
}
```

`kind` is one of `missed_appointment` (a no-show), `cancelled_appointment`, or `test`.
`message` is ready to send as is. The other fields are there if you want to build your own wording.

## In GHL

1. **Automation → Workflows → Create workflow → Start from scratch.** Name it "SBN rep texts".
2. **Add trigger → Inbound Webhook.** (This may be a premium trigger on your plan; check before relying on it.)
   Copy the **webhook URL** it shows.
3. In the tracker: **Sales Reps → Texts to sales reps** → paste the URL → **Save address**.
4. Press **Send a test text** (enter your own mobile). This sends GHL one sample so the workflow can see the fields.
   In the trigger, use **Fetch sample requests** and pick it.
5. Add an action that texts the number in `toPhone`. GHL texts *contacts*, so the usual way is:
   - **Create/Update Contact**: phone = the webhook's `toPhone`, first name = `toName`, and add a tag such as `sbn-rep`
     (use that tag to keep your reps out of any marketing workflows).
   - **Send SMS** to that contact with the message body set to the webhook's `message` field.
   (If your reps are GHL users with a phone saved on their profile, an **Internal Notification** by SMS can work too.)
6. **Save**, then switch the workflow to **Published**.
7. Back in the tracker, press **Send a test text** again: it should reach your phone. Then press **Turn texts ON**.

## Things to know

- Only **today's** appointments text anyone. One text per job.
- A **No-show** text waits 20 seconds (so a mis-tap can be undone). A **Cancelled** text waits 3 minutes (in case it was a reschedule).
- Each rep needs a mobile number saved (Sales Reps page). The **fallback number** gets the text when a job has no sales rep or the rep has no number.
- The **Recent texts** list on the Sales Reps page shows every text: Sent, Waiting, Failed (with the reason), or Not sent (with the reason).
- If GHL is down, the tracker retries after 1, 5 and 15 minutes, then marks it Failed. Waiting texts survive a restart.
- A rep who replies STOP to a text will be blocked by GHL's own opt-out rules.

---

# Follow-ups (a reminder text at the time the rep chose)

## How a rep uses it

In GHL, add a **tag** to the contact. The tag says who you are and when you want the reminder:

| Tag | Meaning |
|---|---|
| `fu-fk-1h` | Firdavs: text me in 1 hour |
| `fu-fk-2h` | in 2 hours |
| `fu-fk-4h` | in 4 hours |
| `fu-fk-tomorrow` | tomorrow at 10:00 AM Eastern |
| `fu-dg-2h`, `fu-tg-2h`, `fu-mr-2h` | the same, for Dmitriy, Timothy, Matt (use the rep's initials as saved on the Sales Reps page) |
| `fu-fk-90m`, `fu-fk-3d` | any number of minutes (`m`), hours (`h`) or days (`d`), from 1 minute to 14 days |
| `fu-cancel` | cancel the follow-up that is waiting for this contact |

When it's due, that rep gets a text like:
`SBN NJ: FOLLOW-UP - Maria Lopez, (856) 555-0177. Note: wants a quote for the full car`

Why the initials are in the tag: GHL doesn't say who added a tag, and a contact's "owner" in GHL is often not the rep who is
following up. If you leave the initials out (`fu-2h`), the tracker falls back to the rep named in the message (see `salesRepName`
below), and then to your fallback number.

Adding a new follow-up tag for the same contact **replaces** the one that was waiting.

## The two GHL workflows

**Workflow 1: "SBN follow-up"**
1. Trigger: **Contact Tag → Tag Added**, and pick all of your `fu-…` tags (the trigger lets you choose several).
2. Action: **Webhook** (POST) to
   `https://YOUR-TRACKER-ADDRESS/api/webhook/ghl/followup?secret=YOUR_WEBHOOK_SECRET`
   (the same address and secret as your booking workflow: only the ending, `/followup`, is different).
   Custom data:
   - `contactId` = the contact's ID
   - `contactName` = the contact's full name
   - `contactPhone` = the contact's phone
   - `tags` = the contact's tags (the tracker picks out the `fu-…` one)
   - optional `note` = any custom field you want shown in the text (e.g. "what they want")
   - optional `salesRepName` = the same field you already send as the rep's name in the booking workflow
3. Action: **Remove Tag**: remove the `fu-…` tags, so the same tag can be added again later (GHL only fires on a tag being *added*).

**Workflow 2: "SBN follow-up cancel"**
1. Trigger: **Tag Added** = `fu-cancel`.
2. Action: **Webhook** (POST) to `https://YOUR-TRACKER-ADDRESS/api/webhook/ghl/followup-cancel?secret=YOUR_WEBHOOK_SECRET`
   with `contactId`, `contactName` and `contactPhone`.
3. Action: **Remove Tag** `fu-cancel`.

If your GHL can't send the contact's tag list, make one small workflow per tag instead, each sending a fixed
`tags` value (for example `fu-fk-2h`). It does the same thing with more workflows.

## What the tracker does

- Nothing is queued unless texts are ON. (A follow-up that arrives while texts are OFF is written to the Recent texts list as "Not sent: Texts are switched OFF", so a new workflow doesn't fail silently.)
- The text goes out at the due time through the same GHL "send the text" workflow as the missed-appointment texts.
- If texts are switched OFF while a follow-up is waiting, it is not sent (and the list says so).
- Waiting follow-ups survive a restart of the tracker.
- The Sales Reps page shows every follow-up: Waiting (with its due time), Sent, or Cancelled.

I can't see your GHL account, so check the names of the actions and fields above against what your GHL shows (for example the tag-list field).
