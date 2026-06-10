/**
 * @vitest-environment jsdom
 *
 * release201 v2.0.8 F-bug follow-up — Simple mode auto-create main project.
 *
 * Spec recap (see CLAUDE.md release201/20 §F-bug + use-simple-provisioning
 * `ensureSimpleModeProject` docstring):
 *
 *   - Simple mode = "one click, sensible defaults". The wizard MUST create a
 *     default "{org} 主项目" automatically on launch — no mid-flow bouncing
 *     out to ProjectSwitcher.
 *   - Guard: if the user already has an active project sentinel that's a real
 *     id (not 'all' / '__unscoped'), the helper is a no-op. This keeps
 *     re-entry safe.
 *   - Best-effort: failure (network / 409 / etc.) logs `console.warn` but does
 *     NOT throw — downstream device step's `readActiveProjectFromStorage`
 *     still works (falls back to sentinel → workspace-level scope).
 *
 *   - UnifiedCreationModal: in Simple mode + unscoped state, show the
 *     "将自动创建主项目" hint instead of the "先创建项目 →" inline link
 *     (which is reserved for Pro mode's explicit-config UX).
 */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureSimpleModeProject } from '../use-simple-provisioning';
import {
  activeProjectStorageKey,
  PROJECT_FILTER_ALL,
  PROJECT_FILTER_UNSCOPED,
  writeActiveProjectToStorage,
  type ProjectDTO,
} from '../../../lib/projects-api';
import type { FetchResult } from '../../../lib/im-api';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = 'cmp_test_workspace';
const ORG_NAME = 'Acme Corp';

function mkProject(id: string): ProjectDTO {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    slug: 'main',
    name: `${ORG_NAME} 主项目`,
    description: '自动创建于 Simple mode 引导流程',
    status: 'active',
    ownerUserId: 'u_test',
    metadata: { createdBy: 'simple-mode-bootstrap' },
    createdAt: '2026-05-28T00:00:00Z',
    updatedAt: '2026-05-28T00:00:00Z',
    archivedAt: null,
  };
}

function okResult<T>(data: T): FetchResult<T> {
  return { ok: true, data };
}

function errResult(status: number, message: string): FetchResult<never> {
  return { ok: false, status, error: 'HTTP_' + status, message } as FetchResult<never>;
}

