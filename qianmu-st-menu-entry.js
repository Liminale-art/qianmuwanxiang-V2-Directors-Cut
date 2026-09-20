import {QIANMU_HIVE_THEME_LOGO} from './qianmu-hive-theme-logo.js';

// One entry in ST's main hamburger menu. Never add an extra button to send_form.
export function renderQianmuStMenuEntry({document=globalThis.document,enabled,id,fallbackId,onOpen}={}){
 document.getElementById(fallbackId)?.remove();
 let entry=document.getElementById(id);
 if(!enabled){entry?.remove();return null;}
 const menu=document.querySelector('#options .options-content')||document.querySelector('#options');
 if(!menu){entry?.remove();return null;}
 if(entry?.dataset.qmStMenu==='true'){if(entry.parentElement!==menu)menu.append(entry);return entry;}
 entry?.remove();entry=document.createElement('a');entry.id=id;entry.className='interactable story-director-input-entry';
 entry.dataset.qmStMenu='true';entry.dataset.qmIconPreserve='';entry.tabIndex=0;entry.setAttribute('role','button');entry.setAttribute('aria-label','千幕');
 const glyph=document.createElement('span');glyph.className='qm-st-menu-logo';glyph.innerHTML=QIANMU_HIVE_THEME_LOGO;
 const svg=glyph.querySelector('svg');svg?.setAttribute('aria-hidden','true');
 for(const shape of svg?.querySelectorAll('[fill],path')||[])shape.setAttribute('fill','currentColor');
 const label=document.createElement('span');label.textContent='千幕';entry.append(glyph,label);
 entry.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();
  const options=document.querySelector('#options');
  if(options&&document.defaultView.getComputedStyle(options).display!=='none')document.querySelector('#options_button')?.click();
  onOpen?.();
 });
 entry.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();entry.click();}});
 menu.append(entry);return entry;
}
