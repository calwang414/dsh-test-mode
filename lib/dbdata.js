/**
 * 数据库参考数据(dbdata):用户从数据库导出的表结构与测试数据,放在
 * test-mode/dbdata/ 固定目录,供智能体生成 mock 数据 / 断言时参考。
 *
 * 目录约定:
 * - `schema.md`(可选):表结构说明(字段/类型/说明,用户导出或手写);
 * - `<表名>.csv` / `<表名>.md` / `<表名>.xlsx`:测试数据,每种表一个文件;
 *   CSV/MD 第一行为表头;XLSX 每个 sheet 视为一张表(第一行为表头)。
 *
 * 不直连数据库:无驱动/凭据/网络问题,数据准确与否由用户在导出时保证。
 * @module @calwang414/dsh-test-mode/dbdata
 */

import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

/** 解析 CSV 文本(支持引号包裹的逗号/换行/双引号转义)。@returns { columns, rows }。 */
export function parseCsvText(text) {
  const lines = splitCsvLines(text)
  const rows = lines.map((line) => parseCsvRow(line)).filter((row) => row.some((cell) => cell !== ''))
  if (rows.length === 0) return { columns: [], rows: [] }
  const [header, ...data] = rows
  return { columns: header, rows: data }
}

/** 按非引号内换行切分 CSV 行。 */
function splitCsvLines(text) {
  const out = []
  let current = ''
  let inQuotes = false
  for (const ch of String(text)) {
    if (ch === '"') inQuotes = !inQuotes
    if (ch === '\n' && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim() !== '' || out.length === 0) out.push(current)
  return out
}

/** 解析一行 CSV(引号包裹、双引号转义)。 */
function parseCsvRow(line) {
  const cells = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/** 解析 Markdown 表格(第一行为表头,第二行分隔线,其余为数据)。 */
export function parseMdTableText(text) {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean)
  const tableLines = lines.filter((line) => line.startsWith('|') && line.endsWith('|'))
  if (tableLines.length === 0) return null
  const parseRow = (line) => line.slice(1, -1).split('|').map((cell) => cell.trim())
  const header = parseRow(tableLines[0])
  const body = tableLines.slice(1).filter((line) => !/^\|[\s\-:|]+\|$/.test(line)).map(parseRow)
  return { columns: header, rows: body }
}

/**
 * 解析 XLSX 缓冲区:每个 sheet 一张表,第一行为表头。
 * 驱动(xlsx)为动态加载,缺失时抛错。
 * @param buffer - xlsx 文件内容。
 * @returns { name, columns, rows } 数组。
 */
export async function parseXlsxBuffer(buffer) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const tables = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    if (matrix.length === 0) continue
    const [header, ...rows] = matrix
    tables.push({ name: sheetName, columns: header.map(String), rows })
  }
  return tables
}

/**
 * 扫描 test-mode/dbdata/ 目录,解析全部数据参考表。
 * 解析失败的单文件跳过;同名多格式按目录顺序取第一个。
 * @param root - test-mode 根目录。
 * @returns { tables, schemaText }。
 */
export async function loadDbDataTables(root) {
  const dir = join(root, 'dbdata')
  const files = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const tables = []
  const seenFiles = new Set()
  for (const file of files) {
    if (!file.isFile()) continue
    const ext = extname(file.name).toLowerCase()
    if (ext !== '.csv' && ext !== '.md' && ext !== '.xlsx') continue
    if (seenFiles.has(file.name)) continue
    seenFiles.add(file.name)
    const full = join(dir, file.name)
    try {
      if (ext === '.csv') {
        const { columns, rows } = parseCsvText(await readFile(full, 'utf8'))
        if (columns.length > 0) {
          tables.push({ name: file.name.slice(0, -4), format: 'csv', columns, rowCount: rows.length, sample: rows.slice(0, 3) })
        }
      } else if (ext === '.md') {
        const parsed = parseMdTableText(await readFile(full, 'utf8'))
        if (parsed && parsed.columns.length > 0) {
          tables.push({ name: file.name.slice(0, -3), format: 'md', columns: parsed.columns, rowCount: parsed.rows.length, sample: parsed.rows.slice(0, 3) })
        }
      } else if (ext === '.xlsx') {
        const parsed = await parseXlsxBuffer(await readFile(full))
        for (const table of parsed) {
          if (table.columns.length > 0) {
            tables.push({ name: table.name, format: 'xlsx', columns: table.columns, rowCount: table.rows.length, sample: table.rows.slice(0, 3) })
          }
        }
      }
    } catch {
      // 单文件解析失败(格式损坏/驱动缺失)跳过,不影响其他表。
    }
  }
  const schemaText = await readFile(join(dir, 'schema.md'), 'utf8').catch(() => '')
  return { tables, schemaText }
}
