type GroupEntry = { group_id: string; board_id: string };

type Env = {
  API_BASE: string;
  GROUPS_JSON: string;
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postSyncOnce(env: Env, entry: GroupEntry, attempt: number = 1): Promise<void> {
  const url = `${env.API_BASE.replace(/\/$/, '')}/api/miro/sync`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: entry.group_id, board_id: entry.board_id }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s
      console.warn(`[retry] group=${entry.group_id} status=${res.status} wait=${backoff}ms detail=${text}`);
      await sleep(backoff);
      return postSyncOnce(env, entry, attempt + 1);
    }
    throw new Error(`sync failed group=${entry.group_id} status=${res.status} detail=${text}`);
  }
  const json = await res.json().catch(() => ({} as any));
  const counts = json?.counts ?? { added: 0, updated: 0, deleted: 0 };
  console.log(`[ok] ${entry.group_id} added=${counts.added} updated=${counts.updated} deleted=${counts.deleted}`);
}

export default {
  async fetch(_req: any): Promise<Response> {
    return new Response('miro-sync-cron worker');
  },
  async scheduled(_event: any, env: Env, _ctx: any): Promise<void> {
    if (!env.API_BASE) {
      console.error('API_BASE is not set');
      return;
    }
    let groups: GroupEntry[] = [];
    try {
      groups = JSON.parse(env.GROUPS_JSON || '[]');
    } catch (e: any) {
      console.error('Invalid GROUPS_JSON:', e?.message || e);
      return;
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      console.warn('No groups configured. Set GROUPS_JSON.');
      return;
    }
    for (const g of groups) {
      try {
        await postSyncOnce(env, g);
      } catch (e: any) {
        console.error(`[error] group=${g.group_id}`, e?.message || e);
      }
    }
  },
};


