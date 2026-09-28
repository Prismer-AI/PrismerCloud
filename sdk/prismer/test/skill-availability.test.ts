import { describe, expect, it } from 'vitest';
import { assessSkillAvailability, reconcileSkillDisables } from '../src/daemon/skill-availability.js';

const context = { platform: 'linux', environments: [], disabled: [], hasCommand: () => false, env: {} };
const skill = (yaml: string) => `---\nname: example\ndescription: Example\n${yaml}\n---\nBody`;

describe('effective skill availability', () => {
  it('removes only attributed disables when a dependency or policy is repaired', () => {
    expect(reconcileSkillDisables(['github', 'operator-only'], ['github'], [])).toEqual({
      disabled: ['operator-only'],
      managed: [],
    });
    expect(reconcileSkillDisables(['github'], [], ['github'])).toEqual({ disabled: ['github'], managed: [] });
  });
  it('hides OS and environment mismatches without calling them broken', () => {
    expect(assessSkillAvailability(skill('platforms: [macos]'), context).status).toBe('filtered');
    expect(assessSkillAvailability(skill('platforms: [macos]'), { ...context, platform: 'darwin' }).status).toBe(
      'available',
    );
    expect(assessSkillAvailability(skill('environments: [kanban]'), context).status).toBe('filtered');
  });
  it('does not advertise missing dependencies or unset credentials as available', () => {
    expect(assessSkillAvailability(skill('').replace('name: example', 'name: github'), context).status).toBe('available');
    expect(assessSkillAvailability(skill('prerequisites:\n  commands: [gh]'), context).status).toBe('not-ready');
    expect(assessSkillAvailability(skill('prerequisites:\n  env_vars: [SERVICE_TOKEN]'), context).reasons).toEqual([
      'missing-env:SERVICE_TOKEN',
    ]);
  });
  it('respects explicit disable and internal resources', () => {
    expect(assessSkillAvailability(skill(''), { ...context, disabled: ['example'] }).status).toBe('filtered');
    expect(assessSkillAvailability(skill('metadata:\n  internal: true'), context).status).toBe('filtered');
  });
  it('keeps undeclared user skills and does not treat command presence as authentication', () => {
    expect(assessSkillAvailability(skill(''), context).status).toBe('available');
    const result = assessSkillAvailability(skill('prerequisites:\n  commands: [gh]'), {
      ...context,
      hasCommand: () => true,
    });
    expect(result.status).toBe('available');
    expect(result).not.toHaveProperty('authenticated');
  });
});
