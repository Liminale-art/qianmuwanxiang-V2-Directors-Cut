// Read-only fictional social panels. Reactions are bounded, session-local UI state:
// no host draft, account, storage, network or generation operation belongs here.
import { htmlEscape } from './qianmu-storyboard-utils.js';
import { qianmuIconMarkup } from './qianmu-icon-renderer.js';

const SESSION_LIMIT = 48;
const sessions = new Map();
const bindings = new WeakMap();
const text = value => typeof value === 'string' ? value.trim() : '';
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const icon = name => qianmuIconMarkup(`qm-regular-${name}`);

function normalizedItem(value) {
  const item = record(value);
  if (item.type === 'forum') return {
    type: 'forum', title: text(item.title),
    posts: list(item.posts).slice(0, 50).map(record).filter(post => text(post.author) && text(post.content)).map(post => ({
      author: text(post.author), handle: text(post.handle), content: text(post.content), time: text(post.time),
      replies: list(post.replies).slice(0, 30).map(record).filter(reply => text(reply.author) && text(reply.content))
        .map(reply => ({ author: text(reply.author), content: text(reply.content) })),
    })),
  };
  if (item.type === 'phone' && list(item.messages).length) return {
    type: 'phone', title: text(item.title), owner: text(item.owner),
    conversation_kind: item.conversation_kind === 'group' ? 'group' : 'direct',
    messages: list(item.messages).slice(0, 100).map(record).filter(message => text(message.sender) && text(message.content))
      .map(message => ({ sender: text(message.sender), content: text(message.content), time: text(message.time) })),
  };
  // Historical results stay readable, without pretending prose is a structured feed.
  if (['theater', 'phone'].includes(item.type) && text(item.content)) return {
    type: 'legacy', title: text(item.title), content: text(item.content),
    caption: item.type === 'phone' ? (text(item.owner) ? `${text(item.owner)}的手机` : '角色手机') : '历史番外',
  };
  return { type: 'empty' };
}

function identity(item) {
  const serialized = JSON.stringify(item);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < serialized.length; i++) {
    const code = serialized.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b, 33) ^ code;
  }
  return `social-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}-${serialized.length}`;
}

function session(key) {
  let value = sessions.get(key);
  if (!value) value = { likes: new Set(), bookmarks: new Set(), replies: new Set(), expanded: false };
  sessions.delete(key);
  sessions.set(key, value);
  while (sessions.size > SESSION_LIMIT) sessions.delete(sessions.keys().next().value);
  return value;
}

function avatar(name, small = false) {
  return `<span class="sd-social-avatar${small ? ' sd-social-avatar-small' : ''}" aria-hidden="true">${htmlEscape(Array.from(name)[0] || '·')}</span>`;
}

function action(kind, index, active, label, symbol, extra = '') {
  return `<button type="button" class="sd-social-action" data-qm-social-action="${kind}" data-social-index="${index}"
    ${kind === 'replies' ? 'aria-expanded' : 'aria-pressed'}="${active}" ${extra}>${icon(symbol)}<span class="sd-social-action-label">${label}</span></button>`;
}

function forumBody(item, key, state) {
  if (!item.posts.length) return '<p class="sd-muted sd-social-empty">尚未生成</p>';
  return `<div class="sd-social-panel sd-social-forum">
    <div class="sd-social-panel-head">${icon('globe-hemisphere-east')}<div><strong>${htmlEscape(item.title || '此刻的世界')}</strong><span>世界论坛</span></div></div>
    <div class="sd-social-feed">${item.posts.map((post, index) => {
      const liked = state.likes.has(index), bookmarked = state.bookmarks.has(index), expanded = state.replies.has(index);
      const repliesId = `${key}-replies-${index}`;
      return `<article class="sd-social-post">
        <header class="sd-social-author">${avatar(post.author)}<div><strong>${htmlEscape(post.author)}</strong>${post.handle ? `<span>${htmlEscape(post.handle.startsWith('@') ? post.handle : `@${post.handle}`)}</span>` : ''}</div>${post.time ? `<span class="sd-social-time">${htmlEscape(post.time)}</span>` : ''}</header>
        <p class="sd-social-post-content">${htmlEscape(post.content)}</p>
        <div class="sd-social-actions" aria-label="本地模拟互动">
          ${action('like', index, liked, liked ? '已赞' : '赞', 'bookmarks', 'title="仅本次阅读的模拟点赞"')}
          ${action('replies', index, expanded, `回复 ${post.replies.length}`, 'chat', `aria-controls="${repliesId}"${post.replies.length ? '' : ' disabled'}`)}
          ${action('bookmark', index, bookmarked, bookmarked ? '已收藏' : '收藏', 'bookmark', 'title="仅本次阅读的模拟收藏"')}
        </div>
        <div class="sd-social-replies" id="${repliesId}"${expanded ? '' : ' hidden'}>${post.replies.map(reply => `<div class="sd-social-reply">${avatar(reply.author, true)}<div><strong>${htmlEscape(reply.author)}</strong><p>${htmlEscape(reply.content)}</p></div></div>`).join('')}</div>
      </article>`;
    }).join('')}</div>
  </div>`;
}

