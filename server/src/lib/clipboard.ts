'use client';

export interface CopyTextResult {
  ok: boolean;
  error?: string;
}

export async function copyText(text: string): Promise<CopyTextResult> {
  if (!text) return { ok: false, error: 'Nothing to copy' };

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true };
    } catch {
      // Fall through to the textarea fallback below. Edge / permission-denied /
      // non-secure contexts can reject even when navigator.clipboard exists.
    }
  }

  if (typeof document === 'undefined') {
    return { ok: false, error: 'Clipboard is not available in this environment' };
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const ok = document.execCommand('copy');
    return ok ? { ok: true } : { ok: false, error: 'Copy command was rejected' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Copy failed' };
  } finally {
    document.body.removeChild(textarea);
  }
}
