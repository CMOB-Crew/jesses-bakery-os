import "server-only";
import { randomBytes } from "node:crypto";
import WORDS from "@/lib/password-words.json";

/* ---------------------------------------------------------------------------
 * Generating a password for somebody else.
 *
 * THE SAME RULES AS scripts/provision-users.mjs, AND FROM THE SAME WORD LIST.
 *
 * That script has minted every account on this system since 7 September and its
 * reasoning is sound, so none of it is being re-decided here. What changed on
 * 15 September is only WHO can run it: it needed a terminal and the service
 * role key, so account management was a CMOB job, and a system whose passwords
 * only CMOB can reset has not really been handed over.
 *
 * The word list now lives in lib/password-words.json and both read it, because
 * two copies of 512 words drift and nobody notices until the day somebody
 * checks why two passwords from "the same system" look different.
 *
 * THE TWO SHAPES, AND WHY THERE ARE TWO
 *
 *   BDriver47!            drivers and packers
 *   hill-vault-forest-88  everyone else
 *
 * The floor shape is weaker and that is a deliberate, bounded trade. A driver
 * is handed a password verbally, at 4am, and has to type it into a phone with
 * one hand. Three random words is the wrong tool for that job, and a password
 * nobody can type gets written on the van dashboard, which is worse than a
 * hundred possibilities. The blast radius is one driver account, which can see
 * exactly one screen and its own run.
 *
 * Everyone else -- admin, manager, office, and any role added later -- gets
 * three words from 512 plus two digits. That is 512^3 * 100, about 1.3e10.
 *
 * ROLE DECIDES THE SHAPE, BY OPT-IN. A role that is not named in MEMORABLE_BASE
 * gets the strong shape. So a role added next year is safe by default rather
 * than weak by accident, which is the right way for that mistake to fall.
 * --------------------------------------------------------------------------- */

/** Roles that get the memorable shape, and the base each one gets. */
const MEMORABLE_BASE: Record<string, string> = { driver: "BDriver", packer: "BPacker" };

/**
 * Two digits, rejection-sampled.
 *
 * 256 is not a multiple of 100, so a bare modulo would make 00-55 slightly
 * likelier than 56-99. It matters more than it sounds for the floor shape,
 * where the two digits are the entire secret.
 */
function twoDigits(): string {
  let n: number;
  do {
    n = randomBytes(1)[0];
  } while (n >= 200);
  return String(n % 100).padStart(2, "0");
}

function memorablePassword(base: string): string {
  return `${base}${twoDigits()}!`;
}

function wordPassword(): string {
  // The unbiased-modulo argument below depends on the list being exactly 512.
  // If somebody edits it, they find out here rather than in a subtle skew
  // nobody ever measures.
  if (WORDS.length !== 512) {
    throw new Error(`The word list must be exactly 512 entries, it has ${WORDS.length}.`);
  }
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const b = randomBytes(2);
    parts.push(WORDS[((b[0] << 8) | b[1]) % 512]);
  }
  parts.push(twoDigits());
  return parts.join("-");
}

/**
 * A new password for somebody in this role.
 *
 * Returned, never logged and never stored. The caller shows it once, to the
 * person who pressed the button, and the system then has no way to tell anyone
 * what it was -- which is the property that makes handing this to the bakery
 * safe rather than merely convenient.
 */
export function makePassword(role: string | null | undefined): string {
  const base = MEMORABLE_BASE[String(role ?? "")];
  return base ? memorablePassword(base) : wordPassword();
}

/** Exposed for the assertions in scripts/people-check.ts, and nothing else. */
export const MEMORABLE_ROLES = Object.keys(MEMORABLE_BASE);