function phoneBody(item, key, state) {
  if (!item.messages.length) return '<p class="sd-muted sd-social-empty">尚未生成</p>';
  const long = item.messages.length > 6, id = `${key}-messages`;
  const participants = [...new Set(item.messages.map(message => message.sender))];
  return `<div class="sd-social-panel sd-social-phone">
    <div class="sd-social-panel-head">${icon(item.conversation_kind === 'group' ? 'chats' : 'chat')}<div><strong>${htmlEscape(item.title || (item.conversation_kind === 'group' ? '群聊' : '消息'))}</strong><span>${htmlEscape(item.owner ? `${item.owner}的手机` : '角色手机')} · ${item.conversation_kind === 'group' ? `群聊 · ${participants.length}人发言` : '私信'}</span></div></div>
    <ol class="sd-social-messages" id="${id}">${item.messages.map((message, index) => {
      const own = message.sender === item.owner;
      return `<li class="sd-social-message${own ? ' sd-social-message-own' : ''}"${index >= 6 ? ` data-social-message-extra${state.expanded ? '' : ' hidden'}` : ''}>
        ${avatar(message.sender, true)}<div class="sd-social-message-main"><div class="sd-social-message-meta"><strong>${htmlEscape(message.sender)}</strong>${message.time ? `<span>${htmlEscape(message.time)}</span>` : ''}</div><p>${htmlEscape(message.content)}</p></div>
      </li>`;
    }).join('')}</ol>
    ${long ? `<button type="button" class="sd-social-expand" data-qm-social-action="messages" aria-expanded="${state.expanded}" aria-controls="${id}" data-social-remaining="${item.messages.length - 6}">${state.expanded ? '收起后续消息' : `展开后续 ${item.messages.length - 6} 条消息`}${icon('caret-down')}</button>` : ''}
  </div>`;
}

/** Render the complete Qianmu card. All model content is escaped, never HTML/URLs. */
export function renderCreativeSocialCard(value) {
  const item = normalizedItem(value), key = identity(item);
  const state = item.type === 'forum' || item.type === 'phone' ? session(key) : null;
  const body = item.type === 'forum' ? forumBody(item, key, state)
    : item.type === 'phone' ? phoneBody(item, key, state)
      : item.type === 'legacy' ? `<div class="sd-social-legacy">${item.title ? `<h4>${htmlEscape(item.title)}</h4>` : ''}<p>${htmlEscape(item.content)}</p></div>`
        : '<p class="sd-muted sd-social-empty">尚未生成</p>';
  const caption = item.type === 'legacy' ? item.caption : item.type === 'forum' ? '众人正在说' : item.type === 'phone' ? '消息一隅' : '';
  return `<section class="sd-card sd-director-extra-card sd-director-extra-interlude sd-creative-social" data-qm-social="${key}">
    <div class="sd-section-title"><h3>世界论坛</h3>${caption ? `<span>${htmlEscape(caption)}</span>` : ''}</div>${body}</section>`;
}

/** Bind once per current root; repeated renders cannot accumulate listeners. */
export function bindCreativeSocialEvents(root) {
  if (!root?.addEventListener) return () => {};
  bindings.get(root)?.();
  const onClick = event => {
    const button = event.target?.closest?.('button[data-qm-social-action]');
    if (!button || !root.contains(button) || button.disabled) return;
    const card = button.closest('.sd-creative-social'), key = card?.dataset.qmSocial;
    if (!key || !root.contains(card)) return;
    // A streamed host may be bound inside an already-bound modal. This action
    // belongs to the nearest reading root, not both delegated listeners.
    event.stopPropagation?.();
    const state = session(key), kind = button.dataset.qmSocialAction, index = Number(button.dataset.socialIndex);
    if (kind === 'like' || kind === 'bookmark') {
      const set = kind === 'like' ? state.likes : state.bookmarks;
      const selected = !set.has(index);
      if (selected) set.add(index); else set.delete(index);
      button.setAttribute('aria-pressed', String(selected));
      button.querySelector('.sd-social-action-label').textContent = kind === 'like' ? (selected ? '已赞' : '赞') : (selected ? '已收藏' : '收藏');
    } else if (kind === 'replies') {
      const expanded = !state.replies.has(index), target = card.querySelector(`[id="${button.getAttribute('aria-controls')}"]`);
      if (!target) return;
      if (expanded) state.replies.add(index); else state.replies.delete(index);
      target.hidden = !expanded;
      button.setAttribute('aria-expanded', String(expanded));
    } else if (kind === 'messages') {
      state.expanded = !state.expanded;
      card.querySelectorAll('[data-social-message-extra]').forEach(message => { message.hidden = !state.expanded; });
      button.setAttribute('aria-expanded', String(state.expanded));
      button.innerHTML = `${state.expanded ? '收起后续消息' : `展开后续 ${Number(button.dataset.socialRemaining) || 0} 条消息`}${icon('caret-down')}`;
    }
  };
  root.addEventListener('click', onClick);
  const dispose = () => {
    root.removeEventListener('click', onClick);
    if (bindings.get(root) === dispose) bindings.delete(root);
  };
  bindings.set(root, dispose);
  return dispose;
}

/** Call on new accepted results, chat changes and explicit result cleanup. */
export function resetCreativeSocialState() { sessions.clear(); }
