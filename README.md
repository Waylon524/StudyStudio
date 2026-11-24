# Study Studio

> **本地优先的 AI 学习工作区** — 将课程资料管理、持续对话辅导、多格式并排阅读、PDF 批注与书签、交互式练习题库和化学/理工科渲染集中在同一个窗口。
>
> **A local-first AI study workspace** — bringing course materials, persistent tutoring conversations, multi-format side-by-side reading, PDF annotations & bookmarks, interactive practice, and chemistry/STEM rendering together in one window.

[![Build & Release macOS App](https://github.com/Waylon524/StudyStudio/actions/workflows/build-macos.yml/badge.svg)](https://github.com/Waylon524/StudyStudio/actions/workflows/build-macos.yml)
[![Latest Release](https://img.shields.io/github/v/release/Waylon524/StudyStudio?label=Release)](https://github.com/Waylon524/StudyStudio/releases)
[![Platform](https://img.shields.io/badge/macOS-14%2B%20Apple%20Silicon-black)](https://github.com/Waylon524/StudyStudio/releases)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933)](https://nodejs.org/)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

[中文文档](#中文) · [English Documentation](#english) · [下载安装包 / Releases](https://github.com/Waylon524/StudyStudio/releases) · [环境变量 / Configuration](#configuration)

---

## 中文

### 目录

- [核心特性](#核心特性)
- [系统要求与前置依赖](#系统要求与前置依赖)
- [安装与运行指南](#安装与运行指南)
  - [方式一：下载预构建 macOS 安装包（推荐）](#方式一下载预构建-macos-安装包推荐)
  - [方式二：从源码本地运行（浏览器模式 / 开发模式）](#方式二从源码本地运行浏览器模式--开发模式)
  - [方式三：从源码打包 macOS 原生应用](#方式三从源码打包-macos-原生应用)
- [可选增强环境配置（Poppler 与化学矢量引擎）](#可选增强环境配置poppler-与化学矢量引擎)
- [首次启动与常见问题排查](#首次启动与常见问题排查)
- [数据存储、架构与安全边界](#数据存储架构与安全边界)
- [测试验证与 GitHub 自动构建](#测试验证与-github-自动构建)

### 核心特性

- **按课程组织的学习空间**：每门课保留独立的资料目录、持续会话线程、阅读进度、专属向量头像与学习约定（`AGENTS.md`）。支持简体中文 / English 双语界面即时切换，以及课程归档与恢复。
- **多格式并排阅读与批注系统**：
  - **PDF 课件阅读器（EmbedPDF + 本地 PDF.js 备用）**：支持全文检索、页面缩略图、框选文字或区域带页码引用提问，以及保留原件的带批注/自定义书签 PDF 导出。用户与 AI 助教均可添加文字、直线、矩形、椭圆标注，并支持 AI 后台一键重构 PDF 书签目录。
  - **Markdown 阅读器**：复用对话渲染内核，完整支持 KaTeX 公式、`\ce{}` 化学式、矢量化学结构式/方程式与可折叠目录。
  - **HTML 阅读器与隔离交互画布**：在受限离线沙箱 iframe 中运行；可将对话中的教学动画/交互画布一键在右侧展开、保存至练习区或导出独立 HTML。AI 也可在课程目录中安全创建或更新自己生成的 Markdown 笔记与交互页面（不会覆盖用户原件或系统文件）。
  - **按需读取，不盲传全文**：打开课件不会自动把整本 PDF 发给模型；AI 按需读取当前页文字与页面图像、图片或 EPUB 章节。
- **原生交互练习与题库管理**：
  - 支持 **判断题、选择题（单选/多选）、填空题、简答题（支持上传/粘贴多张图片作答）、闪卡（四档自评）** 五类组件，自动记录真实作答、提示/参考答案使用情况与 AI 点评。
  - 点击「继续」会结合已保存的真实作答无缝衔接辅导，不向聊天记录暴露内部续写提示词。
  - 侧边栏学习区与「设置 → 练习与题库」支持按单元/知识点分类、AI 一键智能整理、编辑和删除；题目和交互画布内同样支持渲染化学结构式与方程式。
- **化学与理工科专业能力**：
  - 内置 KaTeX 与 `mhchem`（`\ce{...}`，含自由基与质谱碎裂等反应表达）。
  - 配合可选 RDKit + `codex-organic-chem` 引擎支持分子结构式、有机反应式、电子流弯箭头机理图、**选择性显式氢（按原子拆分特定 H）与指向箭头/标注修饰**，并按视口渐进渲染以保持长对话阅读位置稳定。
  - 内置本地 Python 科学计算、统计分析与只读 Excel（XLSX / XLSM）读取工具。
- **课程日常（日程与课程要求）**：自动沉淀考试、作业、截止日期、评分规则等课程要求，保留原文引用、适用条件与更正历史（不自动写入系统外部日历）。
- **可自定义模型与思考强度**：在「设置（`⌘,`）→ 偏好与状态」中，可从当前 Codex 账号暴露的全部模型和推理强度里，分别为 **Fast / Default / Deep** 三档自由配置模型与思考强度。

### 系统要求与前置依赖

- **桌面原生应用目标平台**：**Apple Silicon macOS（M1 / M2 / M3 / M4，`arm64`）**，要求 **macOS 14 (Sonoma) 或更高版本**。其他系统/架构未做完整验证。
- **必装前置组件：兼容的 Codex CLI 与登录状态**
  - Study Studio 通过本机 [Codex CLI](https://developers.openai.com/codex/cli/)（`codex app-server`）连接模型服务。
  - 请先安装并登录 Codex CLI，确保 `~/.codex/auth.json` 为已存在的**常规登录文件**（应用会在独立运行目录中通过符号链接复用该文件，不修改全局 Codex 配置；应用本身不包含登录界面，也不读取仅保存在系统钥匙串中的登录凭证）。
  - Fast / Default / Deep 默认在 [`shared/model-presets.mjs`](shared/model-presets.mjs) 与 [`server/model-policy.mjs`](server/model-policy.mjs) 中预设为 GPT-6.1 Terra medium / high 与 GPT-6.2 Astra high，可在设置中改为你当前账号可用的任意模型；课程头像另需 GPT-6 Astra high。具体模型名称和 Codex 实验接口不保证适用于所有账号或 CLI 版本。

| 组件 | 必要性 | 用途与说明 | 安装方式 / 默认路径 |
| --- | --- | --- | --- |
| **Codex CLI** | **必装** | 模型对话、工具调用、资料分类、题库整理与书签生成 | 见 [Codex 文档](https://developers.openai.com/codex/cli/)（`npm i -g @openai/codex` / `brew install --cask codex` / ChatGPT 桌面端内置）；登录后生成 `~/.codex/auth.json` |
| **Node.js 22.13+ & npm** | 仅源码运行/打包需要 | 运行本地服务与构建前端（**预构建 `.app` 已内置独立 arm64 Node，无需另装**） | [nodejs.org](https://nodejs.org/) 或 `brew install node` |
| **Poppler** (`pdfinfo` / `pdftotext` / `pdftoppm`) | **强烈推荐** | 让 AI 读取 PDF 页面文字与渲染图像（前端 PDF 阅读本身已内置 EmbedPDF + 思源黑体与本地 PDF.js，不依赖 Poppler） | `brew install poppler`（默认查找 `/opt/homebrew/bin`，可用 `STUDY_POPPLER_DIR` 覆盖） |
| **Python 3** | 推荐 | DOCX / PPTX / EPUB 原生内容提取（无 OCR）、本地计算统计与只读 XLSX/XLSM 解析 | macOS `/usr/bin/python3`（若未安装 Command Line Tools，运行 `xcode-select --install`） |
| **RDKit + `codex-organic-chem`** | 可选 | 矢量化学结构式、反应式、电子流机理图、选择性显式氢与指向标注 | 独立 Python 虚拟环境，默认 `~/.local/share/codex-organic-chem/.venv/bin/python`（可用 `STUDY_CHEM_PYTHON` 覆盖） |
| **macOS `sips`** | 系统自带 | 简答题图片上传预处理与部分 EPUB 图片预览 | macOS 内置，无需安装 |

### 安装与运行指南

#### 方式一：下载预构建 macOS 安装包（推荐）

适用于 **Apple Silicon Mac（macOS 14+）**，无需配置 Node.js 或编译 Swift。

1. **先安装并登录 Codex CLI**（若尚未安装）：
   ```sh
   # 方式 A：通过 Homebrew 安装
   brew install --cask codex
   # 或 方式 B：通过 npm 安装
   # npm install -g @openai/codex

   # 完成登录并确认生成常规登录文件 ~/.codex/auth.json
   codex login
   ls -l ~/.codex/auth.json
   ```
   > 应用启动时会自动按顺序查找 Codex 可执行文件：`STUDY_CODEX_BIN` → ChatGPT.app 内置 CLI → Codex.app 内置 CLI → `/opt/homebrew/bin/codex` → `/usr/local/bin/codex` → `~/.local/bin/codex` → `PATH`。
2. **（推荐）安装 Poppler**，使 AI 助教可以查看 PDF 课件文字与页面图像：
   ```sh
   brew install poppler
   ```
3. **下载安装包**：
   - 前往 [GitHub Releases](https://github.com/Waylon524/StudyStudio/releases) 下载最新版本的 **`Study-Studio-vX.Y.Z-macos-arm64.dmg`**（或 `.zip`）。
   - 如需下载最新主分支或手动触发的 CI 构建产物，也可在 [GitHub Actions → Build & Release macOS App](https://github.com/Waylon524/StudyStudio/actions/workflows/build-macos.yml) 的对应构建页底部下载 Artifact。
   - （可选）校验文件完整性：
     ```sh
     shasum -a 256 -c SHA256SUMS.txt
     ```
4. **安装到应用程序目录**：
   - 双击 `.dmg`，将 **`Study Studio.app`** 拖入 **`Applications`** 文件夹（若下载 `.zip`，解压后移动至 `/Applications/Study Studio.app`）。
5. **首次打开解除 macOS 隔离属性（重要）**：
   - 当前发布的安装包采用 **ad-hoc 本地签名**，未经过 Apple Developer ID 公证。通过浏览器下载后 macOS 会附加 `com.apple.quarantine` 隔离属性，直接双击可能提示 **“Study Studio 已损坏，无法打开”** 或 **“无法验证开发者”**。
   - 打开「终端」执行以下命令移除隔离属性后再启动：
     ```sh
     xattr -dr com.apple.quarantine "/Applications/Study Studio.app"
     open "/Applications/Study Studio.app"
     ```
   - 也可在尝试打开后，前往 **系统设置 → 隐私与安全性** 底部点击 **「仍要打开」**。
6. **在应用内确认模型配置**：
   - 打开后按 `⌘,` 进入 **设置 → 偏好与状态**，确认 Codex 状态为「已连接」；若默认预设模型在当前账号中不可用，点击 **「刷新模型」** 并为 Fast / Default / Deep 选择可用模型即可开始学习。

> **升级提示**：覆盖安装新版前，请先确认没有正在生成的回复或未发送草稿，按 `⌘Q` 完全退出 Study Studio，再将新版 `Study Studio.app` 拖入 `/Applications` 替换。你的课程文件（`~/Documents/StudyStudio/`）与应用数据（`~/Library/Application Support/Study Studio/data/`）独立存放，不会被清除。

---

#### 方式二：从源码本地运行（浏览器模式 / 开发模式）

适合想在浏览器中运行、二次开发或调试前后端的用户。需先安装 **Node.js 22.13+**、**npm** 与已登录的 **Codex CLI**。

```sh
git clone https://github.com/Waylon524/StudyStudio.git
cd StudyStudio
npm ci

# 如 codex 不在默认自动发现路径中，可显式指定：
# export STUDY_CODEX_BIN="$(command -v codex)"

npm run build
npm start
```

打开浏览器访问 [http://127.0.0.1:4317](http://127.0.0.1:4317)。

**前端热重载开发模式**（保持上方 `npm start` 后端进程运行，在第二个终端执行）：

```sh
npm run dev:ui
```

访问 [http://127.0.0.1:5173](http://127.0.0.1:5173)（`/api` 默认代理到 `127.0.0.1:4317`；若通过 `STUDY_PORT` 修改后端端口，请同步调整 [`vite.config.ts`](vite.config.ts)）。

> `npm run build` 和 `npm run dev:ui` 会自动执行 `node scripts/prepare-pdf-assets.mjs`，从 `pdfjs-dist` 提取 `public/pdfjs/` 资源与对应许可证（这些生成文件已由 `.gitignore` 排除，无需提交）。

---

#### 方式三：从源码打包 macOS 原生应用

适合在本机自行编译、打包或更新 `/Applications/Study Studio.app`。

1. **打包环境要求**：
   - Apple Silicon Mac（`arm64`）、Xcode Command Line Tools（`xcode-select --install`）、Swift、Python 3。
   - **独立 arm64 Node.js 二进制**：打包脚本 [`script/package_macos.py`](script/package_macos.py) 会用 `otool -L` 严格校验内置 Node 仅链接 macOS 系统库（`/System/Library/` 和 `/usr/lib/`）。通过 Homebrew 安装的 Node 若动态链接了 `/opt/homebrew/opt/...` 会被拒绝；请从 [nodejs.org](https://nodejs.org/) 下载官方 `macOS (arm64) .tar.gz` 压缩包，将 `STUDY_NODE_BINARY` 指向解压出的 `bin/node`（若本机已安装过 Study Studio，打包器也会自动复用其内置的合法 Node）。
2. **仅构建 `.app` 包（不替换本机已安装应用）**：
   ```sh
   npm ci
   export STUDY_NODE_BINARY=/path/to/node-v24.x.x-darwin-arm64/bin/node
   ./script/build_and_run.sh --build-only
   ```
   构建产物位于 `build/macos/Study Studio.app`。
3. **构建并安全替换 `/Applications/Study Studio.app`**：
   - 请先保存未发送草稿并完全退出正在运行的 Study Studio（安装器会拒绝在运行中覆盖）。
   ```sh
   ./script/build_and_run.sh
   ```
   该脚本会编译前端与原生外壳、校验签名与包结构、原子替换 `/Applications/Study Studio.app`、启动并验证新实例就绪后清理构建缓存；若启动验证失败会自动回滚旧版本。
4. **安装已构建好的 `.app` 并清理缓存**：
   ```sh
   /usr/bin/python3 script/install_macos.py "build/macos/Study Studio.app" --clean-builds
   ```

### 可选增强环境配置（Poppler 与化学矢量引擎）

安装包与 `npm ci` **不包含** Poppler 和化学 Python 环境，按需配置后重启应用即可生效：

1. **PDF 页面读取（Poppler）**：
   ```sh
   brew install poppler
   # 验证工具就绪
   which pdfinfo pdftotext pdftoppm
   ```
   若 Poppler 安装在非 `/opt/homebrew/bin` 目录，请在启动前设置 `STUDY_POPPLER_DIR`。

2. **矢量化学结构式 / 反应式 / 机理图渲染（可选）**：
   参考 [`codex-organic-chem`](https://github.com/LaoZhong-Mihari/codex-organic-chem) 的安装说明，将其与 RDKit 安装到默认虚拟环境路径 `~/.local/share/codex-organic-chem/.venv`：
   ```sh
   # 示例：创建独立虚拟环境并安装 RDKit 与 codex-organic-chem
   python3 -m venv ~/.local/share/codex-organic-chem/.venv
   ~/.local/share/codex-organic-chem/.venv/bin/pip install --upgrade pip rdkit
   # 随后按 codex-organic-chem 仓库说明安装该包到同一虚拟环境
   ```
   Study Studio 默认自动查找 `~/.local/share/codex-organic-chem/.venv/bin/python`；若放在其他路径，可设置环境变量 `STUDY_CHEM_PYTHON` 指向对应的 Python 解释器。

### 首次启动与常见问题排查

| 现象 | 原因与解决方法 |
| --- | --- |
| 打开 `.app` 提示「已损坏，无法打开」或「无法验证开发者」 | 安装包为 ad-hoc 签名，执行 `xattr -dr com.apple.quarantine "/Applications/Study Studio.app"` 后重新打开。 |
| 界面显示「Codex 启动失败」或「未找到可复用的 Codex 登录文件」 | 1. 确认已安装 Codex CLI 且运行 `codex login` 生成常规文件 `~/.codex/auth.json`。<br>2. 若 `codex` 安装在 nvm / fnm / Volta 等非标准路径，可建立软链到 `/opt/homebrew/bin/codex`，或在终端运行 `STUDY_CODEX_BIN="$(command -v codex)" open "/Applications/Study Studio.app"`。<br>3. 查看本机后端日志排查细节：`tail -n 100 ~/Library/Application\ Support/Study\ Studio/server.log`。 |
| 提示「当前账号暂无可用模型」或「某档位配置的模型暂不可用」 | 打开 **设置（`⌘,`）→ 偏好与状态**，点击 **「刷新模型」**，为 Fast / Default / Deep 切换为当前账号可用的模型与思考强度。 |
| AI 表示无法读取 PDF 页面内容 | 未安装 Poppler 或路径不对：执行 `brew install poppler`，确认 `/opt/homebrew/bin/pdftoppm` 存在。 |
| 化学结构式卡片提示绘图失败 | 未配置化学引擎：确认 `~/.local/share/codex-organic-chem/.venv/bin/python` 已安装 RDKit 与 `codex-organic-chem`，或正确设置了 `STUDY_CHEM_PYTHON`。 |
| 启动提示「另一个学习平台正在运行」或端口 `4317` 占用 | 先退出正在运行的 Study Studio 或旧的 `npm start` 进程；浏览器开发模式可通过 `STUDY_PORT=4318 npm start` 更换端口。 |

### 数据存储、架构与安全边界

#### 代码目录结构

- [`src/`](src/)：React / TypeScript 界面、EmbedPDF 阅读器、Markdown/HTML 阅读器与内置教学组件。
- [`server/`](server/)：仅绑定 `127.0.0.1` 的 Node 服务；通过 [Codex app-server](https://developers.openai.com/codex/app-server) 提供受限课程工具，按需调用本地 Python / Poppler / 化学渲染脚本。
- [`shared/`](shared/)：数据校验、Markdown 扩展、化学方程式解析、流式状态与渐进绘图队列。
- [`native/`](native/) / [`script/`](script/)：macOS AppKit / WKWebView 原生外壳及打包、原子替换安装脚本。
- [`scripts/`](scripts/)：资源准备脚本（`prepare-pdf-assets.mjs`）与分模块验证检查脚本（`check-*.mjs`）。
- [`.github/workflows/build-macos.yml`](.github/workflows/build-macos.yml)：Apple Silicon macOS 自动化验证、打包与 GitHub Release 发布工作流。

#### 本地数据存储位置

| 数据类型 | 浏览器开发模式默认路径 | macOS 原生 App 路径 |
| --- | --- | --- |
| 课程资料与学习记录 | `~/Documents/StudyStudio/`（每门课状态位于 `<课程>/.study-studio/`） | `~/Documents/StudyStudio/`（每门课状态位于 `<课程>/.study-studio/`） |
| 会话索引、设置与隔离 Codex 目录 | 仓库内 `.data/`（可通过 `STUDY_DATA_ROOT` 覆盖） | `~/Library/Application Support/Study Studio/data/` |
| 原生 App 后端运行日志 | 终端标准输出 | `~/Library/Application Support/Study Studio/server.log` |

> 以上数据目录包含你的个人资料、对话与登录符号链接，已被 `.gitignore` 排除，不包含在公开源码仓库或发布安装包中。

#### 隐私、安全与能力边界

- **本地优先 ≠ 离线模型**：提问内容、AI 实际读取的资料片段/页面图像、作答提交与学习约定会发送到 Codex 所连接的模型服务；上传资料后的后台自动分类会发送有限文字与必要图像；生成课程头像会发送课程名称。PDF 渲染、原件存储与本地化学/计算渲染留在你的设备上。
- **工具隔离与沙箱**：Agent 的文件工具严格限制在当前课程目录内；独立的 Codex 运行实例关闭任意命令行执行、原生直接改文件工具与外部插件，仅保留应用提供的受限 `study_*` 课程工具（含安全创建学习文档，禁止覆盖用户原件或系统文件）与公开联网搜索。交互画布与 HTML 阅读器均运行在隔离沙箱 iframe 中。
- **能力限制**：模型讲解、自动评分与化学绘图仍可能出错，化学排版与电子记账校验不等于实验验证。单文件上传上限为 **100 MB**；整本 PDF / PPTX 一次文字提取上限为前 **100 页 / 100,000 字符**。暂不提供 OCR、语音转写、外部 LMS 登录或云同步。

### 测试验证与 GitHub 自动构建

- **本地检查脚本**：仓库在 [`scripts/`](scripts/) 中提供了覆盖 i18n、模型策略、Markdown、画布、教学组件、练习管理、资料管理、PDF 目录、化学渲染与运行隔离的 `check-*.mjs` 验证脚本（部分脚本需要 Poppler、化学 Python 环境或真实 Codex 登录，请按改动范围运行）。
- **GitHub Actions 自动构建与发布**：
  - 每次推送符合 `v*` 格式的标签（如 `git tag v0.21.0 && git push origin v0.21.0`，且标签号与 `package.json` 及 `native/Info.plist` 一致）时，[Build & Release macOS App](.github/workflows/build-macos.yml) 会在 Apple Silicon (`macos-15`) Runner 上自动完成前端构建、离线测试、`Study Studio.app` 签名打包，并生成 `.dmg`、`.zip` 与 `SHA256SUMS.txt` 发布到 **GitHub Releases**。
  - 也可在 GitHub 仓库的 **Actions → Build & Release macOS App → Run workflow** 手动触发构建并下载产物（勾选 `publish_release` 还可直接发布/更新对应版本的 Release）。

---

## English

### Table of Contents

- [Key Features](#key-features)
- [System Requirements & Prerequisites](#system-requirements--prerequisites)
- [Installation & Running](#installation--running)
  - [Option 1: Download Pre-built macOS App (Recommended)](#option-1-download-pre-built-macos-app-recommended)
  - [Option 2: Run from Source (Browser / Development Mode)](#option-2-run-from-source-browser--development-mode)
  - [Option 3: Build & Install the Native macOS App from Source](#option-3-build--install-the-native-macos-app-from-source)
- [Optional Tools (Poppler & Chemical Vector Engine)](#optional-tools-poppler--chemical-vector-engine)
- [First Launch & Troubleshooting](#first-launch--troubleshooting)
- [Architecture, Data Storage & Boundaries](#architecture-data-storage--boundaries)
- [Verification & GitHub Actions Releases](#verification--github-actions-releases)

### Key Features

- **Course-centric workspaces:** Each course keeps its own material directory, persistent conversation thread, reading position, custom vector avatar, and course instructions (`AGENTS.md`). Supports instant bilingual UI switching (Simplified Chinese / English) and course archiving/restoration.
- **Multi-format side-by-side reader & annotations:**
  - **PDF courseware reader (EmbedPDF + local PDF.js fallback):** Full-text search, page thumbnails, quoting selected text or regions with page numbers into chat, and exporting annotated copies with custom bookmarks without modifying originals. Both the learner and AI tutor can add text, line, rectangle, and ellipse annotations, plus background AI PDF bookmark regeneration.
  - **Markdown reader:** Shares the chat rendering engine with full KaTeX, `\ce{}`, native vector chemical structures/equations, and a collapsible document outline.
  - **HTML reader & sandboxed interactive canvases:** Runs in an isolated offline sandboxed iframe; chat canvases can be opened side-by-side, saved to the practice area, or downloaded as standalone HTML. The agent can also safely author/update its own Markdown study notes and interactive HTML pages inside the course workspace (never overwriting user originals or system files).
  - **On-demand material access:** Opening a file never dumps the entire document into the prompt; the agent inspects text, rendered PDF pages, images, or EPUB sections only when needed.
- **Native interactive practice & question bank:**
  - Supports **True/False, Multiple Choice (single/multi), Fill-in-the-Blank, Short Answer (with multi-image answer uploads/paste), and Flashcards (4-level self-rating)**. Saves actual submissions, hint/reveal usage, and tutor feedback.
  - Clicking **Continue** resumes tutoring using saved submissions without exposing internal continuation prompts in the chat transcript.
  - The Learning sidebar and **Settings → Practice & Questions** provide unit/knowledge-point categorization, AI one-click organization, editing, and deletion. Chemical structures and equations also render directly inside questions and interactive canvases.
- **Chemistry & STEM tooling:**
  - Built-in KaTeX and `mhchem` (`\ce{...}`, including radical / mass-spec fragmentation formulas).
  - With the optional RDKit + `codex-organic-chem` engine, renders molecular structures, organic reactions, curved-arrow mechanisms, **selective explicit hydrogens, and pointer-arrow/label annotations** progressively near the viewport without jumping your reading position.
  - Local Python math, statistics, and read-only Excel (XLSX / XLSM) analysis tools.
- **Course schedule & requirements:** Tracks exams, assignments, deadlines, and grading rules with original source quotes, conditions, and revision history (no automatic external calendar writes).
- **Flexible model & reasoning presets:** Configure **Fast / Default / Deep** in **Settings (`⌘,`) → General** using any models and reasoning efforts exposed by your Codex account.

### System Requirements & Prerequisites

- **Native macOS app target:** **Apple Silicon macOS (M1 / M2 / M3 / M4, `arm64`)**, requiring **macOS 14 (Sonoma) or later**. Other platforms/architectures have not been fully validated.
- **Required prerequisite: Compatible Codex CLI & authentication**
  - Study Studio connects to models through a local [Codex CLI](https://developers.openai.com/codex/cli/) (`codex app-server`).
  - Install and sign in to Codex CLI first so that `~/.codex/auth.json` exists as a **regular file**. Study Studio reuses it via a symlink inside an isolated runtime directory without modifying your global Codex configuration. There is no built-in login screen, and credentials stored exclusively in the system keychain are not supported.
  - Fast / Default / Deep default in [`shared/model-presets.mjs`](shared/model-presets.mjs) and [`server/model-policy.mjs`](server/model-policy.mjs) to GPT-6.1 Terra medium / high and GPT-6.2 Astra high, and can be remapped in Settings to any model available on your account. Course avatar generation additionally uses GPT-6 Astra high. Model names and Codex experimental interfaces are not guaranteed across every account or CLI release.

| Component | Requirement | Purpose & Notes | Setup / Default Path |
| --- | --- | --- | --- |
| **Codex CLI** | **Required** | Chat, tool calling, import classification, practice organization, and PDF bookmark generation | Follow [Codex CLI docs](https://developers.openai.com/codex/cli/) (`npm i -g @openai/codex` / `brew install --cask codex` / ChatGPT desktop bundle); run `codex login` to create `~/.codex/auth.json` |
| **Node.js 22.13+ & npm** | Source / Dev / Packaging only | Runs the local server and builds the frontend (**not needed for the pre-built `.app`**, which bundles a standalone arm64 Node runtime) | [nodejs.org](https://nodejs.org/) or `brew install node` |
| **Poppler** (`pdfinfo`, `pdftotext`, `pdftoppm`) | **Strongly recommended** | Enables AI agent reading of PDF text and page images (viewing PDFs in the UI uses bundled EmbedPDF + Noto Sans SC and local PDF.js assets, and works without Poppler) | `brew install poppler` (defaults to `/opt/homebrew/bin`; override with `STUDY_POPPLER_DIR`) |
| **Python 3** | Recommended | Native DOCX / PPTX / EPUB extraction (no OCR), local calculations/statistics, and read-only XLSX / XLSM reading | macOS `/usr/bin/python3` (install Xcode Command Line Tools via `xcode-select --install` if prompted) |
| **RDKit + `codex-organic-chem`** | Optional | Native vector chemistry rendering: structures, reactions, mechanisms, selective explicit H, and annotations | Separate Python venv at `~/.local/share/codex-organic-chem/.venv/bin/python` (override with `STUDY_CHEM_PYTHON`) |
| **macOS `sips`** | Built into macOS | Short-answer image decoding/conversion and EPUB image previews | Included with macOS |

### Installation & Running

#### Option 1: Download Pre-built macOS App (Recommended)

For **Apple Silicon Macs (macOS 14+)** — no local Node.js or Swift build toolchain required.

1. **Install and sign in to Codex CLI** (if you haven't already):
   ```sh
   # Option A: Homebrew
   brew install --cask codex
   # Or Option B: npm
   # npm install -g @openai/codex

   # Sign in and verify ~/.codex/auth.json exists as a regular file
   codex login
   ls -l ~/.codex/auth.json
   ```
   > At startup, Study Studio automatically searches for the Codex executable in this order: `STUDY_CODEX_BIN` → ChatGPT.app bundled CLI → Codex.app bundled CLI → `/opt/homebrew/bin/codex` → `/usr/local/bin/codex` → `~/.local/bin/codex` → `PATH`.
2. **(Recommended) Install Poppler** so the AI tutor can inspect PDF courseware pages:
   ```sh
   brew install poppler
   ```
3. **Download the release package:**
   - Download **`Study-Studio-vX.Y.Z-macos-arm64.dmg`** (or `.zip`) from [GitHub Releases](https://github.com/Waylon524/StudyStudio/releases).
   - You can also download recent CI build artifacts from [GitHub Actions → Build & Release macOS App](https://github.com/Waylon524/StudyStudio/actions/workflows/build-macos.yml).
   - *(Optional)* Verify checksums:
     ```sh
     shasum -a 256 -c SHA256SUMS.txt
     ```
4. **Install into `/Applications`:**
   - Open the `.dmg` and drag **`Study Studio.app`** into **`Applications`** (or extract the `.zip` and move `Study Studio.app` to `/Applications`).
5. **Clear macOS quarantine on first launch (Important):**
   - Release packages are **ad-hoc signed** and not notarized with an Apple Developer ID. macOS attaches `com.apple.quarantine` to browser downloads, which may trigger *"Study Studio is damaged and can't be opened"* or *"unidentified developer"* warnings.
   - Run this command in Terminal before opening:
     ```sh
     xattr -dr com.apple.quarantine "/Applications/Study Studio.app"
     open "/Applications/Study Studio.app"
     ```
   - Alternatively, go to **System Settings → Privacy & Security** and click **Open Anyway**.
6. **Verify models in Settings:**
   - Press `⌘,` to open **Settings → General**, confirm Codex shows **Connected**, and click **Refresh Models** if you want to remap Fast / Default / Deep to models available on your account.

> **Upgrading:** Save any unsent drafts and completely quit Study Studio (`⌘Q`) before replacing `/Applications/Study Studio.app`. Your course materials (`~/Documents/StudyStudio/`) and application data (`~/Library/Application Support/Study Studio/data/`) are stored outside the app bundle and remain intact.

---

#### Option 2: Run from Source (Browser / Development Mode)

Requires **Node.js 22.13+**, **npm**, and a signed-in **Codex CLI**.

```sh
git clone https://github.com/Waylon524/StudyStudio.git
cd StudyStudio
npm ci

# Optional if codex is outside the default auto-discovery locations:
# export STUDY_CODEX_BIN="$(command -v codex)"

npm run build
npm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

**Frontend HMR development** (keep `npm start` running and launch Vite in a second terminal):

```sh
npm run dev:ui
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api` to port `4317` by default; update [`vite.config.ts`](vite.config.ts) if you change `STUDY_PORT`.

> `npm run build` and `npm run dev:ui` automatically run `node scripts/prepare-pdf-assets.mjs` to copy `public/pdfjs/` assets and upstream license files from `pdfjs-dist` (excluded from Git).

---

#### Option 3: Build & Install the Native macOS App from Source

1. **Build prerequisites:**
   - Apple Silicon Mac (`arm64`), Xcode Command Line Tools (`xcode-select --install`), Swift, Python 3.
   - A **standalone arm64 Node.js binary** linked only to macOS system libraries (`/System/Library/` and `/usr/lib/`). Download the official `macOS (arm64) .tar.gz` archive from [nodejs.org](https://nodejs.org/) and set `STUDY_NODE_BINARY` to its `bin/node` (Homebrew Node builds linked against external dynamic libraries are rejected by [`script/package_macos.py`](script/package_macos.py); if Study Studio is already installed in `/Applications`, the packager can also reuse its validated bundled Node).
2. **Build `.app` only (without replacing `/Applications/Study Studio.app`):**
   ```sh
   npm ci
   export STUDY_NODE_BINARY=/path/to/node-v24.x.x-darwin-arm64/bin/node
   ./script/build_and_run.sh --build-only
   ```
   Output bundle: `build/macos/Study Studio.app`.
3. **Build, atomically replace `/Applications/Study Studio.app`, and verify startup:**
   - Save drafts and quit any running Study Studio instance first (the installer refuses to overwrite a running app).
   ```sh
   ./script/build_and_run.sh
   ```
   The installer validates bundle structure and code signatures, swaps in the new app, verifies the fresh instance comes online, cleans build caches, and automatically restores the previous bundle if startup verification fails.
4. **Install a pre-built `.app` bundle safely:**
   ```sh
   /usr/bin/python3 script/install_macos.py "build/macos/Study Studio.app" --clean-builds
   ```

### Optional Tools (Poppler & Chemical Vector Engine)

Neither the packaged `.app` nor `npm ci` bundles Poppler or the chemistry Python environment. Install them as needed and restart Study Studio:

1. **Poppler (for AI PDF page reading):**
   ```sh
   brew install poppler
   which pdfinfo pdftotext pdftoppm
   ```
   If installed outside `/opt/homebrew/bin`, set `STUDY_POPPLER_DIR`.

2. **Vector Chemistry Engine (optional, for molecular structures, reactions, mechanisms, and selective-H annotations):**
   Follow the setup instructions for [`codex-organic-chem`](https://github.com/LaoZhong-Mihari/codex-organic-chem) with RDKit in the default virtual environment `~/.local/share/codex-organic-chem/.venv`:
   ```sh
   python3 -m venv ~/.local/share/codex-organic-chem/.venv
   ~/.local/share/codex-organic-chem/.venv/bin/pip install --upgrade pip rdkit
   # Then install codex-organic-chem into the same virtualenv per its README
   ```
   Study Studio automatically checks `~/.local/share/codex-organic-chem/.venv/bin/python`; set `STUDY_CHEM_PYTHON` to use a different interpreter.

### First Launch & Troubleshooting

| Issue | Cause & Fix |
| --- | --- |
| *"Study Studio is damaged and can't be opened"* or *"unidentified developer"* | Ad-hoc signed download quarantined by Gatekeeper. Run `xattr -dr com.apple.quarantine "/Applications/Study Studio.app"` and reopen. |
| *"Codex failed to start"* or missing auth file | 1. Confirm Codex CLI is installed and `codex login` created a regular `~/.codex/auth.json` file.<br>2. If `codex` lives under nvm / fnm / Volta, symlink it to `/opt/homebrew/bin/codex` or launch via `STUDY_CODEX_BIN="$(command -v codex)" open "/Applications/Study Studio.app"`.<br>3. Check logs: `tail -n 100 ~/Library/Application\ Support/Study\ Studio/server.log`. |
| *"No models available"* or preset unavailable warning | Open **Settings (`⌘,`) → General**, click **Refresh Models**, and assign models supported by your Codex account to Fast / Default / Deep. |
| Agent cannot read PDF slide pages | Install Poppler (`brew install poppler`) and verify `/opt/homebrew/bin/pdftoppm` exists. |
| Chemical structure card reports render failure | Verify `~/.local/share/codex-organic-chem/.venv/bin/python` has RDKit and `codex-organic-chem` installed, or set `STUDY_CHEM_PYTHON`. |
| Port `4317` already in use / another instance running | Quit any existing Study Studio app or `npm start` process. In browser mode, override via `STUDY_PORT=4318 npm start`. |

### Architecture, Data Storage & Boundaries

#### Repository Layout

- [`src/`](src/): React / TypeScript frontend, EmbedPDF viewer, Markdown/HTML readers, and native study components.
- [`server/`](server/): Localhost-only (`127.0.0.1`) Node service exposing bounded `study_*` tools through [Codex app-server](https://developers.openai.com/codex/app-server), invoking local Python / Poppler / chemistry workers on demand.
- [`shared/`](shared/): Schema validation, Markdown extensions, chemical equation parser, streaming state, and progressive render queue.
- [`native/`](native/) / [`script/`](script/): macOS AppKit / WKWebView native shell, packaging, and atomic installation scripts.
- [`scripts/`](scripts/): Asset preparation (`prepare-pdf-assets.mjs`) and module-level checks (`check-*.mjs`).
- [`.github/workflows/build-macos.yml`](.github/workflows/build-macos.yml): Automated Apple Silicon macOS build, offline test suite, and GitHub Release workflow.

#### Local Data Locations

| Data | Browser / Dev Default | Native macOS App |
| --- | --- | --- |
| Course files & learning state | `~/Documents/StudyStudio/` (per-course state in `<course>/.study-studio/`) | `~/Documents/StudyStudio/` (per-course state in `<course>/.study-studio/`) |
| Chat index, settings & isolated `CODEX_HOME` | `.data/` inside repo (override via `STUDY_DATA_ROOT`) | `~/Library/Application Support/Study Studio/data/` |
| Native app backend log | Terminal stdout/stderr | `~/Library/Application Support/Study Studio/server.log` |

> Personal materials, conversations, and credentials are gitignored and never included in this repository or release bundles.

#### Privacy, Security & Functional Limits

- **Local-first ≠ offline model:** Questions, material excerpts/page images actually read, submissions, and learning instructions are sent to the model provider configured in Codex. Background import classification sends bounded text and necessary images; course avatar generation sends the course name. PDF display, file storage, and local chemistry/math rendering stay on your machine.
- **Sandboxed tools & iframes:** File tools are strictly confined to the active course workspace. The isolated Codex process disables arbitrary shell commands, native direct file-editing tools, and external plugins, keeping only bounded `study_*` tools (including safe note/HTML creation without overwriting user originals or system files) and public web search. Interactive canvases and the HTML reader run inside restricted sandboxed iframes.
- **Limits:** Model explanations, grading, and diagrams can still contain mistakes; chemical layout/electron checks are not experimental validation. Individual uploads are capped at **100 MB**; whole-document PDF / PPTX text extraction reads at most the first **100 pages / 100,000 characters**. OCR, speech transcription, external LMS login, and cloud sync are not provided.

### Verification & GitHub Actions Releases

- **Local checks:** Run targeted `node scripts/check-*.mjs` scripts covering i18n, model policy, Markdown, canvases, teaching UI, practice/material management, PDF outlines, chemistry rendering, and runtime isolation (some checks require Poppler, the chemistry Python venv, or a live Codex login).
- **Automated GitHub macOS Builds & Releases:**
  - Pushing any `v*` tag matching `package.json` and `native/Info.plist` (e.g. `git tag v0.21.0 && git push origin v0.21.0`) triggers [Build & Release macOS App](.github/workflows/build-macos.yml) on an Apple Silicon `macos-15` runner, runs offline checks, packages and verifies `Study Studio.app`, builds `.dmg` / `.zip` / `SHA256SUMS.txt`, uploads build artifacts, and publishes a **GitHub Release**.
  - You can also trigger a build manually anytime via **Actions → Build & Release macOS App → Run workflow** (enable `publish_release` to publish/update the corresponding release).

---

## Configuration

Set these environment variables before starting the backend / 在启动后端前按需设置以下环境变量：

| Variable | Default / 默认值 | Purpose / 用途 |
| --- | --- | --- |
| `STUDY_CODEX_BIN` | Auto-detected (ChatGPT.app → Codex.app → Homebrew/PATH) / 自动探测 | Explicit path to the Codex CLI executable / 显式指定 Codex 可执行文件路径。 |
| `STUDY_PORT` | `4317` | Local backend port / 后端监听端口（原生外壳固定使用独立端口管理）。 |
| `STUDY_WORKSPACE_ROOT` | `~/Documents/StudyStudio` | Course materials root directory / 课程文件根目录。 |
| `STUDY_DATA_ROOT` | `.data/` (dev) / `~/Library/Application Support/Study Studio/data/` (app) | Chat index, settings, and isolated runtime data / 对话索引、设置与独立运行数据目录。 |
| `STUDY_POPPLER_DIR` | `/opt/homebrew/bin` | Directory containing `pdfinfo`, `pdftotext`, `pdftoppm` / Poppler 工具所在目录。 |
| `STUDY_CHEM_PYTHON` | `~/.local/share/codex-organic-chem/.venv/bin/python` | Python interpreter with RDKit + `codex-organic-chem` / 化学矢量引擎 Python 解释器。 |
| `STUDY_EXTRACT_PYTHON` | `/usr/bin/python3` | Python interpreter for DOCX / PPTX / EPUB extraction / 文档提取 Python 解释器。 |
| `STUDY_ANALYSIS_PYTHON` | `/usr/bin/python3` | Python interpreter for local math, statistics, and XLSX / 计算与统计 Python 解释器。 |
| `STUDY_NODE_BINARY` | Installed app runtime or `node` on `PATH` / 已有 App 内置或 `PATH` | Standalone arm64 Node binary for macOS packaging / 打包 macOS 应用使用的独立 arm64 Node。 |
| `STUDY_NATIVE_INSPECT` | `0` | Set to `1` to enable WKWebView Web Inspector in native app / 设为 `1` 开启原生窗口 Web Inspector 调试。 |

## License

[Apache-2.0](LICENSE) · Copyright (c) 2026 Weilun Qian · See [NOTICE](NOTICE).

Third-party components retain their respective licenses; see [Third-party notices](THIRD_PARTY_NOTICES.md). / 第三方组件保留各自的许可证，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
