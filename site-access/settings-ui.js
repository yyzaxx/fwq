(()=>{
'use strict';
const site=document.currentScript.dataset.site;
const css=document.createElement('style');css.textContent=`
.sa-card{margin:18px 0;padding:18px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:12px;color:inherit;font:14px/1.6 system-ui;background:transparent}
.sa-card h3{font:600 15px system-ui;margin:0 0 6px}.sa-card p{margin:0 0 12px;opacity:.65;font-size:13px}
.sa-card button,.sa-close{font:inherit;color:inherit;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:7px;background:transparent;padding:7px 14px;cursor:pointer}
.sa-card iframe{display:block;width:100%;height:510px;border:0;margin-top:12px;border-radius:8px;background:#f4f6f9}
.sa-dialog{box-sizing:border-box;width:min(640px,94vw);max-height:90vh;overflow:auto;border:1px solid #8884;border-radius:16px;padding:24px;background:var(--fn-bg-elevated,var(--bg,#fff));color:var(--fn-text-primary,var(--text,#18202d))}
.sa-dialog::backdrop{background:#0005}.sa-dialog>header{display:flex;justify-content:space-between;align-items:center}.sa-dialog h2{font:600 20px system-ui;margin:0}
`;document.head.append(css);
function card(){const e=document.createElement('section');e.className='sa-card';e.dataset.siteAccess='card';e.innerHTML='<h3>访问密码</h3><p>为本网站设置访问密码；默认免密，可随时修改或关闭。</p><button type="button" aria-expanded="false">管理访问密码</button>';const b=e.querySelector('button');b.onclick=()=>{let f=e.querySelector('iframe');if(f){f.remove();b.setAttribute('aria-expanded','false');return}f=document.createElement('iframe');f.title='访问密码设置';f.src='/_access/settings?embedded=1';e.append(f);b.setAttribute('aria-expanded','true')};return e}
function attach(parent){if(parent&&!parent.querySelector('[data-site-access="card"]'))parent.append(card())}
function openSettings(){let d=document.querySelector('#sa-settings');if(!d){d=document.createElement('dialog');d.id='sa-settings';d.className='sa-dialog';d.innerHTML='<header><h2>设置</h2><button type="button" class="sa-close" aria-label="关闭设置">关闭</button></header>';d.append(card());d.querySelector('.sa-close').onclick=()=>d.close();d.onclick=e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}};document.body.append(d)}d.showModal()}
function nav(selector,cls,tag='button'){const p=document.querySelector(selector);if(!p||p.querySelector('[data-site-access="nav"]'))return;const b=document.createElement(tag);b.dataset.siteAccess='nav';b.className=cls;b.textContent='设置';if(tag==='button')b.type='button';else b.href='#site-settings';b.onclick=e=>{e.preventDefault();openSettings()};p.append(b)}
let pending=false;
function update(){pending=false;
 if(site==='harness')attach(document.querySelector('[data-shortcut-modal="settings"] [class*="_options"]'));
 if(site==='clawchat')attach(document.querySelector('#dlg-settings [data-panel="general"]'));
 if(site==='bili')attach(document.querySelector('#page-account'));
 if(site==='octop'){const main=document.querySelector('main');if(main&&[...main.querySelectorAll('h1,h2,h4')].some(e=>e.textContent.trim()==='应用设置'))attach(main.querySelector('[class*="tabbedBody"]'))}
 if(site==='listing')nav('.sidebar nav','nav-button');
 if(site==='qingdan')nav('.sidebar nav','nav');
 if(site==='workbuddy')nav('.navigation','nav-link','a');
}
new MutationObserver(()=>{if(!pending){pending=true;requestAnimationFrame(update)}}).observe(document.documentElement,{childList:true,subtree:true});
update();
})();