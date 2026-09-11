// Put one driver licence photograph into storage, from the phone.
//
// Same three steps as lib/driver-proof.ts, and it reuses that file's blob and
// checksum helpers rather than copying them:
//   1. ask the server for a one-time upload URL for THIS day
//   2. PUT the bytes straight to storage -- they never pass through Netlify,
//      which refuses a body over 4.5 MiB before the function even runs
//   3. tell the server the object exists, with its checksum
//
// NOTHING HERE IS ALLOWED TO STOP A SHIFT STARTING. Every failure returns a
// reason and the driver goes to work regardless. The gate already cost a driver
// thirty seconds a morning for a record that was never kept; making it also
// able to strand somebody in a car park at 4am would be a worse bug than the
// one this fixes.

import { dataUrlToBlob, sha256Hex } from "@/lib/driver-proof";

export type LicenceUpload =
  | { ok: true; path: string; sha256: string }
  | { ok: false; error: string };

export async function uploadLicence(
  dataUrl: string,
  meta: { day: string },
): Promise<LicenceUpload> {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return { ok: false, error: "That photo could not be read, so it was not kept." };

  const sha256 = await sha256Hex(blob);
  if (!sha256) {
    return {
      ok: false,
      error: "This browser cannot checksum the photo, so the licence was not kept. Your shift still starts.",
    };
  }

  let mint: Response;
  try {
    mint = await fetch("/api/driver/licence/upload-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(meta),
    });
  } catch {
    return { ok: false, error: "No signal, so the licence was not kept. Your shift still starts." };
  }

  const minted = (await mint.json().catch(() => null)) as
    | { ok?: boolean; path?: string; signedUrl?: string; error?: string }
    | null;
  if (!mint.ok || !minted?.ok || !minted.path || !minted.signedUrl) {
    return { ok: false, error: minted?.error ?? "Could not start the upload. Your shift still starts." };
  }

  try {
    const put = await fetch(minted.signedUrl, {
      method: "PUT",
      headers: { "content-type": blob.type || "image/jpeg" },
      body: blob,
    });
    if (!put.ok) return { ok: false, error: "The licence photo did not upload. Your shift still starts." };
  } catch {
    return { ok: false, error: "No signal, so the licence was not kept. Your shift still starts." };
  }

  return { ok: true, path: minted.path, sha256 };
}
