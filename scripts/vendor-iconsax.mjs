// Development-only vendoring of the small functional subset used by Qianmu.
// Official free API: https://docs.iconsax.io/mcp/ai-integration
// Icons remain integrated in application code; do not publish loose SVG packs.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const glyphs = {
  anchor:'qianmu-anchor', archive:'archive', 'arrow-clockwise':'refresh-right', 'arrow-counter-clockwise':'refresh-left',
  'arrow-down':'arrow-down-01', 'arrow-left':'arrow-left-01', 'arrow-right':'arrow-right-01', 'arrow-up':'arrow-up-01',
  'arrows-clockwise':'refresh-arrow-02', 'arrows-in':'qianmu-minimize', 'arrows-left-right':'swap-horizontal-01',
  'arrows-out':'maximize-3', 'arrows-out-simple':'maximize-4', backstage:'signpost', assistant:'ai-commentary', aperture:'ai-record-video',
  book:'book', 'book-bookmark':'book-saved', 'book-open':'book-open', 'book-open-text':'book-open', bookmark:'archive',
  bookmarks:'heart-circle', camera:'camera', 'caret-down':'arrow-down-02', 'caret-left':'arrow-left-02',
  'caret-right':'arrow-right-02', 'caret-up':'arrow-up-02', character:'user-tag', chat:'message-text',
  'chat-dots':'message-text', chats:'messages', check:'qianmu-check', 'check-circle':'tick-circle',
  'check-square':'tick-square', checks:'qianmu-checks', circle:'record', clear:'broom', clock:'clock',
  'cloud-moon':'moon', coffee:'coffee', context:'shapes', copy:'copy', coread:'book-open', cpu:'cpu',
  crosshair:'gps', database:'driver', 'dots-three':'more', 'download-simple':'document-download', eraser:'eraser',
  eye:'eye', 'eye-slash':'eye-slash', feather:'pen-tool', 'file-arrow-down':'document-download',
  'file-arrow-up':'document-upload', 'film-slate':'video-play', 'film-strip':'video-horizontal', flask:'lamp-charge',
  'floor-tools':'textalign-left', 'floppy-disk':'save-2', focus:'coffee', folder:'folder', 'folder-minus':'folder-minus',
  'folder-plus':'folder-add', funnel:'filter', gauge:'speedometer', gear:'setting-2', 'globe-hemisphere-east':'global',
  graph:'hierarchy-2', headphones:'headphone', highlighter:'brush', image:'gallery', 'image-regenerate':'refresh-arrow-02',
  images:'gallery', info:'info-circle', lightbulb:'lamp-on', link:'link', list:'menu', 'list-bullets':'task',
  'list-checks':'task-square', 'list-numbers':'task', 'lock-keyhole':'lock', 'magic-wand':'magicpen',
  'magnifying-glass':'search-normal', 'mask-happy':'happyemoji', 'microphone-stage':'microphone-2', minus:'minus',
  'minus-circle':'minus-circle', 'note-pencil':'note-2', notes:'note-text', package:'box', palette:'color-swatch', pause:'pause',
  pen:'pen-tool', 'pen-nib':'pen-tool-2', 'pencil-simple':'edit-2', plant:'tree', play:'qianmu-play', 'play-circle':'play-circle',
  'plugs-connected':'electricity', plus:'add', 'push-pin':'qianmu-pin', 'puzzle-piece':'component', question:'message-question',
  quotes:'quote-down', robot:'cpu-charge', rows:'row-vertical', screening:'video-octagon', selection:'scan', shield:'shield-tick',
  'skip-back':'previous', 'skip-forward':'next', sliders:'setting-4', 'sort-descending':'sort', 'speaker-high':'volume-high',
  'spinner-gap':'refresh-arrow-02', 'squares-four':'category', stack:'layer', star:'qianmu-star', 'star-half':'qianmu-star-half', stop:'qianmu-stop',
  'stop-circle':'stop-circle', syringe:'health', tag:'tag', target:'discover', tasks:'task-square', theater:'candy', 'text-aa':'text',
  'text-align-start':'textalign-left', tv:'monitor', 'text-underline':'text-underline', trash:'trash', 'trend-up':'trend-up',
  'upload-simple':'document-upload', user:'user', 'user-circle':'profile-circle', 'user-plus':'user-add',
  'video-camera':'video', 'voice-lines':'message-search', 'voice-reextract':'message-notif', 'voice-regenerate':'refresh-arrow-01', 'voice-playall':'sound',
  warning:'warning-2', 'wave-sine':'sound', world:'map', 'world-map':'radar', x:'qianmu-close',
};

