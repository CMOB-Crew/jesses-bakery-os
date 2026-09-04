/* ---------------------------------------------------------------------------
 * provision-users.mjs — create the floor's accounts without sending an email.
 *
 * WHY THIS EXISTS.
 *
 * AUTH_ENFORCED=1 has been live since 24 August, so nobody without an account
 * can open the app at all. On go-live morning that is every driver and every
 * packer.
 *
 * The normal way in is a Supabase invite email. That is not available: custom
 * SMTP is off on this project, so everything goes through Supabase's shared
 * testing sender at TWO EMAILS PER HOUR, project-wide. Ten staff is five hours
 * of waiting in two-person batches, competing with every password reset, from a
 * noreply@mail.app.supabase.io address that a fair share of clients drop in
 * junk -- and a re-send burns the quota again.
 *
 * So this creates each account with `email_confirm: true` and a generated
 * password, which sends nothing. The person signs in with what you hand them.
 *
 * THIS IS THE FALLBACK, NOT THE FIX. The fix is custom SMTP (see
 * auth-email-setup.md), and it should still be done -- without it, password
 * RESET is stuck on the same two-an-hour limit forever, and the first person to
 * forget their password on a Tuesday morning is stuck behind it. This exists so
 * that Monday does not depend on that landing first.
 *
 * WHAT IT WILL NOT DO.
 *
 *   * It will not put a role on an account that the database would refuse.
 *     Valid roles are admin, manager, office, driver, packer -- and 'packer'
 *     only became valid on 4 September (migration 082); before that the
 *     constraint rejected it and the tempting workaround was to hand a packer
 *     'office', which can UPDATE every store in the network. This refuses
 *     anything outside the list rather than letting that happen at 4am.
 *   * It will not silently re-create somebody. An existing account is left
 *     alone except for its role, which is corrected if wrong. Re-running is
 *     safe and is the intended way to fix a typo'd role.
 *   * It will not print a password for an account it did not create, because it
 *     does not know one.
 *
 * USAGE
 *
 *   node scripts/provision-users.mjs people.csv           # dry run, changes nothing
 *   node scripts/provision-users.mjs people.csv --commit  # actually create
 *
 * people.csv -- header required, order does not matter:
 *
 *   email,role,name
 *   dan@jessesbakery.com.au,driver,Dan Kelly
 *   ana@jessesbakery.com.au,packer,Ana Silva
 *
 * IF THE FLOOR HAS NO EMAIL ADDRESSES. Likely, for casual packers and drivers.
 * Supabase requires one, but nothing is ever SENT to it in this flow, so an
 * address on the bakery's domain that simply routes nowhere is fine --
 * packer1@jessesbakery.com.au and so on. Use something a person can recognise
 * as theirs, because it is what they type to sign in. It does mean that person
 * can never self-serve a password reset, so keep a note of who is in that
 * position; when custom SMTP lands, real addresses can be swapped in.
 *
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from apps/web/.env.local.
 * The service key bypasses RLS entirely, which is why this is a local script
 * and not a route.
 * --------------------------------------------------------------------------- */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const VALID_ROLES = new Set(["admin", "manager", "office", "driver", "packer"]);

// ---------------------------------------------------------------------------
// Env, read from .env.local rather than the shell, so this works the same way
// the app does and there is one place the key lives.
// ---------------------------------------------------------------------------
function loadEnv(path) {
  const out = {};
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    die(`Cannot read ${path}. Run this from apps/web.`);
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// A password somebody has to read off a screen and type on a phone at 4am.
// No l/I/1/O/0, no symbols that move around on a phone keyboard. 4 groups of 4
// from a 30-character alphabet is ~78 bits, which is far beyond anything that
// matters here, and it is legible.
// ---------------------------------------------------------------------------
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
function makePassword() {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) s += "-";
    s += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return s;
}

// ---------------------------------------------------------------------------
// CSV. Deliberately not a library: the file is three columns typed by a person,
// and a dependency for that is not worth it. Quoted fields are supported
// because a name may contain a comma.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (c === "," && !inQuotes) {
        cells.push(cur.trim()); cur = "";
      } else cur += c;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  if (!rows.length) die("The CSV is empty.");
  const header = rows.shift().map((h) => h.toLowerCase());
  for (const need of ["email", "role"]) {
    if (!header.includes(need)) die(`The CSV has no "${need}" column. Header seen: ${header.join(", ")}`);
  }
  return rows.map((cells, i) => {
    const rec = {};
    header.forEach((h, j) => { rec[h] = cells[j] ?? ""; });
    rec._line = i + 2;
    return rec;
  });
}

