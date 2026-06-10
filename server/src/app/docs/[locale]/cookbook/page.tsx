import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { ArrowRight, BookOpen, Boxes, Code2, FileCode2, RadioTower, ShieldCheck, Users } from 'lucide-react';
import { DocsSidebar } from '../../_components/docs-sidebar';
import { LocaleSwitcher } from '../../_components/locale-switcher';
import { isValidLocale, getMessages, LOCALES, type Locale } from '../../_lib/i18n';
import { listCookbooks } from '../../_lib/cookbook-loader';
import { getEndpointSlug, getEndpointsByGroup, loadSpec } from '../../_lib/openapi-loader';

const COPY = {
  en: {
    title: 'Cookbook Index',
    description:
      'v2.0 implementation guides organized around workspace, skills, channels, sandbox, and role templates.',
    concepts: 'v2.0 cookbook concepts',
    apiEntrypoints: 'SDK and runtime API entrypoints',
    existingGuides: 'Existing guides',
    open: 'Open',
    viewApi: 'View API',
    cards: [
      {
        title: 'Workspace onboarding',
        description: 'Create a shared workspace, invite agents and humans, and route work into the default channels.',
        href: 'workspace',
        icon: Users,
        status: 'Available',
        apis: ['workspace', 'messaging'],
      },
      {
        title: 'Skill lifecycle',
        description: 'Discover, install, sync, and inject built-in or workspace skills for an agent runtime.',
        href: 'skill-marketplace',
        icon: Boxes,
        status: 'Available',
        apis: ['skills', 'evolution'],
      },
      {
        title: 'Channel fanout',
        description:
          'Bring external conversations into IM, preserve routing, and hand agent mentions to daemon dispatch.',
        href: 'realtime',
        icon: RadioTower,
        status: 'Concept path',
        apis: ['realtime', 'agent-protocol'],
      },
      {
        title: 'Sandbox pipeline',
        description:
          'Run task work in an isolated provider, register outputs as assets, and return previews to workspace.',
        href: 'file-upload',
        icon: ShieldCheck,
        status: 'Concept path',
        apis: ['tasks', 'files'],
      },
      {
        title: 'Role template onboarding',
        description:
          'Start from a curated role template, attach skill references, and bind the agent to runtime execution.',
        href: 'identity-aip',
        icon: BookOpen,
        status: 'Concept path',
        apis: ['identity-aip', 'workspace'],
      },
    ],
    entrypoints: [
      ['TypeScript SDK', 'workspace.* / evolution.skills.*', '/docs/en/api/workspace'],
      ['Runtime dispatch', 'AgentDispatchRequest / ReplyPayload', '/docs/en/api/agent-protocol'],
      ['External channel APIs', 'realtime events and IM fanout', '/docs/en/api/realtime'],
      ['Asset and task APIs', 'workspace tasks with previewable outputs', '/docs/en/api/files'],
    ],
  },
  zh: {
    title: 'Cookbook 索引',
    description: '围绕 workspace、skill、channel、sandbox、role template 组织的 v2.0 实施指南入口。',
    concepts: 'v2.0 cookbook 概念',
    apiEntrypoints: 'SDK 与 runtime API 入口',
    existingGuides: '现有指南',
    open: '打开',
    viewApi: '查看 API',
    cards: [
      {
        title: 'Workspace onboarding',
        description: '创建协作工作区，邀请 agent 与成员，并把任务路由到默认频道。',
        href: 'workspace',
        icon: Users,
        status: '已有指南',
        apis: ['workspace', 'messaging'],
      },
      {
        title: 'Skill lifecycle',
        description: '发现、安装、同步 built-in 或 workspace skill，并注入 agent runtime。',
        href: 'skill-marketplace',
        icon: Boxes,
        status: '已有指南',
        apis: ['skills', 'evolution'],
      },
      {
        title: 'Channel fanout',
        description: '外部会话进入 IM，保留路由，并把 @Agent 交给 daemon dispatch。',
        href: 'realtime',
        icon: RadioTower,
        status: '概念入口',
        apis: ['realtime', 'agent-protocol'],
      },
      {
        title: 'Sandbox pipeline',
        description: '在隔离 provider 中执行任务，将输出注册为 asset，并回传 workspace 预览。',
        href: 'file-upload',
        icon: ShieldCheck,
        status: '概念入口',
        apis: ['tasks', 'files'],
      },
      {
        title: 'Role template onboarding',
        description: '从精选 role template 创建 agent，附加 skillRefs，并绑定 runtime 执行。',
        href: 'identity-aip',
        icon: BookOpen,
        status: '概念入口',
        apis: ['identity-aip', 'workspace'],
      },
    ],
    entrypoints: [
      ['TypeScript SDK', 'workspace.* / evolution.skills.*', '/docs/zh/api/workspace'],
      ['Runtime dispatch', 'AgentDispatchRequest / ReplyPayload', '/docs/zh/api/agent-protocol'],
      ['External channel APIs', 'realtime events and IM fanout', '/docs/zh/api/realtime'],
      ['Asset and task APIs', 'workspace tasks with previewable outputs', '/docs/zh/api/files'],
    ],
  },
} as const;

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale: loc } = await params;
  const locale = isValidLocale(loc) ? (loc as Locale) : 'en';
  const copy = COPY[locale];
  return {
    title: `${copy.title} - Prismer Cloud Docs`,
    description: copy.description,
  };
}

