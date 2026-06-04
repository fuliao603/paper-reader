# Paper Reader

当前版本：0.7.0

Paper Reader 是一个本地运行的 PDF 学术阅读与翻译桌面工具，面向英文论文、教材章节、课程讲义、技术文档、扫描件和截图型资料。它把 PDF 阅读、文献库、滑词翻译、区域 OCR、图解翻译、对照翻译、批注高亮、笔记、历史数据管理和整理导出放在同一个桌面应用里，方便在阅读过程中持续积累翻译结果和笔记，并把这些内容整理成 Markdown 或 PDF 报告。

项目基于 Vite、React、Electron 和 Express 构建。桌面端是主使用方式；浏览器模式主要用于开发调试，部分本地文件能力会降级或不可用。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动桌面开发版

```bash
npm run electron:dev
```

这个命令会先构建前端，再启动 Electron 桌面应用。首次打开后，进入左侧“设置”页面填写 API 配置，然后回到“阅读”页面导入 PDF。

### 3. 配置翻译模型

桌面端推荐直接在应用内配置：

1. 打开左侧“设置”。
2. 在“模型设置”里选择 DeepSeek、OpenRouter 或 OpenAI-compatible 自定义接口。
3. 填写 API Key、Base URL 和模型名称。
4. 保存设置后进行滑词翻译或 OCR 翻译。

配置会保存到 Electron 的 `userData/config.json`。不要把 API Key 写入 README、截图或提交到代码仓库。

## 主要功能

### PDF 阅读

- 导入本地 PDF，在桌面端阅读。
- 支持多 PDF 标签页、标签页切换、关闭和拖拽排序。
- 支持上一页、下一页、页码跳转、缩放比例输入和全屏阅读。
- 鼠标滚轮会优先滚动当前页，滚到顶部或底部后再翻页。
- 大缩放比例下支持横向滚动条、触控板横向滑动和 `Shift + 鼠标滚轮`。
- 自动记录最近打开、阅读页码、缩放比例、右侧栏宽度和右侧栏显示状态。
- 启动时可恢复上次未关闭的 PDF 标签页会话。

### 文献库与项目文件夹

- 左侧“文献库”集中管理已导入 PDF。
- 支持单文件导入、批量导入、按文件名搜索和排序。
- 支持创建项目文件夹，把文献移动到不同文件夹。
- 支持单篇或批量移动、删除文献。
- 文献列表展示导入日期、最近阅读日期、阅读进度、笔记数和批注数。
- 文献移动文件夹不会改变它关联的翻译历史、笔记、高亮、OCR 结果和阅读进度。

### 滑词翻译

- 在 PDF 文本层中划选英文内容后自动翻译。
- 翻译结果显示在右侧“翻译结果”区域。
- 翻译 Prompt 会尽量保留公式、上下标、单位、专业术语、缩写和变量表达。
- 翻页、缩放、全屏和标签页切换不会自动清空当前结果。
- 右侧结果支持复制、清空和添加为笔记。

### 区域 OCR 与截图翻译

点击顶部工具栏“区域 OCR”后，可以框选 PDF 页面中的截图、图表、扫描文字或复杂区域。

| 模式 | 适合内容 | 输出 |
| --- | --- | --- |
| 文本模式 | 普通扫描文字、截图段落 | OCR 文本、可编辑文本框、重新翻译按钮、译文 |
| 图解模式 | 示意图、流程图、结构图、图表说明 | 保留原图结构，在对应模块旁放置译文标签 |
| 对照模式 | 文字密集图片、扫描版段落、需要原图/译图对照的内容 | 原图和译文覆盖图，自动选择左右或上下对照布局 |

图解模式和对照模式会尽量保留箭头、边框、编号、化学式、短标签和图形结构。结果图片可以在弹窗中缩放、拖动和全屏查看，关闭弹窗后仍可从右侧结果重新打开。

在“设置”中启用“多模态翻译”后，图解模式和对照模式会优先把框选区域交给支持图片输入的 AI 模型识别文字坐标并翻译；如果多模态调用失败，程序会自动回退到原来的本地 OCR 流程。

