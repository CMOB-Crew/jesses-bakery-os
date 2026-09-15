-- ---------------------------------------------------------------------------
-- 107  NOBODY COULD CHANGE THEIR OWN PASSWORD.
--
-- Migration 105 gave the bakery a People screen, so Simona can hand a driver a
-- password without ringing CMOB. It did not give anybody a way to change their
-- OWN, and that is the other half of the same problem:
--
--   * Every password on this system was chosen by somebody else. A driver's
--     was generated and read out to him; Simona's was typed into Slack on
--     9 September and is still there.
--   * The reset page at /login/reset sends an email through Supabase's shared
--     testing sender -- two an hour, project-wide, and driver and packer
--     addresses have no mailbox behind them at all, so for most of the staff
--     it sends into nothing.
--
-- So a person handed a password could never stop using it. Handing somebody a
-- credential they cannot change is not handing it over.
--
-- WHAT THIS MIGRATION IS
--
-- One line of it: 'password_changed' joins the actions user_admin_events will
-- accept. The screen is application code.
--
-- WHY IT IS ITS OWN ACTION AND NOT A 'password_reset'
--
-- They are different events and a year from now the difference is the whole
-- point of looking. 'password_reset' is somebody acting on somebody else's
-- account. 'password_changed' is a person changing their own, having proved
-- they knew the old one. Folding the second into the first would make the
-- audit trail say Simona reset her own password, which is not what happened
-- and reads like something went wrong.
--
-- Still no password in any column, in any form. The self-change writes actor
-- and target as the same person and nothing else.
--
-- Reversible:
--
--     alter table public.user_admin_events drop constraint user_admin_events_action_check;
--     alter table public.user_admin_events add constraint user_admin_events_action_check
--       check (action in ('created','password_reset','deactivated','reactivated','role_changed'));
-- ---------------------------------------------------------------------------

alter table public.user_admin_events
  drop constraint if exists user_admin_events_action_check;

alter table public.user_admin_events
  add constraint user_admin_events_action_check
  check (action in (
    'created',
    'password_reset',    -- somebody else reset it for them
    'password_changed',  -- they changed their own, having proved the old one
    'deactivated',
    'reactivated',
    'role_changed'
  ));

comment on column public.user_admin_events.action is
  'created, password_reset (somebody acting on another account), password_changed (a person changing their own after proving the old one), deactivated, reactivated, role_changed. password_changed added by migration 107 on 15 September 2026, when self-service password change shipped -- kept distinct from password_reset because who did it to whom is the whole reason anybody reads this table.';

-- ---------------------------------------------------------------------------
-- A self-change writes actor_id = target_id, which the insert policy already
-- allows: its check is actor_id = public.jb_uid(), and for a self-change the
-- person IS the actor. Nothing about the policy needs to move.
--
-- Worth stating rather than leaving to be re-derived: the reason the policy
-- keeps working is the same reason it is worth having. It asserts the author,
-- not the subject.
-- ---------------------------------------------------------------------------
