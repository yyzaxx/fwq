(() => {
    const api = window.lotteryDesktop;
    if (!api.previewDynamics || !api.refreshWins) return;
    const $ = selector => document.querySelector(selector);
    const labels = {reposts:'全部转发动态（保留原创）', recorded:'本工具记录的抽奖转发', all:'全部动态（含原创）'};
    let state, report, activeDialog = false, pollTimer, winAttempt = 0, pollBusy = false, previewPending = false, previewVersion = 0, suppressReady = false;
    const dialog = $('#dynamic-delete-dialog');
    const stamp = value => value ? new Date(value).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) : '';
    for (const element of document.querySelectorAll('.web-only')) element.classList.remove('hidden');
    function toast(text, error=false) { window.showToast?.(text,error); }
    function apply(value) { window.updateState(value, false); }
    function showDialog() { activeDialog=true; if (!dialog.open) dialog.showModal(); }
    function stopPolling() { clearTimeout(pollTimer); pollTimer=null; }
    async function poll() {
        stopPolling();
        if (pollBusy || previewPending) return;
        pollBusy=true;
        try { render(await api.dynamicStatus()); } catch {} finally {
            pollBusy=false;
            if (['scanning','deleting'].includes(report?.state)) pollTimer=setTimeout(poll,2000);
        }
    }
    function render(value, force=false) {
        if (previewPending && !force) return;
        report=value || {};
        const total=report.count ?? report.total ?? 0;
        const busy=['scanning','deleting'].includes(report.state);
        const ready=report.state==='preview' && report.canExecute && !suppressReady && !previewPending;
        const messages={idle:'尚未读取待删动态。',scanning:`正在核对动态，已扫描 ${report.scanned||0} 条；尚未删除。`,preview:`已核对 ${total} 条符合范围的动态，尚未删除。`,deleting:`正在后台处理：已删除 ${report.deleted||0} / ${total} 条，跳过 ${report.skipped||0} 条。`,completed:`处理完成：已删除 ${report.deleted||0} 条，跳过 ${report.skipped||0} 条。`,simulated:`模拟完成：演练 ${report.simulated||0} 条，未执行真实删除。`,cancelled:`已停止：已删除 ${report.deleted||0} 条，剩余动态保留。`,failed:`处理已停止：${report.error||'请重新核对登录和来源状态'}；已删除 ${report.deleted||0} 条。`,interrupted:`上次处理已中断，已确认删除 ${report.deleted||0} 条；重新预览后再继续。`};
        const message=messages[report.state]||'尚未读取待删动态。';
        $('#dynamic-summary').textContent=message;
        $('#dynamic-dialog-title').textContent=report.state==='preview'?'确认动态删除范围':'动态处理进度';
        $('#dynamic-dialog-meta').textContent=report.uid?`账号 UID ${report.uid} · ${labels[report.scope]||''} · 本次共 ${total} 条`:'';
        $('#dynamic-dialog-status').textContent=message;
        $('#dynamic-delete-warning').textContent=report.dryRun?'当前为模拟模式，仅演练清单，不执行真实删除。':'确认后会真实删除当前清单内的动态，此操作不能撤销；未开奖转发也可能在内。';
        $('#dynamic-delete-warning').classList.toggle('hidden', report.state!=='preview');
        const box=$('#dynamic-delete-items');box.replaceChildren();
        for (const item of report.items||[]) {
            const row=document.createElement('div');row.className='dynamic-preview-item';
            const kind=document.createElement('strong');kind.textContent=item.type==='DYNAMIC_TYPE_FORWARD'?'转发':'原创/其他';
            const text=document.createElement('span');text.textContent=item.text||`动态 ${item.id}`;
            const link=document.createElement('button');link.type='button';link.className='text-button';link.textContent='查看动态';link.addEventListener('click',()=>api.openExternal(item.url).catch(e=>toast(e.message,true)));
            row.append(kind,text,link);box.append(row);
        }
        $('#dynamic-preview-note').textContent=total>(report.items?.length||0)?`此处展示前 ${report.items?.length||0} 条；确认后会处理本次清单内共 ${total} 条。`:ready?'只处理本次已预览清单，之后新发布的动态不在本次范围。':'';
        $('#btn-dynamic-confirm').classList.toggle('hidden',!ready);
        $('#btn-dynamic-confirm').disabled=!ready;
        $('#btn-dynamic-confirm').textContent=`确认${report.dryRun?'模拟':''}删除 ${total} 条`;
        $('#btn-dynamic-stop').classList.toggle('hidden',!busy);
        $('#btn-dynamic-stop').textContent=report.state==='scanning'?'停止预览':'停止删除';
        $('#btn-dynamic-close').textContent=report.state==='deleting'?'在后台继续':ready?'取消':'关闭';
        $('#btn-dynamics-progress').classList.toggle('hidden',!report.uid);
        if (activeDialog && !dialog.open) dialog.showModal();
        if (busy && !pollTimer && !pollBusy) pollTimer=setTimeout(()=>{pollTimer=null;poll();},1200);
        if (!busy) stopPolling();
    }
    function renderWins(wins={}) {
        $('#stat-wins').textContent=Number.isInteger(wins.count)?String(wins.count):'—';
        const loading=state?.process?.action==='wins'&&state.process.running;
        $('#wins-status').textContent=loading?'正在统计近七天站内中奖通知…':wins.status==='ok'?`按中奖通知去重 · 更新 ${stamp(wins.updatedAt)}`:wins.status==='stale'?`上次结果 ${stamp(wins.updatedAt)}；${wins.message||'当前更新未完成'}`:wins.message||'尚未完成统计；未知不会按0次显示。';
        $('#btn-wins-refresh').disabled=Boolean(state?.process?.running);
    }
    async function refreshWins(manual=false) {
        if (!state?.account?.loggedIn || state.process.running) return;
        winAttempt=Date.now();
        try { apply(await api.refreshWins()); } catch(error) { if(manual)toast(error.message,true); }
    }
    function maybeRefreshWins() {
        if (!state?.account?.loggedIn || state.process.running) return;
        const last=Math.max(Date.parse(state.wins?.updatedAt)||0,winAttempt);
        if (Date.now()-last>30*60*1000) void refreshWins(false);
    }
    async function preview() {
        if (previewPending) return;
        const version=++previewVersion, scope=$('#dynamic-scope').value;
        previewPending=true; suppressReady=false; activeDialog=true;
        stopPolling();
        render({state:'scanning',scope,uid:state?.settings?.uid||'',dryRun:state?.settings?.dryRun!==false,items:[],count:0,canExecute:false},true);
        showDialog();
        try {
            winAttempt=Date.now();
            await window.saveSettings(false);
            if (version!==previewVersion) return;
            const latest=await api.previewDynamics(scope);
            if (version!==previewVersion) return;
            previewPending=false;
            apply(latest);
        } catch(error) {
            if (version!==previewVersion) return;
            previewPending=false; suppressReady=true;
            render({...report,state:'failed',canExecute:false,previewId:null,error:error.message},true);
            toast(error.message,true);
        }
    }
    $('#btn-dynamics-open').addEventListener('click',preview);
    $('#btn-dynamics-preview').addEventListener('click',preview);
    $('#btn-dynamics-progress').addEventListener('click',()=>{showDialog();render(report);});
    $('#btn-dynamic-confirm').addEventListener('click',async()=>{
        if (previewPending || suppressReady || !report?.canExecute || report.state!=='preview') return;
        $('#btn-dynamic-confirm').disabled=true;
        try { apply(await api.deleteDynamics(report.previewId)); } catch(error) { toast(error.message,true);void window.refresh(false); }
    });
    async function stop() { if(['dynamic-preview','dynamic-delete'].includes(state?.process?.action)) { try{await api.stop();}catch(error){toast(error.message,true);} } }
    $('#btn-dynamic-stop').addEventListener('click',stop);
    $('#btn-dynamic-close').addEventListener('click',async()=>{
        const scanning=previewPending||report?.state==='scanning';
        ++previewVersion; previewPending=false; suppressReady=true; activeDialog=false;
        stopPolling();
        if (scanning || report?.state==='preview') render({...report,state:'cancelled',canExecute:false,previewId:null},true);
        dialog.close();
        if(scanning)await stop();
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();$('#btn-dynamic-close').click();});
    $('#btn-wins-refresh').addEventListener('click',()=>refreshWins(true));
    setInterval(maybeRefreshWins,60*1000);
    window.biliFeatures={
        update(value) { state=value;render(state.dynamicDeletion);renderWins(state.wins);setTimeout(maybeRefreshWins,1000); },
        setProcess(proc) { if(state)state.process=proc;renderWins(state?.wins);if(['dynamic-preview','dynamic-delete'].includes(proc.action))void poll(); }
    };
})();
