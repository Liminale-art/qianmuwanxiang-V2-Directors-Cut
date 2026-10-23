// Backup content is untrusted text. Never render a saved message as chat HTML.
// Keep autocomplete useful without imposing a new runtime dependency on
// installations that only ship the Qianmu extension.  Character cards may
// also expose aliases; those are included alongside the small built-in map.
const SEARCH_PINYIN = Object.freeze({
    琮: 'cong', 秦: 'qin', 铎: 'duo', 邓: 'deng', 霄: 'xiao', 钰: 'yu', 奉: 'feng',
    楚: 'chu', 瑾: 'jin', 瑜: 'yu', 沈: 'shen', 凌: 'ling', 苏: 'su', 维: 'wei', 塞: 'sai',
    维: 'wei', 斯: 'si', 赫: 'he', 拉: 'la', 斐: 'fei', 艾: 'ai', 瑞: 'rui', 克: 'ke',
    谢: 'xie', 洛: 'luo', 宁: 'ning', 安: 'an', 林: 'lin', 叶: 'ye', 花: 'hua', 夜: 'ye',
});
const searchTokensFor = (name, avatar, aliases = []) => {
    const text = String(name || ''), lower = text.toLocaleLowerCase();
    const pinyin = [...text].map(character => SEARCH_PINYIN[character] || character).join('').toLocaleLowerCase();
    const initials = [...text].map(character => (SEARCH_PINYIN[character] || character).charAt(0)).join('').toLocaleLowerCase();
    return [...new Set([lower, pinyin, initials, String(avatar || '').toLocaleLowerCase(), ...aliases.map(value => String(value).toLocaleLowerCase())])];
};
const matchesSearch = (row, query) => !query || (row.searchTokens || [row.searchName]).some(token => token.includes(query));
export function mountChatRecoveryView({ root, controller, getCharacters, confirm, notify = () => {}, onRecovered = () => {} } = {}) {
    const document = root.ownerDocument, OTHER = '__qianmu_other_backups__';
    let disposed = false, visibleLimit = 10, selectedAvatar = '', selection = '', search = '', selectionRevision = 0, suggestionDismissed = false, pickerOpen = false;
    // Keep preview data in the view so each expanded row owns its own
    // disclosure state. The controller still performs the bounded, verified
    // download; switching back to an already-open row never reloads it.
    const expandedPreviews = new Map();
    const expandedRows = new Set();
    let activePreviewName = '';
    const CHARACTER_BATCH = 50;
    let characterLimit = CHARACTER_BATCH, targetLimit = CHARACTER_BATCH, targetSearch = '', searchTimer = null, targetSearchTimer = null;
    let characterIndex = null, characterIndexRevision = 0;
    const pickerStates = new WeakMap();
    let hasRead = false;
    const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (label, action) => {
        const node = element('button', '', label); node.type = 'button';
        node.addEventListener('click', action); return node;
    };
    const run = async action => {
        try { await action(); }
        catch (error) { if (!disposed) notify(error?.message || '操作未完成，请核对后重试。', 'warning'); }
    };
    // ST already owns the loaded character array. Index it in one linear pass;
    // batching below controls DOM size, never changes the full search source.
    // The permanent native Assistant is a ST utility chat, not a user role.
    // Its avatar is stable even when a host localizes or otherwise changes the
    // displayed name, so hide it before building the picker and suggestions.
    const isNativeAssistant = row => {
        const avatar = String(row?.avatar || '').split(/[\\/]/).pop().toLocaleLowerCase();
        const name = String(row?.name || '').trim().toLocaleLowerCase();
        return avatar === 'default_assistant.png' || (avatar === 'assistant.png' && name === 'assistant');
    };
    const readCharacterIndex = () => {
        const raw = getCharacters?.() || [];
        let changed = !characterIndex || characterIndex.sources.length !== raw.length;
        for (let i = 0; !changed && i < raw.length; i++) {
            const old = characterIndex.sources[i], row = raw[i];
            changed = old.avatar !== row?.avatar || old.name !== row?.name;
        }
        if (!changed) return characterIndex;
        const sources = [], rows = [], names = new Map(), avatarCounts = new Map(), hiddenAvatars = new Set();
        for (const row of raw) {
            sources.push({ avatar: row?.avatar, name: row?.name });
            if (isNativeAssistant(row)) {
                if (typeof row?.avatar === 'string' && row.avatar) hiddenAvatars.add(row.avatar);
                continue;
            }
            if (typeof row?.avatar !== 'string' || !row.avatar) continue;
            const name = typeof row.name === 'string' ? row.name : '';
            const aliases = Array.isArray(row?.aliases) ? row.aliases : Array.isArray(row?.data?.aliases) ? row.data.aliases : [];
            rows.push({ avatar: row.avatar, name, searchName: name.toLocaleLowerCase(), searchTokens: searchTokensFor(name, row.avatar, aliases) });
            names.set(name, (names.get(name) || 0) + 1);
            avatarCounts.set(row.avatar, (avatarCounts.get(row.avatar) || 0) + 1);
        }
        for (const row of rows) row.label = names.get(row.name) > 1 ? `${row.name || '未命名角色'} · ${row.avatar}` : row.name || row.avatar;
        return characterIndex = { sources, rows, avatarCounts, hiddenAvatars, revision: ++characterIndexRevision };
    };
    const characters = () => readCharacterIndex().rows;
    const option = (label, value) => { const node = element('option', '', label); node.value = value; return node; };
    const invalidatePreview = () => { expandedPreviews.clear(); expandedRows.clear(); activePreviewName = ''; selectionRevision++; visibleLimit = 10; };
    const filteredRows = snapshot => {
        const currentCharacters = readCharacterIndex();
        const rows = (snapshot.backups || []).filter(row => !(Array.isArray(row.candidateAvatars)
            && row.candidateAvatars.some(avatar => currentCharacters.hiddenAvatars.has(avatar)))).filter(row => selection === OTHER
            ? row.match !== 'candidate' || !(row.candidateAvatars || []).some(avatar => currentCharacters.avatarCounts.get(avatar) === 1)
            : !!selection && (row.candidateAvatars || []).includes(selection));
        // Match ST's own chat list: the timestamp of the final conversation
        // floor is the primary order, regardless of file creation time or
        // message count. ST accepts both Unix milliseconds and its compact
        // humanized UTC form, while Qianmu snapshots normally carry ISO dates.
        const timestampOf = value => {
            if (typeof value === 'number') return Number.isFinite(value) ? value : null;
            if (typeof value !== 'string' || !value.trim()) return null;
            const text = value.trim();
            if (/^\d+$/.test(text)) {
                const number = Number(text);
                return Number.isFinite(number) ? number : null;
            }
            const humanized = /^(\d{4})-(\d{1,2})-(\d{1,2})@?(?:\s*)?(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?$/.exec(text)
                || /^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?$/.exec(text);
            if (humanized) {
                const [, year, month, day, hour, minute, second, millisecond = '0'] = humanized;
                const date = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond.padEnd(3, '0')));
                return Number.isFinite(date) ? date : null;
            }
            const date = Date.parse(text);
            return Number.isFinite(date) ? date : null;
        };
        return rows.sort((a, b) => {
            const timeA = timestampOf(a.lastMessageAt), timeB = timestampOf(b.lastMessageAt);
            if (timeA !== null || timeB !== null) {
                if (timeA === null) return 1;
                if (timeB === null) return -1;
                if (timeB !== timeA) return timeB - timeA;
            }
            const knownA = Number.isFinite(a.backupSort), knownB = Number.isFinite(b.backupSort);
            if (knownA !== knownB) return knownA ? -1 : 1;
            const dayA = a.backupDay || '', dayB = b.backupDay || '';
            return dayB.localeCompare(dayA) || String(a.timeZoneLabel || '').localeCompare(String(b.timeZoneLabel || ''))
                || ((Number.isFinite(b.backupSort) ? b.backupSort : -Infinity) - (Number.isFinite(a.backupSort) ? a.backupSort : -Infinity) || 0)
                || String(a.name).localeCompare(String(b.name));
        });
    };
    const tools = element('div', 'qm-recovery-tools qm-recovery-character-tools');
    const input = element('input'); input.type = 'search'; input.autocomplete = 'off'; input.placeholder = '搜索角色名'; input.setAttribute('aria-label', '搜索角色名');
    const suggestions = element('div', 'qm-recovery-role-suggestions');
    suggestions.setAttribute('role', 'listbox');
    input.addEventListener('input', () => {
        suggestionDismissed = false;
        selection = ''; selectedAvatar = ''; hasRead = false;
        invalidatePreview(); previewActions.hidden = true; recover.disabled = true;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { searchTimer = null; if (disposed) return; search = input.value; characterLimit = CHARACTER_BATCH; render(); }, 120);
    });
    const character = element('select', 'qm-recovery-character-select'); character.setAttribute('aria-label', '选择要找回的角色'); character.hidden = true; character.tabIndex = -1; character.setAttribute('aria-hidden', 'true');
    character.addEventListener('change', () => {
        selection = character.value; selectedAvatar = selection === OTHER ? '' : selection;
        const picked = readCharacterIndex().rows.find(row => row.avatar === selection);
        input.value = selection === OTHER ? '其他备份' : picked?.name || '';
        search = input.value;
        pickerOpen = false; hasRead = false; invalidatePreview(); render();
    });
    const characterControl = element('span', 'qm-recovery-character-control');
    const rolePicker = element('div', 'qm-recovery-role-picker'); rolePicker.hidden = true; rolePicker.setAttribute('role', 'listbox');
    const rolePickerList = element('div', 'qm-recovery-role-picker-list'); rolePicker.append(rolePickerList);
    const characterIcon = button('', () => {
        search = input.value;
        characterLimit = CHARACTER_BATCH;
        pickerOpen = !pickerOpen;
        render();
    });
    characterIcon.className = 'qm-recovery-icon-button'; characterIcon.innerHTML = '<i class="fa-solid fa-filter"></i><span class="qm-sr-only">选择角色</span>';
    characterIcon.setAttribute('aria-label', '选择角色');
    const moreCharacters = button('加载更多角色', () => { characterLimit += CHARACTER_BATCH; render(); });
    moreCharacters.className = 'qm-recovery-character-more'; moreCharacters.setAttribute('aria-label', '加载更多角色');
    rolePicker.append(moreCharacters);
    characterControl.append(characterIcon, character, rolePicker);
    const load = button('读取备份', () => run(async () => {
        if (!selection) return;
        invalidatePreview(); hasRead = true; render(); await controller.load();
    }));
    load.innerHTML = '<i class="fa-solid fa-rotate"></i><span class="qm-sr-only">读取备份</span>';
    load.setAttribute('aria-label', '读取备份');
    tools.append(characterControl, input, load);
    const nativePolicy = element('section', 'qm-recovery-native-policy');
    const nativePolicyField = element('label', 'qm-recovery-native-policy-field', '单聊天备份数上限');
    const nativePolicyInput = element('input'); nativePolicyInput.type = 'number'; nativePolicyInput.step = '1'; nativePolicyInput.placeholder = '读取后可设置'; nativePolicyInput.setAttribute('aria-label', '单聊天备份数上限');
    const nativePolicyStatus = element('p', 'qm-recovery-native-policy-status'); nativePolicyStatus.setAttribute('role', 'status'); nativePolicyStatus.hidden = true;
    nativePolicyField.append(nativePolicyInput); nativePolicy.append(nativePolicyField, nativePolicyStatus);
    nativePolicyInput.addEventListener('change', () => run(async () => {
        if (typeof controller.configureNativeBackupPolicy !== 'function') throw new Error('当前版本未提供 ST 原生备份设置接口');
        await controller.configureNativeBackupPolicy(Number(nativePolicyInput.value));
    }));
    const status = element('p', 'qm-recovery-status'); status.setAttribute('role', 'status');
    const loadedCount = element('small', 'qm-recovery-loaded');
    const list = element('div', 'qm-recovery-list');
    const loadMoreBackups = button('加载更多', () => { visibleLimit += 10; render(); });
    loadMoreBackups.className = 'qm-recovery-load-more';
    // Recovery actions remain shared because only one target can be active at
    // a time; the preview bodies themselves are rendered per row below.
    const previewActions = element('section', 'qm-recovery-preview qm-recovery-preview-actions');
    const targetLabel = element('label', '', '找回至角色');
    const targetTools = element('div', 'qm-recovery-target-tools');
    const targetInput = element('input', 'qm-recovery-target-search'); targetInput.type = 'search'; targetInput.placeholder = '搜索目标角色名'; targetInput.setAttribute('aria-label', '搜索目标角色名');
    targetInput.addEventListener('input', () => {
        selectionRevision++; clearTimeout(targetSearchTimer);
        targetSearchTimer = setTimeout(() => { targetSearchTimer = null; if (disposed) return; targetSearch = targetInput.value; targetLimit = CHARACTER_BATCH; render(); }, 120);
    });
    const target = element('select'); target.setAttribute('aria-label', '找回副本的目标角色');
    target.addEventListener('change', () => { selectedAvatar = target.value; selectionRevision++; render(); });
    target.append(option('请选择目标角色', ''));
    const moreTargets = button('加载更多目标角色', () => { targetLimit += CHARACTER_BATCH; render(); });
    moreTargets.className = 'qm-recovery-character-more';
    moreTargets.setAttribute('aria-label', '加载更多目标角色');
    targetTools.append(targetInput, target, moreTargets); targetLabel.append(targetTools);
    const recover = button('将当前所选聊天找回至所选角色', () => run(async () => {
        const before = controller.snapshot(), currentPreview = activePreviewName ? expandedPreviews.get(activePreviewName) : null;
        const name = currentPreview?.name, revision = currentPreview?.revision;
        const avatar = selectedAvatar, selectionToken = selectionRevision, matches = characters().filter(row => row.avatar === avatar);
        if (matches.length !== 1 || !name || !currentPreview.canRecover || before.busy) return;
        const characterName = matches[0].name;
        const after = controller.snapshot(), afterPreview = activePreviewName ? expandedPreviews.get(activePreviewName) : null, currentCharacters = characters().filter(row => row.avatar === avatar);
        if (disposed || selectedAvatar !== avatar || selectionRevision !== selectionToken || afterPreview?.name !== name || afterPreview?.revision !== revision
            || after.preview?.name !== name || after.preview?.revision !== revision || after.busy
            || currentCharacters.length !== 1 || currentCharacters[0].name !== characterName) return;
        const result = await controller.recover(avatar);
        // The native import route writes the file on disk, but ST's welcome
        // page keeps its recent-chat panel in the current DOM. Let the host
        // refresh that view after the controller has verified the new copy;
        // a refresh failure must not turn a successful recovery into an
        // error or invite a second import.
        try { await onRecovered(result); } catch {}
    }));
    previewActions.append(targetLabel, recover);

    root.replaceChildren(status, tools, nativePolicy, suggestions, loadedCount, list, previewActions);

    const createPreviewSection = currentPreview => {
        const section = element('section', 'qm-recovery-preview');
        const floorLimit = currentPreview.previewFloorLimit || 5;
        const previewHint = element('small', 'qm-recovery-preview-hint',
            `预览仅加载最后${floorLimit}层`);
        const body = element('div', 'qm-recovery-preview-body');
        body.append(previewHint);
        for (const message of currentPreview.previewMessages || []) {
            const details = element('details', 'qm-recovery-message');
            const summary = element('summary', '', `第 ${message.floor} 层 · ${message.name}`);
            const content = element('pre', '', message.text);
            details.append(summary, content);
            body.append(details);
        }
        section.append(body);
        return section;
    };

    function renderCharacterPicker(select, more, index, query, limit, selected, other = false) {
        const normalized = query.trim().toLocaleLowerCase(), previous = pickerStates.get(select);
        if (previous?.revision === index.revision && previous.query === normalized && previous.limit === limit && previous.selected === selected) return;
        const matching = previous?.revision === index.revision && previous.query === normalized
            ? previous.matching : index.rows.filter(row => matchesSearch(row, normalized));
        const shown = matching.slice(0, limit), nodes = [option(other ? '请选择角色' : '请选择目标角色', '')];
        // Keep an explicit current selection even outside this search/page.
        // A search never silently chooses a different role or clears a target.
        const current = index.rows.find(row => row.avatar === selected);
        if (current && !shown.some(row => row.avatar === selected)) nodes.push(option(`当前：${current.label}`, current.avatar));
        for (const row of shown) nodes.push(option(row.label, row.avatar));
        if (other) nodes.push(option('其他／未匹配备份', OTHER));
        select.replaceChildren(...nodes); select.value = selected;
        more.hidden = matching.length <= limit;
        more.textContent = `加载更多（${Math.min(limit, matching.length)} / ${matching.length}）`;
        pickerStates.set(select, { revision: index.revision, query: normalized, limit, selected, matching });
    }

    function render(snapshot = controller.snapshot()) {
        if (disposed) return;
        const index = readCharacterIndex(), allCharacters = index.rows;
        renderCharacterPicker(character, moreCharacters, index, search, characterLimit, selection, true);
        if (character.value !== selection) { selection = ''; selectedAvatar = ''; hasRead = false; invalidatePreview(); }
        // The role picker is a complete, batched list. Typing in the search box
        // only provides a nearby match; it must never hide the rest of the list.
        const pickerQuery = input.value.trim().toLocaleLowerCase();
        const pickerRows = index.rows;
        rolePicker.hidden = !pickerOpen || !!snapshot.busy;
        if (!rolePicker.hidden) {
            const choices = pickerRows.slice(0, characterLimit).map(row => {
                const choice = button(row.label, () => {
                    input.value = row.name;
                    search = row.name;
                    selection = row.avatar;
                    selectedAvatar = row.avatar;
                    character.value = row.avatar;
                    hasRead = false;
                    suggestionDismissed = true;
                    pickerOpen = false;
                    invalidatePreview();
                    render();
                    input.focus();
                });
                choice.className = `qm-recovery-role-option${selection === row.avatar ? ' is-selected' : ''}`;
                if (pickerQuery && matchesSearch(row, pickerQuery)) choice.setAttribute('data-query-match', 'true');
                choice.setAttribute('role', 'option');
                choice.setAttribute('aria-selected', String(selection === row.avatar));
                return choice;
            });
            const other = button('其他／未匹配备份', () => {
                input.value = '其他备份'; search = ''; selection = OTHER; selectedAvatar = '';
                character.value = OTHER; hasRead = false; suggestionDismissed = true; pickerOpen = false; invalidatePreview(); render();
            });
            other.className = `qm-recovery-role-option${selection === OTHER ? ' is-selected' : ''}`; other.setAttribute('role', 'option');
            rolePickerList.replaceChildren(...choices, other);
            if (pickerQuery) {
                const match = [...rolePickerList.children].find(node => node.getAttribute?.('data-query-match') === 'true');
                match?.scrollIntoView?.({ block: 'nearest' });
            }
        } else rolePickerList.replaceChildren();
        const rows = filteredRows(snapshot), currentPreview = activePreviewName ? expandedPreviews.get(activePreviewName) : null;
        const recoveredCurrent = currentPreview && Array.isArray(snapshot.recovered)
            ? snapshot.recovered.find(row => row.sourceName === currentPreview.name && row.target?.avatar === selectedAvatar)
            : null;
        load.classList.toggle('is-loading', !!snapshot.busy);
        load.disabled = !!snapshot.busy || !selection; input.disabled = !!snapshot.busy; character.disabled = !!snapshot.busy; characterIcon.disabled = !!snapshot.busy;
        moreCharacters.disabled = !!snapshot.busy;
        const result = snapshot.result;
        status.hidden = !(snapshot.busy || snapshot.error || result);
        status.classList.toggle('is-loading', !!snapshot.busy);
        status.replaceChildren();
        if (snapshot.busy) {
            status.append(element('span', 'qm-recovery-loading-dot'), element('span', '', '正在读取，请稍候…'));
        } else if (snapshot.error) status.append(element('span', '', snapshot.error));
        else if (result?.status === 'verified') status.textContent = `已将此聊天备份找回至${result.target?.name || '所选角色'}`;
        else if (result) status.append(element('span', '', result.status === 'conflict' ? '找到的文件与预期内容不一致，未覆盖或自动重试。' : '找回未完成，未创建副本。'));
        input.disabled = !!snapshot.busy;
        const policy = snapshot.nativeBackupPolicy || {};
        const policyBusy = policy.busy === true || snapshot.busy && snapshot.phase === 'native-policy';
        const policyAvailable = policy.availability === 'available';
        const policyWritable = policy.writable === true;
        nativePolicyInput.min = String(Number.isSafeInteger(policy.min) ? policy.min : 1);
        nativePolicyInput.max = String(Number.isSafeInteger(policy.max) ? policy.max : 500);
        nativePolicyInput.value = Number.isSafeInteger(policy.value) ? String(policy.value) : '';
        nativePolicyInput.disabled = !!snapshot.busy || !policyAvailable || !policyWritable;
        nativePolicyStatus.hidden = !(policyBusy || policy.error || policy.notice || policyAvailable && !policyWritable);
        nativePolicyStatus.classList.toggle('is-loading', policyBusy);
        const readOnlyNotice = policy.source === 'environment'
            ? '当前由 ST 环境变量控制，请修改部署环境变量并重启 ST'
            : '当前 ST 原生备份设置为只读';
        nativePolicyStatus.textContent = policyBusy ? '正在读取 ST 原生备份设置…'
            : policy.error || policy.notice || (policyAvailable && !policyWritable ? readOnlyNotice : '');
        const indexForSuggestions = readCharacterIndex();
        const suggestionQuery = input.value.trim().toLocaleLowerCase();
        const suggestionRows = suggestionQuery
            ? indexForSuggestions.rows.filter(row => matchesSearch(row, suggestionQuery)).slice(0, 50)
            : [];
        suggestions.hidden = suggestionDismissed || !suggestionQuery || suggestionRows.length === 0;
        suggestions.replaceChildren(...suggestionRows.map(row => {
            const suggestion = button(row.label, () => {
                input.value = row.name;
                search = row.name;
                selection = row.avatar;
                selectedAvatar = row.avatar;
                hasRead = false;
                invalidatePreview();
                suggestionDismissed = true;
                render();
                input.focus();
            });
            suggestion.className = 'qm-recovery-suggestion';
            suggestion.setAttribute('role', 'option');
            return suggestion;
        }));
        const loadedRole = selection === OTHER
            ? '其他备份'
            : allCharacters.find(row => row.avatar === selection)?.name || '当前角色';
        const loadedVisible = Math.min(rows.length, visibleLimit);
        loadedCount.textContent = snapshot.busy
            ? '正在读取备份…'
            : hasRead ? `当前已加载 ${loadedRole} ${loadedVisible} / ${rows.length} 份聊天记录` : '';
        loadedCount.hidden = !snapshot.busy && !hasRead;
        previewActions.hidden = !currentPreview;
        list.replaceChildren();
        const shownRows = rows.slice(0, visibleLimit);
        const formatLastMessage = value => {
            if (value === '' || value == null) return '';
            const date = new Date(value);
            return Number.isFinite(date.getTime()) ? date.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : String(value);
        };
        for (const row of shownRows) {
            const item = button('', () => run(async () => {
                const before = controller.snapshot(), epoch = selectionRevision;
                if (before.busy || !filteredRows(before).some(candidate => candidate.name === row.name)) return;
                if (expandedRows.has(row.name)) {
                    expandedRows.delete(row.name);
                    if (activePreviewName === row.name) {
                        const last = [...expandedRows].at(-1);
                        activePreviewName = last || '';
                    }
                    render();
                    return;
                }
                if (expandedPreviews.has(row.name)) {
                    expandedRows.add(row.name);
                    activePreviewName = row.name;
                    render();
                    return;
                }
                render(); await controller.preview(row.name);
                const after = controller.snapshot();
                if (disposed || epoch !== selectionRevision || after.preview?.name !== row.name || !filteredRows(after).some(candidate => candidate.name === row.name)) return;
                expandedPreviews.set(row.name, after.preview);
                expandedRows.add(row.name);
                activePreviewName = row.name;
                render();
            }));
            const displayName = typeof row.chatFile === 'string' && row.chatFile ? row.chatFile : row.name;
            item.className = 'qm-recovery-item'; item.disabled = !!snapshot.busy; item.title = displayName;
            const expanded = expandedRows.has(row.name);
            item.classList.toggle('is-selected', expanded);
            item.classList.toggle('is-active', activePreviewName === row.name);
            item.setAttribute('aria-pressed', String(expanded));
            const count = Number.isFinite(row.messageCount) ? `${row.messageCount} 条消息` : '消息数待预览';
            const title = element('span', 'qm-recovery-name', displayName);
            const titleLine = element('span', 'qm-recovery-title-line'); titleLine.append(title);
            const metadata = [count, row.size].filter(Boolean).join(' · ');
            const lastMessage = formatLastMessage(row.lastMessageAt);
            item.append(titleLine, element('small', 'qm-recovery-meta', metadata + (lastMessage ? ` · 最后对话 ${lastMessage}` : '')));
            if (row.excerpt) item.append(element('span', 'qm-recovery-excerpt', row.excerpt));
            const wrap = element('article', 'qm-recovery-row'); wrap.append(item);
            const rowPreview = expanded ? expandedPreviews.get(row.name) : null;
            if (rowPreview) wrap.append(createPreviewSection(rowPreview));
            list.append(wrap);
        }
        list.append(loadMoreBackups);
        loadMoreBackups.hidden = rows.length <= visibleLimit;
        loadMoreBackups.disabled = !!snapshot.busy;
        const matches = allCharacters.filter(row => row.avatar === selectedAvatar);
        targetLabel.hidden = selection !== OTHER;
        if (selection === OTHER) {
            renderCharacterPicker(target, moreTargets, index, targetSearch, targetLimit, selectedAvatar);
            if (target.value !== selectedAvatar) selectedAvatar = '';
        }
        target.disabled = !!snapshot.busy;
        targetInput.disabled = !!snapshot.busy; moreTargets.disabled = !!snapshot.busy;
        recover.textContent = `将当前所选聊天找回至${matches.length === 1 ? matches[0].label : '所选角色'}`;
        recover.disabled = !!snapshot.busy || matches.length !== 1 || !currentPreview?.canRecover || !!recoveredCurrent;
    }
    render();
    // The retention control is independent of role selection. Read it after
    // the local shell is painted so the panel is immediately visible, while
    // keeping older server plugins (without this route) non-blocking.
    if (typeof controller.inspectNativeBackupPolicy === 'function' && controller.snapshot()?.nativeBackupPolicy?.availability === 'unknown') {
        void run(() => controller.inspectNativeBackupPolicy());
    }
    return Object.freeze({ render, dispose() { disposed = true; clearTimeout(searchTimer); clearTimeout(targetSearchTimer); root.replaceChildren(); } });
}
