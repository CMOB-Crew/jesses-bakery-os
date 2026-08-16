import { getArchivedStores } from "@/lib/queries";
import StoreArchive from "@/components/StoreArchive";

export const metadata = { title: "Archive · Jesse's Bakery OS" };
export const revalidate = 120;

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
