import { JSDOM } from 'jsdom'
import { createServer } from 'vite'

// dompurify 在模块加载时绑定 window, 必须先注入 jsdom
const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
})

const { renderMarkdown } = await server.ssrLoadModule('/src/lib/markdown.ts')

const samples = {
  'GFM表格+列表': `# 标题\n\n**粗体** *斜体* ~~删除线~~\n\n- 项目 A\n- 项目 B\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |`,
  '代码高亮': '```python\ndef hello():\n    print("hi")\n```',
  mermaid: '```mermaid\ngraph TD\n    A[开始] --> B{判断}\n    B -->|是| C[结束]\n```',
  '行内公式': '质能方程 $E = mc^2$ 很重要',
  '块级公式': '$$\n\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}\n$$',
  XSS: `<script>alert(1)</script>\n\n[点我](javascript:alert(1))\n\n<img src=x onerror=alert(2)>`,
}

let failed = false
for (const [name, src] of Object.entries(samples)) {
  try {
    const html = renderMarkdown(src)
    console.log(`\n=== ${name} ===`)
    console.log(html.length > 600 ? html.slice(0, 600) + ' …' : html)
    if (name === 'mermaid' && !html.includes('class="mermaid"')) {
      console.log('!! mermaid 容器未生成')
      failed = true
    }
    if (name === 'XSS') {
      const bad = ['<script', 'onerror', 'javascript:']
      const leaked = bad.filter((b) => html.includes(b))
      if (leaked.length) {
        console.log('!! XSS 未过滤:', leaked)
        failed = true
      }
    }
    if (name === '代码高亮' && !html.includes('hljs-')) {
      console.log('!! 无高亮 token')
      failed = true
    }
    if (name.includes('公式') && !html.includes('katex')) {
      console.log('!! katex 未渲染')
      failed = true
    }
  } catch (err) {
    console.log(`\n=== ${name} === 抛错:`, err)
    failed = true
  }
}

await server.close()
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
process.exit(failed ? 1 : 0)
