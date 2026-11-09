import {select,restore} from './tasks.js';

const $=s=>document.querySelector(s);
const legacyKey='qingdan-tasks-v1',migrationKey='qingdan-server-migrated-v1';
const titles={all:'全部任务',active:'待办任务',done:'已完成',important:'重要任务'};
let tasks=[],filter='all',editing=null,timer,ready=false,busy=false,syncing=false,epoch=0;
let status='○ 正在读取共享清单…',writeError=false,legacy=[],legacyDone=false,legacyWarning='';
let migrationBlocked=false,migrationIssue='',pendingAdd=null;
try{
  const raw=localStorage.getItem(legacyKey);
  if(localStorage.getItem(migrationKey)==='1'||!raw)legacyDone=true;
  else {legacy=restore(raw);if(!Array.isArray(JSON.parse(raw)))throw new Error('invalid');if(!legacy.length)legacyDone=true;}
}catch{legacyDone=true;}
$('#date').textContent=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date())+' · 今天也要从容一点';
function toast(message){
  $('#toast').textContent=message;$('#toast').classList.add('show');
  clearTimeout(timer);timer=setTimeout(()=>$('#toast').classList.remove('show'),4000);
}
async function request(path='',method='GET',body){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch('/api/tasks'+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store'});
    const data=await response.json();
    if(!response.ok){const error=new Error(data.error||'服务器请求失败，请稍后重试');error.status=response.status;throw error;}
    return data;
  }catch(error){
    if(error.status)throw error;
    throw new Error('无法连接服务器，请检查网络后重试');
  }finally{clearTimeout(timeout);}
}
function render(){
  const done=tasks.filter(t=>t.done).length,pending=tasks.length-done,percent=tasks.length?Math.round(done/tasks.length*100):0;
  $('#total').textContent=tasks.length;$('#pending').textContent=pending;$('#completed').textContent=done;
  $('#percent').replaceChildren(document.createTextNode(percent),Object.assign(document.createElement('small'),{textContent:'%'}));
  $('#progress').style.width=percent+'%';$('#nav-all').textContent=tasks.length;$('#nav-active').textContent=pending;$('#nav-done').textContent=done;
  $('#nav-important').textContent=tasks.filter(t=>!t.done&&t.priority==='high').length;
  $('#remaining').textContent=`还有 ${pending} 件任务待完成`;
  $('#saved').textContent=busy?'○ 正在保存到服务器…':status;
  $('#saved').setAttribute('role','status');
  $('#task-input').disabled=!ready||busy;$('#priority').disabled=!ready||busy;$('#add-form button').disabled=!ready||busy;
  $('#edit-form button[type=submit]').disabled=!ready||busy;
  const visible=select(tasks,filter,$('#search').value.trim());
  $('#list-title').replaceChildren(document.createTextNode(titles[filter]+' '),Object.assign(document.createElement('span'),{textContent:visible.length}));
  $('#tasks').replaceChildren();
  for(const task of visible){
    const row=document.createElement('div');row.className='task'+(task.done?' done':'');
    const checkbox=document.createElement('button');checkbox.className='check';checkbox.textContent=task.done?'✓':'';
    checkbox.setAttribute('aria-label',(task.done?'标为待办：':'完成：')+task.title);checkbox.setAttribute('aria-pressed',String(task.done));checkbox.disabled=!ready||busy;
    checkbox.onclick=()=>mutate('/'+task.id,'PATCH',{done:!task.done,version:task.version},data=>replaceTask(data.task),'状态已保存到服务器');
    const name=document.createElement('span');name.className='task-name';name.textContent=task.title;
    const badge=document.createElement('span');badge.className='badge '+task.priority;badge.textContent={high:'高优先级',normal:'普通',low:'低优先级'}[task.priority];
    const actions=document.createElement('div');actions.className='task-actions';
    for(const [label,fn] of [
      ['编辑',()=>{editing={id:task.id,version:task.version};$('#edit-input').value=task.title;$('#edit-input').setCustomValidity('');$('#edit-dialog').showModal();$('#edit-input').focus();}],
      ['删除',()=>mutate('/'+task.id+'?version='+task.version,'DELETE',undefined,()=>{tasks=tasks.filter(t=>t.id!==task.id);},'任务已删除')]
    ]){const button=document.createElement('button');button.textContent=label;button.setAttribute('aria-label',label+'：'+task.title);button.disabled=!ready||busy;button.onclick=fn;actions.append(button);}
    row.append(checkbox,name,badge,actions);$('#tasks').append(row);
  }
  $('#empty').hidden=visible.length>0;
  if(!visible.length){
    $('#empty h3').textContent=!ready?'正在连接共享清单':tasks.length?'这里暂时没有任务':'给今天一个小小的开始';
    $('#empty p').textContent=!ready?'读取成功后即可操作，网络恢复后会自动重试。':tasks.length?'试试其他筛选条件，或添加一件新的待办。':'在上方记下第一件事，把想法变成行动。';
  }
  $('#clear').disabled=!ready||busy||!done;$('#clear').style.opacity=$('#clear').disabled?'.4':'1';
  document.querySelectorAll('[data-filter]').forEach(button=>{const active=button.dataset.filter===filter;button.classList.toggle(button.classList.contains('nav')?'active':'selected',active);button.setAttribute('aria-pressed',String(active));});
}
function replaceTask(task){const found=tasks.some(t=>t.id===task.id);tasks=found?tasks.map(t=>t.id===task.id?task:t):[...tasks,task];}
async function sync(){
  if(syncing||busy)return;
  syncing=true;const startEpoch=epoch;
  try{
    let data=await request();
    if(!legacyDone&&!migrationBlocked){
      try{
        data=await request('/import','POST',{tasks:legacy});legacyDone=true;migrationIssue='';
        try{localStorage.setItem(migrationKey,'1');}catch{/* 服务器导入幂等，本地标记失败不影响已保存的数据。 */}
        legacyWarning='原浏览器任务已合并到服务器，本地备份已保留';
      }catch(error){
        // 导入失败不影响已成功读取的共享清单，原始备份和迁移标记保持原样。
        if(!migrationIssue)legacyWarning='旧任务迁移失败，本地备份已保留，不影响共享清单';
        migrationIssue=error.message;
        migrationBlocked=error.status>=400&&error.status<500;
      }
    }
    if(startEpoch!==epoch)return;
    if(!Array.isArray(data.tasks))throw new Error('服务器数据格式异常，请稍后重试');
    const changed=JSON.stringify(tasks)!==JSON.stringify(data.tasks)||!ready;
    tasks=data.tasks;ready=true;
    const next=writeError?'○ 上次保存失败，请重试':migrationIssue?'● 已同步到服务器 · 旧任务待导入':'● 已同步到服务器';
    const statusChanged=status!==next;status=next;
    if(changed||statusChanged)render();
    if(legacyWarning){toast(legacyWarning);legacyWarning='';}
  }catch(error){
    if(startEpoch!==epoch)return;
    status=ready?'○ 无法同步，正在重试':'○ 无法读取服务器，正在重试';
    render();
    if(!ready)toast(error.message);
  }finally{syncing=false;}
}
async function mutate(path,method,body,apply,message){
  if(!ready||busy)return false;
  busy=true;epoch++;render();
  try{
    const data=await request(path,method,body);apply(data);writeError=false;status='● 已同步到服务器';toast(message);return true;
  }catch(error){
    writeError=true;status='○ 保存失败，请重试';toast(error.message);
    if(path===''&&method==='POST'&&error.status>=400&&error.status<500)pendingAdd=null;
    if(error.status===409||error.status===404){
      try{const data=await request();if(Array.isArray(data.tasks))tasks=data.tasks;}catch{}
    }
    return false;
  }finally{busy=false;epoch++;render();}
}
$('#add-form').onsubmit=async event=>{
  event.preventDefault();const input=$('#task-input');
  if(!input.value.trim()){input.setCustomValidity('请填写任务内容');input.reportValidity();return;}
  const title=input.value,priority=$('#priority').value;
  if(!pendingAdd||pendingAdd.title!==title||pendingAdd.priority!==priority){
    const requestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
    pendingAdd={title,priority,requestId};
  }
  const ok=await mutate('','POST',pendingAdd,data=>replaceTask(data.task),'新任务已保存到服务器');
  if(ok){pendingAdd=null;input.value='';filter='all';$('#search').value='';render();input.focus();}
};
$('#task-input').oninput=event=>event.target.setCustomValidity('');
$('#edit-input').oninput=event=>event.target.setCustomValidity('');
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;render();});
$('#search').oninput=render;
$('#clear').onclick=()=>{
  if(!ready||busy||!confirm('确定清理共享清单中的所有已完成任务？所有设备都会同步删除。'))return;
  const completed=tasks.filter(t=>t.done).map(t=>({id:t.id,version:t.version}));
  mutate('/clear-completed','POST',{tasks:completed},data=>{tasks=data.tasks;},'已完成任务已清理');
};
$('#edit-form').onsubmit=async event=>{
  event.preventDefault();const input=$('#edit-input');
  if(!input.value.trim()){input.setCustomValidity('请填写任务内容');input.reportValidity();return;}
  if(!editing)return;
  const ok=await mutate('/'+editing.id,'PATCH',{title:input.value,version:editing.version},data=>replaceTask(data.task),'修改已保存到服务器');
  if(ok){$('#edit-dialog').close();editing=null;}
};
$('#cancel-edit').onclick=()=>$('#edit-dialog').close();
window.addEventListener('focus',sync);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});
setInterval(()=>{if(!document.hidden)sync();},3000);
render();sync();
