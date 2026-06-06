/* global process */

import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ProviderRouter,
  getProviderErrorMessage,
  normalizeProviderConfig,
} from './aiProviders.js'

const envPath = process.env.PAPER_READER_ENV_PATH || path.resolve(process.cwd(), '.env')
const defaultTranslationPrompt =
  '你是通用学术翻译助手。请把用户提供的英文学术文本翻译成准确、自然、符合中文学术表达习惯的中文。保留必要的专业术语、英文缩写、公式、指数、上下标、单位、变量名和专有名词。遇到 10^16、10^{-6}、H_2O、CO_2 等表达时，不要改写成普通数字。不要扩写，不要总结，不要添加解释，只输出译文。'
const maxGlossaryEntries = 200
const maxGlossaryPromptLength = 8000
const maxTocRecognitionCandidates = 180
const maxTocRecognitionTextLength = 60000
const tocRecognitionPrompt = `You clean and organize pre-extracted table-of-contents candidates for academic papers, books, and textbooks.
The input is JSON with documentType and candidates. Each candidate is extracted from the PDF and includes its exact title, pageNumber, pageIndex, score, and evidence.
Return JSON only, using this exact shape:
{"documentType":"paper","items":[{"title":"Introduction","level":1,"pageNumber":3,"pageIndex":2,"confidence":0.95,"children":[{"title":"1.1 Background","level":2,"pageNumber":4,"pageIndex":3,"confidence":0.9,"children":[]}]}]}
Delete candidates that are captions, running headers, footers, page numbers, reference entries, DOI/URL/email lines, copyright text, or ordinary paragraph sentences.
Use numbering before typography for levels: 1 is level 1, 1.1 is level 2, 1.1.1 is level 3, Chapter/Part/第X章 is level 1, Section/第X节 is level 2.
Common paper headings such as Abstract, Keywords, Introduction, Methods, Results, Discussion, Conclusion, References, and Appendix are normally level 1.
Do not invent a title. Do not translate, rewrite, combine, or correct title text. Do not change pageNumber or pageIndex. Every output item must correspond to one exact input candidate.
Return strict JSON without markdown fences or commentary.`

dotenv.config({ path: envPath })

function readElectronConfig() {
  if (!process.env.PAPER_READER_CONFIG_PATH) {
    return { config: null, error: null }
  }

  try {
    if (!fs.existsSync(process.env.PAPER_READER_CONFIG_PATH)) {
      return { config: null, error: null }
    }

    const rawConfig = fs.readFileSync(process.env.PAPER_READER_CONFIG_PATH, 'utf8')
    return { config: JSON.parse(rawConfig), error: null }
  } catch (error) {
    return { config: null, error: `读取 AI 模型配置失败：${error.message}` }
  }
}

function readGlossary() {
  if (!process.env.PAPER_READER_GLOSSARY_PATH) return []

  try {
    if (!fs.existsSync(process.env.PAPER_READER_GLOSSARY_PATH)) return []

    const rawGlossary = fs.readFileSync(process.env.PAPER_READER_GLOSSARY_PATH, 'utf8')
    const glossary = JSON.parse(rawGlossary)

    if (!Array.isArray(glossary)) return []

    return glossary
      .map((entry) => ({
        source: String(entry.source || '').trim(),
        target: String(entry.target || '').trim(),
      }))
      .filter((entry) => entry.source && entry.target)
  } catch (error) {
    console.error(`读取术语库失败：${error.message}`)
    return []
  }
}

function getAiConfig() {
  const { config, error } = readElectronConfig()

  return { ...normalizeProviderConfig(config || {}, process.env), error }
}

function buildGlossaryPrompt(glossary) {
  if (!glossary.length) return ''

  const lines = [
    '',
    '以下是用户术语库。翻译时请优先使用这些固定译法：',
  ]
  let currentLength = lines.join('\n').length

  glossary.slice(0, maxGlossaryEntries).some((entry) => {
    const line = `- ${entry.source} => ${entry.target}`
    const nextLength = currentLength + line.length + 1

    if (nextLength > maxGlossaryPromptLength) return true

    lines.push(line)
    currentLength = nextLength
    return false
  })

  lines.push('如果术语库与上下文冲突，请优先保证译文准确，但尽量遵循术语库。')

  return lines.join('\n')
}

function buildSystemPrompt(config) {
  const basePrompt = config.prompt || defaultTranslationPrompt
  const glossaryPrompt = buildGlossaryPrompt(readGlossary())

  return `${basePrompt}${glossaryPrompt}`
}

function getProviderFromConfig() {
  const aiConfig = getAiConfig()

  if (aiConfig.error) throw new Error(aiConfig.error)

  return {
    config: aiConfig,
    provider: ProviderRouter.create(aiConfig),
  }
}

