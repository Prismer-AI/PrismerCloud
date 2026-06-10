import { describe, expect, it } from 'vitest';
import {
  PrismerClient,
  readCardKanbanMetadata,
  writeCardKanbanMetadata,
  type CardKanbanMetadata,
} from '../../src/index';

describe('workspace card metadata public helpers', () => {
  it('prefers cardOrder when both cardOrder and legacy order exist', () => {
    expect(readCardKanbanMetadata({
      columnId: 'todo',
      cardOrder: 20,
      order: 10,
    })).toEqual({
      columnId: 'todo',
      cardOrder: 20,
    });
  });

  it('falls back to legacy order when cardOrder is absent', () => {
    expect(readCardKanbanMetadata({
      columnId: 'todo',
      order: 10,
    })).toEqual({
      columnId: 'todo',
      cardOrder: 10,
    });
  });

  it('reads legacy nested metadata.kanban', () => {
    expect(readCardKanbanMetadata({
      metadata: {
        columnId: 'backlog',
        kanban: {
          columnId: 'review',
          order: 30,
          cardStatus: 'running',
          cardPriority: 'high',
        },
      },
    })).toEqual({
      columnId: 'review',
      cardOrder: 30,
      cardStatus: 'running',
      cardPriority: 'high',
    });
  });

  it('writes canonical cardOrder and removes legacy order', () => {
    const next = writeCardKanbanMetadata(
      {
        title: 'keep me',
        order: 1,
        kanban: {
          order: 2,
          columnId: 'todo',
        },
      },
      {
        columnId: 'in_progress',
        order: 40,
        cardStatus: 'running',
      } satisfies CardKanbanMetadata,
    );

    expect(next).toEqual({
      title: 'keep me',
      columnId: 'in_progress',
      cardOrder: 40,
      cardStatus: 'running',
      kanban: {
        columnId: 'in_progress',
        cardOrder: 40,
        cardStatus: 'running',
      },
    });
    expect(next).not.toHaveProperty('order');
    expect(next.kanban).not.toHaveProperty('order');
  });

  it('normalizes legacy done status to completed on write', () => {
    const next = writeCardKanbanMetadata(
      {
        columnId: 'done',
        cardStatus: 'done',
      },
      {
        cardOrder: 50,
      },
    );

    expect(readCardKanbanMetadata(next).cardStatus).toBe('completed');
    expect(next.cardStatus).toBe('completed');
    expect((next.kanban as CardKanbanMetadata).cardStatus).toBe('completed');
  });
});

describe('v2.0 SDK public surface', () => {
  it('exposes frozen workspace and skill namespace aliases', () => {
    const client = new PrismerClient({ baseUrl: 'https://api.test' });

    expect(client.workspaces).toBe(client.im.workspaces);
    expect(client.workspaceFiles).toBe(client.im.workspaceFiles);
    expect(client.assets).toBe(client.im.assets);
    expect(client.evolution).toBe(client.im.evolution);
    expect(typeof client.evolution.skills.list).toBe('function');
    expect(typeof client.evolution.skills.get).toBe('function');
    expect(typeof client.evolution.skills.create).toBe('function');
    expect(typeof client.evolution.skills.update).toBe('function');
    expect(typeof client.evolution.skills.delete).toBe('function');
    expect(typeof client.evolution.skills.install).toBe('function');
    expect(typeof client.evolution.skills.uninstall).toBe('function');
    expect(typeof client.evolution.skills.pending).toBe('function');
    expect(typeof client.evolution.skills.ack).toBe('function');
    expect('publish' in client.evolution.skills).toBe(false);
  });
});
