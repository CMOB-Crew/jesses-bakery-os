/* ---------------------------------------------------------------------------
 * Who may do what to whose account.
 *
 * Pure on purpose. No database, no network, no React -- so the part that
 * decides whether Simona can reset a driver's password can be asserted in a
 * script rather than discovered on a real person's account. The same reason
 * lib/xero-invoice.ts is pure: this is the file where a mistake is expensive
 * and silent.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Until 15 September there was no people screen. Creating an account,
 * resetting a password and switching somebody off all needed a terminal and
 * SUPABASE_SERVICE_ROLE_KEY, so all three were CMOB jobs. A system whose
 * passwords only the agency can reset has not been handed over, it is being
 * hosted.
 *
 * Handing that control to the bakery means somebody who is not CMOB can mint a
 * password for another human being. Every rule below exists to bound that.
 *
 * THE ONE THAT MATTERS MOST IS ESCALATION. A manager who can grant the manager
 * role, or reset an admin's password, is an admin with extra steps. Both are
 * refused here and both are asserted in scripts/people-check.ts.
 *
 * NOTHING HERE IS THE SECURITY BOUNDARY ON ITS OWN. It runs on the server and
 * is called by the actions, but the database is what actually holds: every
 * policy compares public.current_app_role(), and jb_role() only returns a role
 * for a row that is still is_active. This file stops the app offering a button
 * that the database would refuse -- and stops it offering one the database
 * would ALLOW because the service role key bypasses policies entirely, which
 * is the real reason these checks cannot live in RLS.
 * --------------------------------------------------------------------------- */

export type AppRole = "admin" | "manager" | "office" | "driver" | "packer";

/** Every role public.users will accept. Mirrors the CHECK in migration 012. */
export const ROLES: AppRole[] = ["admin", "manager", "office", "driver", "packer"];

/** The two roles that can open the People screen at all. */
export const CAN_MANAGE: string[] = ["admin", "manager"];

/**
 * The roles a manager may touch.
 *
 * The floor, and only the floor. Simona hands out driver and packer logins
 * every week and should never wait on CMOB to do it. She has no business
 * resetting an office, manager or admin password, and if she needs one of
 * those changed there is a person to ask.
 */
export const MANAGER_MAY_TOUCH: string[] = ["driver", "packer"];

export type Refusal = { reason: string };
export type Decision = { ok: true } | { ok: false } & Refusal;

const ok: Decision = { ok: true };
const no = (reason: string): Decision => ({ ok: false, reason });

/** Is this person allowed to open the screen at all? */
export function mayManagePeople(actorRole: string | null | undefined): boolean {
  return CAN_MANAGE.includes(String(actorRole ?? ""));
}

/**
 * May the actor act on an account currently holding this role?
 *
 * Covers reset, deactivate, reactivate and role change. Creating is separate,
 * because there is no existing target to weigh.
 */
export function mayActOn(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined,
): Decision {
  const actor = String(actorRole ?? "");
  const target = String(targetRole ?? "");

  if (!mayManagePeople(actor)) {
    return no("Only an admin or a manager can change accounts.");
  }
  if (actor === "admin") return ok;

  // A target with no role at all is an account nobody has finished setting up.
  // A manager may finish it -- that is the ordinary case of a new starter --
  // but only into a floor role, which mayGrant below enforces.
  if (target === "") return ok;

  if (!MANAGER_MAY_TOUCH.includes(target)) {
    return no(
      `A manager can change driver and packer accounts. This one is ${target}, ` +
      `so it needs an admin.`,
    );
  }
  return ok;
}

