import { withUser } from "@/lib/db";
import Link from "next/link";
import NotFoundPanel from "@/components/NotFoundPanel";
import { getProductById, getProductStores } from "@/lib/queries";
import ProductProfile from "@/components/ProductProfile";

export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

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
