import {normalizeCharacterArchive} from './qianmu-character-archive.js';
import {sameCharacterSubject} from './qianmu-user-identity.js';
import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {characterBindingTarget} from './qianmu-character-archive.js';
import {characterBackupBindingKey, validateCharacterLibraryBackup, planCharacterLibraryRestore, characterLibraryBackupDigest} from './qianmu-character-library-backup.js';
import {readCharacterImport,planCharacterImport} from './qianmu-character-import.js';
import {CHARACTER_NATIVE_SLOT, characterNativeFail as fail, characterNativeAccount, characterNativeId, characterNativeBytes as bytes,
  characterNativeEqual as equal, characterNativeStoredHead as storedHead, characterNativeStoredBinding as storedBinding,
  characterNativeUsage, emptyCharacterNativeIndex, validateCharacterNativeIndex, characterNativeBackup, createCharacterNativeOriginals} from './qianmu-character-native-contract.js';

// Pure presentation projection of an already validated directory. Session
// selection may reuse its own read for the first overview, never for a write.
export function characterNativeOverview(namespace,index){
  return {rows:index.archives.map(row=>storedHead(namespace,row.head)).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)),
    bindings:index.bindings.map(row=>storedBinding(namespace,row)),imports:(index.imports||[]).filter(row=>row.pending.length).map(row=>({digest:row.digest,count:row.pending.length}))};
}

