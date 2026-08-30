import { withUser } from "@/lib/db";
import Link from "next/link";
import NotFoundPanel from "@/components/NotFoundPanel";
import { getProductById, getProductStores } from "@/lib/queries";
import ProductProfile from "@/components/ProductProfile";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [product, stores] = await withUser(() =>
    Promise.all([getProductById(id), getProductStores(id)])
  );
  if (!product) {
    return (
      <NotFoundPanel
        heading="That product is not here"
        body="It may have been retired, or the link may be out of date."
        primaryHref="/products"
        primaryLabel="All products"
      />
    );
  }
  return (
    <>
      <div className="crumbs">
        <Link prefetch={false} href="/products">Products</Link> › {product.name}
      </div>
      <ProductProfile product={product} stores={stores} />
    </>
  );
}
