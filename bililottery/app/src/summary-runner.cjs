const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { setTimeout: pause } = require('timers/promises');
const { writeJsonAtomic } = require('./config.cjs');
const { hydrateSummaryTask } = require('./summaries.cjs');
const { installRepostTracking } = require('./cleanup.cjs');

async function runSummaryTasks(tasks, { prepare, execute, now = Date.now, signal, onOutput = () => {}, interval = 0 }) {
    let processed = 0;
    for (let index = 0; index < tasks.length; index++) {
        signal?.throwIfAborted();
        const item = tasks[index];
        if (!(Date.parse(item.drawAt) > now())) continue;
        if (index && interval) await pause(interval, undefined, { signal });
        onOutput(`[每日汇总] 正在处理 ${index + 1}/${tasks.length}：${item.name || item.dyid}\n`);
        const record = await prepare(item);
        signal?.throwIfAborted();
        if (!record || !(Date.parse(item.drawAt) > now())) continue;
        await execute(record);
        processed++;
    }
    return processed;
}

async function main() {
    const enginePath = path.resolve(process.argv[3]);
    const runtime = process.cwd();
    const engineRequire = createRequire(path.join(enginePath, 'package.json'));
    const env = engineRequire('./lib/data/env.js');
    env.init();
    const config = engineRequire('./lib/data/config.js');
    const globals = engineRequire('./lib/data/global_var.js');
    const { log, hasEnv } = engineRequire('./lib/utils.js');
    log.init();
    const simulation = Boolean(hasEnv('NOT_GO_LOTTERY'));
    const mode = simulation ? '模拟运行' : '真实互动';
    console.log(`[每日汇总] 本轮模式：${mode}`);
    if (simulation) {
        // Upstream records IDs even when go() skips every action in dry-run mode.
        // Keep those simulated IDs out of the user's actual participation history.
        engineRequire('./lib/helper/d_storage.js').updateDyid = async () => {};
    }
    let reposted = 0, reserved = 0;
    const engineInfo = log.info;
    log.info = function (label, message) {
        if (!simulation && label === '转发动态' && String(message).includes('成功转发一条动态')) reposted++;
        if (!simulation && label === '预约抽奖' && message === '预约成功') reserved++;
        return engineInfo.apply(this, arguments);
    };
    await globals.init(process.env.COOKIE, process.env.NUMBER || '1');
    const document = JSON.parse(fs.readFileSync(path.join(runtime, 'summary-tasks.json'), 'utf8'));
    const tasks = document.tasks;
    if (!/^\d+$/.test(String(document.summaryUid)) || !Array.isArray(tasks)) throw new Error('汇总任务文件无效');
    installRepostTracking(engineRequire('./lib/net/http.js'), runtime, { uid: globals.get('myUID'), summaryUid: document.summaryUid,
        tasks, simulation, onOutput: text => process.stdout.write(text) });
    if (config.model === '00') { console.log('[每日汇总] 已关闭抽奖行为'); return; }
    const { checkCookie } = engineRequire('./lib/index.js');
    if (!await checkCookie(process.env.NUMBER || '1')) throw new Error('账号登录失效，已停止');
    const { Monitor } = engineRequire('./lib/core/monitor.js');
    const bili = engineRequire('./lib/net/bili.js');
    const monitor = new Monitor(['APIs', 'file://up-summary.json']);
    if (!monitor.tagid && config.is_not_create_partition !== true) {
        monitor.tagid = await bili.checkMyPartition();
        if (!monitor.tagid) throw new Error('关注分区读取失败，已停止');
    }
    const attention = await bili.getAttentionList(globals.get('myUID'));
    if (attention === null) throw new Error('关注列表读取失败，已停止');
    monitor.attentionList = new Set(attention ? attention.split(',') : []);
    const count = await runSummaryTasks(tasks, {
        interval: Math.max(2000, Number(config.search_wait) || 2000),
        onOutput: text => process.stdout.write(text),
        prepare: item => hydrateSummaryTask(item, enginePath, runtime, {}),
        execute: async record => {
            writeJsonAtomic(path.join(runtime, 'lottery_info/up-summary.json'), { summary: [record] });
            const status = await monitor.startLottery();
            if (status) throw new Error(`当前动态处理返回 ${status}，已停止后续任务`);
        }
    });
    console.log(`[每日汇总] 本轮逐条处理结束，已交给引擎 ${count} 条；转发成功 ${reposted} 条，预约成功 ${reserved} 条；${mode}`);
}

if (require.main === module) main().catch(error => { console.error(`[每日汇总] ${error.message}`); process.exitCode = 1; });
module.exports = { runSummaryTasks };
