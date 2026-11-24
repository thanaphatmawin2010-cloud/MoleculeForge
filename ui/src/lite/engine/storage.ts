/**
 * Persistent key-value storage for MoleculeForge Lite: IndexedDB in browsers and the Android
 * WebView, a Map in tests. Everything stays on the device.
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  values<T>(): Promise<T[]>;
}

export class MemoryStore implements Store {
  private data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async values<T>(): Promise<T[]> {
    return [...this.data.values()] as T[];
  }
}

export class IndexedDbStore implements Store {
  private db: Promise<IDBDatabase>;

  constructor(
    name: string,
    private readonly storeName = "records",
  ) {
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB unavailable"));
    });
  }

  private async run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode);
      const request = fn(tx.objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.run("readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.run("readwrite", (s) => s.put(value, key));
  }
  async delete(key: string): Promise<void> {
    await this.run("readwrite", (s) => s.delete(key));
  }
  values<T>(): Promise<T[]> {
    return this.run("readonly", (s) => s.getAll() as IDBRequest<T[]>);
  }
}

/** IndexedDB when the platform has it (and it opens), otherwise memory for this session. */
export async function openStore(name: string): Promise<Store> {
  if (typeof indexedDB === "undefined") return new MemoryStore();
  try {
    const store = new IndexedDbStore(name);
    await store.values();
    return store;
  } catch {
    return new MemoryStore();
  }
}
