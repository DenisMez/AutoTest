export const savedConnectionKey = 'savedFormsConnection';

export function savedConnectionWriter(storage) {
  let pending = Promise.resolve();
  return (auth, remember) => {
    const token = auth.token.trim();
    const record = remember && token ? {mode: auth.mode, org: auth.org.trim(), token} : null;
    pending = pending.catch(() => {}).then(async () => {
      if (!record) {
        await storage.remove(savedConnectionKey);
        return false;
      }
      await storage.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
      await storage.set({[savedConnectionKey]: record});
      return true;
    });
    return pending;
  };
}
