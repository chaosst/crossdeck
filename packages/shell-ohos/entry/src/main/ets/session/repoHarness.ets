/**
 * 把**同一份**仓储用例（`checkSessionRepository`，22 条）跑到鸿蒙 RDB 上。
 *
 * 一致性规格住在 core、不碰 IO，所以它能被三端各跑一遍：Electron 在 Node 里对
 * 真 SQLite、Web 在真浏览器里对真 IndexedDB、这里是模拟器/真机对 relationalStore。
 * 通过的用例集合一致，才叫"同一套语义"。
 *
 * ## 每个用例一个**新的空库**
 *
 * harness 的 `create()` 契约就是"造一个空仓储"。所以这里按用例递增库名、
 * 打开前先删一遍 —— 复用同一个库会让上一条用例的残留数据把后一条染红，
 * 而那种红看起来像实现有 bug。
 *
 * ⚠️ RDB 限制：**同一进程内不能用同一个名字同时开两个库**。所以 `create()`
 * 先把上一条用例的连接关掉；`reopen()` 才是"同名再开一次"（先 close 再 getRdbStore），
 * 那正是"数据真的落到盘上了"的证据。
 */
import { relationalStore } from '@kit.ArkData';
import type { common } from '@kit.AbilityKit';
import type { ConformanceResult, SessionRepository, SessionRepositoryDeps } from '../shared/core/index';
import { checkSessionRepository } from '../shared/core/index';
import { openSessionDatabase, RdbSessionRepository } from './RdbSessionRepo';

const BASE_TIME = 1_700_000_000_000;

export class RdbConformanceHarness {
  private readonly context: common.Context;
  private clock: number = BASE_TIME;
  private idSeq: number = 0;
  private caseSeq: number = 0;
  private opened: relationalStore.RdbStore[] = [];
  private names: string[] = [];
  private lastName: string = '';
  private lastStore: relationalStore.RdbStore | null = null;

  readonly label: string = 'ohos-rdb';

  constructor(context: common.Context) {
    this.context = context;
  }

  async create(): Promise<SessionRepository> {
    await this.closeAll();
    this.caseSeq += 1;
    const name = `conformance_${this.caseSeq}.db`;
    await this.drop(name);
    const store = await openSessionDatabase(this.context, name);
    this.opened.push(store);
    this.names.push(name);
    this.lastName = name;
    this.lastStore = store;
    return new RdbSessionRepository(store, this.deps());
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  /** 同一个库再开一次 —— 先关连接，再按同名打开。 */
  async reopen(): Promise<SessionRepository> {
    if (this.lastStore !== null) {
      try {
        await this.lastStore.close();
      } catch (e) {
        // 连接可能已经关了 —— 重开才是重点，别在这里中断
      }
    }
    this.lastStore = null;
    const store = await openSessionDatabase(this.context, this.lastName);
    this.opened.push(store);
    this.lastStore = store;
    return new RdbSessionRepository(store, this.deps());
  }

  async dispose(): Promise<void> {
    await this.closeAll();
    for (const name of this.names) {
      await this.drop(name);
    }
    this.names = [];
  }

  private deps(): SessionRepositoryDeps {
    const d: SessionRepositoryDeps = {
      now: (): number => this.clock,
      newId: (prefix: string): string => {
        this.idSeq += 1;
        return `${prefix}_${this.idSeq}`;
      },
    };
    return d;
  }

  private async closeAll(): Promise<void> {
    for (const store of this.opened) {
      try {
        await store.close();
      } catch (e) {
        // 已经关过了
      }
    }
    this.opened = [];
    this.lastStore = null;
  }

  private async drop(name: string): Promise<void> {
    try {
      await relationalStore.deleteRdbStore(this.context, name);
    } catch (e) {
      // 库不存在时删除会失败 —— 这是清理路径，不是错误
    }
  }
}

/** 跑全套一致性用例，返回 core 的 `ConformanceResult`（不判成功失败，判定在脚本侧）。 */
export async function runRepoConformance(context: common.Context): Promise<ConformanceResult> {
  const harness = new RdbConformanceHarness(context);
  return checkSessionRepository(harness);
}
