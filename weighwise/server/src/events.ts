import { EventEmitter } from 'node:events';

export interface SavedEvent {
  sessionId: string;
  measurementId: string;
  userId: string;
}

/** In-process bus. `saved` fires after a measurement is persisted (drives AI + notifications). */
export const bus = new EventEmitter();

type Handler = (e: SavedEvent) => Promise<void> | void;
export const onSaved = (h: Handler) => bus.on('saved', (e: SavedEvent) => void Promise.resolve(h(e)).catch(() => undefined));
export const emitSaved = (e: SavedEvent) => bus.emit('saved', e);
