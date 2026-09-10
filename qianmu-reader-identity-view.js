// Display-only inputs. Identity ownership, ST access and persistence stay with the caller.
export function renderCoreadIdentityView({role, name, avatar, icon, kind = ''}, htmlEscape) {
  return `<div class="sd-reader-setup-identity">
    <${kind ? 'button type="button"' : 'span'} class="sd-reader-identity-avatar" ${kind ? `data-coread-identity="${kind}" aria-label="选择${kind === 'user' ? 'USER 人设' : 'CHAR 书友'}"` : ''}><i class="fa-solid ${icon}"></i>${avatar ? `<img src="${htmlEscape(avatar)}" alt="">` : ''}</${kind ? 'button' : 'span'}>
    <span class="sd-reader-setup-tag"><em>${htmlEscape(role)}</em><b title="${htmlEscape(name)}">${htmlEscape(name)}</b></span>
  </div>`;
}

export function renderCoreadIdentityChoicesView({user, chosen, choices}, htmlEscape) {
  return `<div class="sd-reader-identity-picker"><b>${user ? '选择人设' : '选择书友'}</b>
    <select class="text_pole" size="${Math.min(8, Math.max(3, choices.length + 1))}" aria-label="${user ? '人设名字' : '书友名字'}">
      <option value="" ${!chosen ? 'selected' : ''}>跟随当前聊天</option>
      ${choices.map(item => `<option value="${htmlEscape(item.key)}" ${chosen === item.key ? 'selected' : ''}>${htmlEscape(item.name)}</option>`).join('')}
    </select></div>`;
}
