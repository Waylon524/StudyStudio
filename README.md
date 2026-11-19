# Study Studio

本地优先的 AI 学习工作区：课程资料、持续对话、PDF 阅读与交互练习集中在同一个窗口。

A local-first AI study workspace that brings course materials, persistent conversations, PDF reading, and interactive practice into one window.

[中文](#中文) · [English](#english)

## 中文

### 功能

- **按课程学习**：每门课保留持续会话、资料目录、阅读位置与学习约定；支持在设置中统一管理各课程资料、课件与分类，以及课程归档与恢复。
- **结合资料讲解与多格式右侧阅读**：并排阅读 PDF、Markdown 与 HTML 资料并支持点击引用直达；Agent 按需读取文字、页面图像、图片和 EPUB 分节，也可在课程资料目录中安全创建或更新自己生成的 Markdown 笔记与离线交互 HTML 页面（不覆盖用户原件或系统文件）。打开文件本身不会自动发送全文内容。用 EmbedPDF 在 PDF 课件上添加文字、直线、矩形和椭圆，Agent 也能在讲解时添加批注；Markdown 阅读器复用对话渲染内核，完整支持 KaTeX、`\ce{}`、化学结构式/反应方程式与折叠目录；HTML 阅读器复用离线沙箱引擎，并支持将对话中的交互画布一键在右侧打开。
- **交互练习**：判断、选择、填空、简答与闪卡；保存真实作答、提示使用情况和点评。简答支持图片；“继续”会接着上文讲解并参考已保存作答，内部提示不显示在聊天里。
- **课程日常**：记录考试、截止日期与课程要求，保留来源、条件和更正历史；不自动创建外部日历或提醒。
- **学科工具**：LaTeX / mhchem、分子结构、反应与电子流图、本地计算与统计、只读 Excel，以及可保存的隔离交互画布。
- **长对话阅读**：流式显示最终回答，复用历史消息；化学图在自身内容完整后按视口渐进绘制，向上阅读时保持位置。

### 环境与依赖

主要开发与打包目标是 **Apple Silicon macOS**；原生外壳要求 macOS 14 或更新版本。其他平台未做完整验证。

基础运行需要 **Node.js 22.13+、npm 和兼容的 Codex CLI**。请先按 [Codex 文档](https://developers.openai.com/codex/cli/)安装并登录，再将 `STUDY_CODEX_BIN` 指向该可执行文件。当前桥接要求 `~/.codex/auth.json` 为已有的普通登录文件，通过符号链接在独立运行目录中复用；不包含登录页面，也不处理仅保存在系统钥匙串中的登录方式。

Fast / Default / Deep 三个思考强度档位可在「设置 → 偏好与状态」中从当前 Codex 账号暴露的全部模型及其支持的思考强度里自由配置（默认在 [`shared/model-presets.mjs`](shared/model-presets.mjs) 与 [`server/model-policy.mjs`](server/model-policy.mjs) 中预设为 GPT-6.1 Terra medium / high 与 GPT-6.2 Astra high）。课程头像另需 GPT-6 Astra high。账号必须能访问对应模型与能力；这些名称和 Codex 的实验接口不保证适用于所有账号或 CLI 版本。

| 功能 | 额外环境与限制 |
| --- | --- |
| PDF 页面供 Agent 读取 | Poppler 的 `pdfinfo`、`pdftotext`、`pdftoppm`；前端使用随应用打包的 EmbedPDF 阅读器和中文字体，备用阅读器使用本机 PDF.js 资源。 |
| DOCX / PPTX / EPUB 提取 | Python 3；只读取支持的原生内容，不执行 OCR。PPT / PPTX 需另转为 PDF 才能在阅读器中翻页。 |
| 化学绘图 | Python 环境中安装 RDKit 和 [`codex-organic-chem`](https://github.com/LaoZhong-Mihari/codex-organic-chem)，按其说明配置，并设置 `STUDY_CHEM_PYTHON`。这些依赖不由 `npm ci` 安装。 |
| 本地计算、统计与 XLSX / XLSM 读取 | Python 3；分析模块使用标准库。Excel 宏与公式不执行，缓存值可能缺失或过期；旧 XLS 需转换。 |
| 图片作答与部分 EPUB 图片预览 | 使用 macOS 的 `sips` 解码与转换。 |

### 开发运行

在仓库根目录运行：

```sh
npm ci
export STUDY_CODEX_BIN="$(command -v codex)"
npm run build
npm start
```

打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。`STUDY_CODEX_BIN` 必须指向支持项目所需 app-server 接口的有效程序；安装依赖并不保证 Codex 兼容性或模型访问权限。

前端开发时保留后端进程，再在另一个终端运行：

```sh
npm run dev:ui
```

开发页面为 [http://127.0.0.1:5173](http://127.0.0.1:5173)，`/api` 默认代理到端口 4317。更改后端端口时，也需调整 [`vite.config.ts`](vite.config.ts) 中的代理。

`npm run build` 和 `npm run dev:ui` 会先从已安装的 `pdfjs-dist` 生成 `public/pdfjs/` 资源及其许可证；也可手动运行 `node scripts/prepare-pdf-assets.mjs`。这些生成文件无需提交。

环境变量见下方 [Configuration](#configuration)。仓库中有按功能划分的 `scripts/check-*.mjs` 和 Python 检查脚本；部分检查需要对应可选环境或真实 Codex 登录，请按变更范围选择。

### macOS 打包

需要 Xcode Command Line Tools、Swift、Python 3，以及只依赖 macOS 系统库的独立 arm64 Node 二进制。打包器优先采用 `STUDY_NODE_BINARY`，否则尝试已安装 Study Studio 的内置 Node，再查找 `PATH` 中的 Node。若所用 Node 链接了 Homebrew 等外部动态库，校验会拒绝；可显式指定合适的独立二进制：

```sh
export STUDY_NODE_BINARY=/path/to/standalone-arm64-node
./script/build_and_run.sh --build-only
```

产物为 `build/macos/Study Studio.app`。去掉 `--build-only` 会构建、替换 `/Applications/Study Studio.app` 并启动核验；更新前应保存草稿并退出正在运行的 App。安装器会校验包与签名，在失败时恢复旧应用。

包内包含原生外壳、Node、前端、服务端和生产 npm 依赖，**不包含 Codex CLI、登录信息、Poppler 或化学 Python 环境**。它们仍须在运行机器上配置。当前脚本生成本机 ad-hoc 签名包，未提供 Developer ID 公证或通用安装发行流程。

### 架构、数据与边界

- [`src/`](src/)：React / TypeScript 界面、EmbedPDF 阅读器与内置教学组件。
- [`server/`](server/)：绑定 `127.0.0.1` 的 Node 服务；通过 [Codex app-server](https://developers.openai.com/codex/app-server) 提供课程工具，按需调用本地 Python / Poppler。
- [`shared/`](shared/)：数据校验、Markdown 扩展、流式状态与绘图队列。
- [`native/`](native/) / [`script/`](script/)：AppKit / WebKit 外壳及打包、安装脚本。

课程文件默认位于 `~/Documents/StudyStudio/`，课程状态保存在各课程的 `.study-studio/` 中。开发服务数据默认为仓库内 `.data/`；原生 App 使用 `~/Library/Application Support/Study Studio/data/`。这些目录可能包含聊天与登录引用，不属于公开源码。仓库不附带个人课程、教材、聊天或登录数据。

“本地优先”不等于离线模型：提问、实际读取的资料、作答和约定会发送到 Codex 使用的模型服务。资料上传后的后台分类也会发送有限文字及必要图片，头像生成会发送课程名称。PDF 显示、资料存储与本地渲染留在机器上。应用复用已有登录，不改全局 Codex 配置。

Agent 的文件工具限定在当前课程目录；独立 Codex 进程关闭任意命令、原生直接改文件工具及外部插件，仅保留应用提供的受限课程工具（含在资料目录内安全创建学习文档，禁止修改系统文件或覆盖用户原件）与公开网页搜索。交互画布与 HTML 阅读器均在限制网络和主应用访问的独立沙箱 iframe 中运行。

模型讲解、题目评分与生成图示仍可能出错。化学输入通过排版和电子记账校验，不等于真实机理或实验已验证。单个资料文件上限为 100 MB；有界提取和模型上下文另有限制，整本 PDF / PPTX 的一次文字提取最多前 100 页及 100,000 字符。没有 OCR、语音转写、外部 LMS 登录或云同步功能。

## English

### Features

- **Course workspaces:** persistent conversations, materials, reading positions, and learning preferences, with unified material/courseware management in Settings and course archiving/restoration.
- **Material-aware tutoring & multi-format side reader:** read PDF, Markdown, and HTML files side by side with the conversation and follow citations directly. The agent reads text, page images, pictures, and EPUB sections on demand, and can create or update its own Markdown notes and self-contained offline HTML pages inside course material folders (never overwriting user originals or system files). EmbedPDF lets you and the agent add text, lines, rectangles, and ellipses to PDF slides, search full text, quote selections/regions in chat, and export annotated copies. The Markdown reader reuses the chat renderer for KaTeX, `\ce{}`, native vector chemical structures/equations, and a collapsible outline; the HTML reader reuses the sandboxed canvas iframe and lets you open chat canvases directly in the right pane.
- **Interactive practice:** true/false, multiple choice, fill-in-the-blank, short answers, and flashcards. Actual submissions, hint use, and feedback are saved. Short answers accept images; Continue resumes the lesson using saved submissions without showing its internal prompt.
- **Course planning:** exams, deadlines, and course requirements retain sources, conditions, and revision history. No external calendar events or reminders are created automatically.
- **Subject tools:** LaTeX / mhchem, molecular structures, reactions, electron-flow diagrams, local calculations and statistics, read-only Excel, and saved sandboxed interactive canvases.
- **Long conversations:** final answers stream into view, historical messages are reused, and complete chemical blocks render progressively near the viewport while preserving the learner’s reading position.

### Requirements and optional tools

The primary development and packaging target is **Apple Silicon macOS**. The native shell requires macOS 14 or later. Other platforms have not been fully validated.

Basic operation requires **Node.js 22.13+, npm, and a compatible Codex CLI**. Follow the [Codex documentation](https://developers.openai.com/codex/cli/) to install and sign in, then point `STUDY_CODEX_BIN` to the executable. The current bridge requires an existing regular `~/.codex/auth.json` file and reuses it through a symbolic link in its isolated runtime directory. It has no built-in sign-in screen or support for credentials stored exclusively in the system keychain.

Fast / Default / Deep thinking presets can be configured in Settings from all models and reasoning efforts exposed by your Codex account (defaulting in [`shared/model-presets.mjs`](shared/model-presets.mjs) and [`server/model-policy.mjs`](server/model-policy.mjs) to GPT-6.1 Terra medium / high and GPT-6.2 Astra high). Course avatar generation additionally requires GPT-6 Astra high. Your account must expose the corresponding models and capabilities; these names and Codex’s experimental interfaces are not guaranteed to work with every account or CLI version.

| Feature | Additional requirements and limits |
| --- | --- |
| Agent access to PDF pages | Poppler: `pdfinfo`, `pdftotext`, and `pdftoppm`. The frontend bundles EmbedPDF and a Chinese font. The fallback reader uses local PDF.js assets. |
| DOCX / PPTX / EPUB extraction | Python 3; supported native content only, without OCR. Convert PPT / PPTX to PDF separately for page-by-page reading. |
| Chemical rendering | A Python environment with RDKit and [`codex-organic-chem`](https://github.com/LaoZhong-Mihari/codex-organic-chem). Follow its setup instructions and set `STUDY_CHEM_PYTHON`; `npm ci` does not install these tools. |
| Calculations, statistics, and XLSX / XLSM reading | Python 3; the analysis modules use its standard library. Macros and formulas are not executed; cached values may be missing or stale. Convert legacy XLS files first. |
| Image answers and some EPUB previews | macOS `sips` for image decoding and conversion. |

### Development

From the repository root:

```sh
npm ci
export STUDY_CODEX_BIN="$(command -v codex)"
npm run build
npm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). `STUDY_CODEX_BIN` must point to a working executable that supports the required app-server interfaces. Installing dependencies does not establish Codex compatibility or model access.

For frontend development, keep the backend running and use a second terminal:

```sh
npm run dev:ui
```

The development frontend runs at [http://127.0.0.1:5173](http://127.0.0.1:5173). Its `/api` proxy targets port 4317 by default; update [`vite.config.ts`](vite.config.ts) if the backend port changes.

`npm run build` and `npm run dev:ui` first generate `public/pdfjs/` assets and their licenses from the installed `pdfjs-dist`. Run `node scripts/prepare-pdf-assets.mjs` to prepare them manually. Generated assets do not need to be committed.

See [Configuration](#configuration) below. Feature-specific `scripts/check-*.mjs` and Python checks are included. Some require optional tools or a live Codex login; choose checks appropriate to the change.

### macOS packaging

Building requires Xcode Command Line Tools, Swift, Python 3, and a standalone arm64 Node binary linked only to macOS system libraries. The packager prefers `STUDY_NODE_BINARY`, then the runtime in an installed Study Studio app, then Node on `PATH`. Node builds linked to external libraries, including some Homebrew builds, are rejected. Set a suitable standalone binary explicitly:

```sh
export STUDY_NODE_BINARY=/path/to/standalone-arm64-node
./script/build_and_run.sh --build-only
```

The output is `build/macos/Study Studio.app`. Without `--build-only`, the script builds, replaces `/Applications/Study Studio.app`, launches it, and verifies the installation. Save drafts and quit the running app before updating. The installer validates the package and signature and restores the previous app if installation fails.

The bundle includes the native shell, Node, frontend, backend, and production npm dependencies. **Codex CLI, authentication, Poppler, and the chemical Python environment are not bundled** and must be configured on the target machine. The current scripts produce a local ad-hoc signed app, not a Developer ID notarized or general-purpose installer release.

### Architecture, data, and boundaries

- [`src/`](src/): React / TypeScript interface, EmbedPDF reader, and built-in teaching components.
- [`server/`](server/): Node service bound to `127.0.0.1`, exposing course tools through [Codex app-server](https://developers.openai.com/codex/app-server) and calling local Python / Poppler when needed.
- [`shared/`](shared/): validation, Markdown extensions, streaming state, and the rendering queue.
- [`native/`](native/) / [`script/`](script/): AppKit / WebKit shell, packaging, and installation scripts.

Course files default to `~/Documents/StudyStudio/`, with per-course state under `.study-studio/`. Development service data defaults to `.data/` in the repository; the native app uses `~/Library/Application Support/Study Studio/data/`. These locations may contain conversations and authentication references and are not public source files. Personal course materials, textbooks, chats, and credentials are not included in this repository.

Local-first does not mean an offline model. Questions, material actually read, submissions, and learning agreements are sent to the model service used by Codex. Background classification after uploads also sends bounded text and necessary images; avatar generation sends the course name. PDF display, file storage, and local rendering remain on the machine. The application reuses existing authentication without changing global Codex configuration.

The agent’s file tools are restricted to the active course directory. Its isolated Codex process disables arbitrary commands, native direct file-editing tools, and external plugins, while retaining bounded application-provided course tools (including safe material creation without overwriting user originals or system files) and public web search. Both interactive canvases and the HTML reader run in separate sandboxed iframes with network and host-app access restricted.

Model explanations, grading, and generated diagrams can be wrong. Chemical layout and electron-accounting checks do not validate a real mechanism or experiment. Individual material files are limited to 100 MB; extraction and model context have separate bounds. A whole-document PDF / PPTX text extraction reads at most the first 100 pages and 100,000 characters. OCR, speech transcription, external LMS login, and cloud synchronization are not provided.

## Configuration

Set these variables before starting the backend. / 在启动后端前设置环境变量。

| Variable | Purpose / 用途 |
| --- | --- |
| `STUDY_CODEX_BIN` | Codex app-server executable / Codex 可执行文件路径。 |
| `STUDY_PORT` | Backend port, default `4317` / 后端端口，默认 `4317`。 |
| `STUDY_WORKSPACE_ROOT` | Course materials root / 课程文件根目录。 |
| `STUDY_DATA_ROOT` | Conversation index and isolated runtime data / 对话索引和独立运行数据目录。 |
| `STUDY_POPPLER_DIR` | Directory containing Poppler tools; default `/opt/homebrew/bin` / Poppler 工具目录。 |
| `STUDY_CHEM_PYTHON` | Python interpreter with the chemical engine / 化学引擎的 Python 解释器。 |
| `STUDY_EXTRACT_PYTHON` | Document extraction interpreter, default `/usr/bin/python3` / 文档提取解释器。 |
| `STUDY_ANALYSIS_PYTHON` | Analysis interpreter, default `/usr/bin/python3` / 计算与统计解释器。 |
| `STUDY_NODE_BINARY` | Standalone arm64 Node binary used when packaging / 打包时使用的独立 arm64 Node。 |

The native shell sets its own service port and data directory. / 原生外壳会设置自己的服务端口和数据目录。

## License

[MIT](LICENSE) · Copyright (c) 2026 Weilun Qian.

Third-party components retain their respective licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md). / 第三方组件保留各自的许可证，详见[第三方说明](THIRD_PARTY_NOTICES.md)。