function getImagePayload(req) {
  const image = String(req.body?.image || '').trim()
  const mode = req.body?.mode === 'compare' ? 'compare' : 'diagram'
  const imageWidth = Number(req.body?.imageWidth) || 0
  const imageHeight = Number(req.body?.imageHeight) || 0

  if (!image) throw new Error('image cannot be empty')
  if (!imageWidth || !imageHeight) throw new Error('image size cannot be empty')

  return {
    image,
    mode,
    imageWidth,
    imageHeight,
  }
}

function sendProviderError(res, error, fallbackMessage) {
  return res.status(500).json({
    error: getProviderErrorMessage(error) || fallbackMessage,
  })
}

async function handleTranslateText(req, res) {
  const text = String(req.body?.text || '').trim()

  if (!text) {
    return res.status(400).json({ error: 'text cannot be empty' })
  }

  try {
    const { config, provider } = getProviderFromConfig()
    const result = await provider.translateText(text, {
      systemPrompt: buildSystemPrompt(config),
    })

    return res.json({
      ...result,
      provider: config.provider,
      supportsMultimodal: provider.supportsMultimodal,
    })
  } catch (error) {
    console.error('Text translation failed:', error)
    return sendProviderError(
      res,
      error,
      'Translation failed. Check API Key, Base URL, model ID, account balance, and provider permissions.',
    )
  }
}

async function handleImageTranslation(req, res, targetMode) {
  try {
    const { image, mode, imageWidth, imageHeight } = getImagePayload(req)
    const { config, provider } = getProviderFromConfig()
    const options = {
      mode: targetMode === 'diagram' ? 'diagram' : mode === 'compare' ? 'compare' : 'compare',
      imageWidth,
      imageHeight,
      systemPrompt: buildSystemPrompt(config),
    }
    const result = targetMode === 'diagram'
      ? await provider.translateImageDiagram(image, options)
      : await provider.translateImageOCR(image, options)

    return res.json({
      ...result,
      provider: config.provider,
      supportsMultimodal: provider.supportsMultimodal,
    })
  } catch (error) {
    console.error('Multimodal translation failed:', error)
    return sendProviderError(res, error, '多模态翻译失败，已回退到原 OCR 流程。')
  }
}

async function handleRecognizeToc(req, res) {
  const documentType = ['paper', 'book', 'unknown'].includes(req.body?.documentType)
    ? req.body.documentType
    : 'unknown'
  const candidates = (Array.isArray(req.body?.candidates) ? req.body.candidates : [])
    .slice(0, maxTocRecognitionCandidates)
    .map((candidate) => ({
      text: String(candidate?.text || candidate?.title || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      pageNumber: Math.max(1, Math.floor(Number(candidate?.pageNumber) || 1)),
      pageIndex: Math.max(0, Math.floor(Number(candidate?.pageIndex) || 0)),
      fontSize: Math.max(0, Number(candidate?.fontSize) || 0),
      level: Math.max(1, Math.min(3, Math.floor(Number(candidate?.level) || 1))),
      score: Number(candidate?.score) || 0,
      reasons: Array.isArray(candidate?.reasons) ? candidate.reasons.slice(0, 8).map(String) : [],
      penalties: Array.isArray(candidate?.penalties) ? candidate.penalties.slice(0, 8).map(String) : [],
    }))
    .filter((candidate) => candidate.text)
  let limitedCandidates = candidates
  let text = JSON.stringify({ documentType, candidates: limitedCandidates })
  while (text.length > maxTocRecognitionTextLength && limitedCandidates.length > 20) {
    limitedCandidates = limitedCandidates.slice(0, -10)
    text = JSON.stringify({ documentType, candidates: limitedCandidates })
  }

  if (!candidates.length) {
    return res.status(400).json({ error: 'No table-of-contents candidates are available for cleanup.' })
  }

  try {
    const { config, provider } = getProviderFromConfig()
    const result = await provider.translateText(text, {
      systemPrompt: tocRecognitionPrompt,
    })

    return res.json({
      toc: result.translation,
      provider: config.provider,
    })
  } catch (error) {
    console.error('Table of contents recognition failed:', error)
    return sendProviderError(res, error, 'Table of contents recognition failed.')
  }
}

export function createServer() {
  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '20mb' }))

  app.post('/ai/translate-text', handleTranslateText)
  app.post('/ai/translate-image-ocr', async (req, res) => handleImageTranslation(req, res, 'ocr'))
  app.post('/ai/translate-image-diagram', async (req, res) => handleImageTranslation(req, res, 'diagram'))
  app.post('/ai/recognize-toc', handleRecognizeToc)

  // Legacy renderer/browser endpoints kept for compatibility.
  app.post('/translate', handleTranslateText)
  app.post('/multimodal-translate-image', async (req, res) => {
    const targetMode = req.body?.mode === 'diagram' ? 'diagram' : 'ocr'
    return handleImageTranslation(req, res, targetMode)
  })

  return app
}

export function startServer(options = {}) {
  const port = options.port || process.env.PORT || 3001
  const app = createServer()

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Translate server is running at http://localhost:${port}`)
      resolve(server)
    })

    server.on('error', reject)
  })
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false

if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
