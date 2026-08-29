import Link from "next/link";

// Reached by any notFound() in the app -- today that is /store/[id] with an id
// that does not resolve.
//
// Before this file existed, that returned the sidebar, an empty main and no
// message at all: 51KB of shell with nothing in it. A stale bookmark or an old
// link looked like the system was broken rather than like the store was gone,
// which is a bad thing to hand somebody in their first week.
export default function NotFound() {
  return (
    <>
      <div className="head">
        <h1>Not found</h1>
        <div className="meta">that page is not here</div>
      </div>
      <div className="panel" style={{ maxWidth: 560 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>
          Nothing lives at that address
        </div>
        <div style={{ color: "var(--ink2)", lineHeight: 1.6, marginBottom: 16 }}>
          The store or page you followed a link to is not here. It may have been
          archived, or the link may be out of date.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link prefetch={false} href="/stores" className="loginbtn primary linkbtn">
            All stores
          </Link>
          <Link prefetch={false} href="/" className="loginback">
            Overview
          </Link>
        </div>
      </div>
    </>
  );
}
