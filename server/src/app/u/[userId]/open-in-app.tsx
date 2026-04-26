'use client';

const APP_STORE_URL = 'https://prismer.cloud'; // TODO: replace with real App Store URL

export function OpenInAppButton({ customSchemeUrl }: { customSchemeUrl: string }) {
  function handleClick() {
    const timeout = setTimeout(() => {
      window.location.href = APP_STORE_URL;
    }, 2000);

    window.addEventListener('blur', () => clearTimeout(timeout), { once: true });
    window.location.href = customSchemeUrl;
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="block w-full rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 py-3 text-sm font-bold text-white shadow-lg shadow-violet-500/20 hover:shadow-violet-500/30 transition-shadow"
    >
      Open in Lumin
    </button>
  );
}
