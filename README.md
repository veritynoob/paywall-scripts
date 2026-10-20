# Paywall Scripts

一个 **Manifest V3 Chrome 扩展**：把"绕过付费墙"做成**可配置的脚本**，规则是纯 JSON，界面上是一个**站点列表 + 每站一个表单编辑器**。

自带纽约时报、经济学人、WSJ 的规则；Bloomberg、Medium 走 `redirect` 到镜像；也能给任意站点自己加规则。

> 只处理**客户端**付费墙。服务器没下发的正文，任何扩展都变不出来——那种情况本工具提供 `redirect` 到存档镜像，并在诊断里**明确告诉你属于哪种**。

---

## 安装

1. 下载或 `git clone` 本仓库
2. 打开 `chrome://extensions`
3. 右上角开启 **开发者模式 / Developer mode**
4. 点 **加载已解压的扩展程序 / Load unpacked**
5. 选择**本仓库根目录**（`manifest.json` 所在目录）

> ⚠️ 从 `chrome://extensions` 手动加载是**唯一**可行的安装方式。
> **Chrome 137+ 已完全不认 `--load-extension` 命令行参数**（在 Chrome 155 上实测：headless、有头、
> 加 `--disable-extensions-except`、加 `--enable-unsafe-extension-debugging` 全都无效，连最简单的
> 静态 content script 扩展都加载不了）。不要在这上面浪费时间。

### 注意：换个路径安装 = 一份全新的扩展

扩展 ID 由安装路径推导。**从不同目录加载会得到不同的扩展 ID 和不同的存储空间**，
所以你之前在别处装的配置**不会**自动带过来。

---

## 使用

点工具栏图标，看到一个**站点列表**：

- 左侧开关：单独启用/停用某一站，**即时生效**，已打开的标签页不用刷新
- 点整行：进入**这一站自己的编辑页**（名字、URL 模式、规则卡片、该站的 JSON）
- `+ Add site`：输入域名即可，自动推出 match pattern 和起步规则
- `Enable all` / `Disable all` / `Reset to examples`
- 折叠区：**Check the page I am on**（诊断）和 **Rule syntax reference**

### 站点编辑页

规则是**结构化表单**，不用碰 JSON：

- 每条规则一张卡片：动作类型下拉、上移/下移/删除
- 字段按类型自动生成（选择器一行一条、Cookie 写成 `名字 | .域名`、数字/开关各就各位）
- 少用字段折叠在 "N optional fields" 里
- 改动标记 `Apply ●`，点 `Apply` 才保存并推送到已打开的标签页

### 诊断：先搞清楚墙是哪一种

页面被挡时点 **Check the page I am on → Find paywall elements**，报告开头就是裁决：

| 裁决 | 含义 | 该怎么办 |
|---|---|---|
| `server-truncated` | 正文容器几乎没字 | 规则救不了，用 `redirect` 换来源 |
| `hidden-but-present` | 正文在，被 `display:none` 之类藏了 | 加 `unhide` 规则 |
| `visually-truncated` | 正文在且已渲染，但被**渐变淡出/高度裁切**洗掉 | 加 `css` 规则杀掉渐变和裁切 |
| `covered-by-overlay` | 正文在，但被浮层盖住 | `css` / `nukeSelector` 去掉浮层 |
| `readable` | 正文在且可见 | 规则不是问题所在 |

报告还会列出：正文容器选择器、字符数、段落数、**淡出元素的颜色/透明度**、**裁切它的祖先**、
**真正盖住正文的浮层（带覆盖率）**，以及可直接粘贴的选择器候选。

---

## 配置

站点列表存在 `chrome.storage.local` 的 `paywallConfig` 键下：

```jsonc
{
  "version": 2,
  "debug": true,
  "scripts": [
    {
      "id": "example-site",
      "name": "Example",
      "enabled": true,
      "runAt": "document_start",          // document_start | document_end | document_idle
      "matches": ["https://*.example.com/*"],   // Chrome match pattern，也支持 /.../i 和 *glob*
      "rules": [ /* 按顺序执行 */ ]
    }
  ]
}
```

