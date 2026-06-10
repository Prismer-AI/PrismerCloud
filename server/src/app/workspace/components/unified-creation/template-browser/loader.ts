import { imFetch } from '../../../lib/im-api';

import type { RoleTemplateLoader } from './types';

export const defaultRoleTemplateLoader: RoleTemplateLoader = async (signal) => {
  const res = await imFetch<unknown[]>('/role-templates', { signal });
  if (!res.ok) {
    throw new Error(res.message || 'Failed to load role templates');
  }
  return Array.isArray(res.data) ? res.data : [];
};
