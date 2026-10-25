import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { renderMarkdown } from '@/lib/markdown'

interface MarkdownProps {
  text: string
  /** 是否允许渲染 mermaid (流结束后再画图, 避免半截语法) */
  mermaidEnabled?: boolean
}

let mermaidInstance: typeof import('mermaid').default | null = null

async function loadMermaid() {
  if (!mermaidInstance) {
    const mod = await import('mermaid')
    mermaidInstance = mod.default
    const isLight = document.documentElement.getAttribute('data-theme') === 'light'
    mermaidInstance.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: isLight ? 'default' : 'dark',
      fontFamily: 'inherit',
    })
  }
  return mermaidInstance
}

export function Markdown({ text, mermaidEnabled = true }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const ref = useRef<HTMLDivElement>(null)
  const [modalData, setModalData] = useState<{ svg: string; code: string } | null>(null)

  useEffect(() => {
    // 1. 为所有常规代码块 (<pre>) 挂载复制按钮
    const preNodes = ref.current?.querySelectorAll<HTMLElement>(
      'pre:not([data-copy-enabled])',
    )
    if (preNodes) {
      for (const pre of preNodes) {
        pre.setAttribute('data-copy-enabled', 'true')
        const codeElem = pre.querySelector('code')
        const rawCode = codeElem?.textContent || pre.textContent || ''
        if (rawCode.trim()) {
          addCopyButton(pre, rawCode.trim(), '复制代码')
        }
      }
    }

    // 2. 为所有 Mermaid 图表进行渲染并挂载「放大」与「复制」按钮
    if (!mermaidEnabled) return
    const nodes = ref.current?.querySelectorAll<HTMLElement>(
      '.mermaid:not([data-processed])',
    )
    if (!nodes || nodes.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        const mermaid = await loadMermaid()
        if (cancelled) return

        for (const node of nodes) {
          if (cancelled) return
          node.setAttribute('data-processed', 'true')
          const rawCode = node.textContent?.trim() || ''
          if (!rawCode) continue

          const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`
          try {
            const { svg } = await mermaid.render(id, rawCode)
            if (cancelled) return
            node.innerHTML = svg
            node.classList.add('mermaid-rendered')
            addMermaidActions(node, rawCode, svg, () => {
              setModalData({ svg, code: rawCode })
            })
          } catch (err) {
            console.warn('mermaid.render error:', err)
            node.dataset.processed = 'error'
            node.classList.add('mermaid-error')
            addMermaidActions(node, rawCode, '', () => {
              setModalData({ svg: `<pre class="text-xs text-muted-foreground p-4">${rawCode}</pre>`, code: rawCode })
            })
          }
        }
      } catch (err) {
        console.error('Failed to load mermaid:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [html, mermaidEnabled])

  return (
    <>
      <div
        ref={ref}
        className="markdown"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {modalData &&
        createPortal(
          <MermaidModal
            svg={modalData.svg}
            code={modalData.code}
            onClose={() => setModalData(null)}
          />,
          document.body,
        )}
    </>
  )
}

function addCopyButton(node: HTMLElement, code: string, label: string = '复制') {
  if (!code || node.querySelector('.code-copy-btn, .mermaid-copy-btn')) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'code-copy-btn'
  btn.title = label
  btn.setAttribute('aria-label', label)
  btn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
  `
  btn.onclick = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(code)
      btn.classList.add('copied')
      btn.title = '已复制！'
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"/>
        </svg>
      `
      setTimeout(() => {
        btn.classList.remove('copied')
        btn.title = label
        btn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
        `
      }, 1500)
    } catch {
      /* ignore */
    }
  }
  node.appendChild(btn)
}

function addMermaidActions(
  node: HTMLElement,
  code: string,
  _svg: string,
  onZoom: () => void,
) {
  if (node.querySelector('.mermaid-actions')) return

  const actions = document.createElement('div')
  actions.className = 'mermaid-actions'

  // 1. 放大查看按钮
  const zoomBtn = document.createElement('button')
  zoomBtn.type = 'button'
  zoomBtn.className = 'mermaid-action-btn'
  zoomBtn.title = '放大查看流程图'
  zoomBtn.setAttribute('aria-label', '放大查看流程图')
  zoomBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="15 3 21 3 21 9"/>
      <polyline points="9 21 3 21 3 15"/>
      <line x1="21" x2="14" y1="3" y2="10"/>
      <line x1="3" x2="10" y1="21" y2="14"/>
    </svg>
  `
  zoomBtn.onclick = (e) => {
    e.stopPropagation()
    onZoom()
  }

  // 2. 复制代码按钮
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'mermaid-action-btn'
  copyBtn.title = '复制流程图源码'
  copyBtn.setAttribute('aria-label', '复制流程图源码')
  copyBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
  `
  copyBtn.onclick = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(code)
      copyBtn.classList.add('copied')
      copyBtn.title = '已复制！'
      copyBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"/>
        </svg>
      `
      setTimeout(() => {
        copyBtn.classList.remove('copied')
        copyBtn.title = '复制流程图源码'
        copyBtn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
        `
      }, 1500)
    } catch {
      /* ignore */
    }
  }

  actions.appendChild(zoomBtn)
  actions.appendChild(copyBtn)
  node.appendChild(actions)
}

