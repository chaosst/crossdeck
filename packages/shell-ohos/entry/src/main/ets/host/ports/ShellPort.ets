/** shell 端口 —— 只有 windowOpen（2in1/tablet 多窗口）；更新能力鸿蒙没有（AppGallery）。 */
import { window } from '@kit.ArkUI';
import { formatIpcError } from '../../shared/contract/index';
import type { IpcErrorCode } from '../../shared/contract/index';
import type { Capability } from '../../shared/contract/index';
import type { OhosPort } from '../HostBridge';

class WindowOpened {
  windowId: number = 0;

  constructor(windowId: number) {
    this.windowId = windowId;
  }
}

/**
 * 框架相关的接口类
 * type: windowOpen
 */
export class ShellPort implements OhosPort {
  private readonly stage: () => window.WindowStage | null;
  private readonly capabilities: () => Capability[];
  private seq = 0;

  constructor(stage: () => window.WindowStage | null, capabilities: () => Capability[]) {
    this.stage = stage;
    this.capabilities = capabilities;
  }

  handle(method: string, argsJson: string): Promise<string | null> {
    if (method !== 'windowOpen') {
      return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `shell 端口没有方法 ${method}`, 'METHOD')));
    }
    return this.windowOpen().then((id: number): string => JSON.stringify(new WindowOpened(id)));
  }

  private async windowOpen(): Promise<number> {
    const stage = this.stage();
    if (!this.capabilities().includes('window.multi') || stage === null) {
      throw new Error(formatIpcError('UNSUPPORTED' as IpcErrorCode, '当前设备形态不支持多窗口（window.multi 不在能力表里）'));
    }
    this.seq += 1;
    const win: window.Window = await stage.createSubWindow(`crossdeck_multi_${this.seq}`);
    // 子窗口没有 EntryAbility 起的那个页面栈，只能显式加载。
    await win.loadContent('pages/WebShell', new LocalStorage());
    await win.resize(720, 960);
    await win.showWindow();
    return win.getWindowProperties().id;
  }
}
