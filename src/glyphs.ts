import type { Node } from '@myndra/plugin-sdk'
import { isOrderedList } from './kinds'

export type AssetResolver = (name: string) => string

let resolve: AssetResolver = (name) => `/plugins/markdown-adapter/${name}`

function buildHeadingGlyphs(r: AssetResolver) {
  return new Map<number, string>([
    [1, r('format_h1.svg')],
    [2, r('format_h2.svg')],
    [3, r('format_h3.svg')],
    [4, r('format_h4.svg')],
    [5, r('format_h5.svg')],
    [6, r('format_h6.svg')],
  ])
}

function buildCodeGlyphs(r: AssetResolver) {
  const js = r('javascript.svg')
  const html = r('html.svg')
  const css = r('css.svg')
  const data = r('data_object.svg')
  const term = r('terminal.svg')
  return new Map<string, string>([
    ['javascript', js],
    ['js', js],
    ['jsx', js],
    ['mjs', js],
    ['cjs', js],
    ['typescript', js],
    ['ts', js],
    ['tsx', js],
    ['node', js],
    ['html', html],
    ['html5', html],
    ['css', css],
    ['scss', css],
    ['sass', css],
    ['less', css],
    ['json', data],
    ['jsonc', data],
    ['json5', data],
    ['yaml', data],
    ['yml', data],
    ['bash', term],
    ['sh', term],
    ['shell', term],
    ['zsh', term],
    ['fish', term],
    ['powershell', term],
    ['ps1', term],
  ])
}

function buildCalloutGlyphs(r: AssetResolver) {
  return new Map<string, string>([
    ['NOTE', r('info.svg')],
    ['INFO', r('info.svg')],
    ['TIP', r('lightbulb.svg')],
    ['IMPORTANT', r('priority_high.svg')],
    ['WARNING', r('warning.svg')],
    ['CAUTION', r('report.svg')],
    ['DANGER', r('error.svg')],
  ])
}

let _headingGlyphs: Map<number, string> | null = null
let _codeGlyphs: Map<string, string> | null = null
let _calloutGlyphs: Map<string, string> | null = null

function getHeadingGlyphsMap() {
  return (_headingGlyphs ??= buildHeadingGlyphs(resolve))
}
function getCodeGlyphsMap() {
  return (_codeGlyphs ??= buildCodeGlyphs(resolve))
}
function getCalloutGlyphsMap() {
  return (_calloutGlyphs ??= buildCalloutGlyphs(resolve))
}

export function initializeGlyphs(assetResolver: AssetResolver) {
  resolve = assetResolver
  _headingGlyphs = null
  _codeGlyphs = null
  _calloutGlyphs = null
}

export const getHeadingGlyph = (depth: number) =>
  getHeadingGlyphsMap().get(depth) ?? resolve('title.png')

export const getListGlyph = (node: Node) =>
  isOrderedList(node.text ?? '')
    ? resolve('format_list_numbered.svg')
    : resolve('format_list_bulleted.svg')

export const getTaskListGlyph = (node: Node): string | null => {
  const firstLine = (node.text ?? '').split('\n')[0] ?? ''
  const match = firstLine.match(/^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s*/)
  if (!match) return null
  return match[1].toLowerCase() === 'x'
    ? resolve('check_box.svg')
    : resolve('check_box_outline_blank.svg')
}

const normalizeCodeLang = (lang: string | undefined) => {
  if (!lang) return null
  const cleaned = lang
    .trim()
    .toLowerCase()
    .replace(/^[{.]+/, '')
    .replace(/[}]+$/, '')
  const withoutPrefix = cleaned.startsWith('language-')
    ? cleaned.slice('language-'.length)
    : cleaned
  return withoutPrefix || null
}

export const getCodeGlyph = (lang: string | undefined): string | null => {
  const normalized = normalizeCodeLang(lang)
  if (!normalized) return null
  return getCodeGlyphsMap().get(normalized) ?? null
}

export const getBlockquoteGlyph = (node: Node): string | null => {
  const text = node.text ?? ''
  const firstLine = text.split('\n')[0] ?? ''
  const cleaned = firstLine.replace(/^\s*>+\s?/, '')
  const match = cleaned.match(/\[\!([A-Za-z]+)\]/)
  if (!match) return null
  const callout = match[1].toUpperCase()
  return getCalloutGlyphsMap().get(callout) ?? null
}

export const getTagGlyph = () => resolve('segment.png')
