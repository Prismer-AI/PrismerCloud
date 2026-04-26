import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Locale } from './i18n';

// ─── Types ──────────────────────────────────────────────────────

export interface CodeSample {
  lang: string;
  label: string;
  source: string;
}

export interface Parameter {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description: string;
  default?: unknown;
  enum?: string[];
}

export interface NamedExample {
  name: string;
  value: unknown;
}

export interface EventDef {
  event: string;
  description?: string;
}

export interface InputMode {
  name: string;
  description?: string;
  input: string;
}

export interface ProcessedEndpoint {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  group: string; // domain group ID (e.g., 'messaging', 'evolution')
  tag: string;
  protocol?: 'websocket' | 'sse' | 'webhook';
  modes?: InputMode[];
  parameters?: Parameter[];
  bodyFields?: Parameter[];
  exampleRequests?: NamedExample[];
  exampleResponses?: NamedExample[];
  codeSamples?: CodeSample[];
  events?: { send?: EventDef[]; receive?: EventDef[] };
  cost?: string;
  rateLimit?: string;
}

export interface EndpointGroup {
  id: string;
  endpointCount: number;
}

export interface LoadedSpec {
  info: { title: string; version: string; description: string };
  groups: EndpointGroup[];
  endpoints: ProcessedEndpoint[];
  raw: Record<string, unknown>;
}

// ─── Group Mappings ─────────────────────────────────────────────

const PHASE_TO_GROUP: Record<number, string> = {
  1: 'identity-auth',
  2: 'messaging',
  3: 'groups',
  4: 'conversations',
  5: 'agent-protocol',
  6: 'workspace',
  7: 'social',
  8: 'billing',
  9: 'realtime',
  10: 'tasks',
  11: 'memory-recall',
  12: 'identity-aip',
  13: 'memory-recall',
  14: 'community',
  15: 'contact',
};

const SECTION_TO_GROUP: Record<string, string> = {
  context: 'context',
  parse: 'parse',
  evolution: 'evolution',
  skills: 'skills',
  files: 'files',
  webhook: 'realtime',
  realtime: 'realtime',
};

const GROUP_ORDER: string[] = [
  'context',
  'parse',
  'identity-auth',
  'messaging',
  'groups',
  'conversations',
  'agent-protocol',
  'workspace',
  'evolution',
  'skills',
  'memory-recall',
  'tasks',
  'identity-aip',
  'community',
  'contact',
  'files',
  'realtime',
  'billing',
  'social',
];

// ─── Module-level Cache ─────────────────────────────────────────

let cachedSpec: LoadedSpec | null = null;

// ─── Schema Helpers ─────────────────────────────────────────────

/**
 * Resolve $ref in schemas (one level deep — sufficient for our spec)
 */
function resolveSchema(
  doc: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!schema) return undefined;

  const ref = schema['$ref'] as string | undefined;
  if (ref) {
    // e.g. "#/components/schemas/ContextLoadRequest"
    const parts = ref.replace('#/', '').split('/');
    let resolved: unknown = doc;
    for (const part of parts) {
      resolved = (resolved as Record<string, unknown>)?.[part];
    }
    if (resolved === undefined) {
      console.warn(`[openapi-loader] Could not resolve $ref: ${ref}`);
    }
    return resolved as Record<string, unknown> | undefined;
  }

  // oneOf — return the first option's resolved schema
  if (schema.oneOf) {
    const options = schema.oneOf as Record<string, unknown>[];
    return resolveSchema(doc, options[0]);
  }

  return schema;
}

/** Format a schema type for display (e.g., "string[]", "string | string[]") */
function formatFieldType(schema: Record<string, unknown>): string {
  if (schema.oneOf) {
    const options = schema.oneOf as Record<string, unknown>[];
    return options.map((o) => formatFieldType(o)).join(' | ');
  }
  const type = (schema.type as string) || 'any';
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    const itemType = items ? formatFieldType(items) : 'any';
    return `${itemType}[]`;
  }
  return type;
}

/**
 * Recursively flatten an OpenAPI schema into a flat Parameter[] list.
 * Nested object properties use dot-notation names (e.g., "search.topK").
 * Max depth of 3 to prevent infinite recursion.
 */
