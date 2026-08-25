# Auth email — setup runbook

**Status: not set up. This is a go-live blocker, not polish.**

---

## What's actually wrong

Checked the live Supabase project (`egutikecgederdxpgbvw`) this afternoon:

| Setting | State |
|---|---|
| Custom SMTP | **Off** |
| Rate limit for sending emails | **2 emails per hour**, project-wide (greyed out — it's a consequence of SMTP being off) |
| Site URL | ✅ `https://jesses-bakery-os.netlify.app` |
| Redirect allowlist | ✅ prod `/auth/callback` + localhost |
| Email templates | Supabase defaults |

Everything is going through Supabase's shared testing sender,
`Supabase Auth <noreply@mail.app.supabase.io>`.

## Why it blocks 3 Sept

It isn't the reset flow that breaks. It's **getting anyone into the system in
the first place.**

Onboarding a staff member means Supabase sends them an invite they click to set
a password. At two emails an hour, project-wide:

- 10 staff to onboard = **5 hours of waiting**, in two-person batches
- every password reset that day competes for the same two slots
- and the sender is a Supabase address nobody recognises, so a fair share land
  in junk and get re-sent, burning the quota again

There is no workaround that doesn't involve an admin typing passwords for
people and telling them over the phone, which we should not be doing for a
system that holds the client's trading data.

## Cost

**$0.** Resend's free tier is 3,000 emails/month, 100/day, one verified sending
domain. Jesse's Bakery will use a few dozen a month. This does not add to the
run rate Tommy is already justifying.

---

## The one decision: which domain sends

This is the only part that needs someone else, and it's why this is in a
runbook today rather than being done.

**Option A — `noreply@jessesbakery.com.au`.** Correct answer. Staff get an email
from their own bakery and nobody questions it. Needs three DNS records added to
`jessesbakery.com.au`, which means finding whoever holds that DNS. Unknown lead
time, and that's the risk with 9 days left.

**Option B — `noreply@bakery.cmob.com.au`.** Fred controls CMOB DNS, so this can
be done this afternoon. Display name still reads "Jesse's Bakery", which is what
most mail clients show. Honest — CMOB operates the system — but a careful reader
sees a domain that isn't their employer's.

**Recommendation: ask for A on Wednesday, build B now.** Simona is on the call
anyway; "who looks after your website's DNS" is a 30-second question. Set up B in
the meantime so onboarding is never the thing blocking go-live, and switch to A
if the DNS lands in time. Swapping later is a five-minute change — new domain in
Resend, new credentials in Supabase, done.

---

## Steps

### 1. Resend account + domain (15 min)

1. Create a Resend account on the CMOB email.
2. **Domains → Add Domain** → `bakery.cmob.com.au` (or `jessesbakery.com.au` if
   that's been agreed).
3. Resend shows three DNS records. Add them wherever that domain's DNS lives:

   | Type | Purpose |
   |---|---|
   | MX | receiving for the sending subdomain |
   | TXT (SPF) | authorises Resend to send as this domain |
   | TXT (DKIM) | signs the mail so it isn't forged |

   Copy the values from Resend exactly — they're generated per domain, so
   there's nothing to write down here in advance.
4. Wait for Resend to show **Verified**. Usually minutes; can be up to an hour.
5. Add a **DMARC** record too, even though Resend doesn't demand one.
   `v=DMARC1; p=none; rua=mailto:dmarc@cmob.com.au` is enough to start —
   it tells receivers we're monitoring, which helps placement.

### 2. Supabase SMTP (5 min)

**Authentication → Emails → SMTP Settings → Enable custom SMTP.**

| Field | Value |
|---|---|
| Sender email | `noreply@bakery.cmob.com.au` |
| Sender name | `Jesse's Bakery` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | the Resend API key |

Save. **Then go back to Authentication → Rate Limits** — the email limit becomes
editable once custom SMTP is on. Set it to something sane like `30/hour`. Leave
it generous enough to onboard a shift in one go, tight enough that a loop can't
mail 3,000 people overnight.

### 3. Templates (10 min)

**Authentication → Emails → Templates.** Paste from `auth-email-templates.html`
(alongside this doc). Set the subject line for each — Supabase keeps subject and
body separate.

The defaults are generic and say Supabase. These say what the email is, in
Simona's plain-language standard, and each one tells the reader what to do if it
wasn't them. That last part is what stops a bakery packer deleting it as
phishing.

### 4. Test it properly (10 min)

Not just "did an email arrive".

1. Reset your own password end to end — request, receive, click, set, sign in.
2. **Check where it landed.** Inbox or junk? Test at least one Gmail and one
   Outlook/Hotmail address; they score mail very differently.
3. Send two in a row to confirm the rate limit is no longer two an hour.
4. Invite a real second user (Simona's address) and have her complete it. The
   invite path is the one go-live depends on, and it is not the same template as
   reset.

### 5. Rollback

Turn custom SMTP off in Supabase. Everything reverts to the shared sender and
the two-an-hour limit. Nothing else in the app changes — the app never talks to
SMTP directly, it only calls `resetPasswordForEmail`.

---

## Still open after this

- **Who gets an account on 3 Sept, and with what role?** Unscoped. Roles exist
  (`admin` / `manager` / `office` / driver) and new accounts default to no role
  and no access, so nobody gets in by accident — but nobody has listed who needs
  to be let in either. Needs Simona.
- **A custom domain for the app itself.** Reset links currently point at
  `jesses-bakery-os.netlify.app`. Fine, but a bakery-branded URL would make the
  emails read as obviously legitimate. Worth raising with the domain question.
