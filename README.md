# Paper Reader

> 面向外文论文、教材、课程讲义和扫描资料的本地 PDF 阅读、翻译与知识整理桌面应用。

当前版本：**1.0.0**

主要运行方式：**Windows 桌面端（Electron）**

Paper Reader 把 PDF 阅读、划词翻译、区域 OCR、图解翻译、对照翻译、文献库、批注、笔记、书签和报告导出整合在同一个桌面应用中。PDF 和阅读记录保存在本地；只有用户主动触发翻译或多模态识别时，相应文本、图片区域及术语库内容才会发送给所配置的 AI 服务。

## 功能概览

### 阅读与检索

- 导入本地 PDF，支持多标签页、切换、关闭和拖拽排序。
- 支持翻页、页码跳转、50%–300% 缩放和全屏阅读。
- 自动保存最近打开、阅读页码、缩放比例和右侧栏状态。
- 启动时可恢复上次未关闭的 PDF 标签页。
- 支持当前文献搜索和文献库全局搜索，可筛选文献、翻译、批注和笔记。
- 优先读取 PDF 原生目录；缺少目录时，可通过文本结构、目录页识别、OCR 和 AI 清洗生成目录。

### 翻译与 OCR

- 划选 PDF 文本后自动识别源语言并翻译为中文。
- 区域 OCR 提供三种模式：
  - **文本模式**：识别扫描文字或截图段落，展示可编辑原文与译文。
  - **图解模式**：识别图表、流程图和结构图中的文字，在原图附近放置译文标签。
  - **对照模式**：生成原图与译文覆盖图的左右或上下对照。
- 优先利用 PDF 文本层，必要时回退到本地 Tesseract OCR。
- 可选用多模态模型识别文字模块、行坐标和公式区域；失败时回退到本地 OCR。
- 支持行内公式识别和公式占位保护，尽量避免翻译过程破坏公式、变量和单位。
- 本地 Tesseract OCR 当前仍只内置英语语言包；其他语言优先使用 PDF 文字层或可选的多模态识别。

### 阅读记录

- 每篇文献独立保存翻译历史、笔记、批注、书签和自动目录。
- 每篇文献最多保留 50 条翻译历史，最近 30 篇打开过的文献保留阅读记录。
- 支持多色文本高亮、高亮关联笔记和 OCR 小便签。
- 支持当前页主题书签及跳转、删除和批量管理。
- 历史记录可以直接恢复，不会重复执行 OCR 或翻译。

### 文献库与导出

- 支持单篇或批量导入 PDF。
- 支持树形项目文件夹、同级排序、跨层级移动和回收站。
- 移动文献不会丢失其翻译、笔记、批注、书签和阅读进度。
- 支持 `.paperreader.json` 数据备份、批量导入、合并和去重。
- 支持把选中文献整理为 Markdown 或 PDF 报告。
- 批量导出会处理文件名冲突，不会默认覆盖已有导出文件。

## 快速开始

### 环境要求

- Windows 10/11 x64
- Node.js 与 npm
- 至少一个可用的 AI 服务 API Key（仅阅读本地 PDF 时不需要）

### 安装依赖

```bash
npm install
```

### 启动桌面开发版

```bash
npm run electron:dev
```

该命令会先构建 React 前端，再启动 Electron。Electron 主进程会自动启动本地翻译服务，默认端口为 `3001`。

首次启动后：

1. 打开左侧 **设置**。
2. 选择 Provider 并填写对应的 API Key；预设 Provider 会自动填入 Base URL。
3. 从远程模型列表选择模型，或手动填写模型名称，然后保存设置。
4. 回到 **阅读** 页面并导入 PDF。

> 不同 Provider 的 API Key 会分别保存在 Electron `userData/config.json`。不要把该文件、API Key、截图或相关调试日志提交到公开仓库。

## AI Provider 配置

当前设置页支持以下 Provider：

| Provider | 默认 Base URL | 默认模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` |
| OpenAI / GPT | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Anthropic / Claude | `https://api.anthropic.com` | `claude-3-5-sonnet-latest` |
| 智谱 AI / GLM | `https://open.bigmodel.cn/api/paas/v4` | 手动选择 |
| Google / Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | 手动选择 |
| 阿里云百炼 / Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 手动选择 |
| 月之暗面 / Kimi | `https://api.moonshot.cn/v1` | 手动选择 |
| OpenRouter | `https://openrouter.ai/api/v1` | 手动选择 |
| 硅基流动 / SiliconFlow | `https://api.siliconflow.cn/v1` | 手动选择 |
| Custom | 用户填写 | 用户填写 |

