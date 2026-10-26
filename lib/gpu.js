/**
 * 显存互斥：TTS（IndexTTS）与唱歌（Seed-VC 要 11–13 GiB）同时跑会抢爆 16 GiB。
 * 全插件共用一条串行队列，前一个跑完（成功或失败）才轮到下一个。
 */
let tail = Promise.resolve();

/** 串行执行 task；返回 task 的结果，失败照常抛出。 */
export function withGpu(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
}
