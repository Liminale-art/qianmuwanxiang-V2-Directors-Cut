// Development-only in-memory fixture. It must never be passed a live host
// writer as an operation; install/restore only replace context references.
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const clone = value => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const temporaryId = () => `qianmu-memory-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Build a deterministic, memory-only Phase 1 sample for browser checks.
 * The shape deliberately stays within chat-owned storyboard fields; it is
 * not a persistence format and must never be passed to a host writer.
 */
export function createQianmuPhase1Fixture(options = {}) {
  const id = String(options.id || 'qianmu-phase1-fixture');
  if (!id || id.length > 120) throw new TypeError('fixture id is invalid');
  const floors = [
    { floor: 0, title: '夜班厨房', text: '水汽沿着窗框上升，角色A把火调小。' },
    { floor: 1, title: '餐桌边的停顿', text: '角色B没有回答，只把旧瓷杯推回两人之间。' },
    { floor: 2, title: '电车经过之前', text: '窗外的灯影切过桌面，镜头移向未说出口的手势。' },
  ];
  const entries = floors.map(item => ({
    mes: item.text,
    name: item.floor % 2 ? '角色B' : '角色A',
    is_user: false,
    send_date: item.floor + 1,
    extra: { qianmuTemporaryFixture: true, fixtureId: id, floor: item.floor },
  }));
  const storyboardImages = floors.map((item, index) => ({
    id: `${id}-image-${index + 1}`,
    kind: 'still',
    status: 'succeeded',
    temporary: true,
    fixtureId: id,
    floor: item.floor,
    messageRef: { floor: item.floor, chatKey: `temporary:${id}` },
    title: item.title,
    prompt: index === 0 ? 'cinematic kitchen, steam, medium shot' : index === 1 ? 'two people at a table, held silence' : 'tram light across a table, insert shot',
    negative: 'text, watermark',
    provider: 'novel',
    model: 'temporary-fixture',
    createdAt: index + 1,
  }));
  const storyboardCollections = [{
    id: `${id}-sequence`,
    name: '临时连续镜头',
    temporary: true,
    fixtureId: id,
    imageIds: storyboardImages.map(row => row.id),
  }];
  const layer = {
    schemaVersion: 8,
    temporary: true,
    fixtureId: id,
    storyboardImages,
    storyboardCollections,
  };
  return Object.freeze({ id, entries, layer: clone(layer), floors: clone(floors) });
}

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

  const defaults = createQianmuPhase1Fixture({ id });
  const entries = clone(options.entries || (options.entry ? [options.entry] : [defaults.entries[0]]));
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('fixture entries must be a non-empty array');
  const entry = entries[0];
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

  const chat = Array.isArray(original.chat) ? [...original.chat, ...entries] : entries;
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
