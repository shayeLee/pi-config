/**
 * model-failback — provider 终态判定接口
 *
 * 每个 provider 一个 handler:
 *  - 新 provider 只新增一个文件并注册,不动引擎与入口
 *  - handler 只负责"这条失败的 assistant 消息是不是该 provider 的终态错误",
 *    不接触 setModel / steering / 配置,保持可单测
 */

/** 判定结果:null 表示不是终态(或不属于该 provider),正常失败走原路径 */
export interface TerminalVerdict {
  /** 终态类别,写入台账与 UI 提示;新增类别就在这里扩展 */
  reason: "usage_limit" | string;
  /**
   * 终态的作用域语义:
   *  - "cross-provider":错误按账户/订阅计算,同 provider 换模型无效(如 ChatGPT 订阅额度)
   *  - "any":                     换同 provider 其他模型也有效(如某模型被下线)
   */
  scope: "cross-provider" | "any";
  /** 配额恢复的估计时刻(epoch ms)。订阅 backend 的 resets_at 或友好文案推算。 */
  resetsAt?: number;
  /** 面向用户的说明文案(可选,引擎会拼进 notify 与 steering)。 */
  note?: string;
}

/**
 * Provider 终态判定 handler。
 * message 为失败消息的原样对象(结构化、可选链读取,勿信任任何字段存在)。
 */
/** model registry 中解析后的最小鉴权能力；不暴露或持久化凭据。 */
export interface ProviderAuthResolver {
  getProviderAuth(provider: string): Promise<{ auth?: { apiKey?: string; baseUrl?: string } } | undefined>;
}

export interface ProviderFailbackHandler {
  providerId: string;
  /** 返回 null = 与该 handler 无关或非终态;返回 verdict = 需要 failback */
  inspect(message: unknown): TerminalVerdict | null;
  /**
   * 新一轮任务开始时清空该 provider 的会话内易变状态(如瞬时故障连续计数)。
   * 与终态判定无关,只是避免长任务里偶发 5xx 累加成一次有界逃逸。
   */
  resetTransientState?(): void;
  /**
   * 当错误文本没有恢复时间时，best-effort 查询账户额度窗口。
   * 仅在已确认终态后由引擎调用；失败返回 undefined，绝不阻断 failback。
   */
  resolveResetsAt?(
    verdict: TerminalVerdict,
    resolver: ProviderAuthResolver,
    signal?: AbortSignal,
  ): Promise<number | undefined>;
}