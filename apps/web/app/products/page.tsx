import { getProducts } from "@/lib/queries";
import ProductsList from "@/components/ProductsList";

export const metadata = { title: "Products · Jesse's Bakery OS" };
export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

export default async function ProductsPage() {
  const products = await getProducts();
  return (
    <>
      <div className="head">
        <h1>Products</h1>
        <div className="meta">{products.length} lines · delivered vs sold, waste and engine move per product</div>
      </div>
      <ProductsList products={products} />
    </>
  );
}