填写 API Key 和 Base URL 后，设置页会尝试读取远程模型列表。模型服务的名称、权限和接口规则会变化；如果列表或翻译请求失败，请以对应服务商的控制台和官方文档为准。

API Key 按 Provider 独立记忆：

- 切换 Provider 时，应用会保存当前输入的 Key，并恢复目标 Provider 上次保存的 Key。
- 切换同一 Provider 下的模型不会清空 API Key。
- 首次使用某个 Provider 时仍需填写一次 Key，并点击 **保存设置** 才会在重启后继续保留。
- 旧版配置中的当前 API Key 会自动归入当时选中的 Provider；已经被旧配置覆盖或清空的历史 Key 无法自动恢复。

### Temperature

- 默认使用 **自动** 模式：通常不主动发送 `temperature`。
- 已知特殊模型会使用对应参数，例如 `kimi-k2.6` 使用 `temperature: 1`。
- 如果服务端明确返回 temperature 限制，应用会根据错误信息最多自适应重试一次，并缓存该 Provider、Base URL、模型和端点组合的有效参数。
- 选择 **自定义** 后，可手动填写 `0`–`2`；自定义值不会被自动覆盖。

### 多模态识别开关

设置页中的 **启用多模态翻译** 控制当前模型是否可以接收图片。

图解模式和对照模式的新版视觉版面识别管线还需要在构建时设置：

```env
VITE_ENABLE_MULTIMODAL_VISUAL_OCR=true
```

该变量默认是 `false`。未启用、模型不支持图片或请求失败时，图解/对照模式会继续使用本地 OCR 流程。

调试视觉版面识别时可以设置：

```env
VITE_MULTIMODAL_OCR_DEBUG=true
```

调试输出可能包含识别文本和模块坐标，不建议在公开环境开启。

## 浏览器开发模式

浏览器模式适合前后端调试，不提供完整的桌面文件能力。

创建 `.env`：

```env
DEEPSEEK_API_KEY=your_deepseek_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
AI_TEMPERATURE=
VITE_ENABLE_MULTIMODAL_VISUAL_OCR=false
VITE_MULTIMODAL_OCR_DEBUG=false
PORT=3001
```

也可以使用通用变量：

```env
AI_PROVIDER=deepseek
AI_API_KEY=your_api_key
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash
AI_TRANSLATION_PROMPT=
```

分别启动后端和前端：

```bash
node server/index.js
npm run dev
```

也可以在 Windows 中运行 `start-backend.bat` 和 `start-frontend.bat`。

前端默认访问 `http://localhost:3001`，可通过 `VITE_API_BASE_URL` 修改。依赖 Electron API 的本地文件选择、持久化、PDF 写入和系统导出在浏览器模式中会不可用或降级。

## 数据与隐私

桌面端数据保存在 Electron `userData` 目录。Windows 默认位于 `%APPDATA%/paper-reader/` 附近，实际路径由 Electron 决定。

主要文件包括：

| 文件 | 内容 |
| --- | --- |
| `config.json` | Provider、各 Provider 的 API Key、模型、Prompt 和界面设置 |
| `glossary.json` | 用户术语库 |
| `paper-reader-browsing-history.json` | 最近打开和阅读位置 |
| `paper-reader-pdf-session.json` | 上次打开的标签页会话 |
| `paper-reader-library.json` | 文献库、文件夹和回收站 |
| `paper-reader-document-translation-history.json` | 分文献翻译历史 |
| `paper-reader-notes.json` | 分文献笔记 |
| `paper-reader-annotations.json` | 高亮和 OCR 标签 |
| `paper-reader-bookmarks.json` | 分文献书签 |
| `paper-reader-toc.json` | 自动目录缓存 |

持久化层使用按文件串行队列、临时文件和重命名执行 JSON 写入。读取到可恢复的损坏 JSON 时，应用会保留 `.corrupt-<timestamp>.bak` 并重写修复后的数据。

通过 **备份与恢复** 生成的 `.paperreader.json` 不包含当前 API Key，也不包含各 Provider 的 API Key 映射；在其他设备恢复数据后，需要重新配置模型凭据。

