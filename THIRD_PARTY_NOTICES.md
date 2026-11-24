# Third-party notices / 第三方声明

Study Studio's original source code and documentation are licensed under the
[Apache License, Version 2.0](LICENSE), copyright © 2026 Weilun Qian (see
[NOTICE](NOTICE)). Third-party software, services, fonts, and assets retain their
respective licenses and terms. The project's Apache-2.0 license does not
relicense them.

Study Studio 的原创源码和文档采用 [Apache License 2.0 许可证](LICENSE)，版权归
2026 Weilun Qian 所有（详见 [NOTICE](NOTICE)）。第三方软件、服务、字体和资源仍
适用各自的许可或服务条款，不因本项目采用 Apache-2.0 而改变。

| Component / 组件 | Use / 用途 | Upstream / 上游 |
| --- | --- | --- |
| React, React DOM | Application UI / 应用界面 | [facebook/react](https://github.com/facebook/react), MIT |
| Vite | Development and frontend builds / 开发与前端构建 | [vitejs/vite](https://github.com/vitejs/vite), MIT |
| TypeScript | Static type checking / 静态类型检查 | [microsoft/TypeScript](https://github.com/microsoft/TypeScript), Apache-2.0 |
| Lucide | UI icons / 界面图标 | [lucide-icons/lucide](https://github.com/lucide-icons/lucide), ISC |
| react-markdown, remark, rehype, micromark | Markdown and math processing / Markdown 与数学解析 | [unified](https://github.com/unifiedjs), [micromark](https://github.com/micromark), MIT |
| KaTeX and its mhchem extension | Mathematical and chemical notation / 数学与化学排版 | [KaTeX/KaTeX](https://github.com/KaTeX/KaTeX), MIT |
| EmbedPDF (`@embedpdf/*`) | Primary PDF viewer & annotation engine (derived from PDFium; not affiliated with or endorsed by Google) / 主 PDF 阅读与批注引擎（派生自 PDFium） | [embedpdf/embed-pdf-viewer](https://github.com/embedpdf/embed-pdf-viewer), Apache-2.0 (bundled fallback/signature fonts under Apache-2.0 and SIL OFL-1.1; see `public/embedpdf-licenses/`) |
| Noto Sans SC | Bundled Chinese PDF rendering font / 随应用打包的中文字体 | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk), SIL OFL-1.1 (see `public/embedpdf-fonts/OFL.txt`) |
| PDF.js | Fallback local PDF reading, outline inspection, and resources / 备用本地 PDF 阅读、目录提取与配套资源 | [mozilla/pdf.js](https://github.com/mozilla/pdf.js), Apache-2.0 and resource-specific licenses / 另有资源独立许可 |
| codex-organic-chem | Optional external chemistry engine / 可选外部化学绘图引擎 | [LaoZhong-Mihari/codex-organic-chem](https://github.com/LaoZhong-Mihari/codex-organic-chem), core MIT / 核心 MIT |

## Dependency and asset distribution / 依赖与资源分发

- JavaScript dependencies are installed through npm and are not vendored in this
  source repository. Refer to each installed package for its complete copyright
  and license notices, including transitive dependencies.
- EmbedPDF third-party notices and font licenses under `public/embedpdf-licenses/`
  and `public/embedpdf-fonts/OFL.txt` are included in the frontend build and
  packaged application. Preserve those notices when redistributing.
- PDF.js resources under `public/pdfjs/` are generated from the installed
  `pdfjs-dist` package and are excluded from Git. The preparation script preserves
  the upstream license files. These resources include separately licensed fonts,
  CMaps, WebAssembly codecs, and color profiles. In particular, the Liberation
  font resources use GPLv2 with a font embedding exception; other PDF.js resources
  have their own Apache, BSD, MIT, or CC0 notices. Preserve those notices when
  redistributing generated assets or a packaged application.
- The optional chemistry Python environment and its dependencies are installed
  separately. This repository does not bundle that engine or its optional
  ChemDoodle integration. The integration has separate GPLv3 terms and is not
  required by Study Studio.
- Codex CLI, the Node.js runtime, Poppler, Python libraries, and Apple system fonts
  are not included in this source repository. A locally packaged application
  includes selected npm dependencies and a user-supplied Node.js runtime; retain
  their original licenses when distributing such a package. Codex and model
  access remain subject to their providers' terms.

- JavaScript 依赖通过 npm 安装，不随源码仓库一并提交；完整版权和许可声明以各安装包
  为准，传递依赖同样适用。
- `public/embedpdf-licenses/` 与 `public/embedpdf-fonts/OFL.txt` 中的 EmbedPDF
  第三方说明和字体许可证会随前端构建一起打入应用包；再分发时须予以保留。
- `public/pdfjs/` 从已安装的 `pdfjs-dist` 生成并排除在 Git 外；准备脚本保留上游的
  许可证。字体、CMap、WebAssembly 解码器和色彩配置文件可能分别适用不同许可。
  Liberation 字体资源采用 GPLv2 加字体嵌入例外；其他资源另有 Apache、BSD、MIT 或
  CC0 声明。分发生成资源或应用包时须保留这些声明。
- 化学绘图 Python 环境及其依赖需另外安装。本仓库不包含该引擎，也不包含其另有
  GPLv3 条款、且本应用不需要的可选 ChemDoodle 集成。
- Codex CLI、Node.js 运行时、Poppler、Python 库及 Apple 系统字体不包含在本源码仓库
  中。本机打包应用会包含部分 npm 依赖和用户提供的 Node.js 运行时；分发应用包时仍需
  保留它们的原许可。Codex 与模型访问另受对应提供方的服务条款约束。
