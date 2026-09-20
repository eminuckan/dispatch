type IndexedDbEntry = {
  readonly key: IDBValidKey;
  readonly value: unknown;
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionCompleted(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
  let created = false;
  const request = indexedDB.open(name);
  request.addEventListener("upgradeneeded", (event) => {
    if ((event as IDBVersionChangeEvent).oldVersion === 0) created = true;
  });
  const database = await requestResult(request);
  if (!created) return database;

  database.close();
  try {
    indexedDB.deleteDatabase(name);
  } catch {
    // The database did not exist before this probe, so failed cleanup carries no user state.
  }
  return null;
}

async function readEntries(database: IDBDatabase, storeName: string): Promise<IndexedDbEntry[]> {
  const transaction = database.transaction(storeName, "readonly");
  const entries: IndexedDbEntry[] = [];
  const cursorRequest = transaction.objectStore(storeName).openCursor();
  cursorRequest.addEventListener("success", () => {
    const cursor = cursorRequest.result;
    if (cursor === null) return;
    entries.push({ key: cursor.key, value: cursor.value });
    cursor.continue();
  });
  await transactionCompleted(transaction);
  return entries;
}

async function mergeEntries(
  database: IDBDatabase,
  storeName: string,
  entries: readonly IndexedDbEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);
  for (const entry of entries) {
    const existingKey = store.getKey(entry.key);
    existingKey.addEventListener("success", () => {
      if (existingKey.result === undefined) store.put(entry.value, entry.key);
    });
  }
  await transactionCompleted(transaction);
}

/**
 * Copies an old first-party IndexedDB into its Dispatch-owned database name.
 * Canonical records win when both databases contain the same key. The legacy
 * database is deleted only after every requested store has copied successfully.
 */
export async function migrateLegacyIndexedDatabase(
  canonicalDatabase: IDBDatabase,
  legacyDatabaseName: string,
  storeNames: readonly string[],
): Promise<void> {
  const legacyDatabase = await openExistingDatabase(legacyDatabaseName);
  if (legacyDatabase === null) return;

  const requestedStoreNames = new Set(storeNames);
  let safeToDeleteLegacyDatabase = true;
  try {
    for (const storeName of Array.from(legacyDatabase.objectStoreNames)) {
      if (!requestedStoreNames.has(storeName)) {
        safeToDeleteLegacyDatabase = false;
        continue;
      }
      if (!canonicalDatabase.objectStoreNames.contains(storeName)) {
        safeToDeleteLegacyDatabase = false;
        continue;
      }
      await mergeEntries(
        canonicalDatabase,
        storeName,
        await readEntries(legacyDatabase, storeName),
      );
    }
  } finally {
    legacyDatabase.close();
  }

  if (!safeToDeleteLegacyDatabase) return;
  try {
    indexedDB.deleteDatabase(legacyDatabaseName);
  } catch {
    // The canonical copy succeeded. A blocked delete can be retried on the next startup.
  }
}
