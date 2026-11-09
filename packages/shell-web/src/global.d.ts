/**
 * `showDirectoryPicker` 属于 Chromium 的 File System Access API，
 * 至今不在标准 lib.dom.d.ts 里。
 *
 * 手写声明而不是装 `@types/wicg-file-system-access`：本项目只用得到
 * 「让用户选一个目录」这一个方法，为一行调用拉一整个类型包不划算，
 * 而且会让 `tsconfig` 的 `types: []` 纪律变得含糊 ——
 * 那条纪律是 Web 壳作为「试金石」的机制本身。
 */
declare global {
  /**
   * 构建期注入的版本号（见 `vite.config.ts` 的 `define`）。
   *
   * 不用 `import.meta.env`：那需要 vite 的类型声明，而这个项目处在 `types: []`
   * 的约束下 —— 那条纪律是 Web 壳作为「试金石」的机制本身，不为了少写一行声明破例。
   */
  const __APP_VERSION__: string;

  interface Window {
    showDirectoryPicker?: (opts?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export {};
