import { getProducts } from "@/lib/queries";
import ProductsList from "@/components/ProductsList";

export const metadata = { title: "Products · Jesse's Bakery OS" };
// Render per request: this aggregates the whole plan ledger (heavy), and the
// New-product-launch form should reflect immediately. Keeps it off the flaky
// build-time prerender path, like the other data pages.
export const dynamic = "force-dynamic";

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
