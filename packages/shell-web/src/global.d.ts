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
  interface Window {
    showDirectoryPicker?: (opts?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

export {};