function cleanModalSvg(rawSvg: string): string {
  // 移除 Mermaid 在 svg 标签上内嵌的 max-width 限制，使其能够自适应卡片缩放
  return rawSvg.replace(/max-width:\s*[^;"]+;?/gi, '')
}

function MermaidModal({
  svg,
  code,
  onClose,
}: {
  svg: string
  code: string
  onClose: () => void
}) {
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const [copied, setCopied] = useState(false)

  // 解析 viewBox 获取图表原始比例尺寸
  const vbMatch = svg.match(/viewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.-]+)\s+([\d.-]+)\s*["']/i)
  const vbWidth = vbMatch ? parseFloat(vbMatch[1]) : 600
  const vbHeight = vbMatch ? parseFloat(vbMatch[2]) : 400

  // 监听键盘快捷键：ESC 关闭，+/- 缩放，0 重置
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === '+' || e.key === '=') setScale((s) => Math.min(s + 0.2, 4))
      else if (e.key === '-' || e.key === '_') setScale((s) => Math.max(s - 0.2, 0.3))
      else if (e.key === '0') {
        setScale(1)
        setPos({ x: 0, y: 0 })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.15 : 0.15
    setScale((s) => Math.min(Math.max(s + delta, 0.3), 4))
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    setIsDragging(true)
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    setPos({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    })
  }

  const handleMouseUp = () => setIsDragging(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  const handleDownloadSvg = () => {
    try {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `mermaid-diagram-${Date.now()}.svg`
      a.click()
      URL.revokeObjectURL(url)
    } catch {}
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-md animate-in fade-in duration-200 select-none"
      onClick={onClose}
    >
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between border-b border-border/60 bg-card/90 px-5 py-3 backdrop-blur-xl shadow-sm z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-foreground">流程图全屏画板</span>
          <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <span className="text-[11px] text-muted-foreground/80 font-mono hidden sm:inline">
            ({Math.round(vbWidth)} × {Math.round(vbHeight)})
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(s - 0.2, 0.3))}
            className="flex size-8 items-center justify-center rounded-lg border border-border bg-secondary/80 text-sm font-semibold text-foreground transition hover:bg-muted active:scale-95 cursor-pointer"
            title="缩小 (-)"
          >
            -
          </button>
          <button
            type="button"
            onClick={() => {
              setScale(1)
              setPos({ x: 0, y: 0 })
            }}
            className="flex h-8 items-center justify-center rounded-lg border border-border bg-secondary/80 px-3 font-mono text-xs text-foreground transition hover:bg-muted active:scale-95 cursor-pointer"
            title="重置缩放 (0)"
          >
            100%
          </button>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(s + 0.2, 4))}
            className="flex size-8 items-center justify-center rounded-lg border border-border bg-secondary/80 text-sm font-semibold text-foreground transition hover:bg-muted active:scale-95 cursor-pointer"
            title="放大 (+)"
          >
            +
          </button>

          <div className="mx-1 h-4 w-px bg-border" />

          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-3 text-xs text-foreground transition hover:bg-muted active:scale-95 cursor-pointer"
            title="复制代码"
          >
            {copied ? '已复制！' : '复制代码'}
          </button>

          <button
            type="button"
            onClick={handleDownloadSvg}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-3 text-xs text-foreground transition hover:bg-muted active:scale-95 cursor-pointer"
            title="下载 SVG 矢量图"
          >
            导出 SVG
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg border border-border bg-secondary/80 text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive active:scale-95 ml-2 cursor-pointer"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 画布拖拽视窗 */}
      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing p-6"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: isDragging ? 'none' : 'transform 0.12s ease-out',
            width: `${Math.min(Math.max(vbWidth * 1.25, 520), typeof window !== 'undefined' ? window.innerWidth * 0.9 : 800)}px`,
          }}
          className="mermaid-modal-card rounded-2xl border border-border bg-card p-6 md:p-8 shadow-2xl flex items-center justify-center max-w-[95vw] max-h-[85vh] overflow-visible select-text cursor-default shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="mermaid-modal-svg w-full flex items-center justify-center [&>svg]:block [&>svg]:w-full [&>svg]:h-auto [&>svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: cleanModalSvg(svg) }}
          />
        </div>

        <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card/80 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur-md shadow-lg">
          🖱️ 鼠标滚轮缩放 · 拖拽平移 · ESC 退出
        </div>
      </div>
    </div>
  )
}