### 翻译历史、笔记和批注

- 普通滑词翻译、文本 OCR、图解 OCR 和对照 OCR 成功后会保存到当前 PDF 的翻译历史。
- 每篇 PDF 独立保存翻译历史、笔记和批注数据。
- 每篇 PDF 最多保留 50 条翻译历史。
- 最近 30 个打开过的 PDF 会保留自己的历史数据。
- 点击历史记录可以恢复当时的右侧结果，不会重新 OCR 或重新翻译。
- 支持从翻译结果主动添加笔记。
- 笔记来源包括滑词翻译、文本 OCR、图解 OCR、对照 OCR 和批注高亮。
- 点击笔记可跳转到对应页，OCR 笔记会在 PDF 页面上显示小便签标签。
- 支持多种高亮颜色，右键高亮可取消。
- 可选择将高亮写入 PDF 本体；写入时会修改原 PDF，并创建备份文件。

### 历史笔记管理

左侧“历史笔记管理”负责翻译历史、笔记和批注数据的导入导出。

- 支持导出或导入当前 PDF 的翻译历史。
- 支持导出或导入当前 PDF 的笔记和相关 annotations。
- 支持批量导入多个 `.paperreader.json` 文件。
- 支持按 PDF 自选导出翻译历史、笔记或完整备份。
- 支持多篇合并导出，也支持把合并文件拆分回单篇文件。
- 导入采用合并去重策略，不会默认覆盖已有数据。

### Markdown 与 PDF 报告导出

“历史笔记管理”还支持把已积累的阅读数据整理成更适合复习、归档或分享的文件。

- 可选择导出翻译历史、批注和笔记中的任意组合。
- 支持导出当前 PDF、选中文献合并导出、选中文献批量导出。
- Markdown 导出会生成 `.md` 文件，保留文件名、页码、原句和对应的译文或笔记内容。
- PDF 报告导出会生成新的整理报告文件，不会写回或修改原始 PDF。
- 批量导出时会自动处理文件名冲突，避免覆盖同目录下已有文件。

## 配置

### 桌面端配置

桌面端优先使用应用内“设置”页面。当前支持：

- DeepSeek；
- OpenRouter；
- OpenAI-compatible 自定义接口；
- 自定义 Base URL；
- 自定义 API Key；
- 自定义模型名称；
- 常用模型预设；
- 自定义翻译 Prompt；
- 图解模式和对照模式的多模态翻译开关；
- 术语库导入、查看和清空；
- 默认导出目录设置。

当前代码内置的默认模型配置：

| Provider | Base URL | 默认模型 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openrouter/auto` |
| Custom | 自行填写 | 自行填写 |

模型名称、Base URL 和账号权限会随服务商变化。若接口不可用，请到对应平台确认最新可用配置。

### 浏览器开发模式配置

浏览器模式主要用于前后端分开调试。可在项目根目录创建 `.env`：

```env
DEEPSEEK_API_KEY=your_deepseek_api_key_here
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
PORT=3001
```

后端也支持通用环境变量：

```env
AI_PROVIDER=deepseek
AI_API_KEY=your_api_key
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash
AI_TRANSLATION_PROMPT=
```

桌面端运行时，Electron 会把 `userData/config.json` 路径传给后端，应用内设置优先于 `.env`。

## 运行命令

| 命令 | 用途 |
| --- | --- |
| `npm run electron:dev` | 构建前端并启动 Electron 桌面应用 |
| `npm run dev` | 启动 Vite 前端开发服务器 |
| `npm run build` | 构建前端 |
| `npm run lint` | 运行 ESLint |
| `npm run preview` | 预览前端构建结果 |
| `npm run dist` | 打包 Windows 桌面版 |

打包结果会输出到 `release` 目录。项目配置了 Windows 安装包和便携版目标，并使用 `build/icon.ico` 作为应用图标。

### 浏览器开发模式

如需分别启动后端和前端，可以双击或运行：

```bash
start-backend.bat
start-frontend.bat
```

后端默认监听 `http://localhost:3001`。前端通过 `VITE_API_BASE_URL` 指向翻译后端，未设置时默认使用 `http://localhost:3001`。

