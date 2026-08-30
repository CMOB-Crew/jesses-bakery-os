import Link from "next/link";

// The "there is nothing here" panel, used two ways.
//
// 1. app/not-found.tsx renders it for an unmatched route, where Next's
//    not-found boundary works properly: 404, fully rendered.
//
// 2. The three dynamic pages render it DIRECTLY instead of calling notFound().
//    From a force-dynamic route that boundary does not render -- the content
//    reaches the RSC payload and the page comes out blank with a 200. Returning
//    the panel as ordinary page output cannot fail that way.
//
// One component so the two paths cannot drift apart.
export default function NotFoundPanel({
  heading = "Nothing lives at that address",
  body = "The page you followed a link to is not here. It may have been archived, or the link may be out of date.",
  primaryHref = "/stores",
  primaryLabel = "All stores",
}: {
  heading?: string;
  body?: string;
  primaryHref?: string;
  primaryLabel?: string;
}) {
  return (
    <>
      <div className="head">
        <h1>Not found</h1>
        <div className="meta">that page is not here</div>
      </div>
      <div className="panel" style={{ maxWidth: 560 }}>
        <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>{heading}</div>
        <div style={{ color: "var(--ink2)", lineHeight: 1.6, marginBottom: 16 }}>{body}</div>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <Link prefetch={false} href={primaryHref} className="loginbtn primary linkbtn">
            {primaryLabel}
          </Link>
          <Link prefetch={false} href="/" className="loginback">Overview</Link>
        </div>
      </div>
    </>
  );
}