/** May the actor put somebody into this role? */
export function mayGrant(
  actorRole: string | null | undefined,
  newRole: string,
): Decision {
  const actor = String(actorRole ?? "");

  if (!ROLES.includes(newRole as AppRole)) {
    return no(`"${newRole}" is not a role this system has.`);
  }
  if (!mayManagePeople(actor)) {
    return no("Only an admin or a manager can set a role.");
  }
  if (actor === "admin") return ok;

  if (!MANAGER_MAY_TOUCH.includes(newRole)) {
    // The escalation rule. A manager who can grant manager or admin is an
    // admin, one step removed, and nothing else in this file would stop them.
    return no(
      `A manager can create drivers and packers. Giving somebody the ` +
      `${newRole} role needs an admin.`,
    );
  }
  return ok;
}

/**
 * Two things nobody may do, whatever their role.
 *
 * Both are lockout protection rather than privilege protection, which is why
 * they are checked separately and apply to admins too.
 *
 *   * You cannot switch yourself off or change your own role. The failure mode
 *     is somebody demoting themselves at 5pm on a Friday and there being no
 *     way back in.
 *   * You cannot remove the last active admin. Same failure, one step further:
 *     an empty admin list means account management is gone for good and the
 *     only route back is CMOB with the service key, which is the thing this
 *     whole screen exists to stop needing.
 */
export function mayChangeOwnAccount(
  actorId: string,
  targetId: string,
  what: "deactivate" | "role",
): Decision {
  if (actorId !== targetId) return ok;
  return no(
    what === "deactivate"
      ? "You cannot switch off your own account. Ask another admin."
      : "You cannot change your own role. Ask another admin.",
  );
}

export function wouldRemoveLastAdmin(
  target: { role: string | null; is_active: boolean },
  activeAdminCount: number,
  change: { deactivating?: boolean; newRole?: string },
): Decision {
  const targetIsActiveAdmin = target.role === "admin" && target.is_active;
  if (!targetIsActiveAdmin) return ok;
  if (activeAdminCount > 1) return ok;

  if (change.deactivating) {
    return no(
      "This is the only active admin. Switching it off would leave nobody able " +
      "to manage accounts at all. Make somebody else an admin first.",
    );
  }
  if (change.newRole && change.newRole !== "admin") {
    return no(
      "This is the only active admin. Changing the role would leave nobody able " +
      "to manage accounts at all. Make somebody else an admin first.",
    );
  }
  return ok;
}

/** A tidy email, or a refusal. Not validation theatre -- it is the login. */
export function normaliseEmail(raw: string): { ok: true; email: string } | ({ ok: false } & Refusal) {
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: false, reason: "An email address is required -- it is the login." };
  if (email.length > 254) return { ok: false, reason: "That email address is too long." };
  // Deliberately loose. A regex that tries to be RFC-correct rejects real
  // addresses, and the real check is whether the person can be told their
  // login, which a human is doing anyway.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: `"${raw.trim()}" does not look like an email address.` };
  }
  return { ok: true, email };
}

/* ---------------------------------------------------------------------------
 * Changing your own password.
 *
 * Added 15 September, with the self-service change screen. Pure, like
 * everything else here, so the rules can be asserted rather than believed.
 *
 * WHAT IS DELIBERATELY NOT REQUIRED
 *
 * No "must contain a capital, a number and a symbol". Those rules are why
 * people write passwords on the back of the delivery sheet: they push
 * everyone towards Bakery1! and they make a phone keyboard a fight at 4am.
 * Length is what actually helps, so length is what is asked for and nothing
 * else is.
 *
 * WHAT IS REQUIRED, AND WHY EACH ONE
 *
 *   * TEN CHARACTERS. Long enough to matter, short enough to type in a van.
 *   * NOT THE ONE YOU ALREADY HAVE. Otherwise the screen says "changed" and
 *     nothing changed, which is the worst possible answer for somebody who
 *     changed it because they thought somebody else knew it.
 *   * NOT YOUR OWN EMAIL NAME. ankit@... choosing "ankit12345" is the single
 *     most guessable thing available, and the person guessing already has
 *     the list of addresses.
 *   * NO SPACE AT EITHER END. Not prudishness -- a trailing space survives a
 *     copy and paste and then cannot be typed back reliably, and the person
 *     is locked out of an account they just set the password on.
 * --------------------------------------------------------------------------- */

