import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import markedKatex from 'marked-katex-extension'
import 'katex/dist/katex.min.css'

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      return hljs.highlight(code, { language }).value
    },
  }),
)

marked.use({
  gfm: true,
  breaks: true,
})

marked.use(markedKatex({ throwOnError: false }))

/** 完整 Markdown → 安全 HTML (GFM/表格/代码高亮/KaTeX 公式/mermaid 图表)。 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string

  // ```mermaid 代码块 → 交给 mermaid.run() 处理的容器
  const withMermaid = raw.replace(
    /<pre><code class="[^"]*language-mermaid">([\s\S]*?)<\/code><\/pre>/g,
    '<div class="mermaid">$1</div>',
  )

  return DOMPurify.sanitize(withMermaid, {
    ADD_TAGS: ['math', 'annotation', 'annotation-xml'],
    ADD_ATTR: ['encoding', 'aria-hidden'],
  })
}
