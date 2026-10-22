/** 模型可调用的工具：主动发消息、列会话、受白名单约束的原始 OneBot 调用。 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_IMAGE_BYTES, localToBase64Url, sourceToBase64Url } from './media.js';
import { splitText } from './text.js';
/** 允许通过 napcat_api 透传的动作白名单（只读 + 发消息，避免模型乱调用管理类动作）。 */
const ALLOWED_ACTIONS = new Set([
    'send_msg',
    'send_private_msg',
    'send_group_msg',
    'get_login_info',
    'get_status',
    'get_version_info',
    'get_friend_list',
    'get_group_list',
    'get_group_info',
    'get_group_member_info',
    'get_group_member_list',
    'get_stranger_info',
]);
function textOutput() {
    return {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
    };
}
function parseChatId(raw) {
    const match = /^(private|group):(.+)$/.exec(raw.trim());
    if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new Error('chat_id 格式应为 private:<QQ号> 或 group:<群号>，收到: ' + raw);
    }
    const kind = match[1] === 'private' ? 'private' : 'group';
    return { kind, id: match[2].trim() };
}
export function registerTools(ctx, conn, log, deps = {}) {
    const keyForSession = deps.keyForSession;
    const maxImageBytes = deps.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    /** 解析目标会话：显式 chat_id 优先，否则用当前 agent 的会话。 */
    const resolveChat = (explicit, exec) => {
        const raw = typeof explicit === 'string' && explicit.trim() !== '' ? explicit.trim() : undefined;
        if (raw !== undefined)
            return parseChatId(raw);
        const sessionId = exec?.agent?.session?.id;
        const derived = sessionId === undefined || keyForSession === undefined ? undefined : keyForSession(String(sessionId));
        if (derived === undefined || derived === '') {
            throw new Error('需要 chat_id（形如 private:123456 或 group:789012）：当前调用不在某个 QQ 会话里');
        }
        return parseChatId(derived);
    };
    const sendSegments = async (target, message) => {
        const result = await conn.call('send_msg', {
            message_type: target.kind,
            ...(target.kind === 'group' ? { group_id: target.id } : { user_id: target.id }),
            message,
        });
        return result?.message_id === undefined ? undefined : String(result.message_id);
    };
    ctx.tools.register(defineTool({
        name: 'napcat_send_message',
        description: '主动给一个 QQ 会话发文本消息（不需要对方先说话）。chat_id 形如 private:123456 或 group:789012。超长文本会自动分段。',
        parameters: {
            chat_id: { type: 'string', required: true, description: '目标会话：private:<QQ号> 或 group:<群号>' },
            text: { type: 'string', required: true, description: '要发送的纯文本' },
            quote_message_id: { type: 'string', description: '可选：引用（回复）这条消息的 id' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const input = args;
            const target = parseChatId(input.chat_id);
            const chunks = splitText(input.text, 1200);
            const ids = [];
            for (let index = 0; index < chunks.length; index += 1) {
                const chunk = chunks[index];
                if (chunk === undefined)
                    continue;
                const message = [];
                if (index === 0 && typeof input.quote_message_id === 'string' && input.quote_message_id !== '') {
                    message.push({ type: 'reply', data: { id: input.quote_message_id } });
                }
                message.push({ type: 'text', data: { text: chunk } });
                const result = await conn.call('send_msg', {
                    message_type: target.kind,
                    ...(target.kind === 'group' ? { group_id: target.id } : { user_id: target.id }),
                    message,
                });
                if (result?.message_id !== undefined)
                    ids.push(String(result.message_id));
            }
            log('info', '工具发送 ' + input.chat_id + ' (' + chunks.length + ' 段)');
            return '已发送 ' + chunks.length + ' 段到 ' + input.chat_id + (ids.length > 0 ? '（message_id: ' + ids.join(', ') + '）' : '');
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_list_targets',
        description: '列出机器人账号的好友和群（用来确定 napcat_send_message 的 chat_id）。',
        parameters: {},
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async () => {
            let friends = [];
            let groups = [];
            let firstError;
            try {
                friends = await conn.call('get_friend_list', {});
            }
            catch (error) {
                firstError = error instanceof Error ? error.message : String(error);
            }
            try {
                groups = await conn.call('get_group_list', {});
            }
            catch (error) {
                firstError = firstError ?? (error instanceof Error ? error.message : String(error));
            }
            if (friends.length === 0 && groups.length === 0 && firstError !== undefined) {
                throw new Error('取好友/群失败：' + firstError + '（多半是 NapCat 未连接：检查 mode/url/accessToken，以及反向 WS 是否已接入）');
            }
            const lines = [];
            lines.push('好友（' + friends.length + '）：');
            for (const friend of friends.slice(0, 50)) {
                lines.push('  private:' + String(friend.user_id ?? '') + '  ' + String(friend.remark ?? friend.nickname ?? ''));
            }
            lines.push('群（' + groups.length + '）：');
            for (const group of groups.slice(0, 50)) {
                lines.push('  group:' + String(group.group_id ?? '') + '  ' + String(group.group_name ?? '') + '（' + String(group.member_count ?? '?') + ' 人）');
            }
            if (friends.length === 0 && groups.length === 0)
                lines.push('（没有取到任何会话；确认 NapCat 已登录且 get_friend_list/get_group_list 可用）');
            return lines.join('\n');
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_api',
        description: '直接调用一个 OneBot 11 动作（只允许白名单内的只读动作与发送动作）。params_json 是 JSON 字符串，如 {"group_id":"789012","message":[{"type":"text","data":{"text":"hi"}}]}。',
        parameters: {
            action: { type: 'string', required: true, description: 'OneBot 动作名，如 get_group_list / send_group_msg' },
            params_json: { type: 'string', description: '动作参数（JSON 字符串，可省略）' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args) => {
            const input = args;
            if (!ALLOWED_ACTIONS.has(input.action)) {
                throw new Error('动作不在白名单内: ' + input.action + '（允许: ' + [...ALLOWED_ACTIONS].join(', ') + '）');
            }
            let params = {};
            if (typeof input.params_json === 'string' && input.params_json.trim() !== '') {
                const parsed = JSON.parse(input.params_json);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    throw new Error('params_json 必须是 JSON 对象');
                }
                params = parsed;
            }
            const data = await conn.call(input.action, params);
            return JSON.stringify(data ?? null, null, 2);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_send_image',
        description: '给 QQ 会话发图片（本地路径或 http(s) 链接；自动转 base64，NapCat 在远端也能发）。省略 chat_id 时发到当前会话。',
        parameters: {
            source: { type: 'string', required: true, description: '本地图片绝对路径，或 http(s) 图片链接' },
            chat_id: { type: 'string', description: '目标会话：private:<QQ号> 或 group:<群号>；省略=当前会话' },
            caption: { type: 'string', description: '可选：图片前的文字说明' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const target = resolveChat(input.chat_id, exec);
            const image = await sourceToBase64Url(input.source, maxImageBytes);
            const message = [];
            if (typeof input.caption === 'string' && input.caption.trim() !== '') {
                message.push({ type: 'text', data: { text: input.caption.trim() } });
            }
            message.push({ type: 'image', data: { file: image.url } });
            const id = await sendSegments(target, message);
            log('info', '工具发图片 ' + String(target.id) + ' (' + Math.round(image.bytes / 1024) + 'KB)');
            return '已发送图片 ' + image.name + '（' + Math.round(image.bytes / 1024) + 'KB）' + (id === undefined ? '' : '，message_id: ' + id);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'napcat_send_file',
        description: '给 QQ 会话发文件（本地路径；自动转 base64 走上传接口）。省略 chat_id 时发到当前会话。',
        parameters: {
            path: { type: 'string', required: true, description: '本地文件绝对路径' },
            chat_id: { type: 'string', description: '目标会话：private:<QQ号> 或 group:<群号>；省略=当前会话' },
            name: { type: 'string', description: '可选：对方看到的文件名（默认用原文件名）' },
        },
        output: textOutput(),
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
            const input = args;
            const target = resolveChat(input.chat_id, exec);
            const file = await localToBase64Url(input.path, maxFileBytes);
            const displayName = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : file.name;
            const errors = [];
            // ① 先试文件消息段（部分 NapCat 版本支持 base64）
            try {
                const id = await sendSegments(target, [{ type: 'file', data: { file: file.url, name: displayName } }]);
                log('info', '工具发文件（file 段）' + String(target.id) + ' (' + Math.round(file.bytes / 1024) + 'KB)');
                return '已发送文件 ' + displayName + '（' + Math.round(file.bytes / 1024) + 'KB）' + (id === undefined ? '' : '，message_id: ' + id);
            }
            catch (error) {
                errors.push('file 段失败: ' + (error instanceof Error ? error.message : String(error)));
            }
            // ② 退回群文件/私聊文件上传接口
            try {
                if (target.kind === 'group') {
                    await conn.call('upload_group_file', { group_id: target.id, file: file.url, name: displayName });
                }
                else {
                    await conn.call('upload_private_file', { user_id: target.id, file: file.url, name: displayName });
                }
                log('info', '工具发文件（upload）' + String(target.id) + ' (' + Math.round(file.bytes / 1024) + 'KB)');
                return '已通过上传接口发送文件 ' + displayName + '（' + Math.round(file.bytes / 1024) + 'KB）';
            }
            catch (error) {
                errors.push('上传接口失败: ' + (error instanceof Error ? error.message : String(error)));
            }
            throw new Error('发送文件失败：' + errors.join('；') + '（NapCat 远端时文件消息支持有限，可先试发图片或将文件放到公共可访问 URL）');
        },
    }));
}
