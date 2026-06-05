import {
  getPdfDisplayName,
  getPdfExportSections,
} from './markdownExport.js'

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function stripPdfExtension(name) {
  return String(name || '').replace(/\.pdf$/i, '').trim()
}

function replaceUnsafeFileNameChars(name) {
  return String(name || '')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char))
    .join('')
}

function renderTextBlock(value) {
  const text = String(value || '').trim()
  return `<blockquote>${escapeHtml(text || '无')}</blockquote>`
}

function getReportStats(sections) {
  return sections.reduce((stats, section) => {
    stats.total += section.records.length
    stats[section.key] = section.records.length
    return stats
  }, {
    total: 0,
    'translation-history': 0,
    annotations: 0,
    notes: 0,
  })
}

function getSummaryItems(stats, sections) {
  const summaryLabels = {
    'translation-history': '翻译历史',
    annotations: '批注',
    notes: '笔记',
  }

  return sections.map((section) => ({
    key: section.key,
    label: summaryLabels[section.key] || section.title,
    value: stats[section.key] || 0,
  }))
}

function renderRecord(section, record, index) {
  return `
    <article class="record-card">
      <div class="record-head">
        <h3>第 ${index + 1} 条</h3>
        <span>页数：${escapeHtml(record.page || '未知')}</span>
      </div>
      ${section.hideOriginal ? '' : `<div class="record-block">
        <h4>原句</h4>
        ${renderTextBlock(record.original)}
      </div>`}
      <div class="record-block">
        <h4>${escapeHtml(section.bodyLabel)}</h4>
        ${renderTextBlock(record.body)}
      </div>
    </article>
  `
}

function renderSection(section) {
  return `
    <section class="report-section">
      <div class="section-title">
        <h2>${escapeHtml(section.title)}</h2>
        <span>${section.records.length} 条</span>
      </div>
      ${section.records.length
        ? section.records.map((record, index) => renderRecord(section, record, index)).join('')
        : '<p class="empty-section">无</p>'}
    </section>
  `
}

function renderDocumentReport(item, index, total, options = {}) {
  const pdf = item?.pdf || {}
  const fileName = getPdfDisplayName(pdf)
  const sections = getPdfExportSections(item, options)
  const stats = getReportStats(sections)
  const summaryItems = getSummaryItems(stats, sections)

  return `
    <article class="report-document">
      <header class="document-cover">
        <div>
          <p class="report-kicker">Paper Reader 整理报告${total > 1 ? ` · ${index + 1} / ${total}` : ''}</p>
          <h1>文件名：${escapeHtml(fileName)}</h1>
        </div>
        <div class="summary-grid">
          ${summaryItems.map((item) => `
            <div>
              <span>${item.value}</span>
              <small>${escapeHtml(item.label)}</small>
            </div>
          `).join('')}
          <div>
            <span>${stats.total}</span>
            <small>总记录</small>
          </div>
        </div>
      </header>
      ${sections.map(renderSection).join('')}
    </article>
  `
}

function buildHtmlDocument(items, options = {}) {
  const reports = (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map((item, index, allItems) => renderDocumentReport(item, index, allItems.length, options))
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Paper Reader 整理报告</title>
  <style>
    @page {
      size: A4;
      margin: 15mm 14mm 16mm;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: #1f2937;
      background: #ffffff;
      font-family: "Microsoft YaHei", "Noto Sans CJK SC", "PingFang SC", "Segoe UI", sans-serif;
      font-size: 11.5pt;
      line-height: 1.65;
    }

    .report-document + .report-document {
      break-before: page;
      page-break-before: always;
    }

    .document-cover {
      display: grid;
      gap: 18px;
      padding: 0 0 18px;
      border-bottom: 2px solid #d8e2ee;
    }

    .report-kicker {
      margin: 0 0 8px;
      color: #2f6f9f;
      font-size: 9pt;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      color: #122033;
      font-size: 22pt;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }

    .summary-grid div {
      min-height: 64px;
      padding: 10px 12px;
      border: 1px solid #dbe5ef;
      border-radius: 8px;
      background: #f7fafc;
    }

    .summary-grid span {
      display: block;
      color: #173a5e;
      font-size: 18pt;
      font-weight: 800;
      line-height: 1;
    }

    .summary-grid small {
      display: block;
      margin-top: 7px;
      color: #6b7b8f;
      font-size: 8.5pt;
    }

    .report-section {
      margin-top: 22px;
    }

    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid #e1e8f0;
    }

    h2 {
      margin: 0;
      color: #173a5e;
      font-size: 15pt;
      line-height: 1.3;
    }

    .section-title span {
      flex: 0 0 auto;
      color: #6b7b8f;
      font-size: 9pt;
    }

    .record-card {
      margin: 0 0 12px;
      padding: 12px 14px;
      border: 1px solid #dbe5ef;
      border-left: 4px solid #2f6f9f;
      border-radius: 8px;
      background: #ffffff;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .record-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }

    h3 {
      margin: 0;
      color: #122033;
      font-size: 11.5pt;
      line-height: 1.35;
    }

    .record-head span {
      flex: 0 0 auto;
      padding: 2px 8px;
      border-radius: 999px;
      color: #2f5d7f;
      background: #e9f2f8;
      font-size: 8.5pt;
      font-weight: 700;
    }

    .record-block {
      margin-top: 10px;
    }

    h4 {
      margin: 0 0 5px;
      color: #526273;
      font-size: 9pt;
      line-height: 1.3;
    }

    blockquote {
      margin: 0;
      padding: 8px 10px;
      border-left: 3px solid #9bb8d0;
      border-radius: 0 6px 6px 0;
      color: #263241;
      background: #f7fafc;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .empty-section {
      margin: 0;
      padding: 12px 14px;
      border: 1px dashed #d4dee8;
      border-radius: 8px;
      color: #77879a;
      background: #f9fbfd;
    }
  </style>
</head>
<body>
  ${reports || '<p class="empty-section">暂无可导出的报告内容</p>'}
</body>
</html>`
}

export function makeSafePdfReportFileName(name) {
  const baseName = replaceUnsafeFileNameChars(stripPdfExtension(getPdfDisplayName({ fileName: name })))
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

  return `${baseName || 'paper-reader-report'}.pdf`
}

export function buildPdfReportHtml(item, options = {}) {
  return buildHtmlDocument([item], options)
}

export function buildBatchPdfReportHtml(items = [], options = {}) {
  return buildHtmlDocument(items, options)
}
