// Put one piece of proof of delivery into storage, from the phone.
//
// Three steps, in this order, and the order is the point:
//   1. ask the server for a one-time upload URL for THIS store, day and kind
//   2. PUT the bytes straight to storage -- they never pass through Netlify,
//      which refuses a body over 4.5 MiB before the function even runs
//   3. tell the server the object exists, with its checksum
//
// Nothing here is allowed to stop a delivery being recorded. Every failure
// returns a reason; the caller marks the drop either way. A driver standing in a
// loading dock with one bar of signal must never be blocked from saying "I
// delivered this" because a 3MB photo would not go.

export type ProofUpload =
  | { ok: true; path: string; sha256: string }
  | { ok: false; error: string };

function dataUrlToBlob(dataUrl: string): Blob | null {
  const m = /^data:([^;,]+)(;base64)?,/.exec(dataUrl);
  if (!m) return null;
  const type = m[1];
  const body = dataUrl.slice(m[0].length);
  try {
    if (m[2]) {
      const bin = atob(body);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type });
    }
    return new Blob([decodeURIComponent(body)], { type });
  } catch {
    return null;
  }
}

async function sha256Hex(blob: Blob): Promise<string | null> {
  // crypto.subtle is https-only. On a plain-http preview it is simply absent,
  // and a missing checksum should degrade rather than throw -- but the server
  // requires one, so this is reported honestly instead of faked.
  if (!globalThis.crypto?.subtle) return null;
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function uploadProof(
  dataUrl: string,
  meta: { storeId: string; day: string; kind: "photo" | "signature" },
): Promise<ProofUpload> {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return { ok: false, error: "That image could not be read." };

  const sha256 = await sha256Hex(blob);
  if (!sha256) {
    return {
      ok: false,
      error: "This browser cannot checksum the image, so it was not stored. The delivery is still recorded.",
    };
  }

  let mint: Response;
  try {
    mint = await fetch("/api/driver/proof/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(meta),
    });
  } catch {
    return { ok: false, error: "No signal. The delivery is recorded; the image is not." };
  }

  const minted = (await mint.json().catch(() => null)) as
    | { ok?: boolean; path?: string; signedUrl?: string; error?: string }
    | null;
  if (!mint.ok || !minted?.ok || !minted.path || !minted.signedUrl) {
    return { ok: false, error: minted?.error ?? "Could not start the upload." };
  }

  try {
    const put = await fetch(minted.signedUrl, {
      method: "PUT",
      headers: { "content-type": blob.type || "image/jpeg" },
      body: blob,
    });
    if (!put.ok) return { ok: false, error: "The image did not upload. The delivery is recorded." };
  } catch {
    return { ok: false, error: "No signal. The delivery is recorded; the image is not." };
  }

  return { ok: true, path: minted.path, sha256 };
}
