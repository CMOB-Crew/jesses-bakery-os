import NewStoreSetup from "@/components/NewStoreSetup";

export const metadata = { title: "New store · Jesse's Bakery OS" };

export default function NewStorePage() {
  return (
    <>
      <div className="head">
        <h1>New store setup</h1>
        <div className="meta">Enter once, set the ceiling, let it fill</div>
      </div>
      <NewStoreSetup />
    </>
  );
}
