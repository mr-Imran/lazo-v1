import { Injectable } from '@nestjs/common';
import type { Response } from 'express';

export interface ChatEvent {
  type: 'message' | 'conversation' | 'read' | 'typing' | 'presence';
  conversationId: string;
  /** Who this copy is for; lets the client tell its own messages apart. */
  payload: Record<string, unknown>;
}

type Listener = (event: ChatEvent) => void;
const PING_MS = 25_000;

/**
 * Who is listening for chat events right now, in this process. Fine for one
 * PM2 instance; with several API processes this would move to Redis pub/sub.
 * Channels are user ids ('user_…', 'visitor:…') plus 'admin' for every admin.
 */
@Injectable()
export class ChatEventsService {
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Set by ChatService: called when a channel's first stream opens or last closes. */
  onPresence: ((channels: string[], online: boolean) => void) | null = null;

  publish(channels: string[], event: ChatEvent): void {
    for (const channel of new Set(channels.filter(Boolean))) {
      for (const listener of this.listeners.get(channel) ?? []) listener(event);
    }
  }

  subscribe(channel: string, listener: Listener): () => void {
    const set = this.listeners.get(channel) ?? new Set();
    set.add(listener);
    this.listeners.set(channel, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(channel);
    };
  }

  /** Turns an HTTP response into a server-sent event stream for `channels` until the client goes away. */
  stream(res: Response, channels: string[]): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    const send = (event: ChatEvent) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribes = channels.map((c) => this.subscribe(c, send));
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    this.onPresence?.(channels, true);
    const close = () => {
      clearInterval(ping);
      for (const off of unsubscribes) off();
      this.onPresence?.(channels, false);
      if (!res.writableEnded) res.end();
    };
    res.on('close', close);
    res.on('error', close);
  }

  /** Whether anyone is connected on a channel (a user id, or 'admin' for any admin). */
  isOnline(channel: string): boolean {
    return (this.listeners.get(channel)?.size ?? 0) > 0;
  }

  /** How many open streams, for the health endpoint / logs. */
  get connections(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}
