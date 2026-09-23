import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createStAccountStorage, configureStAccountStorage} from '../../qianmu-st-account-storage.js';
import {createCharacterNativeStore} from '../../qianmu-character-native-store.js';
import {newCharacterArchive} from '../../qianmu-character-archive.js';
import {CHARACTER_NATIVE_SLOT} from '../../qianmu-character-native-contract.js';

export const namespace = 'st-user:character-native-fixture';
export const document = (name = 'Alice', category = 'char') => ({...newCharacterArchive(category), name, aliases: ['Alias'], ageStatus: 'adult',
  imagegen: {appearance: 'black hair', negative: 'exclude', sensitiveAppearance: 'private annotation', reference: null, preview: null, novelReference: {strength: 0, fidelity: 1}}});
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
export async function characterNativeFixture(t, {account = namespace} = {}) {
  const files = new Map(), calls = [], clients = []; let owner = account, active = true, hook = null, lose = false, at = 10;
  const fetchImpl = async (url, request = {}) => {
    const {origin, pathname: path} = new URL(url);
    assert.equal(origin, 'https://st.fixture.invalid'); assert.equal(request.cache, 'no-store'); assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'same-origin');
    assert.equal(request.headers.Authorization, undefined); assert.equal(request.headers['X-CSRF-Token'], 'synthetic');
    const call = {path, request}; calls.push(call); const result = await hook?.(call); if (result) return result;
    if (path === '/api/files/upload') {
      const {name, data} = JSON.parse(request.body), body = Buffer.from(data, 'base64').toString('utf8'), value = JSON.parse(body);
      files.set(name, body);
      if (lose && value.schema === 'qianmu.st-account-head.v1' && value.slot === CHARACTER_NATIVE_SLOT) { lose = false; throw Error('accepted directory; acknowledgement lost'); }
      return response({path: '/user/files/' + name});
    }
    assert.match(path, /^\/user\/files\/qianmu-v2-[a-f0-9]{64}-[a-z0-9-]+\.json$/);
    const body = files.get(path.split('/').at(-1)); return body === undefined ? response({}, 404) : response(body);
  };
  const createStorage = options => createStAccountStorage({...options, resolveNamespace: async () => owner,
    isCurrent: () => active && (!options?.isCurrent || options.isCurrent()), headers: () => ({'X-CSRF-Token': 'synthetic', Authorization: 'must-not-forward'}),
    fetchImpl, origin: 'https://st.fixture.invalid', cryptoImpl: webcrypto});
  const storage = await createStorage({maxBytes: 8 * 1024 * 1024}); clients.push(storage);
  const open = () => { const store = createCharacterNativeStore({createStorage, now: () => at}); clients.push(store); return store; };
  t.after(() => clients.forEach(client => client.close()));
  const configure = () => configureStAccountStorage({resolveNamespace: async () => owner, isCurrent: () => active,
    headers: () => ({'X-CSRF-Token': 'synthetic', Authorization: 'must-not-forward'}), fetchImpl, origin: 'https://st.fixture.invalid', cryptoImpl: webcrypto});
  return {files, calls, storage, open, createStorage, fetchImpl, configure, reset() { calls.length = 0; }, setTime(value) { at = value; }, account(value) { owner = value; }, live(value) { active = value; },
    hook(value) { hook = value; }, loseAck() { lose = true; }, async readIndex() { return storage.read(CHARACTER_NATIVE_SLOT); },
    async writeIndex(value) { const old = await storage.read(CHARACTER_NATIVE_SLOT); return storage.write(CHARACTER_NATIVE_SLOT, value, {expectedFingerprint: old.fingerprint}); },
    get originalReads() { return calls.filter(row => row.request.method === 'GET' && row.path.includes('-character-record-')).length; },
    get uploads() { return calls.filter(row => row.request.method === 'POST').length; }};
}
