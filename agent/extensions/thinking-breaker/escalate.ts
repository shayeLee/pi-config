/**
 * thinking-breaker → model-failback 的升级通道。
 *
 * 复读是**模型侧的行为问题**：同一个模型在同一个会话里第二次复读时，继续给它
 * 机会只是把同样的浪费再演一遍（事故里一次烧掉 289 秒 / 35 万字符）。因此第二次
 * 命中要把它踢出本会话的候选集，交给链上的备用模型。
 *
 * 命中有两种形状（尾部周期 / 词表塌缩），`evidence` 是判别联合，`kind` 区分。
 *
 * 这里刻意用事件而不是直接调用：ban 的持久化、链解析、环检测都属于
 * model-failback 的职责，thinking-breaker 不该复制一份。model-failback 未安装
 * 时事件没有订阅者，降级为"只截断 + 继续"，功能不缺失。
 */

export const ESCALATE_EVENT = "thinking-breaker:escalate";

export interface EscalateRequest {
	readonly version: 1;
	readonly sessionId: string;
	/** "provider/model" */
	readonly key: string;
	readonly reason: string;
	readonly note: string;
	/**
	 * 探针证据。判别联合：`kind` 缺省或为 `"period"` 时是尾部周期命中，
	 * `kind: "collapse"` 时是词表塌缩命中（无 `period`，改用 distinct/lineCount/repeatRatio）。
	 * `chars` / `strikes` 两种命中都存在，订阅方不必关心是哪种。
	 */
	readonly evidence:
		| {
				readonly kind?: "period";
				readonly period: number;
				readonly repeats: number;
				readonly chars: number;
				readonly strikes: number;
		  }
		| {
				readonly kind: "collapse";
				readonly distinct: number;
				readonly lineCount: number;
				readonly repeatRatio: number;
				readonly chars: number;
				readonly strikes: number;
		  };
	/** 订阅方接受本次升级请求；返回是否成功接手。 */
	accept(reply: EscalateReply): void;
}

export interface EscalateReply {
	readonly ok: boolean;
	/** 已切换到的新模型 key；接手方负责发送续跑指令。 */
	readonly switchedTo?: string;
	/** 失败原因，用于界面提示。 */
	readonly message?: string;
}
