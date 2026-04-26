import Link from 'next/link';
import { Clock, Rocket, MessageSquare, Dna, BookOpen, Fingerprint, Upload, Radio, Briefcase } from 'lucide-react';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  rocket: Rocket,
  message: MessageSquare,
  dna: Dna,
  book: BookOpen,
  fingerprint: Fingerprint,
  upload: Upload,
  radio: Radio,
  briefcase: Briefcase,
};

interface Props {
  title: string;
  description: string;
  estimatedTime: string;
  icon: string;
  href: string;
}

export function CookbookCard({ title, description, estimatedTime, icon, href }: Props) {
  const Icon = ICONS[icon] ?? BookOpen;
  return (
    <Link
      href={href}
      className="group block rounded-2xl border border-zinc-200 dark:border-white/10 bg-zinc-50 dark:bg-zinc-900/30 p-5 transition-all hover:border-violet-500/30 hover:bg-violet-500/5"
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-violet-500/10">
          <Icon className="w-5 h-5 text-violet-600 dark:text-violet-400" />
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Clock className="w-3 h-3" />
          {estimatedTime}
        </div>
      </div>
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-white mb-1 group-hover:text-violet-600 dark:group-hover:text-violet-300 transition-colors">
        {title}
      </h3>
      <p className="text-xs text-zinc-500 line-clamp-2">{description}</p>
    </Link>
  );
}