function flattenSchemaToFields(
  doc: Record<string, unknown>,
  schema: Record<string, unknown>,
  out: Parameter[],
  prefix: string,
  parentRequired: boolean,
  depth: number = 0,
): void {
  if (depth > 3) return;

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return;

  const requiredList = (schema.required as string[]) || [];

  for (const [name, prop] of Object.entries(properties)) {
    const resolved = resolveSchema(doc, prop) || prop;
    const fieldName = prefix ? `${prefix}.${name}` : name;
    const isRequired = parentRequired ? false : requiredList.includes(name);
    const fieldType = resolved.type as string | undefined;

    out.push({
      name: fieldName,
      in: 'body',
      required: isRequired,
      type: formatFieldType(resolved),
      description: (resolved.description as string) || '',
      default: resolved.default,
      enum: resolved.enum as string[] | undefined,
    });

    // Recurse into nested objects
    if (fieldType === 'object' && resolved.properties) {
      flattenSchemaToFields(doc, resolved, out, fieldName, false, depth + 1);
    }

    // Handle array items with object schemas
    if (fieldType === 'array' && resolved.items) {
      const itemSchema = resolveSchema(doc, resolved.items as Record<string, unknown>);
      if (itemSchema?.properties) {
        flattenSchemaToFields(doc, itemSchema, out, `${fieldName}[]`, false, depth + 1);
      }
    }
  }
}

// ─── Loader ─────────────────────────────────────────────────────

export function loadSpec(): LoadedSpec {
  if (cachedSpec && process.env.NODE_ENV !== 'development') return cachedSpec;

  const yamlPath = join(process.cwd(), 'docs', 'openapi.yaml');

  let rawContent: string;
  try {
    rawContent = readFileSync(yamlPath, 'utf-8');
  } catch (err) {
    throw new Error(`[openapi-loader] Failed to read ${yamlPath}: ${err instanceof Error ? err.message : err}`);
  }

  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(rawContent) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`[openapi-loader] Failed to parse YAML: ${err instanceof Error ? err.message : err}`);
  }

  // Build tag → group mapping from x-phase-number and x-doc-section
  const tagToGroup = new Map<string, string>();

  for (const tag of (doc.tags as Record<string, unknown>[]) || []) {
    const tagName = tag.name as string;
    const phaseNumber = tag['x-phase-number'] as number | undefined;
    const docSection = tag['x-doc-section'] as string | undefined;

    let group: string;
    if (phaseNumber !== undefined && PHASE_TO_GROUP[phaseNumber]) {
      group = PHASE_TO_GROUP[phaseNumber];
    } else if (docSection && SECTION_TO_GROUP[docSection]) {
      group = SECTION_TO_GROUP[docSection];
    } else if (docSection) {
      group = docSection;
    } else {
      group = tagName.toLowerCase();
    }

    tagToGroup.set(tagName, group);
  }

  // Process all paths → flat endpoint list
  const endpoints: ProcessedEndpoint[] = [];

  for (const [path, methods] of Object.entries((doc.paths as Record<string, unknown>) || {})) {
    for (const [method, op] of Object.entries(methods as Record<string, Record<string, unknown>>)) {
      if (!op.operationId) continue;

      const tag = ((op.tags as string[]) || [])[0] || '';
      const group = tagToGroup.get(tag) || 'other';

      // Extract URL/query parameters
      const parameters: Parameter[] = [];
      for (const p of (op.parameters as Record<string, unknown>[]) || []) {
        const schema = (p.schema as Record<string, unknown>) || {};
        parameters.push({
          name: p.name as string,
          in: p.in as string,
          required: (p.required as boolean) || false,
          type: (schema.type as string) || 'string',
          description: (p.description as string) || '',
          default: schema.default,
          enum: schema.enum as string[] | undefined,
        });
      }

      // Extract request body schema → flatten into bodyFields
      const reqBody = op.requestBody as Record<string, unknown> | undefined;
      const bodyFields: Parameter[] = [];
      let exampleRequests: NamedExample[] = [];

      if (reqBody) {
        const content = reqBody.content as Record<string, Record<string, unknown>> | undefined;
        const jsonContent = content?.['application/json'];
        if (jsonContent) {
          const resolved = resolveSchema(doc, jsonContent.schema as Record<string, unknown>);
          if (resolved) {
            flattenSchemaToFields(doc, resolved, bodyFields, '', false);
          }

          // Extract request examples
          const examples = jsonContent.examples as Record<string, Record<string, unknown>> | undefined;
          if (examples) {
            exampleRequests = Object.entries(examples).map(([key, ex]) => ({
              name: (ex.summary as string) || key,
              value: ex.value,
            }));
          }
        }
      }

      // Extract response examples
      let exampleResponses: NamedExample[] = [];
      const responses = op.responses as Record<string, Record<string, unknown>> | undefined;
      if (responses) {
        const okResponse = responses['200'] || responses['201'];
        if (okResponse) {
          const content = okResponse.content as Record<string, Record<string, unknown>> | undefined;
          const jsonContent = content?.['application/json'];
          if (jsonContent) {
            const examples = jsonContent.examples as Record<string, Record<string, unknown>> | undefined;
            if (examples) {
              exampleResponses = Object.entries(examples).map(([key, ex]) => ({
                name: (ex.summary as string) || key,
                value: ex.value,
              }));
            } else if (jsonContent.example) {
              exampleResponses = [{ name: 'Response', value: jsonContent.example }];
            }
          }
        }
      }

      // Extract events for WS/SSE/webhook
      const xEvents = op['x-events'] as Record<string, EventDef[]> | undefined;

      const endpoint: ProcessedEndpoint = {
        operationId: op.operationId as string,
        method: method.toUpperCase(),
        path,
        summary: (op.summary as string) || '',
        description: (op.description as string) || '',
        group,
        tag,
        protocol: op['x-protocol'] as ProcessedEndpoint['protocol'],
        modes: op['x-modes'] as InputMode[] | undefined,
        parameters: parameters.length > 0 ? parameters : undefined,
        bodyFields: bodyFields.length > 0 ? bodyFields : undefined,
        exampleRequests: exampleRequests.length > 0 ? exampleRequests : undefined,
        exampleResponses: exampleResponses.length > 0 ? exampleResponses : undefined,
        codeSamples: op['x-codeSamples'] as CodeSample[] | undefined,
        events: xEvents
          ? {
              send: xEvents.send,
              receive: xEvents.receive,
            }
          : undefined,
        cost: op['x-cost'] as string | undefined,
        rateLimit: op['x-rate-limit'] as string | undefined,
      };

      endpoints.push(endpoint);
    }
  }

  // Build groups in defined order, counting endpoints per group
  const groupCounts = new Map<string, number>();
  for (const ep of endpoints) {
    groupCounts.set(ep.group, (groupCounts.get(ep.group) ?? 0) + 1);
  }

  // Start with ordered groups that have endpoints, then append any extras
  const orderedGroupIds: string[] = [];
  for (const id of GROUP_ORDER) {
    if (groupCounts.has(id)) orderedGroupIds.push(id);
  }
  for (const id of groupCounts.keys()) {
    if (!orderedGroupIds.includes(id)) orderedGroupIds.push(id);
  }

  const groups: EndpointGroup[] = orderedGroupIds.map((id) => ({
    id,
    endpointCount: groupCounts.get(id) ?? 0,
  }));

  cachedSpec = {
    info: {
      title: ((doc.info as Record<string, unknown>)?.title as string) || 'Prismer Cloud API',
      version: ((doc.info as Record<string, unknown>)?.version as string) || '1.0.0',
      description: ((doc.info as Record<string, unknown>)?.description as string) || '',
    },
    groups,
    endpoints,
    raw: doc,
  };

  return cachedSpec;
}

