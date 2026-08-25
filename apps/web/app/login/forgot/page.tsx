import Link from "next/link";
import { requestPasswordReset } from "../actions";
import SubmitButton from "../SubmitButton";

// "Forgot password" — step one of two. Sends the reset email, then says the same
// thing whether or not the address is registered (see the note in actions.ts).
export const dynamic = "force-dynamic";

export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const sp = await searchParams;
  const sent = sp.sent === "1";

  return (
    <div className="loginwrap">
      <div className="logincard">
        <div className="loginbrand">
          <span className="dot" />
          Jesse&apos;s Bakery
        </div>

        {sent ? (
          <>
            <h1>Check your email</h1>
            <p className="sub">
              If that address has an account, a reset link is on its way. It works once
              and lasts an hour.
            </p>
            <p className="loginfoot">
              Nothing arrived? Check the junk folder, then try again — or ask whoever set
              up your account.
            </p>
            <div className="loginor"><span></span></div>
            <Link href="/login" className="loginback">← Back to sign in</Link>
          </>
        ) : (
          <>
            <h1>Reset your password</h1>
            <p className="sub">
              Enter the email you sign in with and we&apos;ll send you a link to set a new
              password.
            </p>
            <form action={requestPasswordReset} className="loginform">
              <label>
                Email
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  placeholder="you@jessesbakery.com.au"
                />
              </label>
              <SubmitButton className="loginbtn primary" pendingText="Sending…">
                Send reset link
              </SubmitButton>
            </form>
            <div className="loginor"><span>or</span></div>
            <Link href="/login" className="loginback">← Back to sign in</Link>
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
        .loginbtn-loading{display:inline-flex;align-items:center;justify-content:center;gap:8px}
        .loginspin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;
          border-top-color:transparent;display:inline-block;animation:loginspin .6s linear infinite}
        @keyframes loginspin{to{transform:rotate(360deg)}}
        .loginor{display:flex;align-items:center;text-align:center;color:var(--faint);
          font-size:12px;margin:16px 0}
        .loginor::before,.loginor::after{content:"";flex:1;height:1px;background:var(--line)}
        .loginor span{padding:0 12px}
        .loginfoot{font-size:12px;color:var(--faint);margin:14px 0 0;line-height:1.5}
        .loginback{display:inline-block;font-size:13px;font-weight:600;color:var(--ink2);
          text-decoration:none}
        .loginback:hover{color:var(--ink)}
      `}</style>
    </div>
  );
}
