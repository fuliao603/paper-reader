# Paper Reader

Paper Reader 是面向论文、教材和扫描资料的 Windows 桌面 PDF 阅读器。它把阅读、翻译、OCR、文献分类、批注和笔记放在同一个工作区，适合边读边整理资料。

当前版本：**1.1.0** · 技术栈：Electron、React、Vite · 平台：Windows x64

> PDF 阅读不需要 AI 账号。翻译、AI 目录识别及可选的多模态识别，需要用户自行配置支持相应能力的模型服务。

## 开始使用

如果已有 Windows 安装包或便携版，运行对应的 Paper Reader Setup 1.1.0.exe 或 Paper Reader 1.1.0.exe。仓库不提交打包产物；开发者可按下方命令在本地生成。

从源码启动桌面版：

~~~powershell
npm install
npm run electron:dev
~~~

需要 Node.js 和 npm。首次启动后，先导入 PDF；如需翻译，再到左侧「设置」选择 Provider、填写 API Key、选择或填写模型并保存。只在浏览器中运行 npm run dev 不是完整桌面版，文件选择、持久化、PDF 写入和系统导出可能不可用或降级。

## 能做什么

| 场景 | 功能 |
| --- | --- |
| 阅读 | 导入 PDF、多标签页、翻页、缩放、全屏、搜索、目录与阅读位置恢复 |
| 翻译 | 划词翻译；区域 OCR 的文本、图解和对照三种模式；可选多模态识别 |
| 记录 | 文献关联的翻译历史、高亮、批注、笔记、书签和目录 |
| 管理 | 多级项目文件夹、同级拖拽排序、跨级移动、未分类与回收箱 |
| 输出 | 文献与记录备份/恢复、Markdown 或 PDF 报告、文献文件导出 |

### 阅读与翻译

- 优先使用 PDF 自带的文字层；扫描页和截图可通过区域 OCR 识别。本地 Tesseract 当前只内置英语语言包，其他语言更依赖 PDF 文字层或可选的多模态模型。
- 文本模式展示识别结果和译文；图解模式在原图旁添加译文标签；对照模式生成原图与逐行译文覆盖图。整块公式或高符号密度区域会保留原图，不强行翻译。
- 行内可疑公式可尝试本地公式 OCR，并在翻译中保护公式、变量与单位。首次使用公式 OCR 可能下载模型文件。
- 当前文献的历史记录可再次查看，无需重新执行 OCR 或翻译。

### 文献与记录

- 「全部文献」汇总正常状态的文献；「未分类」收纳尚未指定文件夹的文献。普通文件夹可多级创建，同级拖拽改变顺序，右键「移动至」改变父级。
- 文献移动时保留原有翻译、笔记、批注、书签和阅读进度。历史笔记管理、备份与恢复、导出文件使用相应的分级文件夹视图。
- 数据备份文件使用 .paperreader.json；导出还支持 Markdown、PDF 报告和原始文献文件。重要数据建议定期备份。

## 配置 AI 模型

设置页提供 DeepSeek、OpenAI/GPT、Anthropic/Claude、GLM、Gemini、Qwen、Kimi、OpenRouter、SiliconFlow 和自定义 Provider。预设会填入 Base URL；输入 API Key 后可尝试读取该服务当前可用的模型列表，也可以手动输入模型 ID。能否列出或调用某个模型取决于服务商接口及账号权限。

API Key 按 Provider 分别保存在本机配置中：切换 Provider 时恢复对应 Key，切换同一 Provider 的模型不会清空它。新填写的 Key 需要保存设置，才会在重启后保留。请勿提交本机配置、.env 或含凭据的日志。

temperature 默认采用自动模式，通常不主动传递该参数；已知有特殊要求的模型会使用相应值，服务端报出明确限制时可自动重试一次。也可在设置中选择自定义 0–2。

设置页的「启用多模态翻译」决定是否向模型发送图片。图解/对照模式的新版多模态版面识别管线还需在**构建时**启用：

~~~env
VITE_ENABLE_MULTIMODAL_VISUAL_OCR=true
~~~

默认值为 false。未启用、模型不支持图片或识别失败时，仍可回退本地 OCR。调试用的 VITE_MULTIMODAL_OCR_DEBUG=true 可能输出识别文字和坐标，不建议在公开环境开启。

## 文件、隐私与备份

桌面端的文献索引、阅读位置、记录和设置保存在 Electron 的 userData 目录中；Windows 上通常位于用户的 %APPDATA% 下，具体位置由 Electron 决定。原始 PDF 仍位于导入时的路径，**文献库和数据备份不等于原 PDF 的备份**。移动、改名或删除原文件后，原路径可能失效。

持久化数据包括 config.json、文献库、浏览历史、笔记、翻译历史、批注、书签及目录等 JSON 文件。写入采用串行队列与临时文件替换；遇到可恢复的损坏 JSON 时，会留下 .corrupt-<timestamp>.bak。.paperreader.json 备份不包含 API Key，换设备恢复后需要重新配置凭据。

高亮可仅保存在 Paper Reader，也可选择写入 PDF 本体。**当前 PDF 写入实现会直接改动原文件，并未自动生成原 PDF 副本；即使界面按钮出现「创建备份」字样，也请先手动备份重要 PDF。**

只有主动使用相关 AI 功能时，请求中的文字、所选图片区域、提示词和相关术语才可能发送给配置的模型服务商。多模态图片及调试日志可能包含文献内容，请按所选服务的隐私条款使用。

## 开发与打包

~~~powershell
npm run lint          # ESLint
npm run build         # Vite 生产构建
npm run electron:dev  # 构建并启动桌面开发版
npm run dist          # Windows x64 安装包和便携版
~~~

npm run dist 输出到 release/，包含 NSIS 安装包与便携版 EXE；不会自动上传 GitHub。仓库目前没有独立的单元测试或 TypeScript 类型检查脚本。修改主进程和服务端时，可额外用 node --check 检查相应 JavaScript 文件；涉及阅读、OCR 或数据恢复的改动仍需桌面端手动验证。

浏览器调试可参考 [环境变量示例](.env.example) 配置后，在不同终端运行：

~~~powershell
node server/index.js
npm run dev
~~~

本地 AI 服务默认监听 3001 端口。浏览器模式不提供完整 Electron 能力；桌面版会自行启动该服务。

主要代码位置：

- [src/App.jsx](src/App.jsx) 与 [src/App.css](src/App.css)：界面和阅读交互。
- [electron/main.js](electron/main.js) 与 [electron/preload.js](electron/preload.js)：桌面文件操作、持久化和受限 IPC。
- [server/aiProviders.js](server/aiProviders.js) 与 [server/index.js](server/index.js)：模型适配与本地 API。
- [src/utils/](src/utils/)：历史、目录和导出工具。

## 参与开发

提交改动前请运行 npm run lint 和 npm run build，并只提交与改动有关的源码。不要提交 API Key、.env、个人文献、导出备份或 release/ 构建产物。涉及数据结构或 PDF 写入的修改，请说明迁移方式与手动验证结果。

## 许可

当前仓库没有独立的开源许可证。未经仓库所有者授权，不应假定可以复制、再发布或商用。
