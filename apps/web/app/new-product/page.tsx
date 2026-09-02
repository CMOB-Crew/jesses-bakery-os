import { withUser } from "@/lib/db";
import NewProductSetup from "@/components/NewProductSetup";
import { getStorePicklist, getProductCodes } from "@/lib/queries";

export const metadata = { title: "New product · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. See the
// note in app/new-store/page.tsx: without this every page ran on a default
// nobody chose, and cold renders were landing at 8.6–10.7 seconds.
export const maxDuration = 60;

export default async function NewProductPage() {
  const [stores, products] = await withUser(() =>
    Promise.all([getStorePicklist(), getProductCodes()])
  );
  return (
    <>
      <div className="head">
        <h1>New product</h1>
        <div className="meta">Name it, size the tray, give it the article numbers that make the sales feed find it</div>
      </div>
      <NewProductSetup stores={stores} products={products} />
    </>
  );
}
