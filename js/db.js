// Mini-couche IndexedDB : deux magasins, « items » (pièces) et « outfits » (tenues).
const DB_NAME = 'dressing';
const VERSION = 1;
const STORES = ['items', 'outfits'];

let dbPromise;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const result = fn(tx);
    tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const getAll = (store) => run(store, 'readonly', (tx) => tx.objectStore(store).getAll());

export const put = (store, value) => run(store, 'readwrite', (tx) => { tx.objectStore(store).put(value); }).then(() => value);

export const putMany = (store, values) => run(store, 'readwrite', (tx) => {
  const s = tx.objectStore(store);
  values.forEach((v) => s.put(v));
});

export const remove = (store, id) => run(store, 'readwrite', (tx) => { tx.objectStore(store).delete(id); });

export const clearAll = () => run(STORES, 'readwrite', (tx) => { STORES.forEach((s) => tx.objectStore(s).clear()); });