/** Ten. Named rather than inlined, because the message quotes it. */
export const MIN_PASSWORD = 10;

export function checkNewPassword(input: {
  next: string;
  confirm: string;
  current: string;
  email: string;
}): Decision {
  const { next, confirm, current, email } = input;

  if (!current) return no("Type the password you use now, so we know it is you.");
  if (!next) return no("Type the new password.");

  if (next !== next.trim()) {
    return no(
      "That starts or ends with a space. It would survive a copy and paste and " +
      "then be impossible to type back, so it is refused rather than locking you out.",
    );
  }
  if (next.length < MIN_PASSWORD) {
    return no(
      `A password needs at least ${MIN_PASSWORD} characters. There are no rules about ` +
      `capitals or symbols — length is the part that helps.`,
    );
  }
  if (next === current) {
    return no("That is the password you already have. Pick a different one.");
  }
  if (next !== confirm) {
    return no("The two new passwords do not match.");
  }

  const local = String(email ?? "").split("@")[0].toLowerCase();
  if (local.length >= 3 && next.toLowerCase().includes(local)) {
    return no(
      `That contains "${local}", which is the first half of your own email address. ` +
      `Anybody guessing starts there.`,
    );
  }

  return ok;
}

/* ---------------------------------------------------------------------------
 * Your own name.
 *
 * Added 15 September with the account screen, because proof of delivery is
 * signed with public.users.full_name and the drivers only had first names.
 *
 * ALMOST NOTHING IS REFUSED, ON PURPOSE.
 *
 * Name validation is where software is most confidently wrong about people.
 * No requirement for two words, no alphabet restriction, no rejecting
 * apostrophes or hyphens or spaces in unexpected places. A person's name is
 * whatever they say it is, and the cost of guessing otherwise falls entirely
 * on the people with the least ordinary names.
 *
 * What IS refused is only what breaks the places it gets printed:
 *
 *   * EMPTY. The delivery receipt would be signed by nobody.
 *   * OVER 80 CHARACTERS. Longer than any real name and long enough to break
 *     a printed run sheet.
 *   * LINE BREAKS AND CONTROL CHARACTERS. A newline in a name corrupts every
 *     layout it lands in, and one of them is the evidence a retailer sees.
 *
 * A single word is ALLOWED and merely noted. It is the case this was built
 * for -- and some people genuinely have one name, so it is a hint and never a
 * refusal.
 * --------------------------------------------------------------------------- */

export const MAX_NAME = 80;

export function checkName(raw: string): Decision {
  const name = String(raw ?? "").trim();

  if (!name) return no("Type the name you want on your deliveries.");
  if (name.length > MAX_NAME) {
    return no(`That is longer than ${MAX_NAME} characters — it would not fit on a run sheet.`);
  }
  // The Unicode control category, and NOT a range written as escape
  // sequences, because those escapes were interpreted on the way into the
  // file -- so the code that refuses control characters contained three of
  // them, and so did the migration beside it, where Postgres lost the IF
  // and asked for a missing THEN. 15 September.
  if (/\p{Cc}/u.test(name)) {
    return no("A name cannot contain line breaks. Paste it as one line.");
  }
  return ok;
}

/**
 * Not a rule -- a nudge, shown beside the field.
 *
 * Returns a sentence when the name is a single word, because that is the exact
 * thing this exists to fix, and nothing at all otherwise. It never blocks:
 * mononyms are real and refusing one would be the mistake this file is at
 * pains not to make.
 */
export function nameHint(raw: string): string | null {
  const name = String(raw ?? "").trim();
  if (!name || /\s/.test(name)) return null;
  return (
    "Just the one word. That is fine if it is your whole name — but if you have " +
    "a surname, this is what a store sees when they query a delivery."
  );
}


