// Reserved registry for fonts shipped by a future Qianmu release.  Built-ins
// are code-owned resources: users can apply them, but they are not editable or
// uploaded as account originals.
const readers = new Map();

export function registerBuiltinFont(key, reader) {
  const id = String(key || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(id) || typeof reader !== 'function') throw new Error('内置字体注册信息无效');
  readers.set(id, reader);
  return () => { if (readers.get(id) === reader) readers.delete(id); };
}

export async function readBuiltinFont(key) {
  const reader = readers.get(String(key || ''));
  return reader ? reader() : null;
}

export function listBuiltinFonts() { return [...readers.keys()]; }

