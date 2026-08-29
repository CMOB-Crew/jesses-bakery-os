/** Where sign-in may send someone once they are authenticated.
 *
 * It has to be a path on THIS site. The check this replaces was
 *
 *     next.startsWith("/")
 *
 * which lets "//evil.com" through: that is a protocol-relative URL and a
 * browser resolves it to https://evil.com. A crafted link of the form
 * /login?next=//evil.com therefore sent the user off-site the instant they
 * signed in successfully, from a page they had every reason to trust.
 *
 * A backslash is the same trick -- browsers normalise "/\evil.com" to
 * "//evil.com" -- and control characters are refused outright rather than
 * reasoned about, since they belong in neither a path nor a Location header.
 *
 * A query string is fine and deliberately allowed: "/packing?day=2026-09-03"
 * is exactly what the proxy now hands over so a deep link survives login.
 *
 * One copy, imported everywhere. This bug existed because the same rule was
 * written out three times and only ever checked once.
 */
export function safeNext(next: string | undefined | null): string {
  const HOME = "/";
  if (!next) return HOME;
  if (next[0] !== "/") return HOME;
  if (next[1] === "/" || next[1] === "\\") return HOME;
  // Control characters belong in neither a path nor a Location header.
  // Checked by codepoint rather than a regex escape, so there is no
  // backslash here for a shell or a heredoc to eat.
  for (let i = 0; i < next.length; i++) {
    const c = next.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return HOME;
  }
  return next;
}
