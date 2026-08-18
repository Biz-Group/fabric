/**
 * Copy text, with a fallback for contexts where the async Clipboard API is
 * unavailable.
 *
 * `navigator.clipboard` only exists in a secure context, so it is silently
 * missing over plain HTTP on a LAN address or an internal host — a copy button
 * that only calls it appears to work and quietly does nothing. The textarea +
 * `execCommand` path still works there.
 *
 * Returns whether the text actually reached the clipboard, so callers can
 * report a failure rather than showing a confirmation that isn't true.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback for local HTTP/dev contexts.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
