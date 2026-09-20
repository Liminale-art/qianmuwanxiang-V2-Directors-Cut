import { collectionIconButton } from './qianmu-text-collection-presentation.js';

const WIDTH=1080,PADDING=84,FONT=34,LINE=56,MAX_HEIGHT=2560,MAX_PAGES=3;

// Pure geometry with an injected text measurer, shared by browser rendering and
// regression tests. Every nonblank paragraph remains intact; redundant empty
// lines become one normal paragraph gap, never artificial blank-page height.
export function layoutCollectionImage({text,header='',footer='',measure}={}) {
    if(typeof text!=='string'||!text.trim())throw Error('没有可保存的正文');
    if(text.length>30000)throw Error('文字过长，请在导出前缩短内容；最多可保存 3 张图片');
    if(typeof measure!=='function')throw TypeError('需要文字测量器');
    if(typeof header!=='string'||typeof footer!=='string'||header.length>160||footer.length>160)throw Error('页眉和页尾请各控制在 160 字以内');
    const segments=value=>typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)].map(item=>item.segment):Array.from(value);
    const lines=[],inner=WIDTH-PADDING*2;
    for(const paragraph of text.replace(/\r\n?/g,'\n').split('\n')){
        if(!paragraph.trim())continue;
        let line='',indent=FONT*2;
        for(const segment of segments(paragraph)){
            if(measure(segment)>inner-indent)throw Error('当前字体含有过宽字符，请更换字体后重试');
            if(line&&measure(line+segment)>inner-indent){lines.push({text:line,indent,gapAfter:0});line='';indent=0;}
            line+=segment;
        }
        lines.push({text:line,indent,gapAfter:12});
    }
    // Header/footer wrap instead of clipping long character names.
    const decoration=value=>{
        if(!value)return [];
        const output=[];let row='';
        for(const segment of segments(value.replace(/[\r\n]/g,' '))){
            if(row&&measure(row+segment)>inner){output.push(row);row='';}row+=segment;
        }
        if(row)output.push(row);
        if(output.length>4)throw Error('页眉或页尾过长，请缩短后再保存');
        return output;
    };
    const headerLines=decoration(header),footerLines=decoration(footer);
    const top=PADDING+(headerLines.length?headerLines.length*42+32:0),bottom=PADDING+(footerLines.length?footerLines.length*42+32:0);
    const capacity=MAX_HEIGHT-top-bottom,pages=[];let rows=[],contentHeight=0;
    const appendPage=()=>{
        if(pages.length>=MAX_PAGES)throw Error('文字超出 3 张图片的排版容量，请在导出前缩短内容；没有截断或保存不完整图片');
        const height=Math.max(WIDTH,Math.ceil(top+contentHeight+bottom));
        pages.push(Object.freeze({width:WIDTH,height,top,bottom,lines:Object.freeze(rows),headerLines:Object.freeze(headerLines),footerLines:Object.freeze(footerLines)}));rows=[];contentHeight=0;
    };
    for(const line of lines){
        const lineHeight=LINE+line.gapAfter;if(rows.length&&contentHeight+lineHeight>capacity)appendPage();
        rows.push(Object.freeze({...line,y:top+contentHeight}));contentHeight+=lineHeight;
    }
    if(rows.length)appendPage();
    return Object.freeze(pages);
}

function canvasBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('当前浏览器未能生成图片，请重试')),'image/png'));}

export async function renderCollectionImages({document,text,header,footer,colors={},fontFamily='sans-serif'}={}){
    const measureCanvas=document.createElement('canvas'),ctx=measureCanvas.getContext('2d');
    if(!ctx)throw Error('当前浏览器不支持文字存图');
    ctx.font=`${FONT}px ${fontFamily}`;
    const pages=layoutCollectionImage({text,header,footer,measure:value=>ctx.measureText(value).width}),images=[];
    // Sequential allocation: never keep three full-resolution canvas buffers.
    for(const page of pages){
        const canvas=document.createElement('canvas');canvas.width=page.width;canvas.height=page.height;
        const context=canvas.getContext('2d');if(!context)throw Error('当前浏览器无法分配图片画布');
        context.fillStyle=colors.background||'#292b2f';context.fillRect(0,0,canvas.width,canvas.height);
        context.textBaseline='top';context.fillStyle=colors.text||'#f0f0f0';context.font=`${FONT}px ${fontFamily}`;
        page.lines.forEach(line=>context.fillText(line.text,PADDING+line.indent,line.y));
        context.font=`28px ${fontFamily}`;context.fillStyle=colors.muted||colors.text||'#b8b8b8';
        page.headerLines.forEach((line,row)=>context.fillText(line,PADDING,PADDING+row*42));
        context.textAlign='right';
        page.footerLines.forEach((line,row)=>context.fillText(line,page.width-PADDING,page.height-page.bottom+32+row*42));
        context.textAlign='left';
        const blob=await canvasBlob(canvas);images.push({blob,width:page.width,height:page.height});canvas.width=canvas.height=1;
    }
    return images;
}

