export interface ClientResource {
  start(): Promise<void>;
  cancel(): void;
  stop(): Promise<void>;
}

interface Entry<T> {
  resource: T;
  current: boolean;
  ready: Promise<T | undefined>;
  stopped?: Promise<void>;
}

/** Own every startup from before the first await through process shutdown. */
export class ClientLifecycle<T extends ClientResource> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly stopping = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly reportError: (error: unknown) => void) {}

  get size(): number {
    return this.entries.size;
  }

  start(key: string, create: () => T): Promise<T | undefined> {
    const existing = this.entries.get(key);
    if (existing) return existing.ready;
    if (this.closed) return Promise.resolve(undefined);

    // Creation is synchronous; claim the key before scheduling any I/O.
    let resource: T;
    try {
      resource = create();
    } catch (error) {
      this.reportError(error);
      return Promise.resolve(undefined);
    }
    const entry: Entry<T> = {
      resource,
      current: true,
      ready: Promise.resolve(undefined),
    };
    this.entries.set(key, entry);
    entry.ready = Promise.resolve().then(async () => {
      try {
        if (entry.current) await entry.resource.start();
        if (entry.current) return entry.resource;
      } catch (error) {
        this.reportError(error);
        entry.current = false;
        if (this.entries.get(key) === entry) this.entries.delete(key);
        entry.resource.cancel();
      }
      await this.stopEntry(entry);
      return undefined;
    });
    return entry.ready;
  }

  private stopEntry(entry: Entry<T>): Promise<void> {
    if (!entry.stopped) {
      entry.stopped = entry.resource.stop().catch(this.reportError);
    }
    return entry.stopped;
  }

  /** Cancels immediately; waits for in-flight startup before disposing. */
  clear(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    for (const entry of entries) {
      entry.current = false;
      entry.resource.cancel();
      const stopping = entry.ready.then(() => this.stopEntry(entry));
      this.stopping.add(stopping);
      void stopping.then(() => this.stopping.delete(stopping));
    }
    return Promise.all(Array.from(this.stopping)).then(() => undefined);
  }

  dispose(): Promise<void> {
    this.closed = true;
    return this.clear();
  }
}
