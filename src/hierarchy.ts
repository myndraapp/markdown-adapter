import type { MyndletAttributes, FilePosition } from '@myndra/plugin-sdk/schemas'
import type { PluginContext } from '@myndra/plugin-sdk'
import {
  MD_KINDS,
  ALL_MD_KINDS,
  withMdExt,
  isMarkdownFileNode,
  collectSubtreeKeys,
  getMarkdownExtension,
  buildLineStarts,
  createFilePosition,
  MARKDOWN_ADAPTER_ID,
} from './kinds'
import { getHeadingGlyph } from './glyphs'
import {
  findMarkdownFileRoot,
  buildHeadingRanges,
  clampHeadingLevel,
  rewriteHeadingSection,
  type HeadingRange,
} from './treeParser'

export { MARKDOWN_ADAPTER_ID }

const MD_SUPPORTED_PARENT_KINDS = [...ALL_MD_KINDS, 'file'] as const

type StructureMoveContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  currentParentKey: string | null
  newParentKey: string
  newParentAttributes: MyndletAttributes
}

type StructureDeleteContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  parentKey: string | null
}

type StructureRenameContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  currentName: string
  newName: string
}

export const createMarkdownAdapter = (ctx: PluginContext) => ({
  id: 'markdown-adapter',
  name: 'Markdown File Adapter',
  supportedChildKinds: ALL_MD_KINDS,
  supportedParentKinds: MD_SUPPORTED_PARENT_KINDS,

  matches(childKind: string | undefined, parentKind: string | undefined) {
    const childMatch = !childKind || ALL_MD_KINDS.includes(childKind)
    const parentMatch = !parentKind || MD_SUPPORTED_PARENT_KINDS.includes(parentKind)
    return childMatch && parentMatch
  },

  validateMove({ nodeAttributes, newParentAttributes }: StructureMoveContext) {
    if (!ALL_MD_KINDS.includes(nodeAttributes.kind)) {
      return { valid: false, reason: 'Not a markdown node' }
    }
    if (nodeAttributes.kind === MD_KINDS.HEADING) {
      if (newParentAttributes.kind === 'file') {
        return isMarkdownFileNode(newParentAttributes)
          ? { valid: true }
          : { valid: false, reason: 'Target file is not markdown' }
      }
      if (newParentAttributes.kind !== MD_KINDS.HEADING) {
        return { valid: false, reason: 'Sections can only be nested under headings' }
      }
      return { valid: true }
    }
    if (newParentAttributes.kind === 'file') {
      return isMarkdownFileNode(newParentAttributes)
        ? { valid: true }
        : { valid: false, reason: 'Target file is not markdown' }
    }
    return ALL_MD_KINDS.includes(newParentAttributes.kind)
      ? { valid: true }
      : { valid: false, reason: 'Invalid markdown parent' }
  },

  async applyMove({ nodeKey, newParentKey, currentParentKey }: StructureMoveContext) {
    const node = ctx.graph.getNode(nodeKey)
    const newParent = ctx.graph.getNode(newParentKey)
    if (!node || !newParent) {
      return { success: false, error: 'Node not found for move' }
    }
    if (!ALL_MD_KINDS.includes(node.attributes.kind)) {
      return { success: false, error: 'Not a markdown node' }
    }
    if (newParent.attributes.kind === 'file') {
      if (!isMarkdownFileNode(newParent.attributes)) {
        return { success: false, error: 'Target file is not markdown' }
      }
    } else if (!ALL_MD_KINDS.includes(newParent.attributes.kind)) {
      return { success: false, error: 'Invalid markdown parent for move' }
    }

    if (
      node.attributes.kind === MD_KINDS.HEADING &&
      newParent.attributes.kind !== MD_KINDS.HEADING &&
      newParent.attributes.kind !== 'file'
    ) {
      return { success: false, error: 'Sections can only be nested under headings' }
    }
    const currentParent = currentParentKey != null ? ctx.graph.getNode(currentParentKey) : null
    if (
      node.attributes.kind === MD_KINDS.HEADING &&
      currentParent &&
      currentParent.attributes.kind !== MD_KINDS.HEADING &&
      currentParent.attributes.kind !== 'file'
    ) {
      return { success: false, error: 'Sections inside lists or blockquotes cannot be moved yet' }
    }

    const rootFile = findMarkdownFileRoot(ctx, nodeKey)
    if (!rootFile?.attributes.path) {
      return { success: false, error: 'Could not find markdown file root' }
    }
    const targetRoot = findMarkdownFileRoot(ctx, newParentKey)
    if (!targetRoot || targetRoot.key !== rootFile.key) {
      return { success: false, error: 'Sections can only be moved within the same file' }
    }

    const subtreeKeys = new Set(collectSubtreeKeys(ctx.graph, nodeKey))
    if (subtreeKeys.has(newParentKey)) {
      return { success: false, error: 'Cannot move a section into its own subtree' }
    }

    try {
      const content = await ctx.files.readFile(rootFile.attributes.path)
      const filePosition = node.attributes.filePosition
      if (!filePosition) {
        return { success: false, error: 'Node is missing a file position' }
      }

      const needsHeadingRanges =
        node.attributes.kind === MD_KINDS.HEADING || newParent.attributes.kind === MD_KINDS.HEADING

      let headingRanges: HeadingRange[] | null = null

      if (needsHeadingRanges) {
        const extension = getMarkdownExtension(rootFile.attributes.path)
        if (!ctx.treeSitter.hasGrammar(extension)) {
          return { success: false, error: `Markdown grammar not loaded for ${extension}` }
        }
        const tree = await ctx.treeSitter.parse(content, extension)
        if (!tree) {
          return { success: false, error: 'Failed to parse Markdown' }
        }
        headingRanges = buildHeadingRanges(tree.rootNode, content)
      }

      const moveRange =
        node.attributes.kind === MD_KINDS.HEADING
          ? headingRanges?.find((range) => range.startIndex === filePosition.startIndex)
          : { startIndex: filePosition.startIndex, endIndex: filePosition.endIndex, level: 0 }

      if (!moveRange) {
        return { success: false, error: 'Could not locate section in file' }
      }

      const parentPosition = newParent.attributes.filePosition
      const parentRange =
        newParent.attributes.kind === MD_KINDS.HEADING
          ? headingRanges?.find((range) => range.startIndex === parentPosition?.startIndex)
          : null

      if (newParent.attributes.kind === MD_KINDS.HEADING && !parentRange) {
        return { success: false, error: 'Could not locate target section in file' }
      }

      const moveStart = moveRange.startIndex
      const moveEnd = moveRange.endIndex
      if (moveEnd <= moveStart) {
        return { success: false, error: 'Invalid markdown range' }
      }

      const originalSectionText = content.slice(moveStart, moveEnd)
      let sectionText = originalSectionText
      let sectionMap = (relativeIndex: number, _isEnd: boolean) => relativeIndex
      let newSectionLength = sectionText.length
      let updatedAttributes: Partial<MyndletAttributes> | undefined

      if (
        node.attributes.kind === MD_KINDS.HEADING &&
        newParent.attributes.kind === MD_KINDS.HEADING
      ) {
        const newLevel = clampHeadingLevel(parentRange!.level + 1)
        if (newLevel !== moveRange.level) {
          const rewrite = rewriteHeadingSection(
            originalSectionText,
            newLevel,
            filePosition.endIndex - moveStart,
          )
          sectionText = rewrite.text
          newSectionLength = rewrite.newLength
          sectionMap = rewrite.mapRelative

          const label = rewrite.headingText
            ? `${'#'.repeat(newLevel)} ${rewrite.headingText}`
            : '#'.repeat(newLevel)
          const headingGlyph = getHeadingGlyph(newLevel)
          updatedAttributes = withMdExt(
            { label, ext: node.attributes.ext, image: headingGlyph },
            { headingDepth: newLevel },
          )
        }
      }

      const targetIndex =
        newParent.attributes.kind === 'file'
          ? content.length
          : newParent.attributes.kind === MD_KINDS.HEADING
            ? parentRange!.endIndex
            : parentPosition?.endIndex

      if (targetIndex == null) {
        return { success: false, error: 'Target is missing a file position' }
      }

      if (targetIndex > moveStart && targetIndex < moveEnd) {
        return { success: false, error: 'Cannot move content inside itself' }
      }

      const oldSectionLength = moveEnd - moveStart
      const insertionIndex = targetIndex <= moveStart ? targetIndex : targetIndex - oldSectionLength

      if (
        insertionIndex === moveStart &&
        (targetIndex === moveStart || targetIndex === moveEnd) &&
        sectionText === originalSectionText
      ) {
        return updatedAttributes ? { success: true, updatedAttributes } : { success: true }
      }

      const withoutSection = content.slice(0, moveStart) + content.slice(moveEnd)
      const nextContent =
        withoutSection.slice(0, insertionIndex) + sectionText + withoutSection.slice(insertionIndex)

      await ctx.files.writeFile(rootFile.attributes.path, nextContent)

      const lineStarts = buildLineStarts(nextContent)
      const insertBefore = targetIndex <= moveStart
      const insertAfter = targetIndex >= moveEnd
      const deltaLength = newSectionLength - oldSectionLength

      const mapIndex = (index: number, isEnd: boolean) => {
        const inSection = isEnd
          ? index > moveStart && index <= moveEnd
          : index >= moveStart && index < moveEnd
        if (inSection) {
          const relativeIndex = index - moveStart
          return insertionIndex + sectionMap(relativeIndex, isEnd)
        }

        if (insertBefore) {
          if (index >= targetIndex && index < moveStart) {
            return index + newSectionLength
          }
          if (index >= moveEnd) {
            return index + deltaLength
          }
          return index
        }

        if (insertAfter) {
          if (index >= moveEnd && index < targetIndex) {
            return index - oldSectionLength
          }
          if (index >= targetIndex) {
            return index + deltaLength
          }
          return index
        }

        return index
      }

      const positionMap = new Map<string, FilePosition>()
      const keys = collectSubtreeKeys(ctx.graph, rootFile.key)
      for (const key of keys) {
        const entry = ctx.graph.getNode(key)
        const entryPosition = entry?.attributes.filePosition
        if (!entryPosition) continue
        const startIndex = mapIndex(entryPosition.startIndex, false)
        const endIndex = mapIndex(entryPosition.endIndex, true)
        positionMap.set(key, createFilePosition(lineStarts, startIndex, endIndex))
      }

      ctx.graph.batch(() => ctx.graph.derived.syncFilePositions(positionMap))

      return updatedAttributes ? { success: true, updatedAttributes } : { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to move markdown section',
      }
    }
  },

  validateCreate() {
    return { valid: false, reason: 'Create nodes by editing the markdown source' }
  },

  async applyCreate() {
    return { success: false, error: 'Markdown structure is read-only for creation' }
  },

  validateDelete({ nodeAttributes }: StructureDeleteContext) {
    if (!ALL_MD_KINDS.includes(nodeAttributes.kind)) {
      return { valid: false, reason: 'Not a markdown node' }
    }
    return { valid: true }
  },

  async applyDelete({ nodeKey, nodeAttributes }: StructureDeleteContext) {
    if (!ALL_MD_KINDS.includes(nodeAttributes.kind)) {
      return { success: false, error: 'Not a markdown node' }
    }

    const rootFile = findMarkdownFileRoot(ctx, nodeKey)
    if (!rootFile?.attributes.path) {
      return { success: false, error: 'Could not find markdown file root' }
    }

    const filePosition = nodeAttributes.filePosition
    if (!filePosition) {
      return { success: false, error: 'Node is missing a file position' }
    }

    try {
      const content = await ctx.files.readFile(rootFile.attributes.path)

      const deleteStart = filePosition.startIndex
      let deleteEnd = filePosition.endIndex

      if (nodeAttributes.kind === MD_KINDS.HEADING) {
        const extension = getMarkdownExtension(rootFile.attributes.path)
        if (ctx.treeSitter.hasGrammar(extension)) {
          const tree = await ctx.treeSitter.parse(content, extension)
          if (tree) {
            const headingRanges = buildHeadingRanges(tree.rootNode, content)
            const sectionRange = headingRanges.find((r) => r.startIndex === filePosition.startIndex)
            if (sectionRange) {
              deleteEnd = sectionRange.endIndex
            }
          }
        }
      }

      const newContent = content.slice(0, deleteStart) + content.slice(deleteEnd)

      await ctx.files.writeFile(rootFile.attributes.path, newContent)

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete markdown content',
      }
    }
  },

  validateRename({ nodeAttributes }: StructureRenameContext) {
    if (!ALL_MD_KINDS.includes(nodeAttributes.kind)) {
      return { valid: false, reason: 'Not a markdown node' }
    }
    if (nodeAttributes.kind !== MD_KINDS.HEADING) {
      return { valid: false, reason: 'Only headings can be renamed' }
    }
    return { valid: true }
  },

  async applyRename({ nodeKey, nodeAttributes, newName }: StructureRenameContext) {
    if (nodeAttributes.kind !== MD_KINDS.HEADING) {
      return { success: false, error: 'Only headings can be renamed' }
    }

    const rootFile = findMarkdownFileRoot(ctx, nodeKey)
    if (!rootFile?.attributes.path) {
      return { success: false, error: 'Could not find markdown file root' }
    }

    const filePosition = nodeAttributes.filePosition
    if (!filePosition) {
      return { success: false, error: 'Node is missing a file position' }
    }

    try {
      const content = await ctx.files.readFile(rootFile.attributes.path)
      const headingLine = content.slice(filePosition.startIndex, filePosition.endIndex)

      const match = headingLine.match(/^(#{1,6})\s*/)
      if (!match) {
        return { success: false, error: 'Could not parse heading format' }
      }

      const prefix = match[1]
      const newHeadingLine = `${prefix} ${newName.trim()}`

      let lineEnd = filePosition.startIndex
      while (lineEnd < content.length && content[lineEnd] !== '\n') {
        lineEnd++
      }

      const newContent =
        content.slice(0, filePosition.startIndex) + newHeadingLine + content.slice(lineEnd)

      await ctx.files.writeFile(rootFile.attributes.path, newContent)

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rename heading',
      }
    }
  },
})
