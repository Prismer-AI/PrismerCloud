import type { IMTask } from '../../types';

export type Card = IMTask;
export type CardMetadata = Record<string, unknown>;

export type CardKanbanStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'pending'
  | 'assigned'
  | 'running'
  /** Legacy v2.0 planning alias; new writers should emit `completed`. */
  | 'done';

/**
 * Typed view over agreed Kanban fields stored in IMTask.metadata.
 * These are not separate cloud columns and do not imply a standalone Card model.
 */
export interface CardKanbanMetadata {
  /** Current Kanban column. Moving a card writes this field. */
  columnId?: string;
  /** Sort weight inside a Kanban column. Fractional values support inserts. */
  cardOrder?: number;
  /** Legacy sort weight from early workspace UI builds. Accepted as input only; writers emit cardOrder. */
  order?: number;
  /** Board-level status view. New writers should prefer execution-aligned values (`completed`, not `done`). */
  cardStatus?: CardKanbanStatus;
  /** Board-level priority view, expected to mirror task priority when present. */
  cardPriority?: 'low' | 'medium' | 'high' | 'urgent';
  /** Visual labels used by Kanban clients. */
  cardLabels?: { color?: string; emoji?: string; tagIds?: string[] };
}

export interface CardCreateInput {
  title: string;
  description?: string;
  assigneeId?: string;
  dueDate?: Date;
  tags?: string[];
  kanban: CardKanbanMetadata;
}

export interface CardFilters {
  columnId?: string;
  cardStatus?: CardKanbanMetadata['cardStatus'];
  assigneeId?: string;
  tags?: string[];
}

export interface CardMove {
  cardId: string;
  toColumnId: string;
  position?: number;
}

export type CardKanbanMetadataSource =
  | CardMetadata
  | { metadata?: CardMetadata | null }
  | null
  | undefined;

const CARD_KANBAN_STATUSES = new Set<CardKanbanStatus>([
  'backlog',
  'todo',
  'in_progress',
  'review',
  'completed',
  'failed',
  'cancelled',
  'pending',
  'assigned',
  'running',
  'done',
]);

const CARD_PRIORITIES = new Set<NonNullable<CardKanbanMetadata['cardPriority']>>([
  'low',
  'medium',
  'high',
  'urgent',
]);

/**
 * Read the public Kanban view from card/task metadata.
 *
 * Accepts both flat `metadata.cardOrder` and legacy `metadata.order`, with
 * `cardOrder` winning when both are present. Legacy nested
 * `metadata.kanban` is also accepted and merged over the flat metadata.
 */
export function readCardKanbanMetadata(source: CardKanbanMetadataSource): CardKanbanMetadata {
  const metadata = readSourceMetadata(source);
  const nestedKanban = readRecord(metadata.kanban);
  const fields = nestedKanban ? { ...metadata, ...nestedKanban } : metadata;
  return toCanonicalCardKanbanMetadata(fields);
}

/**
 * Return task metadata with a canonical public Kanban view.
 *
 * Existing non-Kanban metadata is preserved. Legacy `order` is removed from
 * both flat metadata and nested `metadata.kanban`; the canonical output uses
 * `cardOrder` only.
 */
export function writeCardKanbanMetadata(
  metadata: CardMetadata | null | undefined,
  kanban: CardKanbanMetadata,
): CardMetadata {
  const previous = readRecord(metadata) ?? {};
  const previousKanban = readRecord(previous.kanban);
  const currentView = toWritableCardKanbanMetadata(readCardKanbanMetadata(previous));
  const nextView = toWritableCardKanbanMetadata(toCanonicalCardKanbanMetadata(kanban));
  const nextKanban: CardMetadata = toWritableCardKanbanMetadata({
    ...(previousKanban ? omitLegacyOrder(previousKanban) : {}),
    ...currentView,
    ...nextView,
  });

  return {
    ...omitLegacyOrder(previous),
    ...nextKanban,
    kanban: nextKanban,
  };
}

function readSourceMetadata(source: CardKanbanMetadataSource): CardMetadata {
  const record = readRecord(source);
  if (!record) return {};
  return readRecord(record.metadata) ?? record;
}

function toCanonicalCardKanbanMetadata(source: unknown): CardKanbanMetadata {
  const record = readRecord(source) ?? {};
  const metadata: CardKanbanMetadata = {};
  const columnId = readString(record.columnId);
  const cardOrder = readFiniteNumber(record.cardOrder) ?? readFiniteNumber(record.order);
  const cardStatus = readCardKanbanStatus(record.cardStatus);
  const cardPriority = readCardPriority(record.cardPriority);
  const cardLabels = readCardLabels(record.cardLabels);

  if (columnId) metadata.columnId = columnId;
  if (cardOrder !== undefined) metadata.cardOrder = cardOrder;
  if (cardStatus) metadata.cardStatus = cardStatus;
  if (cardPriority) metadata.cardPriority = cardPriority;
  if (cardLabels) metadata.cardLabels = cardLabels;
  return metadata;
}

function toWritableCardKanbanMetadata<T extends { cardStatus?: unknown }>(view: T): T {
  return view.cardStatus === 'done' ? ({ ...view, cardStatus: 'completed' } as T) : view;
}

function omitLegacyOrder(record: CardMetadata): CardMetadata {
  const { order: _legacyOrder, ...rest } = record;
  return rest;
}

function readRecord(value: unknown): CardMetadata | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as CardMetadata) : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readCardKanbanStatus(value: unknown): CardKanbanStatus | undefined {
  return typeof value === 'string' && CARD_KANBAN_STATUSES.has(value as CardKanbanStatus)
    ? (value as CardKanbanStatus)
    : undefined;
}

function readCardPriority(value: unknown): CardKanbanMetadata['cardPriority'] | undefined {
  return typeof value === 'string' && CARD_PRIORITIES.has(value as NonNullable<CardKanbanMetadata['cardPriority']>)
    ? (value as NonNullable<CardKanbanMetadata['cardPriority']>)
    : undefined;
}

function readCardLabels(value: unknown): CardKanbanMetadata['cardLabels'] | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const labels: NonNullable<CardKanbanMetadata['cardLabels']> = {};
  const color = readString(record.color);
  const emoji = readString(record.emoji);
  const tagIds = Array.isArray(record.tagIds) && record.tagIds.every((tagId) => typeof tagId === 'string')
    ? [...record.tagIds]
    : undefined;

  if (color) labels.color = color;
  if (emoji) labels.emoji = emoji;
  if (tagIds) labels.tagIds = tagIds;
  return Object.keys(labels).length > 0 ? labels : undefined;
}