function resolvedColors(parent){
    const doc=parent.ownerDocument,view=doc.defaultView,style=view.getComputedStyle(parent),probe=doc.createElement('span');parent.append(probe);
    const color=(name,fallback)=>{probe.style.color=style.getPropertyValue(name).trim()||fallback;return view.getComputedStyle(probe).color;};
    const result={background:color('--sd-sticky-bg',style.backgroundColor==='rgba(0, 0, 0, 0)'?'#292b2f':style.backgroundColor),text:color('--sd-text',style.color),muted:color('--sd-muted',style.color)};
    probe.remove();return result;
}

export function openTextCollectionImageExport({parent,record,isCurrent,guard,download}={}){
    const document=parent?.ownerDocument,view=document?.defaultView;if(!parent?.isConnected||typeof isCurrent!=='function')throw Error('收藏页面已关闭');
    const dialog=document.createElement('dialog');dialog.className='qm-text-collection-dialog qm-text-collection-panel qm-text-collection-image-export';dialog.setAttribute('aria-label','收藏存图');
    dialog.innerHTML='<header><strong>收藏存图</strong></header><main><label>页眉（可留空）<input data-image-header maxlength="160"></label><textarea data-image-text aria-label="存图文字"></textarea><label>页尾（可留空）<input data-image-footer maxlength="160"></label></main><footer><p role="status" aria-live="polite"></p><div class="qm-text-collection-actions qm-text-collection-detail-actions"></div></footer>';
    const header=dialog.querySelector('[data-image-header]'),footer=dialog.querySelector('[data-image-footer]'),text=dialog.querySelector('textarea'),status=dialog.querySelector('[role="status"]');
    header.value=`${record.source.charName} & ${record.source.userName}`;footer.value=new Date(record.createdAt).toLocaleDateString('sv-SE');text.value=record.text;
    const close=collectionIconButton(document,'image-close','取消','x'),save=collectionIconButton(document,'image-save','保存图片','download-simple');dialog.querySelector('header').append(close);dialog.querySelector('.qm-text-collection-actions').append(save);
    let closed=false,busy=false;const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
    const stop=()=>{if(closed)return;closed=true;observer.disconnect();view.removeEventListener('pagehide',stop);if(dialog.open)dialog.close();dialog.remove();};
    const observer=new view.MutationObserver(()=>{if(!parent.isConnected||!dialog.isConnected||!isCurrent())stop();});
    const triggerDownload=download||((blob,name)=>{
        const url=view.URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();view.setTimeout(()=>view.URL.revokeObjectURL(url),60000);
    });
    dialog.addEventListener('click',async event=>{
        event.stopPropagation();const action=event.target.closest('button')?.dataset.collectionManage;
        if(action==='image-close'){stop();return;}if(action!=='image-save'||busy||!current())return;
        busy=true;save.disabled=true;header.disabled=footer.disabled=text.disabled=true;status.textContent='正在排版…';
        try{
            if(guard)await guard();if(!current())return;
            const images=await renderCollectionImages({document,text:text.value,header:header.value,footer:footer.value,colors:resolvedColors(parent),fontFamily:view.getComputedStyle(parent).getPropertyValue('--qm-collection-prose-font').trim()||'sans-serif'});
            if(!current())return;
            for(const [index,image] of images.entries()){if(guard)await guard();if(!current())return;await triggerDownload(image.blob,`千幕收藏-${record.createdAt}${images.length>1?'-'+(index+1):''}.png`);}
            if(current())status.textContent=`已生成 ${images.length} 张图片，请在浏览器下载中查看`;
        }catch(cause){if(current())status.textContent=String(cause.message||'存图失败，请重试').slice(0,180);}
        finally{busy=false;if(current()){save.disabled=false;header.disabled=footer.disabled=text.disabled=false;}}
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();stop();});
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape')event.stopPropagation();});dialog.addEventListener('close',stop);
    parent.append(dialog);observer.observe(document.documentElement,{subtree:true,childList:true});view.addEventListener('pagehide',stop);dialog.showModal();
    return {element:dialog,stop};
}
