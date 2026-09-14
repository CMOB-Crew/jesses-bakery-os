-- Migration 101: a drop with no photograph was invisible.
--
-- WHAT WAS WRONG
--
-- Friday's commit d6b922c stopped a drawn placeholder being filed as proof of
-- delivery. That was right, and it left a gap behind it: a driver who cannot
-- photograph a drop now correctly records nothing, and NOTHING COUNTS THE
-- NOTHING.
--
-- The weekly audit inspects rows that exist. It answers "is every recorded
-- proof still there", in both directions, and it answers it well. It has never
-- been able to answer "which deliveries have no proof at all", because a
-- delivery with no photograph has no delivery_photos row to inspect.
--
-- So eleven drops on a Tuesday with no photograph produce a clean audit. The
-- only person who ever knew was the driver who saw the message.
--
-- WHY THIS NEEDS A SECURITY DEFINER FUNCTION AND NOT A QUERY
--
-- This is the trap the proof audit already documents, and it is worse here.
--
-- delivery_photos has row-level security, enabled and forced since migration
-- 014, and current_app_role() reads auth.uid(). A scheduled call has no
-- session, so every policy is false and the table returns NO ROWS rather than
-- an error.
--
-- A plain "deliveries with no matching delivery_photos row" would therefore
-- match EVERY DELIVERY. Not a silent all-clear this time -- a silent
-- all-alarm, every delivery reported as having no proof, every week, until
-- somebody stopped reading it. Which is the same failure wearing the opposite
-- coat.
--
-- Migration 094 solved the same problem for storage.objects by wrapping it in
-- a definer function scoped to one bucket. This is that pattern.
--
-- search_path is pinned. A security-definer function without one is the
-- classic Postgres privilege-escalation hole: the caller sets search_path,
-- the function runs as the owner, and a shadowed table name is all it takes.
--
-- Additive. No existing table, policy, function or row is touched.

create or replace function public.jb_deliveries_without_proof(p_days integer)
returns table (
  delivery_id   text,
  delivery_date text,
  store_id      text,
  store_name    text,
  status        text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select d.id::text,
         to_char(d.delivery_date, 'YYYY-MM-DD'),
         d.store_id::text,
         s.name,
         d.status::text
    from deliveries d
    left join stores s on s.id = d.store_id
   where d.status = 'delivered'
     and d.delivery_date >= (current_date - make_interval(days => p_days))::date
     -- A delivery from before photo capture existed can never be covered, and
     -- reporting the 799 seeded August rows every week would bury the ones
     -- that matter. When no photograph exists at all this is a no-op, which is
     -- correct: then every delivered drop genuinely has no proof.
     and d.delivery_date >= coalesce(
           (select min((p2.captured_at at time zone 'UTC')::date) from delivery_photos p2),
           d.delivery_date)
     and not exists (
           select 1 from delivery_photos p where p.delivery_id = d.id)
   order by d.delivery_date desc, s.name
$$;

comment on function public.jb_deliveries_without_proof(integer) is
  'Deliveries marked delivered in the last N days that have no delivery_photos row at all. Exists because delivery_photos has forced RLS and a scheduled call has no session, so a plain not-exists query would match every delivery and report a silent all-alarm. Security definer with a pinned search_path; returns no photograph, no signer and no GPS, only which drops are uncovered. Migration 101, 14 September.';

-- The denominator, for the same reason and with the same protection. A count
-- of uncovered drops means nothing without how many there were.
create or replace function public.jb_delivered_in_window(p_days integer)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(*)::integer
    from deliveries d
   where d.status = 'delivered'
     and d.delivery_date >= (current_date - make_interval(days => p_days))::date
     and d.delivery_date >= coalesce(
           (select min((p2.captured_at at time zone 'UTC')::date) from delivery_photos p2),
           d.delivery_date)
$$;

comment on function public.jb_delivered_in_window(integer) is
  'How many deliveries were marked delivered in the same window jb_deliveries_without_proof uses, so a count of uncovered drops has a denominator. Migration 101, 14 September.';

revoke all on function public.jb_deliveries_without_proof(integer) from public;
revoke all on function public.jb_delivered_in_window(integer) from public;
grant execute on function public.jb_deliveries_without_proof(integer) to public;
grant execute on function public.jb_delivered_in_window(integer) to public;
