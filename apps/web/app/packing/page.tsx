import PackingApp from "@/components/PackingApp";

export const metadata = { title: "Packing · Jesse's Bakery OS" };

export default function PackingPage() {
  return (
    <>
      <div className="head"><h1>Packing app</h1><div className="meta">iPad prototype · tick off each store, flag any discrepancy</div></div>
      <PackingApp />
    </>
  );
}
