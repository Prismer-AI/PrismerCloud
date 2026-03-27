import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

/**
 * OpenAPI Docs API
 *
 * Parses docs/openapi.yaml and returns structured JSON for the docs page.
 * The spec is parsed once per process and cached in module scope.
 *
 * GET /api/docs/openapi → JSON { success, info, sections, endpoints }
 */

// ─── Types ──────────────────────────────────────────────────────

interface CodeSample {
  lang: string;
  label: string;
  source: string;
}

interface InputMode {
  name: string;
  description?: string;
  input: string;
}

interface EventDef {
  event: string;
  description?: string;
  payload?: Record<string, unknown>;
}

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description: string;
  default?: unknown;
  enum?: string[];
}

interface NamedExample {
  name: string;
  value: unknown;
}

interface ProcessedEndpoint {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  section: string;
  tag: string;
  phaseNumber?: number;
  phaseTitle?: string;
  protocol?: 'websocket' | 'sse' | 'webhook';
  modes?: InputMode[];
  parameters?: Parameter[];
  bodyFields?: Parameter[];
  exampleRequests?: NamedExample[];
  exampleResponses?: NamedExample[];
  codeSamples?: CodeSample[];
  events?: {
    send?: EventDef[];
    receive?: EventDef[];
  };
  cost?: string;
  rateLimit?: string;
  timeout?: string;
}

interface Phase {
  number: number;
  title: string;
  endpointIds: string[];
}

interface Section {
  id: string;
  title: string;
  description?: string;
  phases?: Phase[];
}

interface ErrorCode {
  code: string;
  http: number;
  description: string;
}

interface PricingEntry {
  operation: string;
  cost: string;
}

interface ProcessedSpec {
  info: { title: string; version: string; description: string };
  sections: Section[];
  endpoints: ProcessedEndpoint[];
  pricing: PricingEntry[];
  errorCodes: ErrorCode[];
}

// ─── Parser ─────────────────────────────────────────────────────

let cachedSpec: ProcessedSpec | null = null;

