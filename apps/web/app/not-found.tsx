import NotFoundPanel from "@/components/NotFoundPanel";

// Next's not-found boundary. VERIFIED working for an UNMATCHED route on the
// live site: /definitely-not-a-real-page returns 404 and renders this.
//
// It does NOT render when notFound() is called from a force-dynamic dynamic
// route -- there the content lands in the RSC payload and the page comes out
// blank. Those three pages render NotFoundPanel directly instead.
export default function NotFound() {
  return <NotFoundPanel />;
}
