// Local-only actual renderer/appearance fixture. No ST data or service clients.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>千幕 · 本层插画面板隔离预览</title>
<style>body{margin:0;background:#e8ecec;color:#283b34;font:14px/1.55 system-ui}main{max-width:1040px;margin:auto;padding:18px}h1{font-size:20px;margin:0}p{margin:4px 0 12px}nav{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}button{padding:7px 12px;border:1px solid #869c93;background:#fff;color:#283b34;border-radius:7px;cursor:pointer}button[aria-pressed=true]{background:#375c4c;color:white}iframe{display:block;width:100%;height:800px;border:1px solid #75847e;border-radius:12px;margin:auto;background:#202124;box-sizing:border-box}iframe.narrow{width:min(390px,100%);height:700px}output{display:block;white-space:pre-wrap;font-size:12px;overflow-wrap:anywhere;min-height:24px}</style>
<main><h1>本层插画 · 自有面板预览</h1><p>真实生产 renderer + appearanceSession；模拟 ST 污染样式，无宿主聊天、持久写入或付费请求。</p>
<nav aria-label="预览控制"><button data-family="classic">经典</button><button data-family="glass">流光</button><button data-family="editorial">纸间</button><button id="dark">切换明暗</button><button id="narrow">切换窄屏</button><button id="open">重新打开</button><button id="tests">运行浏览器回归</button></nav><output id="report">正在打开隔离面板…</output><iframe title="本层插画隔离预览" src="/frame"></iframe></main><script type="module" src="/outer.js"></script></html>`;
const outer = `const frame=document.querySelector('iframe'),report=document.getElementById('report');let family='classic',dark=false;
const send=action=>frame.contentWindow.postMessage({action,family,dark},location.origin);
document.querySelectorAll('[data-family]').forEach(button=>button.onclick=()=>{family=button.dataset.family;send('theme');});
document.getElementById('dark').onclick=()=>{dark=!dark;send('theme');};document.getElementById('open').onclick=()=>send('open');document.getElementById('tests').onclick=()=>send('tests');
document.getElementById('narrow').onclick=()=>{const narrow=frame.classList.toggle('narrow');document.getElementById('narrow').setAttribute('aria-pressed',String(narrow));};
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame.contentWindow)return;report.textContent=event.data.report;});`;
const frame = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>本层插画真实组件</title>
<style>body{margin:0;background:#15171c;color:#eee;font:16px/1.6 Georgia,serif;--SmartThemeBlurTintColor:#191c20;--SmartThemeBodyColor:#eee;--SmartThemeQuoteColor:#eee}button{background:#ddd;color:#fff;border:2px solid #414247;border-radius:24px;text-shadow:0 0 3px #fff;box-shadow:0 0 4px #aaa}button[aria-pressed=true]{background:#eee;color:#eee}dialog{background:#14171b;color:#eee;border-radius:5px;text-shadow:0 0 3px black}dialog small{color:#101114}.popup{background:#15171c!important;color:#fff!important}.popup button{background:#e4e4e4!important;color:white!important}.host-label{padding:20px;opacity:.5}.fixture-trigger{position:absolute;left:20px;top:75px}</style>
<p class="host-label">模拟 ST 宿主 · 这些颜色不应污染千幕面板</p><button class="fixture-trigger">宿主原按钮</button><script type="module" src="/frame.js"></script></html>`;
const files = new Set(['style.css', 'qianmu-text-collection-floor.css', 'qianmu-theme-skins.css', 'qianmu-storyboard-capture-view.js', 'qianmu-icon-renderer.js',
    'qianmu-appearance-session.js', 'qianmu-appearance-runtime.js', 'qianmu-appearance-settings.js', 'qianmu-appearance-portals.js',
    'qianmu-classic-palettes.js', 'qianmu-theme-surfaces.js', 'qianmu-theme-palette.js', 'qianmu-input-boundary.js']);
createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://127.0.0.1').pathname.slice(1);
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        let body, type;
        if (!path) { body = html; type = 'text/html'; }
        else if (path === 'frame') { body = frame; type = 'text/html'; }
        else if (path === 'outer.js') { body = outer; type = 'text/javascript'; }
        else if (path === 'frame.js') { body = await readFile(new URL('./storyboard-capture-preview-client.mjs', import.meta.url)); type = 'text/javascript'; }
        else if (files.has(path)) { body = await readFile(new URL('../' + path, import.meta.url)); type = path.endsWith('.css') ? 'text/css' : 'text/javascript'; }
        else { res.writeHead(404).end(); return; }
        res.writeHead(200, {'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; font-src 'none'"});
        res.end(body);
    } catch (error) { console.error(error.message); res.writeHead(500).end('Preview failed'); }
}).listen(18756, '127.0.0.1', () => console.log('Capture preview: http://127.0.0.1:18756/'));
