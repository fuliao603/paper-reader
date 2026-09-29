import { ArrowUpRight, BookOpen, FilePlus2, ScanLine, NotebookPen } from 'lucide-react'

function ReadingWelcome({ onOpenPdf }) {
  return (
    <section className="empty-state reading-welcome">
      <div className="reading-welcome-content">
        <span className="workspace-eyebrow">YOUR RESEARCH, IN FOCUS</span>
        <h1>从一篇文献，<br />开始新的探索<span>。</span></h1>
        <p>阅读、理解、记录。让每一个想法都有迹可循。</p>
        <button type="button" className="welcome-open-button" onClick={onOpenPdf}>
          <FilePlus2 size={18} strokeWidth={1.7} />
          <span>打开 PDF 文献</span>
          <span className="welcome-open-arrow"><ArrowUpRight size={17} /></span>
        </button>
        <div className="welcome-capabilities" aria-label="阅读工具">
          <span><BookOpen size={15} />沉浸阅读</span>
          <span><ScanLine size={15} />划词与 OCR 翻译</span>
          <span><NotebookPen size={15} />批注与笔记</span>
        </div>
      </div>
      <div className="welcome-paper-composition" aria-hidden="true">
        <div className="welcome-paper welcome-paper-back" />
        <div className="welcome-paper welcome-paper-front">
          <div className="welcome-paper-topline"><span>FIELD NOTES</span><span>01 /</span></div>
          <div className="welcome-paper-title">A space<br />for discovery.</div>
          <div className="welcome-paper-rule" />
          <div className="welcome-paper-lines"><i /><i /><i /><i /><i /></div>
          <div className="welcome-paper-quote">Read. Reflect.<br />Make connections.</div>
          <div className="welcome-paper-bottom"><span>PAPER READER</span><BookOpen size={19} strokeWidth={1.3} /></div>
        </div>
        <span className="welcome-paper-caption">A quieter place for deeper thinking.</span>
      </div>
    </section>
  )
}

export default ReadingWelcome
