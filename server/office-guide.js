// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// The authoring guide handed to the model when /doc opens a document — the officecli
// counterpart of server/skills.js. It is hand-written and deliberately small: officecli's
// own `help <format> <element>` is 30k+ characters per element, so injecting it would cost
// more context than the conversation it is meant to serve. Everything below was executed
// against the real binary before being written down; nothing here is inferred from docs.
//
// English by design (this is an LLM prompt, not UI copy).

// Element/property vocabulary is per format, but the envelope, the paths and the failure
// modes are shared — the model reads COMMON once and then one FORMATS entry.
const COMMON = `You can edit and create Office documents by emitting an \`\`\`officecli block. The
user reviews it and presses ▶ to run it; you never run it yourself.

An \`\`\`officecli block holds ONE JSON object:

\`\`\`officecli
{"commands": [ ...operations... ]}
\`\`\`

- Editing the document that is open: give "commands" only.
- Creating a NEW document: also give "format" ("pptx" | "docx" | "xlsx") and a short "name".

Each operation is an object whose "command" is the bare verb; its arguments are sibling
fields, never a command line inside a string:

  {"command":"add",    "parent":"/slide[1]", "type":"shape", "props":{"text":"Hi"}}
  {"command":"set",    "path":"/slide[1]/shape[2]", "props":{"bold":"true"}}
  {"command":"remove", "path":"/slide[2]"}
  {"command":"move",   "path":"/slide[3]", "to":"/slide[1]"}
  {"command":"swap",   "path":"/slide[1]", "path2":"/slide[2]"}

Rules that hold for every format:
- Every "props" value is a STRING, including numbers and booleans: "size":"32", "bold":"true".
- Paths are 1-based and re-number as you go. Deleting /slide[2] makes the old slide 3 the
  new slide 2, so order your operations back-to-front when removing several, or work from
  the stable @id / @paraId form shown in the outline.
- In text values, "\\n" starts a new paragraph and "\\v" a line break within one.
- Lengths take a unit: "2cm", "18pt", "1.5in". Colors are bare hex, no "#": "C00000".
- Only touch what the user asked about. Do not restyle, reorder or "improve" the rest of
  the document — an \`\`\`officecli block is applied literally.
- Say in prose what the block will do before the block, in one or two sentences.`;

