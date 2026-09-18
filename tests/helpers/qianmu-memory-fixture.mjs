// Development-only in-memory fixture. It must never be passed a live host
// writer as an operation; install/restore only replace context references.
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const clone = value => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const temporaryId = () => `qianmu-memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Install a small, explicitly temporary chat/metadata pair in memory.
 *
 * The caller receives a one-shot restore function. The original property
 * presence and object identities are retained so a missing host field is not
 * accidentally normalized into an empty value. No host method is inspected or
 * invoked and no storage/API access is performed.
 */
export function installQianmuMemoryFixture(context, options = {}) {
  if (!context || typeof context !== 'object') throw new TypeError('context must be an object');
  const original = {
    hasChat: hasOwn(context, 'chat'),
    chat: context.chat,
    hasMetadata: hasOwn(context, 'chatMetadata'),
    chatMetadata: context.chatMetadata,
  };
  const id = String(options.id || temporaryId());
  if (!id || id.length > 120) throw new TypeError('fixture id is invalid');

  const entry = clone(options.entry || {
    mes: '[temporary qianmu readonly fixture]',
    name: '__qianmu_temp__',
    is_user: false,
    send_date: 0,
    extra: { qianmuTemporaryFixture: true, fixtureId: id },
  });
  const storyboardImages = clone(options.storyboardImages === undefined ? [{
    id: `${id}-image`,
    kind: 'still',
    temporary: true,
    createdAt: 1,
  }] : options.storyboardImages);
  const layer = clone(options.layer || {
    schemaVersion: 8,
    storyboardImages,
    storyboardCollections: [],
    temporary: true,
    fixtureId: id,
  });
  if (!Array.isArray(layer.storyboardImages)) throw new TypeError('fixture storyboardImages must be an array');
  layer.temporary = true;
  layer.fixtureId = id;

  const chat = Array.isArray(original.chat) ? [...original.chat, entry] : [entry];
  const metadata = original.chatMetadata && typeof original.chatMetadata === 'object'
    ? { ...original.chatMetadata, story_director_liminale: layer }
    : { story_director_liminale: layer };
  context.chat = chat;
  context.chatMetadata = metadata;
  let restored = false;

  return Object.freeze({
    id,
    entry: clone(entry),
    metadata: clone(metadata),
    isRestored: () => restored,
    restore() {
      if (restored) return false;
      if (original.hasChat) context.chat = original.chat;
      else delete context.chat;
      if (original.hasMetadata) context.chatMetadata = original.chatMetadata;
      else delete context.chatMetadata;
      restored = true;
      return true;
    },
  });
}
