import Link from "next/link";
import { updatePassword } from "../actions";
import SubmitButton from "../SubmitButton";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// "Set a new password" — step two. Reached from the emailed link, which lands on
// /auth/callback first; that route exchanges the one-time code for a session, so
// by the time anyone gets here they are authenticated and updateUser() works.
//
// Opening this page cold is the interesting case: there is no session, so the
// form would fail with a Supabase error the user cannot act on. Check up front
// and say something useful instead.
export const dynamic = "force-dynamic";

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error;

  const supabase = await createSupabaseServerClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  const signedIn = Boolean(data?.user);

  return (
    <div className="loginwrap">
      <div className="logincard">
        <div className="loginbrand">
          <span className="dot" />
          Jesse&apos;s Bakery
        </div>

        {!signedIn ? (
          <>
            <h1>That link has expired</h1>
            <p className="sub">
              Reset links work once and last an hour. Ask for a fresh one and it&apos;ll
              take a few seconds.
            </p>
            <Link href="/login/forgot" className="loginbtn primary linkbtn">
              Send a new link
            </Link>
            <div className="loginor"><span></span></div>
            <Link href="/login" className="loginback">← Back to sign in</Link>
          </>
        ) : (
          <>
            <h1>Set a new password</h1>
            <p className="sub">
              Signed in as {data?.user?.email}. Choose something you haven&apos;t used
              here before.
            </p>

            {error && <div className="loginerr">{error}</div>}

            <form action={updatePassword} className="loginform">
              <label>
                New password
                <input
                  type="password"
                  name="password"
                  autoComplete="new-password"
                  minLength={10}
                  required
                  placeholder="At least 10 characters"
                />
              </label>
              <label>
                Confirm password
                <input
                  type="password"
                  name="confirm"
                  autoComplete="new-password"
                  minLength={10}
                  required
                  placeholder="Type it again"
                />
              </label>
              <SubmitButton className="loginbtn primary" pendingText="Saving…">
                Save new password
              </SubmitButton>
            </form>
          </>
        )}
      </div>

      <style>{`
        .loginwrap{position:fixed;inset:0;z-index:100;display:flex;align-items:center;
          justify-content:center;background:var(--bg,#faf6ee);padding:24px}
        .logincard{width:100%;max-width:380px;background:var(--card,#fff);
          border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh-pop);
          padding:34px 32px}
        .loginbrand{display:flex;align-items:center;gap:9px;font-family:var(--serif);
          font-size:17px;font-weight:600;color:var(--ink);margin-bottom:22px}
        .loginbrand .dot{width:11px;height:11px;border-radius:3px;background:var(--amber)}
        .logincard h1{font-family:var(--serif);font-size:24px;font-weight:600;
          letter-spacing:-.3px;color:var(--ink);margin:0 0 4px}
        .logincard .sub{font-size:13.5px;color:var(--muted);margin:0 0 20px}
        .loginerr{background:var(--red-b);color:var(--red-t);border:1px solid var(--red);
          border-radius:var(--rc);padding:9px 12px;font-size:13px;margin-bottom:16px}
        .loginform{display:flex;flex-direction:column;gap:14px}
        .loginform label{display:flex;flex-direction:column;gap:6px;font-size:12.5px;
          font-weight:600;color:var(--ink2)}
        .loginform input{font:inherit;font-size:14px;font-weight:400;color:var(--ink);
          padding:10px 12px;border:1px solid var(--line);border-radius:var(--rc);
          background:#fff;outline:none}
        .loginform input:focus{border-color:var(--amber)}
        .loginbtn{width:100%;font:inherit;font-size:14px;font-weight:600;cursor:pointer;
          padding:11px 14px;border-radius:var(--rc);border:1px solid transparent}
        .loginbtn.primary{background:var(--ink);color:#fff;margin-top:4px}
        .loginbtn[disabled]{opacity:.75;cursor:progress}
        .linkbtn{display:block;text-align:center;text-decoration:none}
        .loginbtn-loading{display:inline-flex;align-items:center;justify-content:center;gap:8px}
        .loginspin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;
          border-top-color:transparent;display:inline-block;animation:loginspin .6s linear infinite}
        @keyframes loginspin{to{transform:rotate(360deg)}}
        .loginor{display:flex;align-items:center;text-align:center;color:var(--faint);
          font-size:12px;margin:16px 0}
        .loginor::before,.loginor::after{content:"";flex:1;height:1px;background:var(--line)}
        .loginor span{padding:0 12px}
        .loginback{display:inline-block;font-size:13px;font-weight:600;color:var(--ink2);
          text-decoration:none}
        .loginback:hover{color:var(--ink)}
      `}</style>
    </div>
  );
}
