import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppBindings } from '../config';
import { miroSyncBodySchema, miroDiffsQuerySchema, miroItemsQuerySchema } from '../schemas/miro';
import { listDiffs, listItems, syncBoardAndDiff } from '../services/miro';

export const miroRoutes = new Hono<{ Bindings: AppBindings }>();

// クライアントからの手動同期トリガ
miroRoutes.post('/miro/sync', zValidator('json', miroSyncBodySchema), async (c) => {
  const { group_id, board_id, types } = c.req.valid('json');
  const resolvedBoardId = board_id ?? group_id!;
  const diff = await syncBoardAndDiff(c.env, resolvedBoardId, { types });
  return c.json({
    board_id: diff.boardId,
    diff_at: diff.diffAt,
    counts: { added: diff.added.length, updated: diff.updated.length, deleted: diff.deleted.length },
    added: diff.added,
    updated: diff.updated,
    deleted: diff.deleted,
  });
});

// 差分履歴を取得
miroRoutes.get('/miro/diffs', zValidator('query', miroDiffsQuerySchema), async (c) => {
  const { group_id, board_id, since, until, limit, offset } = c.req.valid('query');
  const resolvedBoardId = board_id ?? group_id!;
  const rows = await listDiffs(c.env, { boardId: resolvedBoardId, since, until, limit, offset });
  return c.json(rows);
});

// 最新アイテム一覧を取得
miroRoutes.get('/miro/items', zValidator('query', miroItemsQuerySchema), async (c) => {
  const { group_id, board_id, include_deleted, limit, offset } = c.req.valid('query');
  const resolvedBoardId = board_id ?? group_id!;
  const rows = await listItems(c.env, { boardId: resolvedBoardId, includeDeleted: include_deleted ?? false, limit, offset });
  return c.json(rows);
});


