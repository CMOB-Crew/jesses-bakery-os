import { getArchivedStores } from "@/lib/queries";
import StoreArchive from "@/components/StoreArchive";

export const metadata = { title: "Archive · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

export default async function ArchivePage() {
  const stores = await getArchivedStores();
  return (
    <>
      <div className="head">
        <h1>Archive</h1>
        <div className="meta">Inactive stores, kept warm</div>
      </div>
      <StoreArchive stores={stores} />
    </>
  );
}