export default async function CookbookIndexPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: loc } = await params;
  if (!isValidLocale(loc)) notFound();
  const locale = loc as Locale;
  const copy = COPY[locale];
  const cookbooks = listCookbooks(locale);
  const spec = loadSpec();
  const msgs = getMessages(locale);

  const endpointsByGroup: Record<string, { slug: string; method: string; path: string }[]> = {};
  for (const group of spec.groups) {
    endpointsByGroup[group.id] = getEndpointsByGroup(group.id).map((ep) => ({
      slug: getEndpointSlug(ep),
      method: ep.method,
      path: ep.path,
    }));
  }

  return (
    <div className="flex min-h-screen bg-white text-zinc-900 dark:bg-zinc-950 dark:text-white">
      <DocsSidebar
        locale={locale}
        cookbooks={cookbooks}
        groups={spec.groups}
        groupNames={Object.fromEntries(
          spec.groups.map((g) => [g.id, (msgs.groups as Record<string, string>)[g.id] ?? g.id]),
        )}
        endpointsByGroup={endpointsByGroup}
        mode="cookbook"
      />
      <main className="flex-1 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                <Link href={`/docs/${locale}`} className="hover:text-violet-500">
                  Docs
                </Link>
                <span>/</span>
                <span>Cookbook</span>
              </div>
              <h1 className="text-2xl font-semibold">{copy.title}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">{copy.description}</p>
            </div>
            <LocaleSwitcher current={locale} />
          </div>

          <section className="mb-10">
            <h2 className="mb-4 text-sm font-semibold uppercase text-zinc-500">{copy.concepts}</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {copy.cards.map((card) => {
                const Icon = card.icon;
                return (
                  <div
                    key={card.title}
                    className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-white/10 dark:bg-zinc-900"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-white dark:bg-zinc-950">
                          <Icon className="h-5 w-5 text-violet-500" />
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold">{card.title}</h3>
                          <div className="mt-1 text-xs text-zinc-500">{card.status}</div>
                        </div>
                      </div>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{card.description}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link
                        href={`/docs/${locale}/cookbook/${card.href}`}
                        className="inline-flex items-center gap-1.5 rounded-md bg-zinc-950 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-zinc-950"
                      >
                        {copy.open}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                      {card.apis.map((api) => (
                        <Link
                          key={api}
                          href={`/docs/${locale}/api/${api}`}
                          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 hover:text-zinc-950 dark:border-white/10 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:text-white"
                        >
                          <Code2 className="h-3.5 w-3.5" />
                          {api}
                        </Link>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mb-10">
            <h2 className="mb-4 text-sm font-semibold uppercase text-zinc-500">{copy.apiEntrypoints}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {copy.entrypoints.map(([title, detail, href]) => (
                <Link
                  key={title}
                  href={href}
                  className="rounded-lg border border-zinc-200 p-4 transition-colors hover:border-violet-500/40 hover:bg-violet-500/5 dark:border-white/10"
                >
                  <FileCode2 className="h-5 w-5 text-emerald-500" />
                  <div className="mt-4 text-sm font-semibold">{title}</div>
                  <div className="mt-2 font-mono text-xs leading-5 text-zinc-500">{detail}</div>
                </Link>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-4 text-sm font-semibold uppercase text-zinc-500">{copy.existingGuides}</h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {cookbooks.map((cookbook) => (
                <Link
                  key={cookbook.slug}
                  href={`/docs/${locale}/cookbook/${cookbook.slug}`}
                  className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-sm transition-colors hover:bg-zinc-50 dark:border-white/10 dark:hover:bg-white/5"
                >
                  <span className="truncate">{cookbook.title}</span>
                  <ArrowRight className="ml-3 h-4 w-4 shrink-0 text-zinc-400" />
                </Link>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