describe('release201 v2.0.8 F-bug — Simple mode auto-create main project (ensureSimpleModeProject)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('creates a default "{org} 主项目" when no active project sentinel is set', async () => {
    const createProjectMock = vi.fn().mockResolvedValue(okResult(mkProject('p_main_1')));
    const controller = new AbortController();

    await ensureSimpleModeProject(WORKSPACE_ID, ORG_NAME, controller.signal, createProjectMock);

    expect(createProjectMock).toHaveBeenCalledTimes(1);
    const callArg = createProjectMock.mock.calls[0][0];
    expect(callArg.workspaceId).toBe(WORKSPACE_ID);
    expect(callArg.slug).toBe('main');
    expect(callArg.name).toContain(ORG_NAME);
    expect(callArg.name).toContain('主项目');
    expect(callArg.metadata).toEqual({ createdBy: 'simple-mode-bootstrap' });

    // Active project written to localStorage so the device step downstream
    // sees the new id (not the 'all' / '__unscoped' sentinels).
    expect(window.localStorage.getItem(activeProjectStorageKey(WORKSPACE_ID))).toBe('p_main_1');
  });

  it('falls back to "主项目" when organizationName is empty/whitespace', async () => {
    const createProjectMock = vi.fn().mockResolvedValue(okResult(mkProject('p_main_2')));
    const controller = new AbortController();

    await ensureSimpleModeProject(WORKSPACE_ID, '   ', controller.signal, createProjectMock);

    expect(createProjectMock).toHaveBeenCalledTimes(1);
    expect(createProjectMock.mock.calls[0][0].name).toBe('主项目');
  });

  it('skips creation when active project storage already holds a real project id', async () => {
    writeActiveProjectToStorage(WORKSPACE_ID, 'p_existing_user_choice');
    const createProjectMock = vi.fn();
    const controller = new AbortController();

    await ensureSimpleModeProject(WORKSPACE_ID, ORG_NAME, controller.signal, createProjectMock);

    expect(createProjectMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(activeProjectStorageKey(WORKSPACE_ID))).toBe('p_existing_user_choice');
  });

  it("treats 'all' sentinel as unscoped and creates a project", async () => {
    writeActiveProjectToStorage(WORKSPACE_ID, PROJECT_FILTER_ALL);
    const createProjectMock = vi.fn().mockResolvedValue(okResult(mkProject('p_main_3')));
    const controller = new AbortController();

    await ensureSimpleModeProject(WORKSPACE_ID, ORG_NAME, controller.signal, createProjectMock);

    expect(createProjectMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(activeProjectStorageKey(WORKSPACE_ID))).toBe('p_main_3');
  });

  it("treats '__unscoped' sentinel as unscoped and creates a project", async () => {
    writeActiveProjectToStorage(WORKSPACE_ID, PROJECT_FILTER_UNSCOPED);
    const createProjectMock = vi.fn().mockResolvedValue(okResult(mkProject('p_main_4')));
    const controller = new AbortController();

    await ensureSimpleModeProject(WORKSPACE_ID, ORG_NAME, controller.signal, createProjectMock);

    expect(createProjectMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(activeProjectStorageKey(WORKSPACE_ID))).toBe('p_main_4');
  });

  it('does NOT throw when /projects POST fails (best-effort; downstream still works)', async () => {
    const createProjectMock = vi.fn().mockResolvedValue(errResult(409, 'slug already taken'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();

    await expect(
      ensureSimpleModeProject(WORKSPACE_ID, ORG_NAME, controller.signal, createProjectMock),
    ).resolves.toBeUndefined();

    expect(createProjectMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    // Storage NOT touched on failure — sentinel path keeps device step
    // landing at workspace-level scope.
    expect(window.localStorage.getItem(activeProjectStorageKey(WORKSPACE_ID))).toBeNull();
  });

  it('does NOT throw when createProject promise rejects (network error)', async () => {
    const createProjectMock = vi.fn().mockRejectedValue(new Error('Network down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();

    await expect(
      ensureSimpleModeProject(WORKSPACE_ID, ORG_NAME, controller.signal, createProjectMock),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    expect(window.localStorage.getItem(activeProjectStorageKey(WORKSPACE_ID))).toBeNull();
  });

  it('swallows AbortError silently (signal aborted between call and resolve)', async () => {
    const createProjectMock = vi.fn().mockRejectedValue(Object.assign(new DOMException('Aborted', 'AbortError')));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();

    await expect(
      ensureSimpleModeProject(WORKSPACE_ID, ORG_NAME, controller.signal, createProjectMock),
    ).resolves.toBeUndefined();

    // No noisy warn for AbortError — cancel path is normal flow.
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// UnifiedCreationModal project-context strip — mode-aware copy
// ─────────────────────────────────────────────────────────────────────

import { UnifiedCreationModal } from '../UnifiedCreationModal';
import { I18nProvider } from '@/contexts/i18n-context';

// Modal imports a lot of stuff we don't exercise here (Hermes adapters,
// templates, etc.) — they're side-effect-free at module level.
// We DO need to neutralize the imFetch network probes so the modal doesn't
// barf in jsdom (no fetch).
vi.mock('../../../lib/im-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/im-api')>();
  return {
    ...actual,
    imFetch: vi.fn().mockResolvedValue({ ok: false, status: 0, error: 'STUB', message: 'stub' }),
    imFetchWithMeta: vi.fn().mockResolvedValue({ ok: false, status: 0, error: 'STUB', message: 'stub' }),
  };
});

describe('release201 v2.0.8 F-bug — UnifiedCreationModal project-context strip is mode-aware', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  function findContextStrip(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="unified-creation-project-context"]');
  }

  it("Simple mode + unscoped → shows 'auto-create' hint, no inline create link", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <UnifiedCreationModal
            open={true}
            onOpenChange={() => {}}
            isDark={false}
            workspaceId={WORKSPACE_ID}
            agents={[]}
            profiles={[]}
            onCreated={() => {}}
            initialMode="simple"
            activeProjectId={null}
            activeProjectName={null}
            onCreateProject={() => {}}
          />
        </I18nProvider>,
      );
    });

    const strip = findContextStrip();
    expect(strip).not.toBeNull();
    expect(strip!.getAttribute('data-project-scope')).toBe('workspace');
    expect(strip!.getAttribute('data-mode')).toBe('simple');

    // 'auto-create' hint present.
    const autoHint = document.querySelector('[data-testid="unified-creation-project-context-simple-auto"]');
    expect(autoHint).not.toBeNull();

    // 'inline create' link absent.
    const inlineCta = document.querySelector('[data-testid="unified-creation-project-context-create"]');
    expect(inlineCta).toBeNull();
  });

  it("Pro mode + unscoped → keeps inline 'create project' link", () => {
    act(() => {
      root.render(
        <I18nProvider>
          <UnifiedCreationModal
            open={true}
            onOpenChange={() => {}}
            isDark={false}
            workspaceId={WORKSPACE_ID}
            agents={[]}
            profiles={[]}
            onCreated={() => {}}
            initialMode="pro"
            activeProjectId={null}
            activeProjectName={null}
            onCreateProject={() => {}}
          />
        </I18nProvider>,
      );
    });

    const strip = findContextStrip();
    expect(strip).not.toBeNull();
    expect(strip!.getAttribute('data-project-scope')).toBe('workspace');
    expect(strip!.getAttribute('data-mode')).toBe('pro');

    const inlineCta = document.querySelector('[data-testid="unified-creation-project-context-create"]');
    expect(inlineCta).not.toBeNull();

    const autoHint = document.querySelector('[data-testid="unified-creation-project-context-simple-auto"]');
    expect(autoHint).toBeNull();
  });

  it('Simple mode + scoped (real project id) → shows scoped copy, no auto-hint, no inline link', () => {
    act(() => {
      root.render(
        <I18nProvider>
          <UnifiedCreationModal
            open={true}
            onOpenChange={() => {}}
            isDark={false}
            workspaceId={WORKSPACE_ID}
            agents={[]}
            profiles={[]}
            onCreated={() => {}}
            initialMode="simple"
            activeProjectId="p_real_project"
            activeProjectName="Real Project"
            onCreateProject={() => {}}
          />
        </I18nProvider>,
      );
    });

    const strip = findContextStrip();
    expect(strip).not.toBeNull();
    expect(strip!.getAttribute('data-project-scope')).toBe('project');

    const autoHint = document.querySelector('[data-testid="unified-creation-project-context-simple-auto"]');
    expect(autoHint).toBeNull();
    const inlineCta = document.querySelector('[data-testid="unified-creation-project-context-create"]');
    expect(inlineCta).toBeNull();
  });
});
