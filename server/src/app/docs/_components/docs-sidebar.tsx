'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight, BookOpen, Code2 } from 'lucide-react';
import type { Locale } from '../_lib/i18n';
import type { CookbookMeta } from '../_lib/cookbook-loader';
import type { EndpointGroup } from '../_lib/openapi-loader';

interface SidebarEndpoint {
  slug: string;
  method: string;
  path: string;
}

interface Props {
  locale: Locale;
  cookbooks: CookbookMeta[];
  groups: EndpointGroup[];
  groupNames: Record<string, string>;
  endpointsByGroup: Record<string, SidebarEndpoint[]>;
  mode: 'cookbook' | 'api';
}

export function DocsSidebar({ locale, cookbooks, groups, groupNames, endpointsByGroup, mode }: Props) {
  const pathname = usePathname();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <nav className="hidden md:flex md:flex-col w-64 shrink-0 m-4 mr-0 rounded-2xl border border-zinc-200 dark:border-white/10 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl shadow-lg overflow-y-auto p-4 space-y-1 sticky top-20 max-h-[calc(100vh-6rem)]">
      {mode === 'cookbook' && (
        <>
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-wider text-zinc-500">
            <BookOpen className="w-3.5 h-3.5" />
            Cookbooks
          </div>
          {cookbooks.map((cb) => {
            const href = `/docs/${locale}/cookbook/${cb.slug}`;
            const active = pathname === href;
            return (
              <Link
                key={cb.slug}
                href={href}
                className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                  active
                    ? 'bg-violet-500/10 text-violet-700 dark:text-white font-medium'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/5'
                }`}
              >
                {cb.title}
              </Link>
            );
          })}
        </>
      )}
      {mode === 'api' && (
        <>
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-wider text-zinc-500">
            <Code2 className="w-3.5 h-3.5" />
            API Reference
          </div>
          {groups.map((group) => {
            const href = `/docs/${locale}/api/${group.id}`;
            const active = pathname.startsWith(href);
            return (
              <div key={group.id}>
                <button
                  onClick={() => toggleGroup(group.id)}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                    active
                      ? 'bg-zinc-100 dark:bg-white/5 text-zinc-900 dark:text-white'
                      : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-white/5'
                  }`}
                >
                  <span>{groupNames[group.id] ?? group.id}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-600">{group.endpointCount}</span>
                    <ChevronRight
                      className={`w-3 h-3 transition-transform ${expandedGroups.has(group.id) ? 'rotate-90' : ''}`}
                    />
                  </div>
                </button>
                {expandedGroups.has(group.id) && (
                  <div className="ml-4 space-y-0.5">
                    {(endpointsByGroup[group.id] ?? []).map((ep) => {
                      const epHref = `/docs/${locale}/api/${group.id}/${ep.slug}`;
                      const isActive = pathname === epHref;
                      return (
                        <Link
                          key={ep.slug}
                          href={epHref}
                          className={`block px-3 py-1 rounded text-xs font-mono truncate transition-colors ${
                            isActive
                              ? 'text-violet-600 dark:text-violet-400 bg-violet-500/10'
                              : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                          }`}
                        >
                          <span
                            className={`mr-1.5 ${ep.method === 'POST' ? 'text-emerald-500' : ep.method === 'DELETE' ? 'text-red-500' : 'text-blue-500'}`}
                          >
                            {ep.method}
                          </span>
                          {ep.path.replace('/api/', '')}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </nav>
  );
}
