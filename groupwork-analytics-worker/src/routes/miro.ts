import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../config';
import { miroSyncBodySchema, miroDiffsQuerySchema, miroItemsQuerySchema } from '../schemas/miro';
import { listDiffs, listItems, syncBoardAndDiff, upsertBoardMap, resolveBoardId } from '../services/miro';

export const miroRoutes = new Hono<{ Bindings: AppBindings }>();

// クライアントからの手動同期トリガ
miroRoutes.post('/miro/sync', zValidator('json', miroSyncBodySchema), async (c) => {
  const { group_id, board_id, types } = c.req.valid('json');
  try {
    if (!c.env.MIRO_TOKEN || String(c.env.MIRO_TOKEN).trim().length === 0) {
      return c.json({ error: 'Server misconfiguration: MIRO_TOKEN is not set' }, 500);
    }
    // マッピングはベストエフォート（表が無い/権限ない等でも同期は続行）
    try {
      await upsertBoardMap(c.env, group_id, board_id);
    } catch (e: any) {
      console.warn('miro_board_map upsert skipped:', e?.message || e);
    }
    const diff = await syncBoardAndDiff(c.env, board_id, { types });
    return c.json({
      board_id: diff.boardId,
      diff_at: diff.diffAt,
      counts: { added: diff.added.length, updated: diff.updated.length, deleted: diff.deleted.length },
      added: diff.added,
      updated: diff.updated,
      deleted: diff.deleted,
    });
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    console.error('POST /miro/sync error:', message);
    if (message.includes('Miro API error')) return c.json({ error: 'Failed to fetch from Miro API', detail: message }, 502);
    return c.json({ error: 'Internal Server Error', detail: message }, 500);
  }
});

// 差分履歴を取得
miroRoutes.get('/miro/diffs', zValidator('query', miroDiffsQuerySchema), async (c) => {
  try {
    const { group_id, since, until, limit, offset } = c.req.valid('query');
    const resolvedBoardId = await resolveBoardId(c.env, group_id);
    const rows = await listDiffs(c.env, { boardId: resolvedBoardId, since, until, limit, offset });
    return c.json(rows);
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    if (message.includes('No board mapped')) return c.json({ error: 'Mapping not found. POST /api/miro/sync first.' }, 404);
    return c.json({ error: 'Internal Server Error', detail: message }, 500);
  }
});

// 最新アイテム一覧を取得
miroRoutes.get('/miro/items', zValidator('query', miroItemsQuerySchema), async (c) => {
  try {
    const { group_id, include_deleted, limit, offset } = c.req.valid('query');
    const resolvedBoardId = await resolveBoardId(c.env, group_id);
    const rows = await listItems(c.env, { boardId: resolvedBoardId, includeDeleted: include_deleted ?? false, limit, offset });
    return c.json(rows);
  } catch (err: any) {
    const message = err?.message || 'Unknown error';
    if (message.includes('No board mapped')) return c.json({ error: 'Mapping not found. POST /api/miro/sync first.' }, 404);
    return c.json({ error: 'Internal Server Error', detail: message }, 500);
  }
});


