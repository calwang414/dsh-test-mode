/**
 * 旧报告裁剪 CLI:由 `reports.js` 以子进程方式调用(大堆),避免在宿主进程里
 * 解析数百 MB 的旧报告 JSON。
 *
 * 用法:node --max-old-space-size=8192 lib/report-trim.js <输入报告> <输出缓存>
 * @module @calwang414/dsh-test-mode/report-trim
 */

import { readFile, writeFile } from 'node:fs/promises'
import { compactReport } from './reports.js'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  console.error('usage: node report-trim.js <input> <output>')
  process.exit(2)
}

const record = JSON.parse(await readFile(inputPath, 'utf8'))
const stored = compactReport(record)
const serialized = JSON.stringify(stored)
await writeFile(outputPath, serialized)
console.log(JSON.stringify({ input: inputPath, output: outputPath, bytes: serialized.length }))