### 动作类型

| type | 字段 | 作用 |
|---|---|---|
| `css` | `hide[]`, `css` | 在 `document_start` 注入 `<style>` |
| `cookie` | `cookies[{name,domain}]` | 删 Cookie。**在 service worker 里执行**（见下） |
| `storage` | `local[]`, `session[]` | 清 localStorage / sessionStorage（精确 key 或前缀） |
| `text` | `selectors[]`, `phrases[]` | 清扫残留付费墙文案 |
| `unhide` | `selectors[]`, `attrs[]` | 去掉 `hidden` / `aria-hidden` / `inert` / 行内 `display:none` |
| `untruncate` | `selectors[]`, `attrs[]` | 去截断标记（`isAccessibleForFree=false` 等） |
| `click` | `selectors[]`, `tries`, `gap` | 轮询点击按钮，每个只点一次 |
| `blockScripts` | `patterns[]` | 拦截匹配的 `<script src>`（挂钩 setter 和 setAttribute） |
| `deScrim` | `minCoverage` | 找出盖在正文上的**全页渐变遮罩**并按形状清除（类名是哈希的，见下） |
| `nukeSelector` | `selectors[]` | 硬删除节点 |
| `redirect` | `toUrl`, `when[]`, `onlyIfGated` | 把标签页送到别处；`{href}`=原始 URL，`{url}`=编码后 |
| `main` | `js` | 页面主世界跑原文 JS（受页面 CSP 限制，常被禁） |

### 五条踩坑换来的设计

1. **`chrome.cookies` 只给 service worker，内容脚本里是 `undefined`。**
   cookie 规则因此由内容脚本**委托给 worker** 执行。早期版本直接在内容脚本里调，
   被 `try/catch` 静默吞掉，整条规则**完全没生效还不报错**。
2. **`chrome.cookies.remove()` 的 `url` 必须带真实端口。**
   用 `http://localhost/` 去删 `http://localhost:8123/` 的 Cookie 会**返回成功但 Cookie 还在**。
3. **破坏性动作拒绝删除正文本身。**
   付费墙 class 名天天变，`[class*="Paywall"]` 很容易命中文章外层。`nukeSelector` / `text`
   会拒绝删除正文或任何包着正文的祖先节点——删错了会连带正文一起消失，而且 MutationObserver
   每次重扫还会再删一次，页面彻底救不回来。
4. **破坏性动作也拒绝删除"登录面"，cookie 规则更拒绝删登录态 Cookie。**
   （v4 新增，起因是 NYT 登录被踢，见下节。）
5. **有的墙不改正文，是把正文关进 `position:fixed` 的壳里——滚动条直接没了。**
   NYT 把 `main#site-content` 放进 `[data-testid="vi-gateway-container"]`，付费墙状态给这个壳
   `position:fixed; overflow:hidden; height:100vh`。于是 `html` 的 `scrollHeight` 等于视口高度，
   **文档没有任何可滚动内容**，遮罩去掉了照样读不下去（实测：`html` 1030 == 1030，`main` 内容 2817）。
   两个细节值得记：锁通常是 `.no-scroll{overflow:hidden}` 这种 **class**，
   `style.removeProperty()` 完全无效；而且页面框架会在加载后**再加回来**。
   所以 `pcUnlockScroll()` 用行内 `!important`（行内 `!important` 压得过任何样式表规则），
   并在加载后 6 秒内重试；`pcReleaseScrollTrap()` 负责把裁切壳放回文档流。

### 登录态是红线：为什么不能删 `NYT-S`

NYT 登不上、自动退出、卡在"需要登录"的页面，是三个独立错误叠出来的：

