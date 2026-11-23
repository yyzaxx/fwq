const $ = selector => document.querySelector(selector);
const state = { tasks: [], filter: 'all', search: '', busy: new Set() };
const priorityNames = { high: '重要', medium: '普通', low: '稍后' };
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
let toastTimer;

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 2600);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试');
  return data;
}
function dateText(value) {
  if (!value) return '';
  const [year, month, day] = value.split('-');
  return `${Number(month)}月${Number(day)}日${Number(year) === new Date().getFullYear() ? '' : ` · ${year}`}`;
}
function visibleTasks() {
  const query = state.search.trim().toLocaleLowerCase();
  return state.tasks.filter(task => (state.filter === 'all' || (state.filter === 'completed') === task.completed) && (!query || `${task.title} ${task.note}`.toLocaleLowerCase().includes(query)));
}
function taskHtml(task) {
  const overdue = task.dueDate && task.dueDate < localToday() && !task.completed;
  const busy = state.busy.has(task.id);
  return `<article class="task-item ${task.completed ? 'completed' : ''}" data-id="${task.id}">
    <button class="check-button ${task.completed ? 'checked' : ''}" data-action="toggle" aria-label="${task.completed ? '标为待完成' : '标为已完成'}" ${busy ? 'disabled' : ''}>${task.completed ? '✓' : ''}</button>
    <div class="task-main"><div class="task-title">${escapeHtml(task.title)}</div>${task.note ? `<div class="task-note">${escapeHtml(task.note)}</div>` : ''}
      <div class="task-meta"><span class="priority-label ${task.priority}">${priorityNames[task.priority]}</span>${task.dueDate ? `<span class="meta-date ${overdue ? 'overdue' : ''}">${overdue ? '已逾期 · ' : ''}${dateText(task.dueDate)}</span>` : '<span>无截止日期</span>'}</div>
    </div><div class="task-actions"><button class="icon-button" data-action="edit" aria-label="编辑任务" title="编辑" ${busy ? 'disabled' : ''}>✎</button><button class="icon-button" data-action="delete" aria-label="删除任务" title="删除" ${busy ? 'disabled' : ''}>×</button></div></article>`;
}
function render() {
  const visible = visibleTasks();
  $('#task-list').innerHTML = visible.map(taskHtml).join('');
  $('#task-count').textContent = state.tasks.filter(task => !task.completed).length;
  const done = state.tasks.filter(task => task.completed).length;
  const total = state.tasks.length;
  const percent = total ? Math.round(done / total * 100) : 0;
  $('#progress-number').textContent = `${percent}%`;
  $('#progress-ring').style.setProperty('--progress', `${percent}%`);
  $('#progress-copy').textContent = total ? (done === total ? '全部完成，辛苦了' : `还有 ${total - done} 件待完成`) : '还没有任务';
  $('#clear-completed').hidden = done === 0;
  $('#empty').hidden = visible.length > 0;
  if (!visible.length) {
    $('#empty-title').textContent = total ? '没有匹配的任务' : '清单是空的';
    $('#empty-copy').textContent = total ? '换个筛选条件或搜索词试试。' : '在上方添加第一件事吧。';
  }
}
function setSaving(saving) { $('#save-state').textContent = saving ? '正在保存…' : '已保存到服务器'; }
async function load() {
  try { const data = await api('/api/tasks'); state.tasks = data.tasks; render(); }
  catch (error) { toast(error.message); $('#save-state').textContent = '读取失败，请刷新重试'; }
}
function taskPayload(form) {
  const data = new FormData(form);
  return { title: data.get('title'), note: data.get('note'), dueDate: data.get('dueDate'), priority: data.get('priority') };
}

$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true; $('#form-error').textContent = ''; setSaving(true);
  try {
    const data = await api('/api/tasks', { method: 'POST', body: JSON.stringify(taskPayload(form)) });
    state.tasks.unshift(data.task); form.reset(); $('#title').focus(); render(); toast('任务已添加');
  } catch (error) { $('#form-error').textContent = error.message; }
  finally { button.disabled = false; setSaving(false); }
});

$('#task-list').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const item = button.closest('.task-item');
  const id = item.dataset.id;
  const task = state.tasks.find(entry => entry.id === id);
  if (!task || state.busy.has(id)) return;
  const action = button.dataset.action;
  if (action === 'edit') {
    const form = $('#edit-form'); form.reset(); form.elements.id.value = task.id;
    for (const key of ['title', 'note', 'dueDate', 'priority']) form.elements[key].value = task[key];
    $('#edit-error').textContent = ''; $('#edit-dialog').showModal(); return;
  }
  if (action === 'delete' && !confirm(`删除任务“${task.title}”？此操作无法撤销。`)) return;
  state.busy.add(id); render(); setSaving(true);
  try {
    if (action === 'toggle') {
      const data = await api(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ ...task, completed: !task.completed }) });
      state.tasks = state.tasks.map(entry => entry.id === id ? data.task : entry);
    } else if (action === 'delete') {
      await api(`/api/tasks/${id}`, { method: 'DELETE' }); state.tasks = state.tasks.filter(entry => entry.id !== id); toast('任务已删除');
    }
  } catch (error) { toast(error.message); }
  finally { state.busy.delete(id); setSaving(false); render(); }
});

document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach(el => el.classList.toggle('active', el === button));
  render();
}));
$('#search').addEventListener('input', event => { state.search = event.target.value; render(); });
$('#clear-completed').addEventListener('click', async () => {
  if (!confirm('清除所有已完成任务？此操作无法撤销。')) return;
  setSaving(true);
  try { await api('/api/tasks/completed', { method: 'DELETE' }); state.tasks = state.tasks.filter(task => !task.completed); render(); toast('已清除完成任务'); }
  catch (error) { toast(error.message); }
  finally { setSaving(false); }
});
$('#close-dialog').addEventListener('click', () => $('#edit-dialog').close());
$('#cancel-edit').addEventListener('click', () => $('#edit-dialog').close());
$('#edit-dialog').addEventListener('click', event => { if (event.target === $('#edit-dialog')) $('#edit-dialog').close(); });
$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const id = form.elements.id.value;
  const task = state.tasks.find(entry => entry.id === id); if (!task) return;
  const button = form.querySelector('button[type="submit"]'); button.disabled = true; $('#edit-error').textContent = '';
  try {
    const data = await api(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ ...taskPayload(form), completed: task.completed }) });
    state.tasks = state.tasks.map(entry => entry.id === id ? data.task : entry); $('#edit-dialog').close(); render(); toast('修改已保存');
  } catch (error) { $('#edit-error').textContent = error.message; }
  finally { button.disabled = false; }
});

const now = new Date();
$('#today').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now);
load();
