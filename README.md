# Paper Reader

Paper Reader 是一个本地运行的 PDF 阅读和划词翻译桌面工具。它支持上传 PDF、翻页、全屏阅读、鼠标滚轮翻页、划词实时高亮，以及划词后自动调用 AI 模型翻译。

## 功能

- 上传并阅读本地 PDF 文件
- 上一页 / 下一页翻页
- 鼠标滚轮翻页
- 全屏阅读
- PDF 文本划词选择
- 自定义浅蓝色选区高亮
- 划词后自动翻译
- AI 翻译设置保存到 Electron `userData/config.json`
- 支持 DeepSeek、OpenRouter 和 OpenAI-compatible 自定义接口
- 支持自定义翻译 Prompt
- 支持导入用户术语库

## 首次使用

第一次打开软件后，请先点击顶部的“设置”，打开“AI 翻译设置”。

需要填写：

- Provider：选择 DeepSeek、OpenRouter 或 OpenAI-compatible 自定义接口
- API Key：填写对应平台提供的 API Key
- Base URL：通常会根据 Provider 自动填入，也可以手动修改
- 模型名：可以使用预设，也可以自由填写平台支持的模型 ID

保存后上传 PDF，划选英文文本，右侧面板会自动显示中文译文。

请妥善保管你的 API Key，不要把 API Key 发给别人，也不要把包含 API Key 的 `.env`、本地配置文件或截图发给别人。

## 自定义翻译 Prompt

在“设置”里的“自定义翻译 Prompt”区域，可以修改翻译提示词，用来控制翻译风格、术语保留方式和输出要求。

如果留空或恢复默认，软件会使用通用学术翻译 Prompt：

```text
你是通用学术翻译助手。请把用户提供的英文学术文本翻译成准确、自然、符合中文学术表达习惯的中文。保留必要的专业术语、英文缩写、公式、指数、上下标、单位、变量名和专有名词。遇到 10^16、10^{-6}、H_2O、CO_2 等表达时，不要改写成普通数字。不要扩写，不要总结，不要添加解释，只输出译文。
```

自定义 Prompt 会保存到 Electron `userData/config.json`。

## 术语库

在“设置”里的“术语库”区域，可以导入自己维护的术语库。翻译时，模型会优先参考术语库中的固定译法。

CSV 格式示例：

```csv
source,target
activation energy,活化能
transition state,过渡态
free energy,自由能
```

JSON 格式示例：

```json
[
  {
    "source": "activation energy",
    "target": "活化能"
  },
  {
    "source": "transition state",
    "target": "过渡态"
  }
]
```

术语库会保存到 Electron `userData/glossary.json`。可以在设置中查看前若干条术语，也可以清空术语库。

## 区域 OCR 三种模式

点击顶部工具栏的“区域 OCR”后，会先选择 OCR 模式：

### 文本模式

适合文字密集场景。框选 PDF 区域后，右侧文字栏会显示：

- 框选区域截图
- OCR 识别文本
- 翻译结果

右侧文字栏支持独立滚动，也可以拖动分隔条调整宽度。截图可以点击打开大图查看，结果会保留在右侧，直到重新翻译、重新 OCR、上传新 PDF 或点击“清空”。

### 图解模式

适合需要结合图片理解的场景，例如示意图、结构图、流程图、图表说明等。框选区域后，软件会 OCR 识别英文并翻译，然后在原截图中靠近英文的位置叠加中文翻译。翻译成功后会弹出“OCR 图解模式结果”窗口。

图解模式结果弹窗支持鼠标滚轮缩放，方便查看细节；可以点击“重置缩放”恢复默认大小。关闭弹窗后，右侧会保留结果图片预览，点击预览可以重新打开同一个结果图，不会重新 OCR 或重新翻译。

### 对照模式

适合文字密集、需要同时对照原图和译文覆盖图的场景。框选区域后，软件会生成原图和译文覆盖图，并弹出“OCR 对照模式结果”窗口。

对照模式会根据截图比例自动选择左右对照或上下对照。弹窗中原图和译文覆盖图都支持独立缩放和独立滑动。关闭弹窗后，右侧会保留对照结果入口，点击后可以重新打开同一个对照结果，不会重新 OCR 或重新翻译。

## Provider 说明

### DeepSeek

默认配置：

```text
Base URL: https://api.deepseek.com
Model: deepseek-v4-flash
```

也可以手动填写其他 DeepSeek 支持的模型名。

### OpenRouter

默认配置：

```text
Base URL: https://openrouter.ai/api/v1
Model: openrouter/auto
```

如果想使用 Claude、Gemini、GPT、Grok、Qwen 等主流模型，推荐使用 OpenRouter。模型 ID 示例：

```text
openrouter/auto
openai/gpt-5.2
google/gemini-2.5-pro
google/gemini-2.5-flash
anthropic/claude-sonnet-4.5
qwen/qwen3
deepseek/deepseek-v4-flash
```

这些只是常用示例，模型名可能会变化。如果某个模型不可用，请到 OpenRouter 或对应平台查看最新模型 ID。

### OpenAI-compatible 自定义接口

适合接入兼容 OpenAI Chat Completions 格式的服务，例如本地模型、第三方中转、OpenAI-compatible 网关等。

Base URL 和模型名都由用户自由填写。

## 开发环境准备

先安装 Node.js，然后在项目目录中安装依赖：

```bash
npm install
```

## 桌面版开发运行

```bash
npm run electron:dev
```

桌面版启动后会自动启动本地翻译后端，不需要手动运行 `node server/index.js`。

## 浏览器开发模式

如果需要在浏览器里开发调试，可以参考 `.env.example` 创建 `.env`。新配置推荐使用：

```env
AI_PROVIDER=deepseek
AI_API_KEY=your_api_key_here
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash
PORT=3001
```

旧的 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` 仍然兼容。

然后分别启动后端和前端：

```bash
start-backend.bat
start-frontend.bat
```

保持两个窗口运行，不要关闭。前端启动后，打开终端中显示的本地地址，例如：

```text
http://localhost:5173/
```

## 常见错误检查

如果翻译失败，请检查：

- API Key 是否正确
- Base URL 是否正确
- 模型 ID 是否正确
- 账号余额或权限是否支持该模型
- 所选服务是否兼容 OpenAI Chat Completions 格式
- 本地后端是否正常启动

## 打包 Windows 桌面版

运行：

```bash
npm run dist
```

打包结果会输出到 `release` 目录。通常会生成安装版和便携版：

- `Paper Reader Setup *.exe`：安装包
- `Paper Reader *.exe`：便携版

修改代码后必须重新打包，新的 exe 才会包含新功能。

把软件发给别人时，不要附带自己的 `.env` 或本机配置文件。对方第一次打开软件后，也需要在“设置”中填写他们自己的 Provider、API Key、Base URL 和模型名。

## 常用命令

```bash
npm run build
npm run lint
npm run dist
```

## 安全注意事项

- API Key 只应由使用者本人填写和保管。
- 不要提交真实 API Key 到代码仓库。
- 不要把真实 API Key 写进 README、截图、聊天记录或发布包说明中。
- 不要把 API Key 发给别人。