export const fixedVariants = {'voice-lines':'outline','voice-reextract':'broken','voice-regenerate':'bold','voice-playall':'bold'};

const endpoint = 'https://app.iconsax.io/api/mcp';
const cache = path.join(tmpdir(), 'qianmu-iconsax-free-2026-10-01-exact');
const styles = {outline:'linear',bold:'bold',twotone:'twotone'};
const variantsFor = name => [...new Set([...Object.keys(styles), ...Object.entries(fixedVariants).filter(([semantic])=>glyphs[semantic]===name).map(([,variant])=>variant)])];
const sha = text => createHash('sha256').update(text).digest('hex');

export function normalizeIcon(svg) {
  if (!/^<svg\b/.test(svg) || !/viewBox="0 0 24 24"/.test(svg)) throw Error('Unexpected SVG viewport');
  // Official exports wrap artwork in a redundant full-viewport clip. Remove it,
  // including its repeated IDs, after verifying it is exactly the 24x24 rect.
  for (const match of svg.matchAll(/<defs>([\s\S]*?)<\/defs>/g)) {
    if (!/^\s*<clipPath id="[\w-]+">\s*<rect width="24" height="24" fill="(?:white|#[a-f\d]+)"\s*\/>\s*<\/clipPath>\s*$/i.test(match[1])) throw Error('Unexpected SVG defs');
  }
  let body = svg.replace(/^<svg\b[^>]*>/,'').replace(/<\/svg>\s*$/,'')
    .replace(/<defs>[\s\S]*?<\/defs>/g,'').replace(/ clip-path="url\(#[\w-]+\)"/g,'')
    .replace(/\s(?:fill|stroke)="(?:white|black|#[a-f\d]+)"/gi, m => m.replace(/="[^"]+"/, '="currentColor"'))
    .replace(/stroke-width="[\d.]+"/g,'stroke-width="2.5"').replace(/>\s+</g,'><').trim();
  if (/<(?!\/?(?:g|path|circle|rect|ellipse|line|polyline|polygon)\b)/i.test(body)
      || /(?:href|\bid\s*=|url\(|\bon\w+\s*=|<script|<style)/i.test(body)) throw Error('Unsafe SVG element or reference');
  const attributes = new Set(['d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','fill-rule','clip-rule','opacity','stroke-opacity','fill-opacity','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','width','height','points','transform','stroke-miterlimit','stroke-dasharray','stroke-dashoffset']);
  for (const match of body.matchAll(/([a-z][a-z-]*)\s*=/gi)) if (!attributes.has(match[1])) throw Error('Unexpected SVG attribute '+match[1]);
  return body;
}

async function get(name,style) {
  const target=path.join(cache,`${name}-${style}.json`);
  try { return JSON.parse(await readFile(target,'utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
  const response = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_icon',arguments:{name,style}}}),signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw Error(`${name}/${style}: HTTP ${response.status}`);
  const data=await response.json(), text=data.result?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'';
  const exactName=text.match(/^# 🎨 ([^\n]+?) \(/)?.[1];
  const sections=Object.fromEntries([...text.matchAll(/## Style: (\w+)\s*```svg\s*(<svg\b[\s\S]*?<\/svg>)\s*```/g)].map(match=>[match[1],match[2]]));
  // Four official location exports have the twotone style mislabelled null.
  // Only accept that known source defect after checking actual two-opacity line art.
  const nullTone=style==='twotone' && ['gps','global','routing-2'].includes(name) && /opacity="0\.4"/.test(sections.null||'') && /stroke=/.test(sections.null||'');
  const svg=sections[style] || (nullTone ? sections.null : '');
  if(data.error || data.result?.isError || exactName!==name || !svg) throw Error(`${name}/${style}: ${text.slice(0,220) || JSON.stringify(data.error)}`);
  let markup; try {markup=normalizeIcon(svg);} catch(error) {throw Error(`${name}/${style}: ${error.message} ${svg.match(/<defs>[\s\S]*?<\/defs>/)?.[0]||''}`);}
  const result={markup,sha256:sha(svg)};
  await writeFile(target,JSON.stringify(result)); return result;
}

if(process.argv.includes('--write')) {
  await mkdir(cache,{recursive:true});
  // The universal actions lacking a matching Iconsax silhouette retain the
  // existing Lucide geometry. Functional pin states must not become a map marker.
  const familiar={
    'qianmu-anchor':'<path d="M12 6v16"/><path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/><path d="M9 11h6"/><circle cx="12" cy="4" r="2"/>',
    'qianmu-minimize':'<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
    'qianmu-checks':'<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
    'qianmu-check':'<path d="M20 6 9 17l-5-5"/>',
    'qianmu-pin':'<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    'qianmu-close':'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'qianmu-play':'<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    'qianmu-stop':'<rect width="18" height="18" x="3" y="3" rx="2"/>',
    'qianmu-star':'<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
    'qianmu-star-half':'<path d="M12 18.338a2.1 2.1 0 0 0-.987.244L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.12 2.12 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.12 2.12 0 0 0 1.597-1.16l2.309-4.679A.53.53 0 0 1 12 2"/>',
  };
  const names=[...new Set([...Object.values(glyphs),'magic-star'])].sort(), result={}, hashes={}, pending=names.filter(name=>!familiar[name]).flatMap(name=>variantsFor(name).map(variant=>({name,variant,style:styles[variant]||variant}))), errors=[];
  for(const [name,body] of Object.entries(familiar)) for(const variant of Object.keys(styles)) (result[name]||={})[variant]=`<g fill="${['qianmu-pin','qianmu-star','qianmu-star-half','qianmu-play','qianmu-stop'].includes(name)&&variant==='bold'?'currentColor':'none'}" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
  await Promise.all(Array.from({length:4},async()=>{
    for(;;) { const item=pending.shift(); if(!item) break;
      try {const value=await get(item.name,item.style); (result[item.name]||={})[item.variant]=value.markup; hashes[`${item.name}/${item.style}`]=value.sha256;}
      catch(error) {errors.push(error.message);}
    }
  }));
  if(errors.length) { console.error(errors.join('\n')); process.exitCode=1; }
  else {
    const renderer=new URL('../qianmu-icon-renderer.js',import.meta.url), previous=await readFile(renderer,'utf8');
    const tail=previous.slice(previous.indexOf('export const QIANMU_ICON_SYSTEM_VERSION'));
    const art=Object.fromEntries(names.map(name=>[name,Object.fromEntries(variantsFor(name).map(variant=>[variant,result[name][variant]]))]));
    const header=`/** Icons by Iconsax - https://iconsax.io (Free License); familiar action subset Lucide 1.39.0 (ISC/MIT). See THIRD_PARTY_NOTICES.md. */\n// Generated functional subset, retrieved 2026-10-01/02 from the official free MCP endpoint.\n// Outline uses the corresponding linear artwork to expose an exact 2.5px stroke.\n// No icon fonts, remote assets, runtime downloads, observers or cache subsystem.\nexport const ICONSAX_STROKE_WIDTH = 2.5;\nexport const ICONSAX_FIXED_VARIANTS = Object.freeze(${JSON.stringify(fixedVariants,null,2)});\nexport const ICONSAX_GLYPH_NAMES = Object.freeze(${JSON.stringify(glyphs,null,2)});\nexport const ICONSAX_ICON_MARKUP = Object.freeze(${JSON.stringify(art,null,2)});\n\n`;
    await writeFile(renderer,header+tail);
    await writeFile(path.join(cache,'SOURCE-SHA256.json'),JSON.stringify(hashes,null,2));
    console.log(JSON.stringify({icons:names.length,variants:names.reduce((count,name)=>count+variantsFor(name).length,0),bytes:Buffer.byteLength(header),hash:sha(JSON.stringify(hashes)),cache}));
  }
}
