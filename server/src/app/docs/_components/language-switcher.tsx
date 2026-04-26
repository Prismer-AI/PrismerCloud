'use client';

export type DocLanguage = 'typescript' | 'python' | 'go' | 'bash';

const LANGUAGES: { id: DocLanguage; label: string }[] = [
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'go', label: 'Go' },
  { id: 'bash', label: 'REST' },
];

interface Props {
  active: DocLanguage;
  onChange: (lang: DocLanguage) => void;
  isDark: boolean;
}

export function LanguageSwitcher({ active, onChange, isDark }: Props) {
  return (
    <div className={`flex gap-1 p-1 rounded-lg ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}`}>
      {LANGUAGES.map((lang) => (
        <button
          key={lang.id}
          onClick={() => onChange(lang.id)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            active === lang.id
              ? isDark
                ? 'bg-zinc-700 text-white'
                : 'bg-white text-zinc-900 shadow-sm'
              : isDark
                ? 'text-zinc-400 hover:text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-700'
          }`}
        >
          {lang.label}
        </button>
      ))}
    </div>
  );
}
