// Built-in agent role templates. Used by m3 CLI `prismer profile create --from-template <name>`.
// See docs/refactor/11-multi-agent-collab.md §四.
//
// release201/07 S24 — register `skill-author` as the 5th built-in role for the
// authoring engine (skill-authoring built-in skill + 3 supporting skills).
// agentType=specialist, baseSkillSet=prismer-base. Spawned by Studio
// Authoring's "+ New draft" entry to drive the draft pipeline.

import productManager from './roles/product-manager.json' with { type: 'json' };
import engineer from './roles/engineer.json' with { type: 'json' };
import ceo from './roles/ceo.json' with { type: 'json' };
import researcher from './roles/researcher.json' with { type: 'json' };
import skillAuthor from './roles/skill-author.json' with { type: 'json' };

export interface RoleTemplate {
  templateName: string;
  displayName: string;
  description: string;
  applicableAdapters: string[];
  configSchema: Record<string, unknown>;
}

export const BUILTIN_ROLE_TEMPLATES: ReadonlyArray<RoleTemplate> = Object.freeze([
  productManager as RoleTemplate,
  engineer as RoleTemplate,
  ceo as RoleTemplate,
  researcher as RoleTemplate,
  skillAuthor as RoleTemplate,
]);

export function getRoleTemplate(name: string): RoleTemplate | undefined {
  return BUILTIN_ROLE_TEMPLATES.find((t) => t.templateName === name);
}

export function listRoleTemplates(): ReadonlyArray<{ name: string; displayName: string; description: string }> {
  return BUILTIN_ROLE_TEMPLATES.map((t) => ({
    name: t.templateName,
    displayName: t.displayName,
    description: t.description,
  }));
}