const FORMATS = {
  pptx: `Slides (.pptx)

Paths:  /slide[N]  /slide[N]/shape[N]  /slide[N]/shape[@id=ID]  /slide[N]/table[N]  /slide[N]/chart[N]

## Building a deck from existing content

This is the common case — the user has a summary, notes or a report and wants slides out of
it. Build each slide with ONE operation, letting the layout place everything:

  {"command":"add","parent":"/","type":"slide",
   "props":{"layout":"Title Slide","title":"Q4 Review","text":"Prepared by the data team"}}
  {"command":"add","parent":"/","type":"slide",
   "props":{"layout":"Title and Content","title":"Findings",
            "text":"Revenue grew 42%\\nAPAC led the quarter\\nEMEA flat vs Q3",
            "notes":"Mention the EMEA caveat."}}

- "text" fills the layout's body placeholder; each "\\n" is one bullet.
- DO NOT hand-place text boxes for ordinary slides. A shape with x/y/width/height ignores
  the layout and will not match the rest of the deck; use it only for a genuine callout.
- Use the layout names this deck actually has. A newly created deck has "Title Slide" and
  "Title and Content"; when editing someone's deck, reuse a layout you can see in the map.
- Turning prose into slides: one section heading = one slide, at most ~6 bullets, each a
  short line rather than a sentence. Detail that does not fit belongs in "notes".

## Editing slides that already exist

Set the shape — do not remove and re-add it, or it loses the placeholder's inherited fonts
and position:
  {"command":"set","path":"/slide[1]/shape[@id=2]","props":{"text":"New title","size":"32"}}
  {"command":"add","parent":"/slide[1]","type":"notes","props":{"text":"Speaker note."}}
  {"command":"remove","path":"/slide[3]"}
  {"command":"move","path":"/slide[4]","to":"/slide[2]"}

## Tables, pictures, charts

  {"command":"add","parent":"/slide[2]","type":"table",
   "props":{"rows":"3","cols":"2","data":"Region,Q4\\nAPAC,120000\\nEMEA,98000",
            "x":"2cm","y":"6cm","width":"20cm"}}
  {"command":"add","parent":"/slide[1]","type":"picture",
   "props":{"src":"/path/on/this/machine.png","x":"12cm","y":"5cm","width":"10cm"}}
  {"command":"add","parent":"/slide[2]","type":"chart",
   "props":{"chartType":"column","title":"Q4 by region","categories":"APAC,EMEA,AMER",
            "data":"2025:120,98,140;2026:150,110,160",
            "x":"2cm","y":"5cm","width":"20cm","height":"10cm"}}

chartType: bar column line pie doughnut area scatter bubble radar stock combo waterfall
           funnel treemap sunburst boxWhisker histogram pareto
"data" is "Series:v1,v2,v3", several series separated by ";". "categories" is the label list.

## Comments

  {"command":"add","parent":"/slide[1]","type":"comment",
   "props":{"author":"Koko","initials":"K","text":"Check this number","x":"1cm","y":"1cm"}}
  Existing ones live at /slide[N]/comment[M] and can be set or removed.

Useful shape props: text size bold italic underline color fill align valign font
                    x y width height rotation geometry opacity
Useful slide props: layout title text notes background hidden`,

  docx: `Documents (.docx)

Paths:  /body  /body/p[N]  /body/p[@paraId=ID]  /body/table[N]
        /header[N]  /footer[N]  /comments/comment[@commentId=N]

## Structure

Headings and body text are one element with different styles — build a report top-down:

  {"command":"add","parent":"/body","type":"paragraph","props":{"text":"Quarterly Report","style":"Title"}}
  {"command":"add","parent":"/body","type":"paragraph","props":{"text":"Findings","style":"Heading1"}}
  {"command":"add","parent":"/body","type":"paragraph","props":{"text":"Revenue grew 42%.","style":"Normal"}}
  Styles: Title Heading1 Heading2 Heading3 Normal Quote ListParagraph

## Editing

  {"command":"set","path":"/body/p[3]","props":{"text":"Revenue grew 42% year over year."}}
  {"command":"set","path":"/body/p[1]","props":{"bold":"true","size":"14","color":"C00000","align":"center"}}
  {"command":"remove","path":"/body/p[5]"}

## Tables, page breaks, pictures, charts

  {"command":"add","parent":"/body","type":"table",
   "props":{"rows":"3","cols":"2","data":"Region,Q4\\nAPAC,120000\\nEMEA,98000"}}
  {"command":"add","parent":"/body","type":"pagebreak"}
  {"command":"add","parent":"/body","type":"picture","props":{"src":"/path/on/this/machine.png","width":"12cm"}}
  {"command":"add","parent":"/body","type":"chart",
   "props":{"chartType":"line","title":"Trend","categories":"Q1,Q2,Q3","data":"Revenue:10,14,19",
            "width":"14cm","height":"8cm"}}

## Headers and footers

Their parent is the document root "/", not /body. "field" inserts a live field — PAGE for
the page number, NUMPAGES for the total, DATE for the date:

  {"command":"add","parent":"/","type":"header","props":{"text":"Acme Corp — Confidential","align":"center"}}
  {"command":"add","parent":"/","type":"footer","props":{"text":"Page ","field":"PAGE","align":"center"}}
  {"command":"add","parent":"/","type":"header","props":{"type":"first","text":"Cover page header"}}
  {"command":"add","parent":"/","type":"header","props":{"type":"even","text":"Even pages"}}
  type: default (omit) | first | even.  Edit an existing one with set on /header[N].

## Comments

The parent is the paragraph (or run) the comment is anchored to:

  {"command":"add","parent":"/body/p[2]","type":"comment",
   "props":{"author":"Koko","initials":"K","text":"Cite the source here"}}
  {"command":"set","path":"/comments/comment[@commentId=1]","props":{"text":"Reworded","done":"true"}}
  {"command":"remove","path":"/comments/comment[@commentId=1]"}

Useful paragraph props: text style align bold italic underline size color font
                        spaceBefore spaceAfter indent firstLineIndent keepNext pageBreakBefore`,

  xlsx: `Workbooks (.xlsx)

Paths:  /sheet[N]  /sheet[N]/A1  (cells in plain A1 notation)
        /SheetName/col[A]  (columns — note the DIFFERENT form: sheet NAME and col[LETTER])

## Values and formulas

One cell at a time is the reliable path:

  {"command":"set","path":"/sheet[1]/A1","props":{"value":"Region"}}
  {"command":"set","path":"/sheet[1]/B2","props":{"value":"120000"}}
  {"command":"set","path":"/sheet[1]/B5","props":{"formula":"=SUM(B2:B4)"}}

Do NOT use the CSV "import" command: it reports success and writes nothing.

## Formatting

  {"command":"set","path":"/sheet[1]/A1","props":{"bold":"true","fill":"DDEBF7"}}
  {"command":"set","path":"/sheet[1]/B1","props":{"format":"#,##0"}}
  {"command":"set","path":"/Sheet1/col[A]","props":{"width":"18"}}

## Charts

  {"command":"add","parent":"/sheet[1]","type":"chart",
   "props":{"chartType":"column","title":"Q4 by region","categories":"APAC,EMEA",
            "data":"Q4:120,98","anchor":"D2:J18"}}

"data" takes INLINE numbers ("Series:1,2,3") — a cell range there is rejected. Ranges are
allowed in "categories" ("Sheet1!$A$2:$A$3") and in "series1"/"series2"/… instead.

## Comments

  {"command":"add","parent":"/sheet[1]/B2","type":"comment","props":{"author":"Koko","text":"Verify this"}}

Useful cell props: value formula bold italic size color fill format align wrap`,
};

const FORMAT_NAMES = Object.keys(FORMATS);

// The guide text for one format, or "" for an unknown one.
function guideFor(format) {
  const f = String(format || "").toLowerCase().replace(/^\./, "");
  if (!FORMATS[f]) return "";
  return `${COMMON}\n\n---\n\n${FORMATS[f]}`;
}

module.exports = { guideFor, FORMAT_NAMES, COMMON };
