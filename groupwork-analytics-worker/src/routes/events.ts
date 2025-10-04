import { Hono } from 'hono';
import type { AppBindings } from '../config';

export const eventsRoutes = new Hono<{ Bindings: AppBindings }>();

// GET /events - Server-Sent Events
eventsRoutes.get('/events', async (c) => {
  const search = new URL(c.req.url).searchParams;
  const delayMs = Number(search.get('delay_ms') ?? 30000) || 30000; // データ確定猶予
  const stepMs = Number(search.get('step_ms') ?? 300000) || 300000; // 5分

  const encoder = new TextEncoder();
  let lastWindowKey = '';

  function computeLatestWindow(nowMs: number) {
    const anchor = nowMs - delayMs; // 猶予を引く
    const startMs = Math.floor(anchor / stepMs) * stepMs;
    return { start: new Date(startMs).toISOString(), end: new Date(startMs + stepMs).toISOString() };
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // SSEヘッダ: 自動再接続間隔
      controller.enqueue(encoder.encode('retry: 5000\n\n'));

      // 初期の最新ウィンドウを送出
      const now = Date.now();
      const latest = computeLatestWindow(now);
      lastWindowKey = latest.start;
      controller.enqueue(
        encoder.encode(`event: window_status\n` + `data: ${JSON.stringify({ now: new Date(now).toISOString(), latest_window: latest })}\n\n`)
      );

      // BroadcastChannelでWebhook完了通知を受け取る
      const bc = new BroadcastChannel('ta-support-events');
      const onMsg = (ev: MessageEvent) => {
        try {
          const msg = ev.data || {};
          if (msg?.type === 'session_processed') {
            const atMs = Date.parse(msg.at ?? new Date().toISOString());
            const win = computeLatestWindow(atMs);
            controller.enqueue(
              encoder.encode(`event: data_ready\n` + `data: ${JSON.stringify({ group_id: msg.groupId, session_id: msg.sessionId, at: msg.at, window: win })}\n\n`)
            );
            // ついでにwindowの更新も通知（授業時間に依存せず常に最新へ）
            if (win.start !== lastWindowKey) {
              lastWindowKey = win.start;
              controller.enqueue(encoder.encode(`event: window_tick\n` + `data: ${JSON.stringify({ latest_window: win })}\n\n`));
            }
          }
        } catch {}
      };
      bc.addEventListener('message', onMsg);

      // 25秒おきの心拍と時刻ベースのウィンドウ切替検知
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        const latestNow = computeLatestWindow(Date.now());
        if (latestNow.start !== lastWindowKey) {
          lastWindowKey = latestNow.start;
          controller.enqueue(encoder.encode(`event: window_tick\n` + `data: ${JSON.stringify({ latest_window: latestNow })}\n\n`));
        }
      }, 25000);

      // 終了処理
      const abort = c.req.raw.signal;
      const onAbort = () => {
        clearInterval(heartbeat);
        bc.removeEventListener('message', onMsg);
        bc.close();
      };
      abort.addEventListener('abort', onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      "Access-Control-Allow-Origin": "*",
    },
  });
});