// ---------------------------------------------------------------------------
// Validate EVERYTHING before creating ANYTHING. Half a floor provisioned and
// then a crash on row seven is a worse place to be than not having started.
// ---------------------------------------------------------------------------
function validate(people) {
  const problems = [];
  const seen = new Set();
  for (const p of people) {
    const email = (p.email || "").toLowerCase();
    const role = (p.role || "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) problems.push(`line ${p._line}: "${p.email}" is not an email address`);
    if (!VALID_ROLES.has(role)) {
      problems.push(
        `line ${p._line}: role "${p.role}" is not one the database will accept. ` +
        `Valid: ${[...VALID_ROLES].join(", ")}. Do NOT substitute 'office' for a floor role -- it can edit every store.`,
      );
    }
    if (seen.has(email)) problems.push(`line ${p._line}: ${email} appears twice`);
    seen.add(email);
    p.email = email;
    p.role = role;
  }
  return problems;
}

// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const csvPath = args.find((a) => !a.startsWith("--"));
  if (!csvPath) die("Usage: node scripts/provision-users.mjs people.csv [--commit]");

  const env = loadEnv(".env.local");
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_KEY;
  if (!url || !key) die("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not found in .env.local.");

  const people = parseCsv(readFileSync(csvPath, "utf8"));
  const problems = validate(people);
  if (problems.length) {
    console.error("\n  Refusing to run. Fix these first:\n");
    for (const p of problems) console.error(`    ${p}`);
    console.error("");
    process.exit(1);
  }

  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Who already exists. listUsers pages at 50 by default; ask for more and
  // page anyway rather than assuming the floor is small.
  const existing = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) die(`Could not list existing users: ${error.message}`);
    for (const u of data.users) existing.set((u.email || "").toLowerCase(), u);
    if (data.users.length < 200) break;
  }

  console.log(`\n  ${people.length} in the file, ${existing.size} accounts already exist.`);
  console.log(commit ? "  COMMITTING.\n" : "  DRY RUN — nothing will be changed. Add --commit to do it.\n");

  const created = [];
  const rolefixed = [];
  const untouched = [];

  for (const p of people) {
    const already = existing.get(p.email);

    if (already) {
      // Only the role is corrected. Never re-create, never reset a password
      // somebody may already be using.
      if (commit) {
        const { error } = await sb.from("users").update({ role: p.role, is_active: true }).eq("id", already.id);
        if (error) die(`${p.email}: could not set role — ${error.message}`);
      }
      const { data: row } = await sb.from("users").select("role").eq("id", already.id).maybeSingle();
      if (row?.role === p.role) untouched.push(p);
      else rolefixed.push({ ...p, was: row?.role ?? "(none)" });
      continue;
    }

    if (!commit) { created.push({ ...p, password: "(generated on commit)" }); continue; }

    const password = makePassword();
    const { data, error } = await sb.auth.admin.createUser({
      email: p.email,
      password,
      email_confirm: true, // the whole point: no email is sent
      user_metadata: p.name ? { full_name: p.name } : undefined,
    });
    if (error) die(`${p.email}: could not create — ${error.message}`);

    // handle_new_user() (migration 012) inserts the public.users row with a
    // NULL role. Set the real one. If this errored the account would exist and
    // see nothing, which is the failure mode 082 was about, so it is fatal.
    const { error: rerr } = await sb
      .from("users")
      .update({ role: p.role, full_name: p.name || null, is_active: true })
      .eq("id", data.user.id);
    if (rerr) die(`${p.email}: account created but role NOT set — ${rerr.message}\n  Fix this before anyone tries to sign in.`);

    created.push({ ...p, password });
  }

  // -------------------------------------------------------------------------
  const pad = (s, n) => String(s).padEnd(n);
  if (created.length) {
    console.log("  CREATED — hand these over in person, they are shown once:\n");
    console.log(`    ${pad("email", 38)} ${pad("role", 9)} password`);
    console.log(`    ${"-".repeat(38)} ${"-".repeat(9)} ${"-".repeat(19)}`);
    for (const c of created) console.log(`    ${pad(c.email, 38)} ${pad(c.role, 9)} ${c.password}`);
    console.log("");
  }
  if (rolefixed.length) {
    console.log("  ROLE CORRECTED on an account that already existed:\n");
    for (const r of rolefixed) console.log(`    ${pad(r.email, 38)} ${r.was}  ->  ${r.role}`);
    console.log("");
  }
  if (untouched.length) {
    console.log(`  ALREADY CORRECT, left alone: ${untouched.map((u) => u.email).join(", ")}\n`);
  }

  if (commit) {
    console.log("  Check every one of them can sign in BEFORE the RLS flip, while");
    console.log("  the policies are still dormant. That separates 'the password is");
    console.log("  wrong' from 'the policies are wrong', and you do not want to be");
    console.log("  telling those two apart at 4am.\n");
  }
}

main().catch((e) => die(e?.message ?? String(e)));
