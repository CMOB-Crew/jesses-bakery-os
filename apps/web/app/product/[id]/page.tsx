import Link from "next/link";
import { notFound } from "next/navigation";
import { getProductById, getProductStores } from "@/lib/queries";
import ProductProfile from "@/components/ProductProfile";

export const dynamic = "force-dynamic";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [product, stores] = await Promise.all([getProductById(id), getProductStores(id)]);
  if (!product) notFound();
  return (
    <>
      <div className="crumbs">
        <Link href="/products">Products</Link> › {product.name}
      </div>
      <ProductProfile product={product} stores={stores} />
    </>
  );
}
