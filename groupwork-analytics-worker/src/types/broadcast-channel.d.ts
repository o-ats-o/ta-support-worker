// Minimal BroadcastChannel type for Cloudflare Workers runtime
// This silences TS errors in the Worker environment.
declare class BroadcastChannel {
  constructor(name: string);
  postMessage(message: any): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  close(): void;
}