PDF 本体不会复制到 `userData`。当用户选择将高亮写入 PDF 本体时，程序会直接修改原 PDF；**当前实现不会自动为原 PDF 创建备份**。对重要文献使用该功能前，请先自行备份。

触发 AI 功能时，以下内容可能发送给用户配置的服务商：

- 划选或 OCR 得到的待翻译文本；
- 多模态模式中的框选图片；
- 自定义翻译 Prompt；
- 导入术语库中用于当前请求的术语。

行内公式 OCR 使用 Transformers.js，并允许首次使用时下载模型文件；模型文件随后由浏览器缓存管理。

## 架构

```text
React renderer
  ├─ react-pdf / PDF.js：页面渲染、文本层、搜索和目录提取
  ├─ Tesseract.js：本地 OCR
  ├─ Transformers.js：可选行内公式 OCR
  └─ Canvas：截图、图解标签和对照译图
          │
          ▼
Electron preload（受限 IPC API）
          │
          ▼
Electron main
  ├─ userData JSON 持久化与恢复
  ├─ 本地 PDF、批注和导入导出
  └─ 启动 localhost:3001 Express 服务
          │
          ▼
ProviderRouter
  ├─ OpenAI-compatible
  └─ Anthropic-compatible
```

Electron 窗口启用了 `contextIsolation`，关闭了渲染层 `nodeIntegration`；渲染层只能调用 `electron/preload.js` 暴露的 IPC 接口。

## 项目结构

```text
paper-reader/
├─ build/                  # 应用图标和打包资源
├─ electron/
│  ├─ main.js             # 主进程、IPC、持久化、PDF 写入和导出
│  └─ preload.js          # 渲染层 API 白名单
├─ public/
│  └─ tesseract/          # 本地 OCR worker、WASM 和语言数据
├─ server/
│  ├─ aiProviders.js      # Provider、模型列表和多模态版面协议
│  └─ index.js            # Express 接口
├─ src/
│  ├─ App.jsx             # 主界面和核心交互
│  ├─ App.css             # 主界面样式
│  ├─ components/ui/      # 基础 UI 组件
│  └─ utils/
│     ├─ history.js       # 历史和最近文献标准化
│     ├─ markdownExport.js
│     ├─ pdfReportExport.js
│     └─ toc.js           # 目录分析与 AI 结果约束
├─ .env.example
├─ package.json
└─ vite.config.js
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run electron:dev` | 构建前端并启动 Electron |
| `npm run dev` | 启动 Vite 前端 |
| `npm run build` | 构建生产前端 |
| `npm run lint` | 运行 ESLint |
| `npm run preview` | 预览生产构建 |
| `npm run dist` | 生成 Windows x64 安装包和便携版 |

打包产物输出到 `release/`，包括 NSIS 安装包和 portable EXE。

## 开发与验证

修改代码后至少运行：

```bash
npm run lint
npm run build
```

修改 Electron 主进程或服务端时，建议补充：

```bash
node --check electron/main.js
node --check electron/preload.js
node --check server/index.js
node --check server/aiProviders.js
```

涉及 PDF、OCR、批注、文献库或会话恢复时，还应在桌面端手动验证：

- PDF 打开、多标签切换和会话恢复；
- 翻页、缩放、搜索、目录和全屏；
- 划词翻译与三种 OCR 模式；
- 历史、笔记、书签、高亮和 PDF 本体写入；
- 文献库移动、回收站和记录关联；
- Markdown、PDF 报告和数据备份导入导出。

当前仓库尚未配置自动化测试。`App.jsx` 和 `electron/main.js` 承载的职责较多，较大改动应保持范围明确，并优先补充可独立测试的工具模块。

## 安全注意事项

- 不要提交 `.env`、API Key、Electron `userData` 或包含个人文献内容的导出文件。
- 写入 PDF 本体前自行备份原文件。
- 多模态调用会把框选图片发送到所选服务商。
- 导入数据采用合并去重策略，但重要数据仍建议定期导出完整备份。
- 本地 Express 服务默认使用端口 `3001`；在不可信网络环境中运行前，建议确认系统防火墙没有对外开放该端口。
- 分享调试日志前检查其中是否包含论文文本、文件路径、模型信息或服务端错误详情。

## License

当前仓库未包含独立的开源许可证文件。除非仓库所有者另行授权，不应假定项目允许复制、再发布或商业使用。
