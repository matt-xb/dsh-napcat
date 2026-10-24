/** In-process task bookkeeping; execution and cancellation stay with the host subagent provider. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { base64UrlToBuffer, safeName } from './media.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { sanitizeReply } from './text.js';
const active = (task) => task.state === 'starting' || task.state === 'running';
export class BackgroundTasks {
    deps;
    tasks = new Map();
    stopped = false;
    constructor(deps) {
        this.deps = deps;
    }
    async start(input) {
        if (this.stopped)
            throw new Error('后台任务已停止，不能接受新任务');
        const id = 'napcat-task-' + randomUUID();
        const task = {
            id, chatKey: input.chatKey, label: (input.label || '后台任务').replace(/[\r\n]/g, ' ').slice(0, 60),
            state: 'starting', stage: '等待宿主接受', updated: Date.now(),
            controller: new AbortController(), parent: input.parent, media: [], delivered: false,
        };
        // Install ownership before activation: child tools may run before the receipt arrives.
        this.tasks.set(id, task);
        try {
            task.activation = this.deps.start({
                parent: input.parent, prompt: [...input.prompt], childId: id,
                signal: task.controller.signal, label: task.label,
            });
            const receipt = await task.activation;
            if (receipt.childId !== id) {
                // Observe the result even when rejecting an invalid provider receipt.
                void receipt.result.catch(() => { });
                await receipt.dispose?.();
                throw new Error('宿主返回的任务会话与预留会话不一致');
            }
            void receipt.result.then(result => this.finish(task, result), () => this.finish(task, { output: [], stopReason: 'error' })).finally(() => receipt.dispose?.()).catch(() => { this.deps.log?.('后台任务回执处理失败: ' + id); });
            if (this.stopped)
                throw new Error('后台任务启动期间已停止');
            if (task.state === 'starting') {
                task.state = 'running';
                task.stage = '宿主已接受，等待执行事件';
                task.updated = Date.now();
            }
            return { taskId: id, childId: id };
        }
        catch (error) {
            if (task.state !== 'interrupted') {
                task.state = 'error';
                task.stage = '启动失败';
                task.updated = Date.now();
            }
            throw error;
        }
    }
    keyForSession(sid) {
        // Retain ownership at terminal states: dropping it would turn an old worker into an unrestricted caller.
        return this.tasks.get(sid)?.chatKey;
    }
    canSend(sid, chatKey) {
        const task = this.tasks.get(sid);
        return task === undefined ? undefined : false;
    }
    /** Only local, validated media bytes reach this callback; workers never send to QQ. */
    mediaReceiver(sid, chatKey) {
        const task = this.tasks.get(sid);
        if (!task)
            return undefined;
        const assertOwned = () => {
            if (this.stopped || !active(task) || task.chatKey !== chatKey)
                throw new Error('任务已停止或媒体目标不属于本任务');
        };
        assertOwned();
        return async (media) => {
            assertOwned();
            if (!media.url.startsWith('base64://'))
                throw new Error('任务媒体必须是已验证的本地字节');
            const dir = join(task.parent.session.header.cwd || process.cwd(), 'napcat-task-results', task.id);
            await mkdir(dir, { recursive: true });
            const name = safeName(media.name, media.kind);
            const path = join(dir, randomUUID() + '-' + name);
            await writeFile(path, base64UrlToBuffer(media.url), { flag: 'wx' });
            assertOwned();
            task.media.push({ kind: media.kind, path, name, ...(media.caption ? { caption: media.caption } : {}) });
        };
    }
    onSessionEvent(session, event) {
        const task = this.tasks.get(String(session.id));
        if (task === undefined || !active(task) || this.stopped)
            return;
        switch (event.type) {
            case 'turn/start':
                task.stage = '执行中';
                break;
            case 'tool/call':
                task.stage = '调用工具 ' + event.data.name.replace(/[^a-zA-Z0-9_./-]/g, '').slice(0, 100);
                break;
            case 'tool/result':
                task.stage = '工具调用结束，等待后续步骤';
                break;
            case 'turn/end':
                task.stage = '回合结束，等待任务结果';
                break;
            default: return;
        }
        task.updated = Date.now();
    }
    status(chatKey) {
        const rows = [...this.tasks.values()].filter(task => task.chatKey === chatKey);
        if (rows.length === 0)
            return '本聊天没有后台任务（仅记录本次运行，不承诺跨重启续跑）。';
        return rows.map(task => `${task.id} | ${task.label} | ${task.state} | ${task.stage} | 最近事件 ${new Date(task.updated).toISOString()}${task.delivered ? ' | 已交主会话队列' : !active(task) ? ' | 未回传' : ''}`).join('\n');
    }
    async finish(task, result) {
        if (this.stopped || !active(task))
            return;
        task.state = result.stopReason === 'completed' ? 'completed' : result.stopReason === 'aborted' ? 'interrupted' : 'error';
        task.stage = task.state === 'completed' ? '任务完成' : task.state === 'interrupted' ? '任务被中断' : '任务未成功结束';
        task.updated = Date.now();
        const text = sanitizeReply(result.output.filter(block => block.type === 'text').map(block => block.text).join('\n'));
        const message = `后台任务 ${task.id}（${task.label}）：${task.stage}${task.state === 'completed' && text ? '\n' + text : ''}`;
        task.delivery = this.deps.notify(task.chatKey, message, task.parent, task.state === 'completed' ? [...task.media] : []);
        try {
            await task.delivery;
            task.delivered = true;
        }
        catch {
            this.deps.log?.('后台任务结果未回传: ' + task.id);
        }
    }
    interruptParent(sid) {
        for (const task of this.tasks.values()) {
            if (String(task.parent.session.id) !== sid || !active(task))
                continue;
            task.state = 'interrupted';
            task.stage = '原主会话已停止；结果不再自动回交';
            task.updated = Date.now();
            task.controller.abort();
            void task.activation?.then(receipt => receipt.dispose?.()).catch(() => {
                this.deps.log?.('后台任务释放失败: ' + task.id);
            });
        }
    }
    async stop() {
        this.stopped = true;
        const tasks = [...this.tasks.values()];
        for (const task of tasks) {
            if (active(task)) {
                task.state = 'interrupted';
                task.stage = '插件已停止；不承诺跨重启恢复';
                task.updated = Date.now();
            }
            task.controller.abort();
        }
        await Promise.all(tasks.map(async (task) => {
            try {
                await (await task.activation)?.dispose?.();
            }
            catch {
                this.deps.log?.('后台任务释放失败: ' + task.id);
            }
            // A notification already in flight cannot be retracted, but stop waits for it.
            await task.delivery?.catch(() => { });
        }));
    }
}
export function registerTaskTools(ctx, deps) {
    const contextFor = (exec) => {
        const context = deps.resolveContext(exec);
        if (context === undefined || deps.tasks.keyForSession(String(context.parent.session.id)) !== undefined) {
            throw new Error('后台任务工具只能由原 QQ 前台会话调用');
        }
        return context;
    };
    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
    ctx.tools.register(defineTool({
        name: 'napcat_task_start',
        description: '把生图、修图或其他长任务交给独立后台会话。立即返回任务编号，不阻塞本聊天；完成后交回原主智能体检查并统一回复QQ。附件仅使用本轮已准入快照，不接受任意附件路径。',
        parameters: {
            prompt: { type: 'string', required: true, description: '交给后台执行的完整任务说明' },
            label: { type: 'string', description: '简短任务名称' },
        },
        output,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const context = contextFor(exec);
            if (context.resultTurn)
                throw new Error('任务回执轮只能检查并回复结果，不能自动再次派任务');
            const input = args;
            if (!input.prompt.trim())
                throw new Error('任务说明不能为空');
            const result = await deps.tasks.start({
                parent: context.parent, chatKey: context.chatKey, label: input.label,
                prompt: [...context.attachments, { type: 'text', text: input.prompt }],
            });
            return `后台任务已接受：${result.taskId}。无需等待；完成后交回原主智能体检查统一回复，可继续聊天或查询真实状态。`;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_task_status', description: '查看本 QQ 聊天后台任务的真实阶段；不显示推理或工具参数，不虚构完成百分比。',
        parameters: {}, output, isConcurrencySafe: () => true,
        execute: async (_args, exec) => deps.tasks.status(contextFor(exec).chatKey),
    }));
}
