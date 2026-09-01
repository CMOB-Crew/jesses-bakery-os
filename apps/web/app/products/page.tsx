import { getProducts } from "@/lib/queries";
import ProductsList from "@/components/ProductsList";

export const metadata = { title: "Products · Jesse's Bakery OS" };
// Render per request: this aggregates the whole plan ledger (heavy), and the
// New-product-launch form should reflect immediately. Keeps it off the flaky
// build-time prerender path, like the other data pages.
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

export default async function ProductsPage() {
  const products = await getProducts();
  return (
    <>
      <div className="head">
        <h1>Products</h1>
        <div className="meta">{products.length} planned lines · delivered vs sold, waste and difference per product</div>
      </div>
      <ProductsList products={products} />
    </>
  );
}