function loadSpec(): ProcessedSpec {
  if (cachedSpec) return cachedSpec;

  const filePath = join(process.cwd(), 'docs', 'openapi.yaml');
  const raw = readFileSync(filePath, 'utf-8');
  const doc = parseYaml(raw);

  // Build tag → section mapping from x-doc-section extension
  const tagMap = new Map<
    string,
    {
      section: string;
      description?: string;
      phaseNumber?: number;
      phaseTitle?: string;
    }
  >();

  for (const tag of doc.tags || []) {
    tagMap.set(tag.name, {
      section: tag['x-doc-section'] || tag.name.toLowerCase(),
      description: tag.description,
      phaseNumber: tag['x-phase-number'],
      phaseTitle: tag['x-phase-title'],
    });
  }

  // Process all paths → flat endpoint list
  const endpoints: ProcessedEndpoint[] = [];

  for (const [path, methods] of Object.entries(doc.paths || {})) {
    for (const [method, op] of Object.entries(methods as Record<string, Record<string, unknown>>)) {
      if (!op.operationId) continue;

      const tag = ((op.tags as string[]) || [])[0] || '';
      const tagInfo = tagMap.get(tag);
      const section = tagInfo?.section || 'other';

      // Extract parameters
      const parameters: Parameter[] = [];
      for (const p of (op.parameters || []) as Record<string, unknown>[]) {
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

      // Extract request body schema → flatten into bodyFields for display
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

          // Extract ALL examples
          const examples = jsonContent.examples as Record<string, Record<string, unknown>> | undefined;
          if (examples) {
            exampleRequests = Object.entries(examples).map(([key, ex]) => ({
              name: (ex.summary as string) || key,
              value: ex.value,
            }));
          }
        }
      }

      // Extract ALL example responses
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
        section,
        tag,
        phaseNumber: tagInfo?.phaseNumber,
        phaseTitle: tagInfo?.phaseTitle,
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
        timeout: op['x-timeout'] as string | undefined,
      };

      endpoints.push(endpoint);
    }
  }

  // Build sections from tags
  const sectionMap = new Map<string, Section>();
  const sectionOrder: string[] = [];

  for (const tag of doc.tags || []) {
    const sectionId = tag['x-doc-section'] || tag.name.toLowerCase();
    if (!sectionMap.has(sectionId)) {
      sectionMap.set(sectionId, {
        id: sectionId,
        title: sectionId.charAt(0).toUpperCase() + sectionId.slice(1),
        description: tag.description,
      });
      sectionOrder.push(sectionId);
    }

    // Build phases for IM section
    if (tag['x-phase-number']) {
      const section = sectionMap.get(sectionId)!;
      if (!section.phases) section.phases = [];

      const phaseEndpoints = endpoints.filter((e) => e.tag === tag.name).map((e) => e.operationId);

      section.phases.push({
        number: tag['x-phase-number'],
        title: tag['x-phase-title'] || tag.name,
        endpointIds: phaseEndpoints,
      });
    }
  }

  // Sort phases by number
  for (const section of sectionMap.values()) {
    if (section.phases) {
      section.phases.sort((a, b) => a.number - b.number);
    }
  }

  // Friendly section titles
  const sectionTitles: Record<string, string> = {
    context: 'Context API',
    parse: 'Parse API',
    im: 'IM API',
    evolution: 'Evolution API',
    skills: 'Skills API',
    files: 'File Transfer',
    webhook: 'Webhooks',
    realtime: 'Real-Time',
  };

  const sections = sectionOrder.map((id) => {
    const s = sectionMap.get(id)!;
    if (sectionTitles[id]) s.title = sectionTitles[id];
    return s;
  });

  cachedSpec = {
    info: {
      title: doc.info?.title || 'Prismer Cloud API',
      version: doc.info?.version || '1.0.0',
      description: doc.info?.description || '',
    },
    sections,
    endpoints,
    pricing: [
      { operation: 'Context Load (cached)', cost: 'Free' },
      { operation: 'Context Load (new)', cost: '~8 credits / 1K output tokens' },
      { operation: 'Context Search (query)', cost: '20 credits / query' },
      { operation: 'Context Save', cost: 'Free' },
      { operation: 'Parse Fast', cost: '2 credits / page' },
      { operation: 'Parse HiRes', cost: '5 credits / page' },
      { operation: 'IM Message', cost: '0.001 credits' },
      { operation: 'Workspace Init', cost: '0.01 credits' },
      { operation: 'File Upload', cost: '0.5 credits / MB' },
      { operation: 'WebSocket / SSE', cost: 'Free' },
    ],
    errorCodes: [
      { code: 'INVALID_INPUT', http: 400, description: 'Invalid request parameters' },
      { code: 'UNAUTHORIZED', http: 401, description: 'Missing or invalid authentication' },
      { code: 'INSUFFICIENT_CREDITS', http: 402, description: 'Not enough credits' },
      { code: 'FORBIDDEN', http: 403, description: 'Permission denied' },
      { code: 'NOT_FOUND', http: 404, description: 'Resource not found' },
      { code: 'CONFLICT', http: 409, description: 'Duplicate resource' },
      { code: 'RATE_LIMITED', http: 429, description: 'Too many requests' },
      { code: 'INTERNAL_ERROR', http: 500, description: 'Server error' },
    ],
  };

  return cachedSpec;
}

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
    return resolved as Record<string, unknown> | undefined;
  }

  // oneOf — return the first option's resolved schema
  if (schema.oneOf) {
    const options = schema.oneOf as Record<string, unknown>[];
    return resolveSchema(doc, options[0]);
  }

  return schema;
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

// ─── Route Handler ──────────────────────────────────────────────

export async function GET() {
  try {
    const spec = loadSpec();

    return NextResponse.json(
      {
        success: true,
        ...spec,
      },
      {
        headers: {
          'Cache-Control': 'public, max-age=3600',
        },
      },
    );
  } catch (error) {
    console.error('[OpenAPI Docs] Error loading spec:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to load API documentation',
      },
      { status: 500 },
    );
  }
}
