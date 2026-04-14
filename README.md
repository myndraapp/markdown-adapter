# Markdown Adapter Plugin

A Markdown adapter plugin for Myndra that parses Markdown files into a graph representation using tree-sitter.

## Features

- **Hierarchical Structure**: Parses headings, paragraphs, lists, code blocks, blockquotes, and more
- **Syntax Highlighting**: Registers CodeMirror extensions for `.md` and `.markdown` files
- **Bidirectional Highlighting**: Hover graph nodes to highlight corresponding text in the preview panel
- **File Position Tracking**: Maintains accurate source positions for all parsed elements

## Supported Node Types

| Kind            | Description                          |
| --------------- | ------------------------------------ |
| `md:heading`    | Headings (H1-H6) with level and text |
| `md:paragraph`  | Text paragraphs                      |
| `md:list`       | Ordered and unordered lists          |
| `md:list-item`  | Individual list items                |
| `md:code-block` | Fenced and indented code blocks      |
| `md:blockquote` | Block quotes                         |
| `md:link`       | Hyperlinks                           |
| `md:image`      | Images                               |
| `md:section`    | Document sections                    |

## Extension Data

The plugin stores Markdown-specific data in the `ext.markdown-adapter` namespace:

```typescript
interface MdExt {
  headingLevel?: number // 1-6 for headings
  headingText?: string // Heading text content
  listOrdered?: boolean // true for ordered lists
  codeLanguage?: string // Language for fenced code blocks
  linkUrl?: string // URL for links
  imageUrl?: string // URL for images
  imageAlt?: string // Alt text for images
  isMarkdownFile?: boolean // Marks the file node
}
```

## Read-Only Structure

Unlike the JSON adapter, the Markdown adapter is read-only. The structure reflects the source file, and changes must be made by editing the markdown source directly. This ensures the graph always accurately represents the document structure.

## Usage

The plugin automatically activates when you open a `.md` or `.markdown` file. Nodes are injected into the render graph and are reconstructed from the source on each file open.

## Grammar

The adapter expects a tree-sitter Markdown grammar at `/grammars/tree-sitter-markdown.wasm` (as declared in the manifest).

## Glyphs

Place glyph images in `/plugins/markdown-adapter/`:

- `file_markdown.svg` - Markdown file icon (Material Symbols "markdown", U+F552)
- `description.png` - Document
- `format_h1.svg` - Heading level 1 (Material Symbols "format_h1")
- `format_h2.svg` - Heading level 2 (Material Symbols "format_h2")
- `format_h3.svg` - Heading level 3 (Material Symbols "format_h3")
- `format_h4.svg` - Heading level 4 (Material Symbols "format_h4")
- `format_h5.svg` - Heading level 5 (Material Symbols "format_h5")
- `format_h6.svg` - Heading level 6 (Material Symbols "format_h6")
- `title.png` - Heading fallback
- `notes.png` - Paragraph
- `format_list_bulleted.svg` - Unordered list
- `format_list_numbered.svg` - Ordered list
- `chevron_right.png` - List item
- `check_box.svg` - Task list item (checked)
- `check_box_outline_blank.svg` - Task list item (unchecked)
- `code.png` - Code block
- `terminal.svg` - Code block (shell)
- `javascript.svg` - Code block (JS/TS)
- `html.svg` - Code block (HTML)
- `css.svg` - Code block (CSS)
- `data_object.svg` - Code block (JSON/YAML)
- `format_quote.png` - Blockquote
- `info.svg` - Blockquote callout (NOTE/INFO)
- `lightbulb.svg` - Blockquote callout (TIP)
- `priority_high.svg` - Blockquote callout (IMPORTANT)
- `warning.svg` - Blockquote callout (WARNING)
- `report.svg` - Blockquote callout (CAUTION)
- `error.svg` - Blockquote callout (DANGER)
- `link.png` - Link
- `image.png` - Image
- `segment.png` - Section
