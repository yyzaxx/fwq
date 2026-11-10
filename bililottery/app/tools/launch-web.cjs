const { execFile } = require('node:child_process');
const { createWebServer } = require('../web/server.cjs');
const app = createWebServer();
async function start() {
    const preferred = Number(process.env.BILI_WEB_PORT || 8787);
    if (!Number.isInteger(preferred) || preferred < 0 || preferred > 65535) throw new Error('Invalid BILI_WEB_PORT');
    for (let offset = 0; offset < 10 && preferred + offset <= 65535; offset++) {
        try {
            const url = await app.listen(preferred === 0 ? 0 : preferred + offset);
            console.log(`BiliLottery Web ready: ${url}`);
            console.log('Keep this window open. Press Ctrl+C to stop the service.');
            if (process.platform === 'win32' && process.env.BILI_WEB_OPEN_BROWSER !== '0') {
                execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, error => {
                    if (error) console.log('Open the URL above in your browser.');
                });
            }
            return;
        } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    throw new Error('No available port. Set BILI_WEB_PORT to another port.');
}
start().catch(error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
