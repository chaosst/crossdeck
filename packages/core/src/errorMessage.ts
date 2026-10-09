/**
 * 从任意抛出物里取出**人类可读的消息**。
 *
 * core / runtime / tools 与各壳里十几处写着同一段逻辑，按"只留一份"收敛到这里。
 * 放 core 而非 contract：core 对 contract 只做 `import type`（零运行时依赖），
 * 因为 core 的产物必须能被裸 Node 直接加载做单测。
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
