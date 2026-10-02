import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderQianmuStMenuEntry} from '../qianmu-st-menu-entry.js';
import {QIANMU_HIVE_THEME_LOGO} from '../qianmu-hive-theme-logo.js';

// Isolated host DOM double: parses the actual static vector and dispatches events.
// It deliberately supplies no network or browser layout APIs.
function menuFixture({content = true} = {}) {
 const document = {};
 class Element {
  constructor(tag) {
   this.tagName = tag.toLowerCase(); this.children = []; this.parentElement = null;
   this.dataset = {}; this.attrs = {}; this.events = new Map(); this.className = '';
   this.id = ''; this.textContent = ''; this.ownerDocument = document;
   const declarations = new Map();
   this.style = {setProperty: (key, value) => declarations.set(key, String(value)), getPropertyValue: key => declarations.get(key) || ''};
  }
  setAttribute(key, value) {
   this.attrs[key] = String(value);
   if (key === 'id') this.id = String(value);
   if (key === 'class') this.className = String(value);
   if (key === 'style') for (const declaration of String(value).split(';')) {
    const colon = declaration.indexOf(':');
    if (colon >= 0) this.style.setProperty(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
   }
  }
  getAttribute(key) { return this.attrs[key] ?? null; }
  append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  matches(selector) {
   if (selector.startsWith('#')) return this.id === selector.slice(1);
   if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
   if (selector === '[fill]') return this.getAttribute('fill') !== null;
   return this.tagName === selector;
  }
  querySelectorAll(selector) { return all(this).filter(node => selector.split(',').some(part => node.matches(part.trim()))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(markup) {
   this.children.forEach(child => { child.parentElement = null; }); this.children = [];
   const stack = [this];
   for (const match of String(markup).matchAll(/<(\/?)([\w:-]+)\b([^>]*?)(\/?)>/g)) {
    if (match[1]) { stack.pop(); continue; }
    const child = new Element(match[2]);
    for (const attribute of match[3].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) child.setAttribute(attribute[1], attribute[3]);
    stack.at(-1).append(child); if (!match[4]) stack.push(child);
   }
  }
  addEventListener(type, handler) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(handler); }
  emit(type, extra = {}) {
   const event = {type, target: this, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra};
   for (const handler of this.events.get(type) || []) handler(event); return event;
  }
  click() { return this.emit('click'); }
 }
 const all = root => root.children.flatMap(child => [child, ...all(child)]);
 document.body = new Element('body'); document.createElement = tag => new Element(tag);
 document.getElementById = id => all(document.body).find(node => node.id === id) || null;
 document.querySelector = selector => {
  const parts = selector.split(/\s+/); let current = document.body;
  for (const part of parts) { current = current?.querySelector(part); if (!current) return null; }
  return current;
 };
 document.defaultView = {getComputedStyle: element => ({display: element.style.getPropertyValue('display') || 'block'})};
 const options = new Element('div'); options.id = 'options';
 const menu = content ? new Element('div') : options; if (content) { menu.className = 'options-content'; options.append(menu); }
 const trigger = new Element('button'); trigger.id = 'options_button';
 const sendForm = new Element('form'); sendForm.id = 'send_form';
 document.body.append(options, trigger, sendForm);
 const input = {document, enabled: true, id: 'story-director-input-entry', fallbackId: 'story-director-fallback'};
 return {document, options, menu, trigger, sendForm, input, all: () => all(document.body)};
}

test('host menu explicitly shows the real local SVG and inherits text color without changing the hive template', () => {
 const f = menuFixture(), original = QIANMU_HIVE_THEME_LOGO;
 const untouched = f.document.createElement('span'); untouched.innerHTML = original;
 const sharedSvg = untouched.querySelector('svg');
 assert.equal(sharedSvg.style.getPropertyValue('display'), 'none', 'shared hive template remains theme-gated');
 const entry = renderQianmuStMenuEntry(f.input), svg = entry.querySelector('svg');
 assert.ok(svg); assert.equal(svg.style.getPropertyValue('display'), 'block');
 assert.equal(svg.getAttribute('aria-hidden'), 'true');
 assert.equal(svg.getAttribute('viewBox'), sharedSvg.getAttribute('viewBox'));
 const paths = svg.querySelectorAll('path'); assert.ok(paths.length > 0);
 assert.deepEqual(paths.map(path => path.getAttribute('d')), sharedSvg.querySelectorAll('path').map(path => path.getAttribute('d')));
 for (const shape of svg.querySelectorAll('[fill],path')) assert.equal(shape.getAttribute('fill'), 'currentColor');
 assert.equal(QIANMU_HIVE_THEME_LOGO, original); assert.equal(sharedSvg.style.getPropertyValue('display'), 'none');
 assert.equal(entry.dataset.qmIconPreserve, '');
 assert.equal(entry.getAttribute('role'), 'button'); assert.equal(entry.getAttribute('aria-label'), '千幕'); assert.equal(entry.tabIndex, 0);
 assert.equal(entry.children.at(-1).textContent, '千幕');
 assert.doesNotMatch(original, /<(?:img|image|use|script)\b|\b(?:href|src)\s*=|url\(/i);
});

test('repeated mounting retains one entry, one SVG and one set of activation listeners', () => {
 const f = menuFixture(); let opened = 0;
 const input = {...f.input, onOpen: () => opened++}, entry = renderQianmuStMenuEntry(input);
 for (let i = 0; i < 20; i++) assert.equal(renderQianmuStMenuEntry(input), entry);
 assert.equal(f.all().filter(node => node.id === input.id).length, 1);
 assert.equal(entry.querySelectorAll('svg').length, 1); assert.equal(f.sendForm.children.length, 0);
 assert.equal(entry.events.get('click').size, 1); assert.equal(entry.events.get('keydown').size, 1);
 entry.click(); assert.equal(opened, 1);
});

test('legacy fallback is removed and an existing entry moves back into the current host menu', () => {
 const f = menuFixture(), fallback = f.document.createElement('button'); fallback.id = f.input.fallbackId; f.sendForm.append(fallback);
 const entry = renderQianmuStMenuEntry(f.input); assert.equal(fallback.parentElement, null);
 f.sendForm.append(entry); assert.equal(renderQianmuStMenuEntry(f.input), entry);
 assert.equal(entry.parentElement, f.menu); assert.equal(f.sendForm.children.length, 0);
 assert.equal(entry.querySelector('svg').style.getPropertyValue('display'), 'block');
});

test('missing content container falls back to options, while disabling or missing menu removes the owned entry', () => {
 const f = menuFixture({content: false}), entry = renderQianmuStMenuEntry(f.input);
 assert.equal(entry.parentElement, f.options);
 assert.equal(renderQianmuStMenuEntry({...f.input, enabled: false}), null);
 assert.equal(f.document.getElementById(f.input.id), null);
 const remounted = renderQianmuStMenuEntry(f.input); assert.notEqual(remounted, entry);
 f.sendForm.append(remounted); f.options.remove();
 assert.equal(renderQianmuStMenuEntry(f.input), null); assert.equal(remounted.parentElement, null);
 assert.equal(f.sendForm.children.length, 0);
});

test('an unowned legacy entry is replaced rather than producing a duplicate', () => {
 const f = menuFixture(), legacy = f.document.createElement('button'); legacy.id = f.input.id; f.menu.append(legacy);
 const entry = renderQianmuStMenuEntry(f.input); assert.notEqual(entry, legacy); assert.equal(legacy.parentElement, null);
 assert.equal(f.all().filter(node => node.id === f.input.id).length, 1);
 assert.equal(entry.dataset.qmStMenu, 'true');
});

test('click closes an open host menu before opening Qianmu and consumes the host action', () => {
 const f = menuFixture(), actions = []; f.trigger.addEventListener('click', () => actions.push('close'));
 const entry = renderQianmuStMenuEntry({...f.input, onOpen: () => actions.push('open')});
 const event = entry.click(); assert.deepEqual(actions, ['close', 'open']);
 assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
 f.options.style.setProperty('display', 'none'); entry.click(); assert.deepEqual(actions, ['close', 'open', 'open']);
});

test('Enter and Space activate once, unrelated keys leave the host keyboard event untouched', () => {
 const f = menuFixture(); let opened = 0;
 const entry = renderQianmuStMenuEntry({...f.input, onOpen: () => opened++});
 for (const key of ['Enter', ' ']) { const event = entry.emit('keydown', {key}); assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true); }
 assert.equal(opened, 2);
 for (const key of ['Escape', 'Tab', 'ArrowDown']) { const event = entry.emit('keydown', {key}); assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, false); }
 assert.equal(opened, 2);
});

test('the menu fix is cache-busted separately and stays local to its host entry', async () => {
 const [entry, source, css] = await Promise.all(['index.js', 'qianmu-st-menu-entry.js', 'style.css'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')));
 assert.match(entry, /from '\.\/qianmu-st-menu-entry\.js\?v=1\.59\.422'/);
 assert.match(entry, /from '\.\/qianmu-main-tabs\.js\?v=1\.59\.421'/);
 assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|Image)\s*\(|https?:\/\/|send_form[^\n]*append/);
 assert.match(css, /\.qm-st-menu-logo\s*\{[^}]*color:inherit;/);
 assert.match(css, /\.qm-st-menu-logo svg\s*\{[^}]*width:100%;height:100%;fill:currentColor;/);
});
