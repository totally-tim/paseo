import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PluginClientStorage } from "@getpaseo/plugin";

// A plugin can be reinstalled on reconnect while a previous instance is saving.
// Reads and writes for the same key must observe that previous instance's writes.
const writes = new Map<string, Promise<void>>();

function enqueue(key: string, action: () => Promise<void>): Promise<void> {
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
  writes.set(key, pending);
  const cleanup = () => {
    if (writes.get(key) === pending) writes.delete(key);
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

export function createPluginClientStorage(serverId: string, pluginId: string): PluginClientStorage {
  const keyFor = (key: string) => `plugin-preferences:${JSON.stringify([serverId, pluginId, key])}`;
  return {
    async getItem(key) {
      const storageKey = keyFor(key);
      await writes.get(storageKey)?.catch(() => undefined);
      return AsyncStorage.getItem(storageKey);
    },
    setItem: (key, value) => enqueue(keyFor(key), () => AsyncStorage.setItem(keyFor(key), value)),
    removeItem: (key) => enqueue(keyFor(key), () => AsyncStorage.removeItem(keyFor(key))),
  };
}
