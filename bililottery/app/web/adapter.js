(() => {
    let token = '', stream;
    const listeners = { output: new Set(), state: new Set(), qrcode: new Set() };
    async function call(route, input) {
        if (!token && route !== '/api/bootstrap') await bootstrap();
        const response = await fetch(route, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Web-Token': token }, body: JSON.stringify(input) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '请求失败');
        return result;
    }
    async function bootstrap() {
        const result = await call('/api/bootstrap'); token = result.webToken;
        if (!stream) {
            stream = new EventSource('/api/events');
            for (const type of Object.keys(listeners)) stream.addEventListener(type, e => {
                for (const callback of listeners[type]) callback(JSON.parse(e.data));
            });
            stream.onopen = () => {
                fetch('/api/bootstrap').then(r=>r.json()).then(s=>{
                    listeners.state.forEach(f=>f(s.process));
                    if (s.qrImage) listeners.qrcode.forEach(f=>f(s.qrImage));
                }).catch(()=>{});
            };
            if (result.output) setTimeout(() => listeners.output.forEach(f=>f(result.output)), 0);
        }
        if (result.qrImage) setTimeout(() => listeners.qrcode.forEach(f=>f(result.qrImage)), 0);
        return result;
    }
    const subscribe = (type, callback) => { listeners[type].add(callback); return () => listeners[type].delete(callback); };
    window.lotteryDesktop = {
        bootstrap, saveSettings: input => call('/api/settings', input),
        previewSummaries: () => call('/api/summaries', {}), previewCleanup: () => call('/api/cleanup-preview', {}),
        chooseEngine: () => call('/api/engine', { path: document.getElementById('enginePath').value }),
        run: action => call('/api/run', { action }), stop: () => call('/api/stop', {}),
        openPath: async target => { const value = await call('/api/path', { target }); alert(`本机服务路径：\n${value.path}`); },
        openExternal: async value => {
            const url = new URL(value);
            if (url.protocol !== 'https:' || !['www.bilibili.com','t.bilibili.com','github.com','www.gnu.org'].includes(url.hostname)) throw new Error('不支持的链接');
            window.open(url.href, '_blank', 'noopener,noreferrer');
        },
        onOutput: callback => subscribe('output', callback), onState: callback => subscribe('state', callback), onQrCode: callback => subscribe('qrcode', callback)
    };
})();