// ─── Helper Functions ────────────────────────────────────────────

/**
 * Get all endpoints belonging to a specific group.
 */
export function getEndpointsByGroup(groupId: string): ProcessedEndpoint[] {
  const spec = loadSpec();
  return spec.endpoints.filter((ep) => ep.group === groupId);
}

/**
 * Find a single endpoint by path (and optional method).
 * Path matching is case-insensitive.
 */
export function getEndpointByPath(path: string, method?: string): ProcessedEndpoint | null {
  const spec = loadSpec();
  const normalPath = path.toLowerCase();
  const normalMethod = method?.toUpperCase();

  const match = spec.endpoints.find((ep) => {
    const pathMatch = ep.path.toLowerCase() === normalPath;
    if (!pathMatch) return false;
    if (normalMethod) return ep.method === normalMethod;
    return true;
  });

  return match ?? null;
}

/**
 * Convert an endpoint into a URL-friendly slug.
 *
 * Examples:
 *   /api/im/register          → register
 *   /api/im/direct/{userId}/messages → direct-messages
 *   /api/context/load         → context-load
 */
export function getEndpointSlug(ep: ProcessedEndpoint): string {
  const pathSlug =
    ep.path
      .replace(/^\/api\/(im\/|context\/|)/, '')
      .replace(/\{[^}]+\}/g, '')
      .replace(/\/+/g, '-')
      .replace(/^-|-$/g, '') || ep.operationId;
  return `${ep.method.toLowerCase()}-${pathSlug}`;
}

/**
 * Get a localized summary for an endpoint.
 * Currently returns English summary; i18n via x-i18n extensions is a TODO.
 */
export function getLocalizedSummary(ep: ProcessedEndpoint, _locale: Locale): string {
  // TODO: read ep['x-i18n']?.summary?.[locale] when spec supports it
  return ep.summary;
}