## 数据保存位置

Paper Reader 优先把本地数据保存在 Electron `userData` 目录，包括：

- 模型与翻译配置；
- 术语库；
- 最近打开记录；
- 上次打开的 PDF 标签页会话；
- 文献库文件夹与文献归档数据；
- 每篇 PDF 的翻译历史；
- 每篇 PDF 的笔记；
- 每篇 PDF 的 annotations；
- 默认导出目录设置。

PDF 本体不会被复制到配置目录。只有在用户主动选择“写入 PDF 本体”时，程序才会修改对应 PDF，并创建备份文件。

这些本地数据不会自动上传。翻译接口只接收用户主动划选或 OCR 得到、需要翻译的文本，以及设置中导入的术语库内容。

## 项目结构

```text
paper-reader/
├─ build/                  # 应用图标等打包资源
│  ├─ icon.ico
│  └─ icon.png
├─ electron/               # Electron 主进程和 preload
│  ├─ main.js
│  └─ preload.js
├─ server/                 # 本地 Express 翻译接口
│  └─ index.js
├─ src/                    # React 前端
│  ├─ App.jsx              # 主界面和核心交互逻辑
│  ├─ App.css              # 主样式文件
│  ├─ index.css
│  ├─ main.jsx
│  ├─ assets/
│  └─ utils/               # 历史、Markdown 导出、PDF 报告导出等工具
│     ├─ history.js
│     ├─ markdownExport.js
│     └─ pdfReportExport.js
├─ public/                 # 静态资源
├─ index.html
├─ package.json
├─ vite.config.js
├─ start-backend.bat
└─ start-frontend.bat
```

## 开发维护说明

### 技术栈

- React 19：主界面和交互状态。
- react-pdf：PDF 渲染、文本层和 annotation layer。
- tesseract.js：本地 OCR。
- Express：本地翻译接口。
- OpenAI SDK：连接 DeepSeek、OpenRouter 或 OpenAI-compatible 接口，支持文本翻译和可选的多模态图片翻译。
- Electron：桌面窗口、本地文件读写、配置持久化和打包。
- pdf-lib：PDF 高亮写入和 annotation 处理。

### 变更前检查

涉及阅读器、右侧栏、OCR、批注或文献库时，优先确认这些行为没有被破坏：

- PDF 标签页和上次会话恢复；
- 页面跳转、缩放、全屏和鼠标滚轮翻页；
- 滑词翻译和右侧结果保留；
- 翻译历史、笔记、高亮和 OCR 小便签；
- Markdown 与 PDF 报告导出；
- 文献库中的阅读进度、笔记数和批注数；
- Electron `userData` 数据读写。

### 推荐验证

```bash
npm run lint
npm run build
```

如果修改了 Electron 主进程、preload、本地文件读写、PDF annotation 或打包配置，再运行：

```bash
npm run electron:dev
npm run dist
```

## 注意事项

- 请妥善保管 API Key，不要提交到代码仓库，也不要写入 README、截图或公开说明。
- `.env`、Electron `userData` 配置文件和导出文件可能包含个人使用信息，分享前请自行检查。
- 写入 PDF 本体会修改原 PDF。程序会创建备份文件，但重要文献仍建议先自行备份。
- Paper Reader 内部的小便签标签和笔记系统不会写入 PDF 本体；写入 PDF 的是标准高亮标记。
- 如果移动或删除原 PDF，最近打开记录可能失效，软件会提示文件不存在或已移动。
- 导入数据采用合并去重策略，不会默认覆盖已有翻译历史、笔记和批注。
- Markdown 和 PDF 报告导出只整理 Paper Reader 已保存的数据，不会修改原始 PDF。
- 多模态翻译依赖所选模型是否支持图片输入；不支持图片输入的模型应保持该开关关闭，或让程序回退到本地 OCR。
- 浏览器模式不是完整桌面体验，依赖 Electron API 的本地文件读写能力会不可用或降级。
