// API keys that must stay readable in the browser.
//
// ST's secret store does not hand values back to the page (allowKeysExposure is off by default), and
// image requests are issued from the browser, so a copy of each key has to live here. It used to be one
// plain localStorage entry shared by every ST account that signs in from this browser. Now each account
// has its own entry; the old shared entry is handed to the first account that opens Qianmu after the
// upgrade and then removed, so no other account can read it.
//
// Nothing is readable or writable until the account is known: an unknown account yields "no keys",
// never somebody else's.
export function createBrowserCredentialStore({ storage = globalThis.localStorage, legacyKey, prefix, ownerKey } = {}) {
  if (!legacyKey || !prefix || !ownerKey) throw new TypeError('Browser credential store needs its storage keys.');
  let account = '';
  const get = key => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const parse = raw => { try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } };
  const slot = () => prefix + account;

  function adoptLegacy() {
    const legacy = get(legacyKey);
    if (legacy === null || get(ownerKey)) return;
    try {
      if (get(slot()) === null) storage.setItem(slot(), JSON.stringify(parse(legacy)));
      storage.setItem(ownerKey, account);
      // Only drop the shared copy once this account's own copy is really there.
      if (get(slot()) !== null && get(ownerKey) === account) storage.removeItem(legacyKey);
    } catch { /* storage unavailable: the shared copy stays until it can be handed over */ }
  }
  return Object.freeze({
    get account() { return account; },
    setAccount(namespace) {
      account = String(namespace || '');
      if (account) adoptLegacy();
      return account;
    },
    all() { return account ? parse(get(slot())) : {}; },
    read(id) {
      const key = String(id || '').trim();
      return key && account ? String(parse(get(slot()))[key] || '').trim() : '';
    },
    write(id, value) {
      const key = String(id || '').trim();
      if (!key || !account) return false;
      try {
        const stored = parse(get(slot())), next = String(value || '').trim();
        if (next) stored[key] = next; else delete stored[key];
        storage.setItem(slot(), JSON.stringify(stored));
        return true;
      } catch { return false; }
    },
  });
}
