/**
 * crossdeck · HarmonyOS 壳 · 登录界面（**只有界面，不接任何登录逻辑**）。
 *
 * 独立页面：登记在 `main_pages.json` 里，`Index.ets` 一行没改 —— 与另外两端
 * （Electron 的 `#/login`、Web 的独立 `login.html`）是同一条原则：
 * **界面稿不该把主链路绑上，回滚成本应当是 0**。
 *
 * ⚠️ 视觉上是三端**同一套**语言（浅暖底 + 白卡 + 绿主色），数值与
 *    `shell-electron/src/renderer/pages/Login.tsx`、
 *    `shell-web/login.html` 一一对应。改一处请同步另外两处。
 *
 * ⚠️ 与另外两端**唯一有意保留的差异**：密码框的"显示密码"用系统内置的
 *    眼睛图标（`showPasswordIcon`），不是自绘按钮 —— ArkTS 里把 `InputType`
 *    在运行时来回切是能编译但运行期行为不可靠的写法，而内置图标是系统
 *    渲染的、零风险。差异写在这里，不做"看起来统一"的假装。
 *
 * ⚠️ 另一个刻意的不一致：本壳的 `Index.ets` 是深色（#0F1115），这张登录页是浅色。
 *    这是选定的设计方向（三端同一套浅暖视觉），不是漏改配色。
 */
const PAGE_BG: string = '#F6F5F2';
const CARD_BG: string = '#FFFFFF';
const CARD_LINE: string = '#E2DFD7';
const LINE_SOFT: string = '#EAE7E0';
const FIELD_BG: string = '#FBFAF8';
const FIELD_LINE: string = '#DCD8CE';
const TEXT: string = '#1C1B19';
const SUB: string = '#5C5750';
const DIM: string = '#8A857C';
const FAINT: string = '#A09A90';
const ACCENT: string = '#1F6B3A';
const AMBER: string = '#C98A3C';
/** 字标底色渐变的两端（对应 CSS 的 linear-gradient(135deg, …)） */
const MARK_FROM: string = '#2B8A4E';
const MARK_TO: string = '#1A5030';
/** 次按钮描边（CSS 里的 #cfd9cf） */
const SECONDARY_LINE: string = '#CFD9CF';

@Entry
@Component
struct Login {
  /** 只为界面存在：两个输入框的受控值，不做任何校验。 */
  @State account: string = '';
  @State password: string = '';

  @Builder
  fieldLabel(text: string) {
    Text(text)
      .fontSize(12)
      .fontColor(SUB)
      .fontWeight(FontWeight.Medium)
      .width('100%')
  }

  build() {
    Scroll() {
      Column() {
        // ── 品牌 lockup ── 字标 + 一句定位，三端同款
        Row({ space: 12 }) {
          Column() {
            Text('c').fontSize(19).fontColor('#FFFFFF').fontWeight(FontWeight.Bold)
          }
          .width(40)
          .height(40)
          .borderRadius(12)
          .justifyContent(FlexAlign.Center)
          .linearGradient({
            angle: 135,
            colors: [[MARK_FROM, 0.0], [MARK_TO, 1.0]],
          })

          Column() {
            Text('crossdeck').fontSize(17).fontWeight(FontWeight.Bold).fontColor(TEXT)
            Text('跨端桌面工程 · 流式问答').fontSize(12).fontColor(DIM).margin({ top: 2 })
          }
          .alignItems(HorizontalAlign.Start)
          .layoutWeight(1)
        }
        .width('100%')
        .margin({ bottom: 24 })

        // ── 表单卡 ──
        Column() {
          Text('登录').fontSize(15).fontWeight(FontWeight.Bold).fontColor(TEXT).width('100%')
          Text('使用 navigate 账号登录；没有账号可以先拿一个体验账号。')
            .fontSize(12)
            .fontColor(DIM)
            .width('100%')
            .margin({ top: 4 })

          this.fieldLabel('账号')
          TextInput({ placeholder: '请输入账号' })
            .type(InputType.Normal)
            .height(40)
            .borderRadius(10)
            .backgroundColor(FIELD_BG)
            .border({ width: 1, color: FIELD_LINE })
            .fontSize(13)
            .fontColor(TEXT)
            .placeholderColor(FAINT)
            .placeholderFont({ size: 13 })
            .padding({ left: 12, right: 12 })
            .margin({ top: 6 })
            .onChange((value: string): void => {
              this.account = value;
            })

          this.fieldLabel('密码')
          TextInput({ placeholder: '请输入密码' })
            .type(InputType.Password)
            // 系统内置的眼睛图标 —— 见文件头那段"有意保留的差异"
            .showPasswordIcon(true)
            .height(40)
            .borderRadius(10)
            .backgroundColor(FIELD_BG)
            .border({ width: 1, color: FIELD_LINE })
            .fontSize(13)
            .fontColor(TEXT)
            .placeholderColor(FAINT)
            .placeholderFont({ size: 13 })
            .padding({ left: 12, right: 12 })
            .margin({ top: 6 })
            .onChange((value: string): void => {
              this.password = value;
            })

          // 主操作 —— 登录逻辑待接，这里只画（不挂 onClick）
          Button('登录')
            .type(ButtonType.Normal)
            .borderRadius(10)
            .width('100%')
            .height(40)
            .backgroundColor(ACCENT)
            .fontColor('#FFFFFF')
            .fontSize(13)
            .margin({ top: 20 })

          Row({ space: 12 }) {
            Row().layoutWeight(1).height(1).backgroundColor(LINE_SOFT)
            Text('或').fontSize(11).fontColor(FAINT)
            Row().layoutWeight(1).height(1).backgroundColor(LINE_SOFT)
          }
          .width('100%')
          .margin({ top: 16, bottom: 16 })

          // 次操作 —— 对齐上游已有的 guest 通道（仍未接线，不挂 onClick）
          Button('获取体验账号')
            .type(ButtonType.Normal)
            .borderRadius(10)
            .width('100%')
            .height(40)
            .backgroundColor(CARD_BG)
            .borderWidth(1)
            .borderColor(SECONDARY_LINE)
            .fontColor(ACCENT)
            .fontSize(13)

          Text('以 guest 身份进入，无需密码 · 有效期由部署方决定')
            .fontSize(11)
            .fontColor(FAINT)
            .width('100%')
            .textAlign(TextAlign.Center)
            .margin({ top: 8 })
        }
        .width('100%')
        .padding(24)
        .borderRadius(16)
        .backgroundColor(CARD_BG)
        .border({ width: 1, color: CARD_LINE })
        .alignItems(HorizontalAlign.Start)

        // ── 环境状态条 ──
        // UI **必须**如实报上游是哪一种；这里是界面稿，所以是写死的演示值。
        // 真接线时换成 `this.upstreamBase()` 的结果，并且仍然要区分
        // 「navigate 真上游」与「脚本上游」—— 见 Index.ets 的 DEFAULT_UPSTREAM_BASE 注释。
        Row({ space: 8 }) {
          Column().width(6).height(6).borderRadius(3).backgroundColor(AMBER)
          Text('上游：脚本（离线可跑，不是真上游）').fontSize(11).fontColor(FAINT)
          Blank()
          Text('v1.0.0').fontSize(11).fontColor(FAINT)
        }
        .width('100%')
        .margin({ top: 20 })
      }
      .width('100%')
      .padding({ left: 24, right: 24, top: 48, bottom: 48 })
      .constraintSize({ minHeight: '100%' })
      .justifyContent(FlexAlign.Center)
      .alignItems(HorizontalAlign.Center)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .align(Alignment.Center)
  }
}
