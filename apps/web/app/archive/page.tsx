import StoreArchive from "@/components/StoreArchive";

export const metadata = { title: "Archive · Jesse's Bakery OS" };

export default function ArchivePage() {
  return (
    <>
      <div className="head">
        <h1>Archive</h1>
        <div className="meta">Inactive stores, kept warm</div>
      </div>
      <StoreArchive />
    </>
  );
}