| 元凶 | 后果 |
|---|---|
| `cookie` 规则删了 `NYT-S`（**已登录会话**）和 `datadome`（**机器人防护令牌**） | 每次导航都被踢回 `anon` 状态；DataDome 反复 challenge，登录 POST 也被当成机器人 |
| `css` 里藏了 `[role="dialog"][aria-modal="true"]`、`#app > div[role="dialog"]` | 登录弹窗本身就是个 `aria-modal` dialog，被藏了 → 点"登录"没反应 |
| `text` 规则把 `[role="dialog"]` 里含 "already a subscriber?" 的整块删掉 | 登录弹窗刚出现就被移出 DOM → 界面卡死 |

现在的约定：

- **只删计数器 Cookie**（NYT 是 `nyt-a`：匿名设备 id，删它就把计次清零），
  **永不删会话 / 认证 / 反机器人 Cookie**。
- 保护做在**引擎层**，不只靠自带规则：`background.js` 里有一份 `AUTH_COOKIE_RE`，
  名字命中 `session|sess|sid|auth|token|jwt|login|signin|signed|logged|csrf|xsrf|nyt-s|datadome`
  就**拒绝删除并 `console.warn`**。因为配置存在 `chrome.storage.local`，比代码活得久——
  升级扩展后旧配置仍然会生效，护栏必须能兜住旧配置和手改的配置。
- `nukeSelector` / `text` 不碰"真登录表单"：含 `input[type="password"]`、
  `form[action*="login"|"signin"|"auth"]` 的元素及其祖先。
- 站点 `matches` 收窄到内容域（`www.nytimes.com`），**不含 `myaccount.nytimes.com`**
  这类登录/订阅流程页。
- `chrome.cookies.getAll({name})` 是**全库**搜索，规则里的 `domain` 必须在 worker 侧过滤，
  否则同名 Cookie 会跨站被误删（这个 bug 之前就存在，v4 修了）。
- `storage` 的 `local`/`session` 每一项既匹配**精确 key 也匹配前缀**，所以别写 `nyt_`、
  `nytd_`、`wsj` 这种大前缀——那是把站点的登录/流程状态一起清了。写具体 key。

### 主世界与隔离世界

内容脚本跑在隔离世界（有 `chrome.storage` / 消息），同时把同一份 `engine.js` 注入**页面主世界**
（那里才有 `localStorage`）。主世界拿到的配置会**先剥掉它永远跑不了的动作**（`cookie`），
否则控制台会在每一页刷 `unknown rule type: cookie`。

---

## ⚠️ 重新加载扩展后为什么看不到新规则

**配置存在 `chrome.storage.local`，它比扩展代码活得久。** 在 `chrome://extensions` 点
"重新加载"只重载**代码**，不动存储——站点列表还是上次那份，新加的默认站点不会自动出现。

点 **`Reset to examples`** 恢复自带规则（会覆盖你自己的站点，先 `Copy JSON` 备份）。

如果保存的配置比随包发布的版本旧、缺了站点，列表顶部会自动出现**黄色横幅**列出缺哪些，
并给一键加载按钮。

---

## NYT 的墙是三层：遮罩 + 滚动锁 + 服务端截断

把真实页面另存成 MHTML 后逐层拆开（`deScrim` 就是这么验证出来的），一篇被计费墙挡住的
NYT 文章长这样：

| 层 | 事实 | 能不能修 |
|---|---|---|
| **视觉层** | `[data-testid="vi-gateway-container"]` 里一个**空 div**，`position:absolute`，`background-image: linear-gradient(rgba(18,18,18,0), rgba(18,18,18,.65) 402px)`，1472×917 | **能**。类名是 `css-hgm7bf` 这种每次发版都变的哈希，所以规则不写类名：CSS 打 `> div:empty`，`deScrim` 再按"绝对定位 + 带渐变 + 覆盖 ≥25% 视口 + 不包着正文"的形状兜底 |
| **滚动层** | 同一个容器被切成 `position:fixed; overflow:hidden; height:100vh`，而 `main#site-content` 就在它**里面**：`html.scrollHeight` 卡在 1030（=视口高），可 `main` 的内容有 2817 | **能**。`pcReleaseScrollTrap()` 找"裁切祖先、且内容比它高"的壳，放回文档流；`pcUnlockScroll()` 再用行内 `!important` 钉住滚动 |
| **正文层** | `section[name="articleBody"]` 里**只有 3 段**，末尾跟着 `<p role="note"><a>Subscribe to The Times</a> to read as many articles as you like.</p>` | **不能**。服务端只发了 3 段，剩下的文字根本不在页面里；CSS/DOM 规则变不出来 |

