import { signInWithPassword, signInWithMicrosoft } from "./actions";

// Sign-in screen. Self-contained full-viewport layout so it reads as its own
// page rather than sitting inside the app shell/sidebar. Only ever shown once
// AUTH_ENFORCED=1 (the proxy redirects signed-out users here); until then it's
// reachable but nothing sends anyone to it.
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const sp = await searchParams;
  const error = sp.error;
  const next = sp.next && sp.next.startsWith("/") ? sp.next : "/";

  return (
    <div className="loginwrap">
      <div className="logincard">
        <div className="loginbrand">
          <span className="dot" />
          Jesse&apos;s Bakery
        </div>
        <h1>Sign in</h1>
        <p className="sub">Welcome back. Sign in to manage your stores.</p>

        {error && <div className="loginerr">{error}</div>}

        <form action={signInWithPassword} className="loginform">
          <input type="hidden" name="next" value={next} />
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
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              placeholder="••••••••"
            />
          </label>
          <button type="submit" className="loginbtn primary">
            Sign in
          </button>
        </form>

        <div className="loginor"><span>or</span></div>

        <form action={signInWithMicrosoft}>
          <input type="hidden" name="next" value={next} />
          <button type="submit" className="loginbtn ms">
            Continue with Microsoft
          </button>
        </form>

        <p className="loginfoot">
          Access is granted by an admin. If you can sign in but see nothing yet,
          your account is waiting on a role.
        </p>
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
        .loginbtn.ms{background:#fff;color:var(--ink);border-color:var(--line)}
        .loginor{display:flex;align-items:center;text-align:center;color:var(--faint);
          font-size:12px;margin:16px 0}
        .loginor::before,.loginor::after{content:"";flex:1;height:1px;background:var(--line)}
        .loginor span{padding:0 12px}
        .loginfoot{font-size:12px;color:var(--faint);margin:18px 0 0;line-height:1.5}
      `}</style>
    </div>
  );
}