// Native archive-store interface, selected by the common archive session in
// both main-thread and Worker consumers. Existing local originals are migrated
// separately; selection never sends reads and writes to different libraries.
export function createCharacterNativeStore({createStorage = createConfiguredStAccountStorage, now = Date.now, randomUUID = () => globalThis.crypto?.randomUUID(), requireExisting = false} = {}) {
  let opening, storage, closed = false, knownLibrary = requireExisting === true;
  const freshId = () => { const value = randomUUID(); if (!characterNativeId(value)) fail('secure', '角色库需要安全的唯一编号'); return value; };
  const checkId = value => { if (!characterNativeId(value)) fail('id', '角色档案编号无效'); };
  const checkDigest=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('id','旧资料来源编号无效');};
  const findImport=(index,digest)=>{const row=index.imports?.find(row=>row.digest===digest);if(!row)fail('changed','旧资料来源已变化，请重新打开');return row;};
  const clock = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) fail('index', '角色库时间无效'); return value; };
  async function operation(namespace, options, work) {
    characterNativeAccount(namespace);
    const current = options?.isCurrent ?? (() => true);
    if (typeof current !== 'function') fail('changed', '角色库缺少当前身份保护');
    const check = () => { if (closed || options?.signal?.aborted || current() !== true) fail('changed', '角色库页面或账户已变化'); };
    check();
    if (!opening) opening = Promise.resolve().then(() => createStorage({isCurrent: () => !closed, maxBytes: 8 * 1024 * 1024})).then(value => {
      if (closed) { value.close(); fail('changed', '角色库会话已关闭'); } storage = value; return value;
    }).catch(error => { opening = null; throw error; });
    const client = await opening; check();
    if (client.namespace !== namespace) fail('account', '角色库不属于当前 ST 账户');
    const transport = {signal: options?.signal, guard: () => { check(); return true; }}, context = {namespace, scope: client.scope};
    const originals = createCharacterNativeOriginals(client);
    let committed = false;
    const validate = value => validateCharacterNativeIndex(value, context);
    const read = async () => {
      const result = await client.read(CHARACTER_NATIVE_SLOT, transport); check();
      if (!result.exists && knownLibrary) fail('index', '已确认的 ST 角色库目录不可读，未重新建立空库');
      const index = validate(result.exists ? result.value : emptyCharacterNativeIndex(namespace));
      if (result.exists) knownLibrary = true;
      return {index, fingerprint: result.fingerprint};
    };
    const update = async transform => {
      const saved = await client.update(CHARACTER_NATIVE_SLOT, value => {
        if (value === null && knownLibrary) fail('index', '已确认的 ST 角色库目录不可读，未覆盖为空库');
        check(); const index = validate(value === null ? emptyCharacterNativeIndex(namespace) : value), before = structuredClone(index);
        transform(index); index.usage = {count: index.archives.length, bytes: characterNativeUsage(index.archives), bindings: index.bindings.length};
        if (!equal(index, before)) { if (index.revision >= Number.MAX_SAFE_INTEGER) fail('capacity', '角色库目录版本达到上限'); index.revision++; }
        return validate(index);
      }, transport);
      committed = true; knownLibrary = true; check(); return validate(saved.value);
    };
    try { const result = await work({client, check, transport, originals, read, update}); check(); return result; }
    catch (error) { if (committed && error instanceof Error) error.writeState = 'unconfirmed'; throw error; }
  }
  const archive = (index, id) => index.archives.find(row => row.head.id === id);
  const expectArchive = (index, id, previous) => {
    if (!equal(archive(index, id) || null, previous || null)) fail('conflict', '档案已被另一页修改，请重新载入或另存副本');
  };
  const replaceArchive = (index, row) => {
    index.archives = [...index.archives.filter(item => item.head.id !== row.head.id), row];
    index.retired.archives = index.retired.archives.filter(id => id !== row.head.id);
  };
  const putBinding = (index, row) => {
    const key = characterBackupBindingKey(row);
    index.bindings = [...index.bindings.filter(item => characterBackupBindingKey(item) !== key), row];
    index.retired.bindings = index.retired.bindings.filter(item => item !== key);
  };
  const retireBinding = (index, key) => {
    index.bindings = index.bindings.filter(row => characterBackupBindingKey(row) !== key);
    if (!index.retired.bindings.includes(key)) index.retired.bindings.push(key);
  };
  const makeHead = (id, document, previous) => {
    const at = clock();
    return {id, revision: freshId(), version: (previous?.version || 0) + 1, category: document.category, name: document.name,
      aliases: document.aliases, cover: document.imagegen.preview?.url || '', bytes: bytes(document),
      createdAt: previous?.createdAt ?? at, updatedAt: Math.max(at, previous?.updatedAt || 0)};
  };
  async function snapshot(index, originals, transport, check) {
    const archives = [];
    for (const row of index.archives) { check(); archives.push(await originals.read(row, transport)); check(); }
    return characterNativeBackup(index.namespace, archives, index.bindings);
  }
  return Object.freeze({
    overview(namespace){return operation(namespace,null,async({read})=>{
      const {index}=await read();return characterNativeOverview(namespace,index);
    });},
    legacyImports(namespace){return operation(namespace,null,async({read})=>(await read()).index.imports?.filter(row=>row.pending.length).map(row=>({digest:row.digest,count:row.pending.length}))||[]);},
    previewLegacyImport(namespace,digest){checkDigest(digest);return operation(namespace,null,async({read,client,transport})=>{
      const {index,fingerprint}=await read(),receipt=findImport(index,digest),source=await readCharacterImport(client,receipt,transport);
      const plan=planCharacterImport(index,source,{reviewKeys:receipt.pending});return {digest,fingerprint,conflicts:plan.conflicts};
    });},
    legacyDocument(namespace,{digest,id}){checkDigest(digest);checkId(id);return operation(namespace,null,async({read,client,transport,originals})=>{
      const {index}=await read(),source=await readCharacterImport(client,findImport(index,digest),transport),row=source.archives.find(item=>item.head.id===id);
      if(!row)fail('changed','此旧资料来源没有对应档案');return originals.read(row,transport);
    });},
    resolveLegacyImport(namespace,{digest,expectedFingerprint,decisions},{confirmed=false,isCurrent=()=>true,signal}={}){
      checkDigest(digest);checkDigest(expectedFingerprint);if(confirmed!==true)fail('backup','请明确确认旧资料核对选择');
      const choices=structuredClone(decisions);
      if(!choices||typeof choices!=='object'||Array.isArray(choices))fail('choice_stale','旧资料核对选择无效');
      return operation(namespace,{isCurrent,signal},async({read,client,transport,originals,check,update})=>{
        const {index,fingerprint}=await read();if(fingerprint!==expectedFingerprint)fail('conflict','核对期间角色库已变化，请重新打开');
        const receipt=findImport(index,digest),source=await readCharacterImport(client,receipt,transport);
        const plan=planCharacterImport(index,source,{reviewKeys:receipt.pending,decisions:choices});
        if(!plan.ready)fail('choice_stale','请逐项选择如何保留旧资料');
        for(const row of source.archives)if(choices[`archive:${row.head.id}`]==='source'){await originals.read(row,transport);check();}
        plan.next.imports=plan.next.imports.map(row=>row.digest===digest?{...row,pending:[]}:row);
        await update(next=>{if(!equal(next,index))fail('conflict','核对提交期间角色库已变化，未覆盖');Object.assign(next,plan.next);});
        return {resolved:receipt.pending.length};
      });
    },
    list(namespace) { return operation(namespace, null, async ({read}) => {
      const {index} = await read(); return index.archives.map(row => storedHead(namespace, row.head)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    }); },
    load(namespace, id) { checkId(id); return operation(namespace, null, async ({read, originals, transport}) => {
      const row = archive((await read()).index, id); if (!row) return null;
      const saved = await originals.read(row, transport); return {head: storedHead(namespace, saved.head), document: normalizeCharacterArchive(saved.document)};
    }); },
    save(namespace, {id = '', expectedRevision = '', document}) {
      if (id) checkId(id); if (expectedRevision) checkId(expectedRevision);
      const value = normalizeCharacterArchive(document), archiveId = id || freshId();
      return operation(namespace, null, async ({read, originals, transport, update}) => {
        const {index} = await read(), previous = archive(index, archiveId);
        if (id && !previous || previous && previous.head.revision !== expectedRevision || !id && (expectedRevision || previous || index.retired.archives.includes(archiveId))) fail('conflict', '档案已变化，未覆盖原件');
        if (previous && previous.head.category !== value.category) fail('category', '已有档案不能直接更改分类，请复制为新档案');
        const head = makeHead(archiveId, value, previous?.head);
        // Capacity/version checks precede any original upload.
        characterNativeBackup(namespace, [{head, document: value}], []);
        if (index.archives.length + Number(!previous) > 512 || index.usage.bytes - (previous?.head.bytes || 0) + head.bytes > 16 * 1024 * 1024) fail('capacity', '角色库达到 512 项或 16 MB 上限');
        const row = await originals.preserve({head, document: value}, transport);
        await update(next => { expectArchive(next, archiveId, previous); if (!previous && next.retired.archives.includes(archiveId)) fail('conflict', '此角色编号已删除，未重新引入'); replaceArchive(next, row); });
        return storedHead(namespace, head);
      });
    },
    createOnce(namespace, {id, document}, {isCurrent, signal} = {}) {
      checkId(id); if (typeof isCurrent !== 'function') fail('changed', '固定档案缺少当前身份保护');
      const value = normalizeCharacterArchive(document);
      return operation(namespace, {isCurrent, signal}, async ({read, originals, transport, update}) => {
        const {index} = await read(), previous = archive(index, id);
        if (previous) {
          const saved = await originals.read(previous, transport);
          if (saved.head.version !== 1 || !equal(saved.document, value)) fail('conflict', '此人物已有固定档案或已被编辑，不会覆盖');
          return {head: storedHead(namespace, saved.head), created: false};
        }
        if (index.retired.archives.includes(id)) fail('conflict', '此固定档案已删除，不会因重试恢复');
        const head = makeHead(id, value);
        if (index.archives.length >= 512 || index.usage.bytes + head.bytes > 16 * 1024 * 1024) fail('capacity', '角色库达到 512 项或 16 MB 上限');
        const row = await originals.preserve({head, document: value}, transport);
        try {
          await update(next => { expectArchive(next, id, null); if (next.retired.archives.includes(id)) fail('conflict', '此固定档案已删除'); replaceArchive(next, row); });
        } catch (error) {
          // Another same-realm createOnce may have published the identical first
          // version while its original was being prepared. Acknowledge only a
          // freshly verified winner; never retry a write or hide a lost receipt.
          if (error?.code !== 'character_archive_conflict') throw error;
          const winner = archive((await read()).index, id); if (!winner) throw error;
          const saved = await originals.read(winner, transport);
          if (saved.head.version !== 1 || !equal(saved.document, value)) throw error;
          return {head: storedHead(namespace, saved.head), created: false};
        }
        return {head: storedHead(namespace, head), created: true};
      });
    },
    bindings(namespace) { return operation(namespace, null, async ({read}) => (await read()).index.bindings.map(row => storedBinding(namespace, row))); },
    bind(namespace, {target, archiveId = '', expectedRevision = '', inherit = false}) {
      const captured = characterBindingTarget(target); if (archiveId) checkId(archiveId); if (expectedRevision) checkId(expectedRevision);
      const key = characterBackupBindingKey(captured);
      return operation(namespace, null, async ({update}) => {
        let result = null;
        await update(index => {
          if (!inherit && captured.category === 'user' && index.bindings.some(row => sameCharacterSubject(row, captured) && row.subjectKey !== captured.subjectKey)) fail('alias', '同一USER存在其他地址写法，请先核对USER地址');
          const previous = index.bindings.find(row => characterBackupBindingKey(row) === key);
          if ((previous?.revision || '') !== expectedRevision) fail('conflict', '绑定已被另一页修改，请刷新后重试');
          if (inherit) { retireBinding(index, key); return; }
          if (archiveId && archive(index, archiveId)?.head.category !== captured.category) fail('binding', '档案不存在或分类不匹配');
          const row = {...captured, archiveId, revision: freshId(), updatedAt: clock()}; putBinding(index, row); result = storedBinding(namespace, row);
        });
        return result;
      });
    },
    remove(namespace, id, expectedRevision) {
      checkId(id); checkId(expectedRevision);
      return operation(namespace, null, async ({update}) => {
        await update(index => {
          const previous = archive(index, id);
          if (!previous || previous.head.revision !== expectedRevision) fail('conflict', '档案已变化，请刷新后删除');
          if (index.bindings.some(row => row.archiveId === id)) fail('bound', '此档案仍有绑定，请解除后删除');
          index.archives = index.archives.filter(row => row.head.id !== id); index.retired.archives.push(id);
        }); return {removed: true};
      });
    },
    backupSources(namespace,options={}){return operation(namespace,options,async ctx=>{const module=await import('./qianmu-character-source-native.js');ctx.check();return module.backupNativeCharacterSources(ctx);});},
    previewSources(namespace,input,options={}){const captured=structuredClone(input);return operation(namespace,options,async ctx=>{const module=await import('./qianmu-character-source-native.js');ctx.check();return module.previewNativeCharacterSources(ctx,captured);});},
    verifySources(namespace,input,options={}){const captured=structuredClone(input);return operation(namespace,options,async ctx=>{const module=await import('./qianmu-character-source-native.js');ctx.check();return module.verifyNativeCharacterSources(ctx,captured);});},
    restoreSources(namespace,input,options={}){if(options.confirmed!==true)fail('backup','请明确确认保全角色旧来源');const captured=structuredClone(input);return operation(namespace,options,async ctx=>{const module=await import('./qianmu-character-source-native.js');ctx.check();return module.restoreNativeCharacterSources(ctx,captured);});},
    backup(namespace, {isCurrent = () => true, signal} = {}) { return operation(namespace, {isCurrent, signal}, async ({read, originals, transport, check}) => snapshot((await read()).index, originals, transport, check)); },
    restoreBackup(namespace, input, {expectedDigest, decisions = {}, confirmed = false, isCurrent = () => true, signal} = {}) {
      if (confirmed !== true || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) fail('backup', '请先核对并明确确认角色库恢复');
      const incoming = structuredClone(input), choices = structuredClone(decisions); validateCharacterLibraryBackup(incoming);
      if (incoming.namespace !== namespace) fail('backup', '角色库备份属于另一 ST 账户');
      return operation(namespace, {isCurrent, signal}, async ({read, originals, transport, check, update}) => {
        const {index} = await read(), local = await snapshot(index, originals, transport, check);
        if (await characterLibraryBackupDigest(local) !== expectedDigest) fail('conflict', '角色库已变化，请重新核对恢复'); check();
        const plan = planCharacterLibraryRestore(local, incoming, {decisions: choices});
        if (!plan.ready) fail('backup', '角色库仍有未确认的恢复冲突');
        const rows = [];
        for (const row of plan.archiveWrites) { check(); rows.push(await originals.preserve(row, transport)); }
        await update(next => {
          if (!equal(next, index)) fail('conflict', '保存期间角色库已变化，未覆盖其他更新');
          for (const row of rows) replaceArchive(next, row);
          for (const row of plan.bindingWrites) putBinding(next, row);
        }); return plan.summary;
      });
    },
    applyUserAliasReview(namespace, input, {expectedBindings, expectedHeads, confirmed = false, isCurrent = () => true, signal} = {}) {
      if (confirmed !== true) fail('alias', '请明确确认USER地址整理');
      const captured = structuredClone(input), bindings = structuredClone(expectedBindings), heads = structuredClone(expectedHeads);
      return operation(namespace, {isCurrent, signal}, async ({check, update}) => {
        const codec = await import('./qianmu-user-alias.js'), review = await codec.inspectUserAliasReview(captured); check();
        if (review.namespace !== namespace) fail('alias', 'USER凭据不属于当前账户');
        const before = codec.projectAliasBindings(bindings, namespace), choices = Object.fromEntries(review.selections.map(row => [row.groupId, row.candidateId]));
        const plan = await codec.planUserAliases({namespace, chatHash: review.chatHash, bindings: before, choices, resolveTargets: async () => review.targets}); check();
        if (!plan.ready || plan.review.digest !== review.digest || !Array.isArray(heads) || heads.length > 512) fail('alias', '原USER地址关系已经变化，未覆盖');
        const sorted = rows => rows.slice().sort((a, b) => a.key.localeCompare(b.key));
        await update(index => {
          if (!equal(sorted(index.archives.map(row => storedHead(namespace, row.head))), sorted(heads))
            || !equal(sorted(index.bindings.map(row => storedBinding(namespace, row))), sorted(bindings))) fail('conflict', 'USER整理确认后角色或绑定已变化，请重新核对');
          for (const row of plan.affected) retireBinding(index, characterBackupBindingKey(row));
          for (const row of plan.writes) putBinding(index, row);
        }); return {before: plan.affected.length, after: plan.writes.length};
      });
    },
    usage(namespace) { return operation(namespace, null, async ({read}) => ({key: namespace, ...(await read()).index.usage, limit: 16 * 1024 * 1024})); },
    storageSummary(namespace, {isCurrent = () => true, signal} = {}) { return operation(namespace, {isCurrent, signal}, async ({read}) => {
      const {index} = await read(), bindingBytes = bytes(index.bindings), indexBytes = bytes(index) - bindingBytes;
      // Logical active text/index bytes, NOT physical ST disk usage or retained
      // immutable history/images. Reading this summary never opens originals.
      return {version: 1, status: 'ready', namespace, bytes: index.usage.bytes + bindingBytes + indexBytes, filesIncluded: false,
        documents: {count: index.usage.count, bytes: index.usage.bytes}, bindings: {count: index.usage.bindings, bytes: bindingBytes},
        indexes: {count: index.usage.count + 1, bytes: indexBytes}};
    }); },
    close() { closed = true; storage?.close(); },
  });
}
