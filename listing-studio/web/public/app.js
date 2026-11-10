import {applySavedTemplate,changeProductCategory,renameSavedTemplate} from './template-form.js';
const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const paths={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',history:'M3 10a9 9 0 1 1 1 7 M3 4v6h6 M12 7v5l3 2',help:'M9.5 9a2.5 2.5 0 1 1 4 2c-1.5.7-1.5 1.5-1.5 3 M12 17h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',plus:'M12 5v14 M5 12h14',arrow:'M5 12h14 M13 6l6 6-6 6',chevron:'M9 5l7 7-7 7',back:'M19 12H5 M11 6l-6 6 6 6',upload:'M12 16V3 M7 8l5-5 5 5 M4 15v5h16v-5',image:'M3 3h18v18H3z M3 16l6-6 6 6 3-3 3 3 M15 7h.01',check:'M5 12l4 4L19 6',shield:'M12 3l8 3v6c0 5-8 9-8 9S4 17 4 12V6z M8 12l3 3 5-6',globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18 M12 3c-5 5-5 13 0 18',file:'M14 3H5v18h14V8z M14 3v5h5 M8 12h8 M8 16h6',copy:'M9 9h12v12H9z M15 5V3H3v12h2',download:'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',edit:'M4 20l4-1 12-12-5-5L3 14z M12 5l5 5',spark:'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z M20 2v4 M18 4h4',link:'M9 15l6-6 M8 8l3-3a5 5 0 0 1 7 7l-3 3 M16 16l-3 3a5 5 0 0 1-7-7l3-3',clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',sliders:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M9 15v6',info:'M12 11v6 M12 7h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',stop:'M7 7h10v10H7z',refresh:'M20 7v5h-5 M4 17v-5h5 M20 12a8 8 0 0 0-14-5 M4 12a8 8 0 0 0 14 5',search:'M18 18l4 4 M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0',folder:'M3 6h7l2 3h9v12H3z',eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',leaf:'M4 20C2 8 8 3 21 3c0 13-5 18-17 17 M4 20L16 8'};
paths.trash='M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7';
const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;
const stateNames={staged:'等待入队',queued:'排队中',running:'正在处理',cancelling:'正在停止',completed:'已完成',needs_input:'待补充资料',needs_login:'等待登录',partial:'部分完成',failed:'执行中断',cancelled:'已停止'};
const freshForm=()=>({category:'',templateOne:'',templateTwo:'',ranges:[[65,75],[115,125]],presetId:'',presetCategory:'',imageData:'',imageName:'',imageSize:0,reuseId:null,imagePreview:'',batchId:'',batchPreview:null,archiveUploading:false,archiveName:''});
const state={tasks:[],batches:[],queue:{},selectedBatch:null,templates:[],health:{},screen:'new',selected:null,tab:'titles',filter:'all',search:'',form:freshForm(),busy:false,resumingAll:false,restartingId:null,error:''};
try{Object.assign(state.form,JSON.parse(localStorage.getItem('listing-draft')||'{}'));}catch{}
const apiUrl=route=>new URL('api/'+route,location.href.split('?')[0]).href;
const asset=(task,file)=>apiUrl(`tasks/${task.id}/file?path=`+encodeURIComponent(file));
const badge=task=>`<span class="badge ${esc(task.state)}">${esc(stateNames[task.state]||task.state)}</span>`;
const date=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
async function api(route,options={}){const response=await fetch(apiUrl(route),{...options,headers:{'content-type':'application/json',...options.headers}});const data=await response.json();if(!response.ok)throw new Error(data.error||'请求未完成');return data;}
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3500);}
function saveDraft(){const {category,templateOne,templateTwo,ranges,presetId,presetCategory,batchId}=state.form;try{localStorage.setItem('listing-draft',JSON.stringify({category,templateOne,templateTwo,ranges,presetId,presetCategory,batchId}));}catch{}}
function shell(content){
  const active=['detail','batch'].includes(state.screen)?'history':state.screen;
  return `<div class="shell"><aside class="sidebar"><a href="./" class="brand" data-action="new"><img src="./favicon.svg" alt="Listing Studio"><div><div class="brand-name">Listing Studio</div><div class="brand-sub">商品调研与标题</div></div></a><nav><div class="nav-label">工作空间</div><button class="nav-button ${active==='new'?'active':''}" data-action="new">${icon('grid')}新建调研</button><button class="nav-button ${active==='history'?'active':''}" data-action="history">${icon('history')}历史任务<span class="nav-count">${state.tasks.length}</span></button><button class="nav-button ${active==='help'?'active':''}" data-action="help">${icon('help')}使用指南</button></nav><div class="sidebar-bottom"><div class="sidebar-note">${icon('leaf')}<strong>让调研支持每个标题。</strong>核实竞品、保留原词，<br>在每一步留下真实依据。</div><div class="sidebar-foot"><i class="dot"></i>Amazon & Sif · 美国站</div></div></aside><div class="page"><header class="topbar"><div class="breadcrumb">工作台 ${icon('chevron')} <b>${({new:'新建商品调研',history:'历史任务',detail:'调研结果',batch:'批量调研',help:'使用指南'})[state.screen]}</b></div><div class="top-status"><span><i class="dot ${state.health.browserConnected?'':'off'}"></i>${state.health.browserConnected?'浏览器已连接':'浏览器未连接'}</span><span><i class="dot ${state.health.executorReady?'':'off'}"></i>${state.health.executorReady?'任务服务可用':'任务服务待连接'}</span><div class="avatar">LS</div></div></header><main class="workspace" id="workspace">${queueNotice()}${content}</main></div></div>`;
}
function footer(){return `<footer class="workspace-footer"><span>Listing Studio · 用真实调研，支持每一次表达。</span><a href="#" data-action="help">${icon('help')}使用帮助</a></footer>`;}
const canDeleteTask=task=>['completed','partial','needs_input','failed','cancelled'].includes(task.state);
const canRestartTask=task=>canDeleteTask(task)&&task.id!==state.queue.activeId&&!!task.input?.templateOne?.trim()&&!!task.input?.templateTwo?.trim();
function restartTaskButton(task,small=false){return `<button class="button ${small?'small':''}" data-action="restart" data-id="${task.id}" title="${canRestartTask(task)?'使用原图和保存的模板从头调研，旧记录保留':canDeleteTask(task)?'先补齐两套模板，或等待任务收尾':'请先停止原任务，再重新开始'}" ${!canRestartTask(task)||state.restartingId?'disabled':''}>${icon('refresh')}${state.restartingId===task.id?'正在创建…':'重新开始'}</button>`;}
function restartContext(task){
  const source=task.restartedFrom&&state.tasks.find(t=>t.id===task.restartedFrom),next=task.latestRestartId&&state.tasks.find(t=>t.id===task.latestRestartId);
  return source||next?`<div class="restart-context">${source?`<span>本次从头调研，不复用旧进度。<button class="text-button" data-action="open" data-id="${source.id}">查看原记录</button></span>`:''}${next?`<span>本记录已另建任务重新开始。<button class="text-button" data-action="open" data-id="${next.id}">查看新任务</button></span>`:''}</div>`:'';
}
const canDeleteBatch=batch=>batch.state!=='preparing'&&!(batch.taskIds||[]).some(id=>{const task=state.tasks.find(t=>t.id===id);return task&&!canDeleteTask(task)});
function deleteTaskButton(task,compact=false){const allowed=canDeleteTask(task);return `<button class="${compact?'history-delete':'button danger'}" data-action="delete-task" data-id="${task.id}" aria-label="删除${esc(task.name||'历史记录')}" title="${allowed?'删除历史记录':'请先停止任务再删除'}" ${allowed?'':'disabled'}>${icon('trash')}${compact?'':'删除记录'}</button>`;}
function deleteBatchButton(batch,compact=false){const allowed=canDeleteBatch(batch);return `<button class="${compact?'history-delete':'button danger'}" data-action="delete-batch" data-id="${batch.id}" aria-label="删除批次${esc(batch.name||'历史记录')}" title="${allowed?'删除整批历史记录':'请先停止本批任务再删除'}" ${allowed?'':'disabled'}>${icon('trash')}${compact?'':'删除本批历史'}</button>`;}
function taskRow(task){return `<div class="task-record"><button class="task-row" data-action="open" data-id="${task.id}"><img class="task-thumb" src="${asset(task,task.previewFile)}" alt="商品参考图"><div class="task-info"><div class="task-name">${esc(task.name||task.input.category+'商品调研')}</div><div class="task-meta"><span>${esc(task.input.category)}</span><span>美国站</span><span>${date(task.createdAt)}</span>${task.restartedFrom?'<span>重新开始</span>':''}</div></div><div class="task-results"><span>${task.counts?.competitors||0} 款竞品</span><span>${task.counts?.keywords||0} 个流量词</span></div>${badge(task)}<span class="row-arrow">${icon('chevron')}</span></button>${deleteTaskButton(task,true)}</div>`;}
function recent(){return `<section class="recent-panel"><div class="recent-head"><h2>最近的调研</h2><button class="text-button" data-action="history">查看全部 ${icon('arrow')}</button></div>${state.tasks.length?state.tasks.slice(0,2).map(taskRow).join(''):'<div class="empty-history">第一份调研，从上传一张商品图开始。</div>'}</section>`;}
function presetPicker(){
  const category=state.form.category.trim(),selected=state.templates.find(x=>x.id===state.form.presetId);
  const list=[...state.templates].sort((a,b)=>((a.category===category?0:a.category?2:1)-(b.category===category?0:b.category?2:1))||a.name.localeCompare(b.name,'zh-CN'));
  return `<div class="preset-picker" id="preset-picker"><div class="preset-controls"><select class="field-control" id="preset-select" aria-label="选择已保存的两套标题模板"><option value="">${list.length?'选择已保存模板，自动填入两条':'还没有模板，填写后可保存'}</option>${list.map(p=>`<option value="${p.id}" ${p.id===selected?.id?'selected':''} ${category&&p.category&&p.category!==category?'disabled':''}>${esc(p.category||'通用')} · ${esc(p.name)}${category&&p.category&&p.category!==category?'（类目不匹配）':''}</option>`).join('')}</select><button class="button small" type="button" data-action="save-preset">${icon('file')}${selected?'保存修改':'保存模板'}</button></div><div class="preset-caption"><span title="${esc(selected?.name||'')}">${selected?'已选择：'+esc(selected.name):'保存两条模板和字符范围，下次直接选择。'}</span>${selected?'<span class="preset-name-actions"><button class="text-button" type="button" data-action="rename-preset">重命名</button><button class="text-button" type="button" data-action="delete-preset">删除这组</button></span>':''}</div></div>`;
}
function workbenchScreen(){
  const f=state.form,preview=f.imageData||f.imagePreview,batch=f.batchPreview;
  const templateBlocks=[0,1].map(i=>`<div class="template-block"><div class="template-title"><label for="template-${i}">标题${i===0?'一':'二'}<span class="required">*</span></label><span class="range-tag" id="range-tag-${i}">${f.ranges[i][0]}–${f.ranges[i][1]} 字符</span></div><textarea class="template-area" id="template-${i}" name="${i===0?'templateOne':'templateTwo'}" placeholder="粘贴你的英文模板，用 {主体风格}、{画风背景} 标记需要填写的部分。" required maxlength="1500">${esc(i===0?f.templateOne:f.templateTwo)}</textarea><div class="template-note">${icon('check')}保留固定文字与标点，仅填写 <code>{占位部分}</code></div></div>`).join('');
  const upload=preview?`<img src="${esc(preview)}" alt="已选商品参考图"><div><strong>${esc(f.imageName||'复用原始参考图')}</strong><small>${f.reuseId?'已关联这份商品的真实调研':f.imageSize?(f.imageSize/1024/1024).toFixed(2)+' MB · 图片已就绪':'图片已就绪'}</small><span class="upload-change">${icon('refresh')}更换图片</span></div>`:`<div class="upload-symbol">${icon('upload')}</div><strong>拖入图片或 ZIP，或 <em>点击上传</em></strong><p>单图最大15MB · 同批使用相同类目与模板</p>`;
  return `<div class="heading-row"><div><h1>从参考图，<span>到有依据的标题。</span></h1><p class="intro">提供图片、类目和两套模板，一次完成竞品、流量词与标题整理。</p></div><div class="mode-tag">${icon('globe')}Amazon US · 美国站</div></div><form id="task-form" novalidate><div class="editor-grid"><section class="panel product-panel"><div class="panel-head"><div class="panel-title"><span class="step-num">01</span>商品资料</div><span class="panel-sub">先认识你的商品</span></div><div class="panel-body"><input id="image-input" type="file" accept="image/jpeg,image/png,image/webp,.zip,application/zip" hidden><div class="upload-options"><span>单张图片 / ZIP 批量上传</span><span>按文件名逐张处理</span></div><div class="upload-zone ${preview?'upload-ready':''} ${batch?'archive-ready':''}" id="dropzone" role="button" tabindex="0" aria-label="上传参考图或ZIP压缩包" data-action="upload">${f.archiveUploading?`<i class="loading-ring"></i><strong>正在上传并检查图片…</strong><p>准备好后会显示图片清单，尚未开始调研。</p>`:batch?`<div class="upload-symbol">${icon('folder')}</div><strong>${esc(batch.name)}</strong><p>${batch.files.length} 张图片已就绪 · 点击更换压缩包</p>`:upload}</div><div class="upload-format-note">支持 JPG / PNG / WebP，或 ZIP（最大100MB、100张）。</div>${batch?archiveList(batch):''}<div class="field-row"><div><label class="field-label" for="category">商品类目<span class="required">*</span></label><input class="field-control" id="category" name="category" list="category-options" placeholder="选择或输入类目，例如：挂画" value="${esc(f.category)}" ${f.reuseId?'readonly':''} required maxlength="80"><datalist id="category-options"><option value="挂画"><option value="马克杯"><option value="抱枕"><option value="T恤"><option value="手机壳"><option value="其他"></datalist><div class="field-note">${f.reuseId?'仅改标题时保留原类目，更换类目请新建。':'按实际商品填写，帮助调研匹配正确的品类。'}</div></div><div><label class="field-label">目标站点</label><div class="field-control fixed-select"><span class="flag">US</span>美国站 · Amazon.com</div><div class="field-note">Amazon 竞品与 Sif 流量词使用同一站点。</div></div></div></div></section><section class="panel templates-panel"><div class="panel-head"><div class="panel-title"><span class="step-num">02</span>标题模板</div><span class="panel-sub">你的结构，我们填词</span></div><div class="panel-body">${presetPicker()}${templateBlocks}<details class="advanced"><summary>${icon('sliders')}调整标题字符范围</summary>${[0,1].map(i=>`<div class="range-editor"><span>标题${i===0?'一':'二'}</span><input type="number" aria-label="标题${i+1}字符下限" min="1" max="500" data-range="${i}-0" value="${f.ranges[i][0]}"><span>至</span><input type="number" aria-label="标题${i+1}字符上限" min="1" max="500" data-range="${i}-1" value="${f.ranges[i][1]}"><span>字符，含空格与标点</span></div>`).join('')}</details></div></section></div><div class="form-error" id="form-error" role="alert">${esc(state.error)}</div><div class="submission-bar"><div class="submission-copy"><span class="submission-icon">${icon('file')}</span><div><strong>${batch?batch.files.length+' 张图片 · 按顺序独立调研':f.reuseId?'复用已有调研，继续生成标题':'5 款相似竞品 · 15 个 Sif 流量词 · 2 条标题'}</strong><p>${batch?'提交时固定本批模板；每张图各生成报告、流量词和两条标题。':'保留实际来源，生成一份可下载的图文联合报告。'}</p></div></div><div class="submission-actions"><button class="button subtle" type="button" data-action="clear">清空资料</button><button class="button primary start" type="submit" ${state.busy||f.archiveUploading?'disabled':''}>${state.busy?'<i class="loading-ring"></i>':''}${state.busy?'正在提交…':batch?'开始逐张调研（'+batch.files.length+'张）':f.reuseId?'继续生成标题':'开始调研'}${state.busy?'':icon('arrow')}</button></div></div></form><div class="trust-strip"><span>${icon('shield')}词源可追溯</span><span>${icon('check')}固定文字保留</span><span>${icon('folder')}报告与图片归档</span></div><div id="recent-tasks">${recent()}</div>${footer()}`;
}
function resumeAllButton(label='重启全部暂停任务'){
  const blocked=state.queue.resourceError||state.queue.browserCleanupError||state.queue.blockedForLogin;
  const count=state.tasks.filter(task=>!task.latestRestartId&&task.id!==state.queue.activeId&&(['failed','cancelled','needs_login'].includes(task.state)||blocked&&task.state==='queued')).length;
  return `<button class="button primary" data-action="resume-all" title="恢复执行中断、手动停止和等待登录的任务，保留已有资料继续" ${state.resumingAll||!count&&!blocked?'disabled':''}>${icon('refresh')}${state.resumingAll?'正在恢复…':label+(count?'（'+count+'）':'')}</button>`;
}
function historyScreen(){
  const counts={total:state.tasks.length,running:state.tasks.filter(t=>['queued','running'].includes(t.state)).length,completed:state.tasks.filter(t=>t.state==='completed').length};
  return `<div class="heading-row"><div><div class="eyebrow">RESEARCH LIBRARY</div><h1>每一次调研，<span>都有记录。</span></h1><p class="intro">查看进度、继续未完成任务，或回到已经核实的来源。</p></div><div class="history-actions"><span id="resume-all-control">${resumeAllButton()}</span><button class="button" data-action="new">${icon('plus')}新建调研</button></div></div><div class="stats"><div class="stat-card"><span>全部任务</span><strong>${counts.total.toString().padStart(2,'0')}</strong></div><div class="stat-card"><span>正在处理中</span><strong>${counts.running.toString().padStart(2,'0')}</strong></div><div class="stat-card"><span>标题与调研均完成</span><strong>${counts.completed.toString().padStart(2,'0')}</strong></div></div><div class="history-toolbar"><div class="filter-tabs">${[['all','全部'],['active','进行中'],['waiting','待处理'],['done','已完成']].map(([value,label])=>`<button class="${state.filter===value?'active':''}" data-action="filter" data-value="${value}">${label}</button>`).join('')}</div><input class="search-input" id="task-search" aria-label="搜索任务" placeholder="搜索商品名称或类目" value="${esc(state.search)}"></div><div id="batch-library">${batchLibrary()}</div><div id="history-list">${historyRows()}</div>${footer()}`;
}
function historyRows(){const list=state.tasks.filter(t=>(state.filter==='all'||state.filter==='active'&&['queued','running'].includes(t.state)||state.filter==='waiting'&&['needs_input','needs_login','partial','failed','cancelled'].includes(t.state)||state.filter==='done'&&t.state==='completed')&&((t.name||'')+t.input.category).toLowerCase().includes(state.search.toLowerCase()));return list.length?list.map(taskRow).join(''):'<div class="empty-history">这里还没有符合条件的任务。</div>';}
function progress(task){
  const r=task.result||{},steps=[['reading','读取商品','image'],['amazon','竞品调研','search'],['sif','Sif 原词','globe'],['titles','标题生成','edit'],['report','联合报告','file']];
  const index=steps.findIndex(x=>x[0]===task.stage),done=[!!r.competitors?.length,!!r.competitors?.length,!!r.keywords?.length,r.titles?.length===2,!!r.reportFile];
  return `<section class="panel progress-panel ${!['completed','running','queued'].includes(task.state)?'with-notice':''}"><div class="progress-message">${icon(task.state==='completed'?'check':'clock')}<span>${esc(task.message)}</span></div><div class="pipeline">${steps.map(([stage,label,symbol],i)=>{const finished=task.state==='completed'||done[i]||task.state==='running'&&i<index;const active=!finished&&task.stage===stage;return `<div class="pipeline-step ${finished?'done':active?'active':''}"><div class="pipeline-icon">${icon(finished?'check':symbol)}</div><strong>${label}</strong><small>${finished?'已保存':active?task.state==='running'?'处理中':'待继续':'待开始'}</small></div>`;}).join('')}</div></section>`;
}
function taskNotice(task){
  if(['completed','running','queued'].includes(task.state))return '';
  const login=task.state==='needs_login';
  return `<div class="notice"><div><strong>${esc(stateNames[task.state])}</strong> · ${esc(task.message)}</div><div class="notice-actions">${login?`<a class="button small" href="${esc(state.health.browserUrl||'/listing-browser/')}" target="_blank" rel="noopener">${icon('link')}打开浏览器登录</a><button class="button small" data-action="resume" data-id="${task.id}">${icon('refresh')}已登录，继续</button>`:`<button class="button small" data-action="edit" data-id="${task.id}">${icon('edit')}补充或调整模板</button>${['failed','partial','cancelled'].includes(task.state)?`<button class="button small" data-action="resume" data-id="${task.id}">${icon('refresh')}继续任务</button>`:''}`}</div></div>`;
}
function titleTab(task){
  const titles=task.result?.titles||[];
  if(titles.length!==2)return `<section class="panel waiting"><div class="waiting-icon">${icon('edit')}</div><h3>${task.state==='running'?'正在根据真实词源准备标题':'标题尚未生成'}</h3><p>${task.state==='needs_input'?'这份调研已经保存。补充两套标题模板后，可直接使用已有资料继续。':'标题会在调研完成后按你的模板生成；固定文字、占位词源和字符范围都通过校验后才会显示。'}</p>${task.state!=='running'&&task.state!=='queued'?`<button class="button" data-action="edit" data-id="${task.id}">${icon('edit')}填写或调整模板</button>`:''}</section>`;
  return titles.map((title,i)=>`<section class="panel title-result"><div class="title-result-head"><h3>标题${i===0?'一':'二'} <span>· ${title.length} / ${title.min}–${title.max} 字符</span></h3><button class="button small" data-action="copy-title" data-index="${i}">${icon('copy')}复制标题</button></div><div class="title-result-text">${esc(title.text)}</div><div class="checks"><span>${icon('check')}固定文字保留</span><span>${icon('check')}占位词源已核对</span><span>${icon('check')}字符范围通过</span></div><details class="sources"><summary>查看占位词的具体来源</summary><div class="source-list">${(title.wordSources||[]).map(s=>`<span class="source-word" title="${esc(s.type==='sif'?'Sif 原词：'+s.source:'竞品 ASIN：'+s.source)}">${esc(s.word)}<small>${esc(s.type==='sif'?'Sif 原词':s.source)}</small></span>`).join('')}</div></details></section>`).join('');
}
function wordsTab(task){const words=task.result?.keywords||[];if(!words.length)return `<div class="panel waiting"><div class="waiting-icon">${icon('globe')}</div><h3>尚未取得 Sif 原词</h3><p>这里只展示实际返回并筛选的原词。需要登录或数据不足时，会保留真实状态。</p></div>`;return `<section class="panel"><div class="words-head"><div><strong>${words.length} 个 Sif 原始流量词</strong><p>保留报告原文与顺序，不混入自创组合词。</p></div><button class="button small" data-action="copy-words">${icon('copy')}复制全部原词</button></div><div class="keyword-chips">${words.map(w=>`<span class="keyword-chip">${esc(w.term)}</span>`).join('')}</div><div class="table-wrap"><table class="data-table"><thead><tr><th>#</th><th>原始流量词</th><th>搜索量</th><th>周期与口径</th><th>实际种子</th><th>查询来源</th></tr></thead><tbody>${words.map((w,i)=>`<tr><td>${String(i+1).padStart(2,'0')}</td><td class="keyword">${esc(w.term)}</td><td class="${w.volume===null?'muted':''}" title="${esc(w.volumeStatus)}">${w.volume===null?'—':Number(w.volume).toLocaleString('en-US')}</td><td>${esc(w.period)}</td><td>${esc(w.seed)}</td><td><a href="${esc(w.queryUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(w.sourcePosition)}">打开来源 ${icon('link')}</a></td></tr>`).join('')}</tbody></table></div><div class="table-note">“—”表示数据未展示或权限受限，具体状态见来源；缺失数值不等于 0。不同周期的数据不会合并成统一搜索量。</div></section>`;}
function competitorsTab(task){const list=task.result?.competitors||[];if(!list.length)return `<section class="panel waiting"><div class="waiting-icon">${icon('image')}</div><h3>正在等待竞品核实</h3><p>逐款核实 ASIN、完整原标题、所选变体和主图后，结果会保存在这里。</p></section>`;return `<div class="competitor-grid">${list.map((c,i)=>`<article class="panel"><div class="competitor-image"><span class="competitor-number">相似竞品 ${String(i+1).padStart(2,'0')}</span><img src="${asset(task,c.imageFile)}" alt="${esc(c.asin)} 官方主图" loading="lazy"></div><div class="competitor-body"><div class="competitor-meta"><a class="asin-link" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.asin)} ↗</a><span class="similarity">${esc(c.similarity)}</span></div><p>${esc(c.difference)}</p><details><summary>查看完整原标题与所选变体</summary><div class="competitor-full-title">${esc(c.title)}</div><div class="competitor-variant">${esc(c.variant)}</div></details></div></article>`).join('')}</div>`;}
function reportTab(task){if(!task.result?.reportFile)return `<div class="panel waiting"><h3>报告尚未生成</h3><p>核实后的结果会汇总为一份含设计图、竞品与 Sif 来源的联合报告。</p></div>`;return `<div class="report-tools"><a class="button" href="${apiUrl(`tasks/${task.id}/report`)}" target="_blank" rel="noopener">${icon('eye')}独立打开</a><a class="button primary" href="${apiUrl(`tasks/${task.id}/download`)}">${icon('download')}下载报告与图片</a></div><iframe title="商品联合调研报告" class="report-frame" src="${apiUrl(`tasks/${task.id}/report`)}" sandbox="allow-same-origin allow-popups"></iframe>`;}
function detailScreen(){
  const task=state.tasks.find(x=>x.id===state.selected);if(!task)return `<div class="panel waiting">任务不存在或尚未载入。</div>`;
  const result=task.result||{};
  return `<button class="back-button" data-action="history">${icon('back')}返回历史任务</button><div class="heading-row detail-heading"><div class="detail-top"><img src="${asset(task,task.previewFile)}" alt="商品设计参考图"><div><h1>${esc(task.name||task.input.category+'调研任务')}</h1><div class="detail-date"><span>${esc(task.input.category)} · 美国站</span><span>${date(task.createdAt)}</span>${badge(task)}</div></div></div><div class="detail-actions">${['running','queued','needs_login'].includes(task.state)?`<button class="button danger" data-action="cancel" data-id="${task.id}">${icon('stop')}停止任务</button>`:`<button class="button" data-action="edit" data-id="${task.id}">${icon('edit')}调整模板</button>`}${result.reportFile?`<a class="button primary" href="${apiUrl(`tasks/${task.id}/download`)}">${icon('download')}下载报告</a>`:''}${restartTaskButton(task)}${deleteTaskButton(task)}</div></div>${restartContext(task)}${progress(task)}${taskNotice(task)}<div class="detail-tabs">${[['titles','英文标题',result.titles?.length||0],['words','流量词',result.keywords?.length||0],['competitors','相似竞品',result.competitors?.length||0],['report','联合报告','']].map(([key,label,n])=>`<button class="${state.tab===key?'active':''}" data-action="tab" data-tab="${key}">${label}${n!==''?`<span>${n}</span>`:''}</button>`).join('')}</div><div id="result-content">${({titles:titleTab,words:wordsTab,competitors:competitorsTab,report:reportTab})[state.tab](task)}</div>${task.events?.length?`<details class="event-log"><summary>查看执行记录</summary>${task.events.slice(-8).map(e=>`<div class="event-line"><time>${date(e.time)}</time>${esc(e.message)}</div>`).join('')}</details>`:''}${footer()}`;
}
function helpScreen(){return `<div class="heading-row"><div><div class="eyebrow">A LITTLE GUIDANCE</div><h1>把资料交给我们，<span>把依据留给你。</span></h1><p class="intro">一次输入，串联相似竞品、Sif 原词与两条英文标题。</p></div></div><article class="panel help-panel"><h2>只需要准备三样资料</h2><p>一张商品参考图、实际商品类目，以及你自己的两套英文标题模板。</p><h3>一次上传多张图片</h3><p>把 JPG、PNG、WebP 图片放进 ZIP，上传后先检查清单，再统一填写类目、选择模板组并开始。每批最多100张，ZIP最大100MB，单图最大15MB、有效图片解压后合计最大300MB。图片按文件名顺序逐张处理，各自生成报告；不支持加密包、RAR或7z。混合类目请分批上传。需要登录时整个队列等待，登录后点“已登录，继续队列”。单张失败后可继续处理后续图片，再单独重试失败图片。</p><h3>保存和自定义模板组名称</h3><p>填写两条模板后点“保存模板”，在“模板组名称（可自定义）”中输入自己的名字。已有组合先从下拉框选中，再点旁边的“重命名”，输入新名称并保存；这一步只改名称，不会保存输入框中的临时正文修改。</p><h3>怎么填写模板？</h3><p>保持品牌、尺寸等固定文字原样，用 <code>{主体风格}</code>、<code>{画风背景}</code>、<code>{补充图案}</code> 标记需要填词的位置。占位名称可以自己取，两套模板可以有不同结构。</p><p>默认标题一为 65–75 字符，标题二为 115–125 字符，空格和标点也计数。可在“调整字符范围”中更改。</p><h3>结果为什么会暂停？</h3><p>如果 Sif 需要登录或验证码，请打开现有浏览器完成后点击“已登录，继续”。如果来源词不足、字符范围无法自然满足，或模板与已知实物冲突，任务会说明具体缺口，已完成资料仍保留。</p><h3>重新开始与继续任务</h3><p>“继续任务”会使用已有资料补齐缺口。“重新开始”使用该任务的原图和已保存模板，新建一条任务从头调研，旧记录与报告保留；批次内重新开始的图片单独排队。正在运行、排队或等待登录的任务先停止；缺少模板时先补齐模板。</p><h3>哪里查看报告？</h3><p>在历史任务中打开商品，切换到“联合报告”可直接阅读；点击“下载报告与图片”取得 ZIP，解压后报告中的图片可在本地一起查看。</p><h3>有来源，才填写</h3><p>占位词仅来自当次 Sif 原词和核实竞品完整原标题。竞品材质、尺寸、装框方式不会自动成为你的商品属性；不会凑流量词数量或把缺失搜索量当成 0。</p><button class="button primary" data-action="new">${icon('plus')}开始我的第一份调研</button></article>${footer()}`;}
function render(){const content=({new:workbenchScreen,history:historyScreen,detail:detailScreen,batch:batchScreen,help:helpScreen})[state.screen]();$('#app').innerHTML=shell(content);}
function navigate(screen){state.screen=screen;state.error='';history.replaceState(null,'',screen==='detail'?'?task='+state.selected:screen==='batch'?'?batch='+state.selectedBatch:location.pathname);render();window.scrollTo({top:0,behavior:'instant'});}
function updateTask(task){const index=state.tasks.findIndex(t=>t.id===task.id);if(index<0)state.tasks.unshift(task);else state.tasks[index]=task;}
let uploadVersion=0,uploadController;
async function loadImage(file){
  if(!file)return;
  const version=++uploadVersion;uploadController?.abort();uploadController=new AbortController();state.form.archiveUploading=false;render();
  if(/\.zip$/i.test(file.name)||['application/zip','application/x-zip-compressed'].includes(file.type)){
    if(file.size>100*1024*1024){toast('ZIP文件不能超过100MB');return;}
    Object.assign(state.form,{archiveUploading:true,batchId:'',batchPreview:null,reuseId:null,imageData:'',imagePreview:''});render();
    try{
      const response=await fetch(apiUrl('batches/preview'),{method:'POST',headers:{'content-type':'application/zip','x-file-name':encodeURIComponent(file.name)},body:file,signal:uploadController.signal});
      let batch;try{batch=await response.json();}catch{throw new Error('压缩包处理未完成，请稍后重试');}
      if(!response.ok)throw new Error(batch.error||'压缩包处理失败');
      if(version!==uploadVersion)return;
      Object.assign(state.form,{batchId:batch.id,batchPreview:batch,archiveName:file.name,archiveUploading:false});updateBatch(batch);saveDraft();render();toast('已识别 '+batch.files.length+' 张图片，请选择本批类目与模板');
    }catch(error){if(version===uploadVersion){state.form.archiveUploading=false;render();if(error.name!=='AbortError')toast(error.message);}}
    return;
  }
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)){toast('请上传 JPG、PNG、WebP 图片或 ZIP 压缩包');return;}
  if(file.size>15*1024*1024){toast('单张图片不能超过15MB');return;}
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});
  if(version!==uploadVersion)return;
  Object.assign(state.form,{imageData:data,imageName:file.name,imageSize:file.size,reuseId:null,imagePreview:'',batchId:'',batchPreview:null,archiveUploading:false});saveDraft();render();
}
function updateBatch(batch){const index=state.batches.findIndex(x=>x.id===batch.id);if(index<0)state.batches.unshift(batch);else state.batches[index]=batch;}
function archiveList(batch){return `<div class="archive-summary"><strong>${batch.files.length} 张有效图片</strong><span>按文件名顺序调研</span></div><div class="archive-files">${batch.files.map((file,i)=>`<div class="archive-file"><span>${i+1}</span><img loading="lazy" src="${apiUrl('batches/'+batch.id+'/preview/'+file.id)}" alt=""><strong title="${esc(file.name)}">${esc(file.name)}</strong></div>`).join('')}</div>${skippedList(batch)}`;}
function skippedList(batch){return batch.skipped?.length?`<details class="archive-skipped"><summary>已跳过 ${batch.skipped.length} 个文件，查看原因</summary>${batch.skipped.map(file=>`<div><span>${esc(file.name)}</span><small>${esc(file.reason)}</small></div>`).join('')}</details>`:'';}
function queueNotice(){
  if(state.queue.resourceError)return `<div class="notice queue-notice"><div><strong>任务已安全暂停</strong><p>${esc(state.queue.resourceError)} 已保存的资料仍保留。</p></div><div class="notice-actions"><a class="button small" href="${esc(state.health.browserUrl||'/listing-browser/')}" target="_blank" rel="noopener">检查浏览器</a>${resumeAllButton()}</div></div>`;
  if(state.queue.browserCleanupError)return `<div class="notice queue-notice"><div><strong>队列等待浏览器整理</strong><p>${esc(state.queue.browserCleanupError)} 已保存的报告和图片仍保留。</p></div><div class="notice-actions"><a class="button small" href="${esc(state.health.browserUrl||'/listing-browser/')}" target="_blank" rel="noopener">检查浏览器</a>${resumeAllButton()}</div></div>`;
  const id=state.queue.blockedForLogin;if(!id)return '';
  return `<div class="notice queue-notice"><div><strong>队列等待登录</strong><p>当前图片的资料已保存，后续图片暂不开始。</p></div><div class="notice-actions"><a class="button small" href="${esc(state.health.browserUrl||'/listing-browser/')}" target="_blank" rel="noopener">打开浏览器登录</a>${resumeAllButton('已登录，重启暂停任务')}</div></div>`;
}
function batchLibrary(){
  const batches=state.batches.filter(b=>b.state==='submitted'||b.state==='preparing');
  if(!batches.length)return '';
  return `<section class="batch-library"><h2>批量调研</h2>${batches.map(batch=>`<div class="batch-record"><button class="batch-card" data-action="open-batch" data-id="${batch.id}"><span class="batch-card-icon">${icon('folder')}</span><div><strong>${esc(batch.name)}</strong><span>${esc(batch.input?.category||'')} · ${batch.counts.total} 张 · 已完成 ${batch.counts.completed} 张${batch.counts.waiting?' · '+batch.counts.waiting+' 张待处理':''}</span></div>${icon('chevron')}</button>${deleteBatchButton(batch,true)}</div>`).join('')}</section>`;
}
function batchScreen(){
  const batch=state.batches.find(x=>x.id===state.selectedBatch);if(!batch)return '<div class="panel waiting">批次正在载入，请稍后刷新。</div>';
  const counts=batch.counts,tasks=(batch.taskIds||[]).map(id=>state.tasks.find(task=>task.id===id)).filter(Boolean);
  return `<button class="back-button" data-action="history">${icon('back')}返回历史任务</button><div class="heading-row batch-heading"><div><div class="eyebrow">BATCH RESEARCH</div><h1>${esc(batch.name)}</h1><p class="intro">${esc(batch.input?.category||'')} · ${counts.total} 张图片，按文件名逐张调研；每张保留独立来源与报告。</p></div><div class="batch-actions">${counts.queued+counts.running?'<button class="button danger" data-action="cancel-batch" data-id="'+batch.id+'">停止本批剩余任务</button>':''}${deleteBatchButton(batch)}</div></div><div class="stats batch-stats"><div class="stat-card"><span>标题与报告已完成</span><strong>${counts.completed}<small> / ${counts.total}</small></strong></div><div class="stat-card"><span>正在处理 / 排队</span><strong>${counts.running}<small> / ${counts.queued}</small></strong></div><div class="stat-card"><span>待补充 / 已停止</span><strong>${counts.waiting}<small> / ${counts.stopped}</small></strong></div></div><div class="batch-context">${icon('shield')}本批使用提交时保存的类目、两套模板与字符范围。后续修改模板组不影响排队图片。</div><div class="batch-task-list">${tasks.map((task,position)=>`<section class="batch-task">${taskRow(task)}<div class="batch-task-bottom"><span>${position+1} / ${counts.total} · ${esc(task.message)}</span><div>${restartTaskButton(task,true)}${task.result?.reportFile?'<a class="button small" href="'+apiUrl('tasks/'+task.id+'/download')+'">下载报告</a>':''}${['failed','partial','cancelled'].includes(task.state)?'<button class="button small" data-action="resume" data-id="'+task.id+'">继续此图</button>':''}${task.state==='needs_input'?'<button class="button small" data-action="edit" data-id="'+task.id+'">补充资料</button>':''}</div></div></section>`).join('')}</div>${skippedList(batch)}${footer()}`;
}
function openRenameDialog(){
  const preset=state.templates.find(x=>x.id===state.form.presetId);if(!preset){toast('请先选择要改名的模板组');return;}
  const dialog=document.createElement('dialog');dialog.className='preset-dialog';dialog.id='preset-rename-dialog';
  dialog.innerHTML=`<form id="preset-rename-form"><div class="preset-dialog-head"><h2>重命名模板组</h2><p>输入你喜欢的名字。此次只改名称，正文和字符范围保持原样。</p></div><label class="field-label" for="preset-new-name">新的模板组名称<span class="required">*</span></label><input class="field-control" id="preset-new-name" maxlength="80" required value="${esc(preset.name)}" placeholder="例如：卧室挂画模板"><div class="form-error" id="preset-rename-error" role="alert"></div><div class="preset-dialog-actions"><button class="button subtle" type="button" data-close-rename>取消</button><button class="button primary" type="submit">保存名称</button></div></form>`;
  document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.addEventListener('cancel',event=>{if(dialog.dataset.busy)event.preventDefault();});
  dialog.addEventListener('click',event=>{if(event.target.closest('[data-close-rename]'))dialog.close();});
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();if(dialog.dataset.busy)return;
    try{
      const body=renameSavedTemplate(preset,dialog.querySelector('#preset-new-name').value);
      dialog.dataset.busy='true';dialog.querySelectorAll('button').forEach(x=>x.disabled=true);
      const saved=await api('templates/'+preset.id,{method:'PUT',body:JSON.stringify(body)});
      const index=state.templates.findIndex(x=>x.id===saved.id);if(index>=0)state.templates[index]=saved;
      dialog.close();render();toast('模板组已改名为“'+saved.name+'”');
    }catch(error){dialog.querySelector('#preset-rename-error').textContent=error.message;delete dialog.dataset.busy;dialog.querySelectorAll('button').forEach(x=>x.disabled=false);}
  });
  dialog.showModal();const input=dialog.querySelector('#preset-new-name');input.focus();input.select();
}
function openPresetDialog(){
  const f=state.form;
  if(!f.templateOne.trim()||!f.templateTwo.trim()||![f.templateOne,f.templateTwo].every(x=>/\{[^{}]+\}/.test(x))){toast('先填写两套带 {占位部分} 的标题模板，再保存。');return;}
  const selected=state.templates.find(x=>x.id===f.presetId),categories=[...new Set([f.category.trim(),selected?.category].filter(Boolean))];
  $('#preset-dialog')?.close();
  const dialog=document.createElement('dialog');dialog.id='preset-dialog';dialog.className='preset-dialog';
  dialog.innerHTML=`<form id="preset-save-form"><div class="preset-dialog-head"><h2>${selected?'保存模板修改':'保存模板组合'}</h2><p>两条模板和字符范围会一起保存，之后可在任意设备选择。</p></div><label class="field-label" for="preset-name">模板组名称（可自定义）<span class="required">*</span></label><input class="field-control" id="preset-name" name="presetName" maxlength="80" required placeholder="例如：挂画常用标题" value="${esc(selected?.name||(f.category.trim()?f.category.trim()+'常用模板':''))}"><label class="field-label preset-scope-label" for="preset-category">关联类目</label><select class="field-control" id="preset-category" name="presetCategory"><option value="">通用（不限类目）</option>${categories.map(category=>`<option value="${esc(category)}" ${(selected?selected.category:f.category.trim())===category?'selected':''}>${esc(category)}</option>`).join('')}</select><div class="preset-range-summary">标题一 ${f.ranges[0].join('–')} 字符 · 标题二 ${f.ranges[1].join('–')} 字符</div><div class="form-error" id="preset-error" role="alert"></div><div class="preset-dialog-actions"><button class="button subtle" type="button" data-close-preset>取消</button>${selected?'<button class="button" type="submit" name="mode" value="copy">另存一份</button>':''}<button class="button primary" type="submit" name="mode" value="save">${selected?'保存修改':'保存模板'}</button></div></form>`;
  document.body.append(dialog);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.addEventListener('click',event=>{if(event.target.closest('[data-close-preset]'))dialog.close();});
  dialog.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault();if(dialog.dataset.busy)return;
    const copying=event.submitter?.value==='copy',updating=!!selected&&!copying;
    const body={name:dialog.querySelector('#preset-name').value,category:dialog.querySelector('#preset-category').value,templateOne:f.templateOne,templateTwo:f.templateTwo,ranges:structuredClone(f.ranges)};
    if(copying&&body.name.trim()===selected.name)body.name=selected.name+' 副本';
    if(updating)body.expectedUpdatedAt=selected.updatedAt;
    dialog.dataset.busy='true';dialog.querySelectorAll('button').forEach(b=>b.disabled=true);dialog.querySelector('#preset-error').textContent='';
    try{
      const saved=await api(updating?'templates/'+selected.id:'templates',{method:updating?'PUT':'POST',body:JSON.stringify(body)});
      const index=state.templates.findIndex(x=>x.id===saved.id);if(index<0)state.templates.unshift(saved);else state.templates[index]=saved;
      state.form.presetId=saved.id;state.form.presetCategory=saved.category;saveDraft();dialog.close();render();toast(updating?'模板修改已保存':'模板组合已保存，下次可直接选择');
    }catch(error){dialog.querySelector('#preset-error').textContent=error.message;delete dialog.dataset.busy;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
  });
  dialog.showModal();dialog.querySelector('#preset-name').focus();dialog.querySelector('#preset-name').select();
}
async function copy(text){try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(text);else{const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();if(!ok)throw new Error();}toast('已复制，可以直接粘贴使用');}catch{toast('浏览器未允许复制，请选中文本后复制');}}
$('#app').addEventListener('click',async event=>{
  const target=event.target.closest('[data-action]');if(!target)return;event.preventDefault();const {action,id,index,tab,value}=target.dataset;
  try{
    if(action==='new')return navigate('new');if(action==='history'||action==='help')return navigate(action);
    if(action==='upload')return $('#image-input').click();
    if(action==='save-preset')return openPresetDialog();
    if(action==='rename-preset')return openRenameDialog();
    if(action==='delete-preset'){
      const preset=state.templates.find(x=>x.id===state.form.presetId);if(!preset)return;
      if(!window.confirm('删除模板组合“'+preset.name+'”？当前输入和历史任务会保留。'))return;
      target.disabled=true;await api('templates/'+preset.id,{method:'DELETE',body:'{}'});
      state.templates=state.templates.filter(x=>x.id!==preset.id);state.form.presetId='';saveDraft();render();toast('已删除保存的组合，当前输入仍保留');return;
    }
    if(action==='clear'){uploadVersion++;uploadController?.abort();state.form=freshForm();saveDraft();return render();}
    if(action==='open-batch'){state.selectedBatch=id;return navigate('batch');}
    if(action==='resume-all'){
      if(state.resumingAll)return;state.resumingAll=true;render();
      try{
        const result=await api('queue/resume-all',{method:'POST',body:'{}'});
        [state.tasks,state.batches,state.queue]=await Promise.all([api('tasks'),api('batches'),api('queue')]);
        toast(state.queue.resourceError?'服务器资源仍不足，任务保持暂停':state.queue.browserCleanupError?'浏览器整理未完成，任务保持暂停':state.queue.blockedForLogin?'仍需在浏览器完成登录或验证':result.resumedCount?'已恢复 '+result.resumedCount+' 项，将按顺序继续':state.queue.queued?'暂停队列已继续':'当前没有需要恢复的暂停任务');
      }finally{state.resumingAll=false;render();}
      return;
    }
    if(action==='restart'){
      if(state.restartingId)return;
      const source=state.tasks.find(task=>task.id===id);if(!source||!canRestartTask(source))return;
      if(!window.confirm('使用原图和该任务保存的模板从头重新调研？\n将创建新任务，旧记录和报告保留，不复用旧竞品、流量词或进度。'))return;
      state.restartingId=id;render();
      try{
        const task=await api('tasks/'+id+'/restart',{method:'POST',body:'{}'});
        [state.tasks,state.batches,state.queue]=await Promise.all([api('tasks'),api('batches'),api('queue')]);
        state.selected=task.id;state.tab='titles';navigate('detail');
        toast(state.queue.resourceError?'新任务已排队，等待服务器资源恢复':state.queue.blockedForLogin?'新任务已排队，等待完成浏览器登录':'已创建从头调研的新任务，旧记录和报告保留');
      }finally{state.restartingId=null;render();}
      return;
    }
    if(action==='cancel-batch'){if(!window.confirm('停止本批尚未完成的任务？已完成报告会保留。'))return;target.disabled=true;updateBatch(await api('batches/'+id+'/cancel',{method:'POST',body:'{}'}));state.tasks=await api('tasks');state.queue=await api('queue');render();return;}
    if(action==='delete-task'||action==='delete-batch'){
      const batch=action==='delete-batch'?state.batches.find(b=>b.id===id):null;
      const task=action==='delete-task'?state.tasks.find(t=>t.id===id):null;
      if(!batch&&!task)return;
      const removedIds=batch?(batch.taskIds||[]):[id];
      const question=batch?'删除批次“'+batch.name+'”的 '+batch.counts.total+' 条历史记录？':'删除历史记录“'+(task.name||task.input.category)+'”？';
      if(!window.confirm(question+'\n记录、报告和图片将从网站移除。原始资料保留，已保存模板不受影响。'))return;
      target.disabled=true;await api((batch?'batches/':'tasks/')+id,{method:'DELETE',body:'{}'});
      const [tasks,batches,queue]=await Promise.all([api('tasks'),api('batches'),api('queue')]);state.tasks=tasks;state.batches=batches;state.queue=queue;
      if(removedIds.includes(state.form.reuseId)||batch&&state.form.batchId===id){state.form=freshForm();saveDraft();}
      if(state.screen==='detail'&&!tasks.some(t=>t.id===state.selected)||state.screen==='batch'&&!batches.some(b=>b.id===state.selectedBatch)){state.selected=null;state.selectedBatch=null;navigate('history');}else render();
      toast(batch?'已删除本批历史记录':'已删除历史记录');return;
    }
    if(action==='open'){state.selected=id;state.tab='titles';return navigate('detail');}
    if(action==='tab'){state.tab=tab;return render();}
    if(action==='filter'){state.filter=value;return render();}
    if(action==='edit'){uploadVersion++;uploadController?.abort();const task=state.tasks.find(t=>t.id===id);Object.assign(state.form,structuredClone(task.input),{batchId:'',batchPreview:null,archiveUploading:false,reuseId:id,presetId:'',presetCategory:'',imageData:'',imagePreview:asset(task,task.previewFile),imageName:task.name});return navigate('new');}
    if(action==='copy-title')return copy(state.tasks.find(t=>t.id===state.selected).result.titles[Number(index)].text);
    if(action==='copy-words')return copy(state.tasks.find(t=>t.id===state.selected).result.keywords.map(w=>w.term).join(', '));
    if(action==='resume'||action==='cancel'){target.disabled=true;const task=await api(`tasks/${id}/${action}`,{method:'POST',body:'{}'});updateTask(task);state.queue=await api('queue');state.batches=await api('batches');render();toast(action==='resume'?'已继续任务，已有资料会保留':'任务已停止');}
  }catch(error){toast(error.message);target.disabled=false;}
});
$('#app').addEventListener('input',event=>{
  const t=event.target;
  if(t.id==='task-search'){state.search=t.value;$('#history-list').innerHTML=historyRows();return;}
  if(t.dataset.range){const [i,j]=t.dataset.range.split('-').map(Number);state.form.ranges[i][j]=Number(t.value);const tag=$('#range-tag-'+i);if(tag)tag.innerHTML=icon('clock')+state.form.ranges[i].join('–')+' 字符';saveDraft();return;}
  if(['category','templateOne','templateTwo'].includes(t.name)){
    if(t.name==='category'){
      const selected=state.templates.find(p=>p.id===state.form.presetId);
      const previous=state.form;
      state.form=changeProductCategory({...previous,presetCategory:previous.presetCategory||selected?.category||''},t.value);
      if(previous.templateOne&&!state.form.templateOne){
        document.querySelectorAll('.template-area').forEach(x=>x.value='');
        document.querySelectorAll('[data-range]').forEach(x=>{const [i,j]=x.dataset.range.split('-').map(Number);x.value=state.form.ranges[i][j];});
        for(let i=0;i<2;i++)if($('#range-tag-'+i))$('#range-tag-'+i).textContent=state.form.ranges[i].join('–')+' 字符';
        toast('类目已变更，请重新选择或填写对应模板');
      }
      if($('#preset-picker'))$('#preset-picker').outerHTML=presetPicker();
    }else state.form[t.name]=t.value;
    saveDraft();
  }
});
$('#app').addEventListener('change',event=>{
  if(event.target.id==='image-input')void loadImage(event.target.files[0]);
  if(event.target.id==='preset-select'){
    const preset=state.templates.find(p=>p.id===event.target.value);
    if(!preset){state.form.presetId='';saveDraft();render();return;}
    const category=state.form.category.trim();
    if(category&&preset.category&&category!==preset.category){toast('这组模板属于其他类目，请选择匹配的组合');return;}
    state.form=applySavedTemplate(state.form,preset);
    saveDraft();render();toast('已填入“'+preset.name+'”的两套模板');
  }
});
$('#app').addEventListener('keydown',event=>{if(event.target.id==='dropzone'&&['Enter',' '].includes(event.key)){event.preventDefault();$('#image-input').click();}});
$('#app').addEventListener('dragover',event=>{const zone=event.target.closest('#dropzone');if(zone){event.preventDefault();zone.classList.add('dragging');}});
$('#app').addEventListener('dragleave',event=>event.target.closest('#dropzone')?.classList.remove('dragging'));
$('#app').addEventListener('drop',event=>{const zone=event.target.closest('#dropzone');if(zone){event.preventDefault();zone.classList.remove('dragging');void loadImage(event.dataTransfer.files[0]);}});
$('#app').addEventListener('submit',async event=>{
  if(event.target.id!=='task-form')return;event.preventDefault();if(state.busy)return;
  const f=state.form;state.error='';
  if(!f.imageData&&!f.reuseId&&!f.batchId)state.error='请先上传这次商品的参考图。';
  else if(!f.category.trim())state.error='请填写实际商品类目。';
  else if(!f.templateOne.trim()||!f.templateTwo.trim())state.error='请填写两套标题模板。';
  else if(![f.templateOne,f.templateTwo].every(x=>/\{[^{}]+\}/.test(x)))state.error='请用 {主体}、{风格} 等标记模板里需要填词的部分。';
  if(state.error){$('#form-error').textContent=state.error;$('#form-error').scrollIntoView({behavior:'smooth',block:'center'});return;}
  state.busy=true;render();
  if(f.batchId){try{const batch=await api('batches/'+f.batchId+'/start',{method:'POST',body:JSON.stringify({category:f.category,templateOne:f.templateOne,templateTwo:f.templateTwo,ranges:f.ranges})});updateBatch(batch);state.tasks=await api('tasks');state.queue=await api('queue');state.selectedBatch=batch.id;state.form=freshForm();saveDraft();state.busy=false;navigate('batch');toast('本批已提交，将按顺序逐张调研');}catch(error){state.error=error.message;state.busy=false;render();}return;}
  try{const body={category:f.category,templateOne:f.templateOne,templateTwo:f.templateTwo,ranges:f.ranges,imageData:f.imageData,imageName:f.imageName};const task=await api(f.reuseId?`tasks/${f.reuseId}/resume`:'tasks',{method:'POST',body:JSON.stringify(body)});updateTask(task);state.selected=task.id;state.tab='titles';state.form=freshForm();try{localStorage.removeItem('listing-draft');}catch{}state.busy=false;navigate('detail');toast('任务已提交，可随时回到历史记录查看');}catch(error){state.error=error.message;state.busy=false;render();}
});
async function poll(){
  try{
    const [tasks,batches,queue]=await Promise.all([api('tasks'),api('batches'),api('queue')]);
    const before=JSON.stringify([state.tasks,state.batches,state.queue]);state.tasks=tasks;state.batches=batches;state.queue=queue;
    if(JSON.stringify([tasks,batches,queue])!==before){
      if(['detail','batch'].includes(state.screen)){const open=$('.event-log')?.open;render();if(open&&$('.event-log'))$('.event-log').open=true;}
      else if(state.screen==='history'){if($('#history-list'))$('#history-list').innerHTML=historyRows();if($('#batch-library'))$('#batch-library').innerHTML=batchLibrary();if($('#resume-all-control'))$('#resume-all-control').innerHTML=resumeAllButton();}
      else if(state.screen==='new'&&$('#recent-tasks'))$('#recent-tasks').innerHTML=recent();
      const notice=$('.queue-notice'),noticeHTML=queueNotice();if(noticeHTML){if(notice)notice.outerHTML=noticeHTML;else $('#workspace').insertAdjacentHTML('afterbegin',noticeHTML);}else if(notice)notice.remove();
    }
  }catch{}finally{setTimeout(poll,state.tasks.some(t=>['running','queued'].includes(t.state))?2500:10000);}
}
try{const boot=await api('bootstrap');state.tasks=boot.tasks;state.batches=boot.batches||[];state.queue=boot.queue||{};if(state.form.batchId){const draft=state.batches.find(b=>b.id===state.form.batchId&&b.state==='draft');state.form.batchPreview=draft||null;if(!draft)state.form.batchId='';}state.templates=boot.templates||[];state.health=boot.health;if(!state.templates.some(p=>p.id===state.form.presetId))state.form.presetId="";const selected=new URLSearchParams(location.search).get('task');if(selected&&state.tasks.some(t=>t.id===selected)){state.selected=selected;state.screen='detail';}const batchId=new URLSearchParams(location.search).get('batch');if(batchId&&state.batches.some(b=>b.id===batchId)){state.selectedBatch=batchId;state.screen='batch';}render();void poll();}catch(error){$('#app').innerHTML=`<div class="boot"><img src="./favicon.svg" width="44" height="44" alt=""><p>工作台暂时未连接：${esc(error.message)}</p><button class="button" onclick="location.reload()">重新连接</button></div>`;}