> 注意滚动锁和遮罩**是同一个容器**：把遮罩去掉不会恢复滚动，`html.scrollHeight` 仍然是视口高度。

所以自带规则对 NYT 的目标是：**去掉遮罩、清掉残留订阅文案**，让页面看起来正常；正文缺口
只能靠 `redirect` 到存档镜像（同 Bloomberg 的做法，默认关闭，需自己开）。

> 自己取证据：`Check the page I am on → Find paywall elements` 的 `verdict` 在这两种情况下
> 分别是 `visually-truncated` 和 `server-truncated`——完全不同的墙，别用同一种办法打。

`deScrim` 的边界（免得误伤）：只碰 `position: absolute/fixed`、带 `gradient` 背景、
覆盖视口 ≥25%、且**不包含正文**的元素；`<figure>` / `<picture>` 里的渐变直接跳过（那通常是
图片说明的可读性蒙版，不是墙）。这些条件都是用保存下来的真实页面 + 一个合成的
"正文图注渐变"做对照验证过的。

---

## 各站点机制与现状
| 站点 | 机制 | 状态 |
|---|---|---|
| The New York Times | 软墙（浮层 + 计次），未登录时服务端也会截断 | 规则默认启用 |
| The Economist | 软墙：正文全在 HTML 里，但被**渐变淡出**洗掉 | 规则默认启用，含杀渐变/裁切的 CSS |
| Wall Street Journal | 混合：客户端 gate + 服务端按配额截断 | 规则默认启用 |
| Bloomberg | **服务端硬墙** + 机器人检测 | `redirect` 到 archive.ph，**默认关闭** |
| Medium | 服务端 | `redirect` 到 freedium，**默认关闭** |
| Washington Post | 软墙但很隐蔽：正文在 `.meteredContent` 里被**刷成纯白** + `overflow: clip` | 规则默认启用，实测可修 |

**关于 Washington Post**：它的墙很隐蔽——正文其实**全在 HTML 里**（4107 个字符），但被 `.meteredContent`
刷成纯白、再用 `overflow: clip` 裁掉，所以只看得见前两行。规则会恢复颜色与高度，并把 `#paywall-*`
浮层变成**透明且不接收点击**（而不是删除——那个容器可能包着正文，删了会连正文一起没）。
实测数据来自扩展自己的诊断：`VERDICT: VISUALLY TRUNCATED` + `text colour: rgb(255,255,255)` +
`[height-clamped] html ... hiddenPx 2892`。

---

## 已知限制

- 只作用于 `http(s)` 页面；`chrome://`、扩展商店页、`file://` 不会注入。
- 服务端硬墙无解，只能 `redirect`。非浏览器请求会被 CDN 拦（403），**不能**用它判断墙的类型——
  必须在真实浏览器里看。
- `redirect` 会**改变你访问的站点**，默认关闭，需自行开启。
- `main` 规则受该页 CSP 限制；没有 `'unsafe-eval'` 的站会拒绝执行，并打印提示。
- MV3 的 service worker 空闲约 30 秒会被回收，属正常现象。

---

## 许可证

MIT，见 [LICENSE](LICENSE)。

## 免责声明

本项目仅用于**改善你本就有权访问的内容的可读性**（去掉遮挡层、恢复滚动、清理脏 DOM），
不用于规避计费。请遵守你所在地区的法律与目标网站的服务条款。作者不对使用后果负责。
