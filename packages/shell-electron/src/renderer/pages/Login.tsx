import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

/**
 * 登录界面（**只有界面，不接任何登录逻辑**）。
 *
 * 入口是 hash `#/login` —— 由 `main.tsx` 在渲染前分流，`App.tsx` 一行没改。
 * 这样做的理由和"独立窗口"是同一个：界面稿不该把主链路绑上，回滚成本应当是 0。
 *
 * ⚠️ 这里刻意**不碰**任何 IPC / api.ts：
 *   · 不读 `getNavigateStatus()` —— 一次 invoke 都不发，纯静态界面；
 *   · 底部那行「上游」是**写死的演示值**，不是探测结果。真接上时要换成
 *     `getNavigateStatus().upstream`，并且仍然必须如实区分
 *     「navigate 真上游」与「脚本上游」—— 见 README §"UI 必须标注当前是哪个上游"。
 *
 * 视觉上是三端**同一套**语言（浅暖底 + 白卡 + 绿主色），数值与
 * `packages/shell-web/login.html`、`packages/shell-ohos/.../pages/Login.ets` 一一对应。
 * 改一处请同步另外两处，否则"统一设计"会在一次小改动里悄悄散架。
 */
export default function Login() {
  /** 纯表现：眼睛按钮只改 input 的 type，不做任何校验。 */
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-y-auto bg-canvas px-6 py-10 text-ink">
      {/* 环境光：两团低透明色斑，给纯色底一点纵深。纯装饰，不携带信息。 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 -top-28 size-[420px] rounded-full bg-brand/[0.07] blur-3xl" />
        <div className="absolute -bottom-32 -right-20 size-[380px] rounded-full bg-amber/[0.08] blur-3xl" />
      </div>

      <main className="relative w-full max-w-[400px]">
        {/* ── 品牌 lockup ── 字标 + 一句定位，三端同款 */}
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-brand-light to-brand-deep text-[19px] font-semibold leading-none text-white shadow-sm">
            c
          </div>
          <div className="min-w-0">
            <div className="text-[17px] font-semibold leading-tight tracking-tight">crossdeck</div>
            <div className="text-[12px] text-muted">跨端桌面工程 · 流式问答</div>
          </div>
        </div>

        {/* ── 表单卡 ── */}
        <section className="rounded-2xl border border-line bg-white p-6 shadow-[0_1px_2px_rgba(28,27,25,0.04),0_16px_40px_-16px_rgba(28,27,25,0.18)]">
          <h1 className="text-[15px] font-semibold tracking-tight">登录</h1>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            使用 navigate 账号登录；没有账号可以先拿一个体验账号。
          </p>

          {/* 账号 */}
          <div className="mt-5 flex flex-col gap-1.5">
            <label htmlFor="login-account" className="text-[12px] font-medium text-ink-muted">
              账号
            </label>
            <input
              id="login-account"
              name="account"
              type="text"
              autoComplete="username"
              placeholder="请输入账号"
              className="h-10 rounded-[10px] border border-line-input bg-surface-sunken px-3 text-[13px] text-ink outline-none transition placeholder:text-hint focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20"
            />
          </div>

          {/* 密码 —— 右侧眼睛图标是唯一的交互控件，纯视觉 */}
          <div className="mt-4 flex flex-col gap-1.5">
            <label htmlFor="login-password" className="text-[12px] font-medium text-ink-muted">
              密码
            </label>
            <div className="relative flex items-center">
              <input
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="请输入密码"
                className="h-10 w-full rounded-[10px] border border-line-input bg-surface-sunken pl-3 pr-11 text-[13px] text-ink outline-none transition placeholder:text-hint focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20"
              />
              <button
                type="button"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-1.5 flex size-7 items-center justify-center rounded-md text-muted transition hover:bg-surface-hover hover:text-ink-muted"
              >
                {showPassword ? (
                  <EyeOff className="icon size-4" />
                ) : (
                  <Eye className="icon size-4" />
                )}
              </button>
            </div>
          </div>

          {/* 主操作 —— 登录逻辑待接，这里只画 */}
          <button
            type="button"
            className="mt-5 h-10 w-full rounded-[10px] bg-brand text-[13px] font-medium text-white transition hover:bg-brand-hover active:bg-brand-active"
          >
            登录
          </button>

          <div className="my-4 flex items-center gap-3 text-[11px] text-hint">
            <span className="h-px flex-1 bg-line-divider" />
            或
            <span className="h-px flex-1 bg-line-divider" />
          </div>

          {/* 次操作 —— 对齐上游已有的 guest 通道（仍未接线） */}
          <button
            type="button"
            className="h-10 w-full rounded-[10px] border border-line-brand bg-white text-[13px] font-medium text-brand transition hover:border-brand hover:bg-brand-tint-soft"
          >
            获取体验账号
          </button>
          <p className="mt-2 text-center text-[11px] text-hint">
            以 guest 身份进入，无需密码 · 有效期由部署方决定
          </p>
        </section>

        {/* ── 环境状态条 ──
            UI **必须**如实报上游是哪一种；这里是界面稿，所以是写死的演示值，
            真接线时换成 `getNavigateStatus().upstream.kind`。 */}
        <div className="mt-5 flex items-center gap-2 text-[11px] text-hint">
          <span aria-hidden className="size-1.5 flex-none rounded-full bg-amber" />
          上游：脚本（离线可跑，不是真上游）
          <span className="ml-auto font-mono">v1.0.0</span>
        </div>
      </main>
    </div>
  );
}
