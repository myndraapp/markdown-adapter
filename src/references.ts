import { MyndlinkAttributesSchema } from '@myndra/plugin-sdk/schemas'
import type { GraphAPI, IndexedFile, PluginContext } from '@myndra/plugin-sdk'
import {
  MD_KINDS,
  MD_TAG_KIND,
  MD_WIKILINK_KIND,
  buildMdNodeAttributes,
  isMarkdownFileNode,
  normalizeWhitespace,
  referenceEdgeDefaults,
} from './kinds'
import { getTagGlyph, getWikiLinkGlyph } from './glyphs'

const TAG_PATTERN = /#[0-9]*[A-Za-z_/-][A-Za-z0-9_/-]*/g
const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

const stripInlineCode = (value: string) => value.replace(/`[^`]*`/g, ' ')
const stripFencedCode = (value: string) =>
  value.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ')
const stripMarkdownCode = (value: string) => stripInlineCode(stripFencedCode(value))

const normalizeTag = (value: string) => value.slice(1).trim().toLowerCase()

export const normalizeWikiTarget = (value: string) => normalizeWhitespace(value).replace(/\\/g, '/')

const stripWikiAlias = (value: string) => value.split('|', 2)[0] ?? value

const normalizeIndexPath = (value: string) => normalizeWikiTarget(value).replace(/^\/+/, '')

const stripMarkdownExtension = (value: string) => value.replace(/\.(markdown|md)$/i, '')

const dirname = (value: string) => {
  const index = value.lastIndexOf('/')
  return index >= 0 ? value.slice(0, index) : ''
}

const splitWikiTarget = (value: string) => {
  const normalized = normalizeWikiTarget(stripWikiAlias(value))
  const [pathPart, headingPart] = normalized.split('#', 2)
  return {
    path: pathPart.trim(),
    heading: headingPart ? normalizeWhitespace(headingPart) : null,
  }
}

const normalizeHeadingLabel = (value: string) =>
  normalizeWhitespace(value.replace(/^\s*#+\s*/, '').replace(/\s*#+\s*$/, '')).toLowerCase()

export type MarkdownFileIndexEntry = {
  key: string
  path: string
  pathNoExtLower: string
  dirLower: string
  stemLower: string
}

const createMarkdownFileIndexEntry = (key: string, path: string): MarkdownFileIndexEntry => {
  const normalizedPath = normalizeIndexPath(path)
  const pathLower = normalizedPath.toLowerCase()
  const pathNoExtLower = stripMarkdownExtension(pathLower)
  const stemLower = pathNoExtLower.split('/').pop() ?? pathNoExtLower
  return {
    key,
    path: normalizedPath,
    pathNoExtLower,
    dirLower: dirname(pathNoExtLower),
    stemLower,
  }
}

export const buildMarkdownFileIndexFromFiles = (
  files: readonly IndexedFile[],
): MarkdownFileIndexEntry[] =>
  files
    .filter((file) => Boolean(file.path) && isMarkdownFileNode(file.attributes))
    .map((file) => createMarkdownFileIndexEntry(file.nodeKey, file.path))

export const buildMarkdownFileIndex = (
  ctx: PluginContext,
  files?: readonly IndexedFile[],
): MarkdownFileIndexEntry[] => {
  const entriesByKey = new Map<string, MarkdownFileIndexEntry>()

  ctx.graph
    .findNodes(({ attributes }) => Boolean(attributes.path) && isMarkdownFileNode(attributes))
    .forEach((node) => {
      entriesByKey.set(node.key, createMarkdownFileIndexEntry(node.key, node.attributes.path ?? ''))
    })

  if (files) {
    buildMarkdownFileIndexFromFiles(files).forEach((entry) => {
      entriesByKey.set(entry.key, entry)
    })
  }

  return Array.from(entriesByKey.values())
}

const findHeadingNode = (graph: GraphAPI, fileKey: string, heading: string): string | null => {
  const target = normalizeHeadingLabel(heading)
  if (!target) return null
  const stack = [...graph.getChildren(fileKey)]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const key = stack.pop()
    if (!key || visited.has(key)) continue
    visited.add(key)
    const node = graph.getNode(key)
    if (!node) continue
    if (node.attributes.kind === MD_KINDS.HEADING) {
      const label = typeof node.attributes.label === 'string' ? node.attributes.label : ''
      if (normalizeHeadingLabel(label) === target) return key
    }
    stack.push(...graph.getChildren(key))
  }
  return null
}

const uniqueMatch = (
  entries: readonly MarkdownFileIndexEntry[],
  predicate: (entry: MarkdownFileIndexEntry) => boolean,
): MarkdownFileIndexEntry | null => {
  const byKey = new Map<string, MarkdownFileIndexEntry>()
  for (const entry of entries) {
    if (predicate(entry)) byKey.set(entry.key, entry)
  }
  return byKey.size === 1 ? Array.from(byKey.values())[0] : null
}

const resolveWikiFileTarget = (
  fileIndex: readonly MarkdownFileIndexEntry[],
  sourceFileKey: string,
  rawPath: string,
): string | null => {
  const targetLower = normalizeIndexPath(rawPath).toLowerCase()
  const targetNoExtLower = stripMarkdownExtension(targetLower)
  const isPathLike = targetLower.includes('/')
  const sourceEntry = fileIndex.find((entry) => entry.key === sourceFileKey)
  const sourceDirLower = sourceEntry?.dirLower ?? ''

  if (isPathLike) {
    const sourceRelativeCandidate = sourceDirLower
      ? `${sourceDirLower}/${targetNoExtLower}`
      : targetNoExtLower

    const match =
      uniqueMatch(fileIndex, (entry) => entry.pathNoExtLower === sourceRelativeCandidate) ??
      uniqueMatch(fileIndex, (entry) => entry.pathNoExtLower === targetNoExtLower) ??
      uniqueMatch(
        fileIndex,
        (entry) =>
          entry.pathNoExtLower === targetNoExtLower ||
          entry.pathNoExtLower.endsWith(`/${targetNoExtLower}`),
      )

    return match?.key ?? null
  }

  const match =
    uniqueMatch(
      fileIndex,
      (entry) => entry.dirLower === sourceDirLower && entry.stemLower === targetNoExtLower,
    ) ?? uniqueMatch(fileIndex, (entry) => entry.stemLower === targetNoExtLower)

  return match?.key ?? null
}

export const resolveWikiLinkTarget = (
  graph: GraphAPI,
  fileIndex: readonly MarkdownFileIndexEntry[],
  sourceFileKey: string,
  rawTarget: string,
): string | null => {
  const { path, heading } = splitWikiTarget(rawTarget)
  const resolvedKey = path ? resolveWikiFileTarget(fileIndex, sourceFileKey, path) : sourceFileKey

  if (!resolvedKey) return null
  if (heading) return findHeadingNode(graph, resolvedKey, heading)
  return resolvedKey
}

export const extractMarkdownReferences = (content: string) => {
  const sanitized = stripMarkdownCode(content)
  const wikiTargets = Array.from(
    sanitized.matchAll(new RegExp(WIKI_LINK_PATTERN.source, WIKI_LINK_PATTERN.flags)),
  )
    .map((match) => match[1])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeWikiTarget(value))
    .filter((value) => value.length > 0)

  const sanitizedWithoutWiki = sanitized.replace(WIKI_LINK_PATTERN, ' ')
  const tags = Array.from(
    sanitizedWithoutWiki.matchAll(new RegExp(TAG_PATTERN.source, TAG_PATTERN.flags)),
  )
    .map((match) => match[0])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeTag(value))
    .filter((value) => value.length > 0)

  return {
    tags: Array.from(new Set(tags)),
    wikiTargets: Array.from(new Set(wikiTargets)),
  }
}

export type MarkdownReferenceData = {
  tags: string[]
  wikiTargets: string[]
}

const hasReferenceEdge = (graph: GraphAPI, sourceKey: string, targetKey: string) =>
  graph
    .getNodeEdges(sourceKey)
    .some(
      (edge) =>
        edge.attributes.kind === 'reference' &&
        ((edge.source === sourceKey && edge.target === targetKey) ||
          (edge.source === targetKey && edge.target === sourceKey)),
    )

export const addReferenceEdge = (
  graph: GraphAPI,
  sourceKey: string,
  targetKey: string,
): string | null => {
  if (hasReferenceEdge(graph, sourceKey, targetKey)) return null
  return graph.durable.addReferenceLink(
    sourceKey,
    targetKey,
    MyndlinkAttributesSchema.parse({ ...referenceEdgeDefaults, direction: 'outgoing' }),
  )
}

export const ensureTagNode = (graph: GraphAPI, tagName: string): string =>
  graph.durable.addNode(
    buildMdNodeAttributes(
      {
        kind: MD_TAG_KIND,
        label: `#${tagName}`,
        image: getTagGlyph(),
      },
      { stableId: `md:tag:${tagName}`, tagName },
    ),
  )

export const ensureWikiLinkNode = (graph: GraphAPI, rawTarget: string): string => {
  const normalizedTarget = normalizeWikiTarget(stripWikiAlias(rawTarget))
  return graph.durable.addNode(
    buildMdNodeAttributes(
      {
        kind: MD_WIKILINK_KIND,
        label: `[[${normalizedTarget}]]`,
        image: getWikiLinkGlyph(),
      },
      {
        stableId: `md:wikilink:${normalizedTarget.toLowerCase()}`,
        wikiTarget: normalizedTarget,
      },
    ),
  )
}
