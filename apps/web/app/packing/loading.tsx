import Skeleton from "@/components/Skeleton";

// /packing was one of three pages with no loading state, and it is the
// slowest page in the app -- 4.7s warm and 9.8s cold, measured 1 Sept.
// So clicking Packing in the sidebar did nothing visible for several
// seconds and read as a dead click. Tommy on the call: "the left-hand
// panel is not clicking well sometimes."
//
// This does not make it faster. It makes it obvious the click landed.
export default function Loading() {
  return <Skeleton variant="board" />;
}
