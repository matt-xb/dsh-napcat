import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
export interface TaskMedia {
    kind: 'image' | 'file';
    path: string;
    name: string;
    caption?: string;
}
export interface TaskResult {
    output: ContentBlock[];
    stopReason: string;
}
export interface TaskReceipt {
    childId: string;
    result: Promise<TaskResult>;
    dispose?: () => Promise<void>;
}
export interface TaskStart {
    parent: Agent;
    chatKey: string;
    prompt: ContentBlock[];
    label?: string;
}
export interface BackgroundTaskDeps {
    start(input: {
        parent: Agent;
        prompt: ContentBlock[];
        childId: string;
        signal: AbortSignal;
        label?: string;
    }): Promise<TaskReceipt>;
    notify(chatKey: string, text: string, parent: Agent, media: TaskMedia[]): Promise<void>;
    log?(message: string): void;
}
export declare class BackgroundTasks {
    private readonly deps;
    private readonly tasks;
    private stopped;
    constructor(deps: BackgroundTaskDeps);
    start(input: TaskStart): Promise<{
        taskId: string;
        childId: string;
    }>;
    keyForSession(sid: string): string | undefined;
    canSend(sid: string, chatKey: string): boolean | undefined;
    /** Only local, validated media bytes reach this callback; workers never send to QQ. */
    mediaReceiver(sid: string, chatKey: string): ((media: {
        kind: 'image' | 'file';
        url: string;
        name: string;
        caption?: string;
    }) => Promise<void>) | undefined;
    onSessionEvent(session: Pick<Session, 'id'>, event: SessionEvent): void;
    status(chatKey: string): string;
    private finish;
    interruptParent(sid: string): void;
    stop(): Promise<void>;
}
export interface TaskToolDeps {
    tasks: BackgroundTasks;
    /** Bridge supplies a per-turn admitted snapshot; worker sessions must resolve to undefined. */
    resolveContext(exec: unknown): {
        parent: Agent;
        chatKey: string;
        attachments: ContentBlock[];
        resultTurn?: boolean;
    } | undefined;
}
export declare function registerTaskTools(ctx: Context, deps: TaskToolDeps): void;
