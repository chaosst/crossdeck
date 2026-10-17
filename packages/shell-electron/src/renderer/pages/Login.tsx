import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { describeIpcError, getLoginValidCode, loginNavigate, loginNavigateGuest, probeChallengeNeeded } from '../api';
import { logger } from '../utils/logger';

/**
 * 登录界面
 */
export default function Login() {
  /** 纯表现：眼睛按钮只改 input 的 type，不做任何校验。 */
  const [showPassword, setShowPassword] = useState(false);

  const [password, setPassword] = useState("");

  const [account, setAccount] = useState("");
  
  const [code, setCode] = useState("");

  const [challengeId, setChallengeId] = useState("")

  /** 验证码图片的 data URL —— 字节由主进程转发，渲染层不直连上游。 */
  const [challengeImg, setChallengeImg] = useState("")

  /** 是否展示校验码区。上游只在连续失败后才要求它，所以默认不展示。 */
  const [needChallenge, setNeedChallenge] = useState(false)

  /** 登录失败的原文 —— 不吞掉它，否则按钮看起来像"点了没反应"。 */
  const [error, setError] = useState<string | null>(null);

  // 拉取一张新校验码（服务端种 httpOnly sid cookie，答案只在服务端图片里）
  async function refreshChallenge() {
    const res = await getLoginValidCode()
    if (!res.challengeId) return false;
    setChallengeId(res.challengeId)
    setChallengeImg(res.imageDataUrl)
    setCode("");
    return true;
  }

  /**
   * 展开校验码区并领一张题。
   *
   * 已经有题就不换 —— 用户可能正在输入，换图等于把他刚看清的字符作废。
   */
  async function openChallenge() {
    setNeedChallenge(true)
    if (challengeId !== '') return
    await refreshChallenge().catch(() => {
      // 领题失败不阻断登录：用户仍可提交，上游会再要一次
    })
  }

  /**
   * 预判：该 IP / 该账号是否已被要求校验码（先前失败过、或刷新页面后状态仍在）。
   *
   * 与网页端一致 —— 不等提交被打回才让用户发现要填校验码。
   */
  async function probe(username: string) {
    try {
      const res = await probeChallengeNeeded(username)
      if (res.needChallenge) await openChallenge()
    } catch {
      // 探测失败静默：它只是"提前告知"的优化，不是登录的前置条件
    }
  }

  // 进页面按 IP 维度探一次
  useEffect(() => {
    void probe('')
  }, [])

  // 账号维度：输入停顿 300ms 后再探，避免每敲一个字都打一次上游
  useEffect(() => {
    if (account === '') return
    const timer = setTimeout(() => void probe(account), 300)
    return () => clearTimeout(timer)
  }, [account])


  const loginAsUser = async () => {
    try {
      if (!account) {
        setError('账号不能为空')
        return ;
      } 
      if (!password) {
        setError('密码不能为空')
        return ;
      } 
      setError(null)
      await loginNavigate({
        username: account,
        password,
        // 只在真的要校验码时才带上 —— 空 challengeId 会被上游当成"提交了无效挑战"
        ...(needChallenge ? { challengeId, code } : {}),
      })
      // 登录成功 —— 退出 #/login，入口的 hashchange 监听据此切回 App。
      window.location.hash = '#/'
    } catch (err) {
      const described = describeIpcError(err)
      setError(described.text)
      // 上游在 detail 里回了 NEED_CHALLENGE → 展开校验码区并换一张新题
      if (described.detail?.split('|').includes('NEED_CHALLENGE') === true) {
        setChallengeId('')
        await openChallenge()
      }
      logger.error('Login', 'loginAsUser error with:', described.text)
    }
  }

  const loginAsGuest = async () => {
    try {
      setError(null)
      await loginNavigateGuest()
      // 登录成功 —— 退出 #/login，入口的 hashchange 监听据此切回 App。
      window.location.hash = '#/'
    } catch (err) {
      const msg = err instanceof Error ? err.message : JSON.stringify(err)
      setError(msg)
      logger.error('Login', 'loginAsGuest error with:', msg)
    }
  }

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
            N
          </div>
          <div className="min-w-0">
            <div className="text-[17px] font-semibold leading-tight tracking-tight">Navigate Desk</div>
            <div className="text-[12px] text-muted">简历问答</div>
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
              value={account}
              type="text"
              autoComplete="username"
              placeholder="请输入账号"
              onInput={(e) => setAccount(e.currentTarget.value)}
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
                value={password}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="请输入密码"
                onInput={(e) => setPassword(e.currentTarget.value)}
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

          {/* 只在被要求时出现：上游按 IP / 账号的失败次数决定，不是每个访客都要填 */}
          {needChallenge && (
          <div className="mt-4 flex flex-col gap-1.5" id="challenge-box">
            <label htmlFor="code" className="text-[12px] font-medium text-ink-muted">
              校验码
            </label>
            <div className="relative flex items-center">
              <img id="challenge-img" alt="校验码" src={challengeImg} />
              <button type="button" id="challenge-refresh" className='cursor-pointer' title="看不清？换一张" onClick={() => refreshChallenge()}>↻</button>
            </div>
            <input type="text" id="code" name="code" maxLength={4} placeholder="输入图中的 4 位字符"
              value={code}
              onInput={(e) => setCode(e.currentTarget.value)}
              className="h-10 w-full rounded-[10px] border border-line-input bg-surface-sunken pl-3 pr-11 text-[13px] text-ink outline-none transition placeholder:text-hint focus:border-brand focus:bg-white focus:ring-2 focus:ring-brand/20"
            />
            <div className="text-hint text-[10px]">连续登录失败触发，请完成校验后再试</div>
          </div>
          )}

          {/* 主操作 —— 登录逻辑待接，这里只画 */}
          <button
            type="button"
            onClick={loginAsUser}
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
            onClick={loginAsGuest}
            className="h-10 w-full rounded-[10px] border border-line-brand bg-white text-[13px] font-medium text-brand transition hover:border-brand hover:bg-brand-tint-soft"
          >
            获取体验账号
          </button>
          <p className="mt-2 text-center text-[11px] text-hint">
            以 guest 身份进入，无需密码 · 有效期由部署方决定
          </p>

          {error !== null && (
            <p
              data-testid="login-error"
              className="mt-3 whitespace-pre-wrap rounded-[10px] border border-danger-line bg-danger-surface px-3 py-2 text-[11px] leading-relaxed text-danger"
            >
              {error}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
