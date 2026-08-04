# The `/tool` Command — Reading What You're Working On

`/tool` runs one named tool **first**, drops its result into the chat, and answers from it. Unlike the [agentic tool loop](../README.md#features) — where the model decides what to call — you choose, so it always hits, keeps replies streaming, and works with any chat model. Type `/tool @` for the tool list.

```
/tool @chrome                          summarize the page you're looking at
/tool @chrome --sel explain this       only the text you selected (light on context)
/tool @chrome:2 compare with the first tab   :N or :text picks a tab
/tool @clip what's wrong with this SQL       whatever you just copied (text or image)
/tool @word what's weak in this argument     the open document + your cursor selection
/tool @excel any outliers here?              the active sheet as a table
/tool @excel --sel how do these columns relate   only the cells you selected
/tool @ppt how can I improve this slide      slide text + notes + a picture of the slide
/tool @outlook draft a reply                 the email selected in Outlook
/tool @web  ·  @library  ·  @memory          search the web / your library / past chats
```

## Co-browsing Chrome (`@chrome`)

A second Chrome instance you drive yourself, which Hey-Koko can read: it sees logged-in pages, client-rendered apps, and whatever you have selected — things a plain server-side fetch can't reach. It keeps its own profile (`~/.hey-koko/chrome`), so your everyday browser stays untouched and private.

- Start it from **⚙ More → Read pages in the co-browsing Chrome → Open Chrome** (or run `./start-cobrowsing-chrome.command`); the same button brings it to the front later. The checkbox also gates the browser tools in the agentic loop.
- Chrome 136+ only opens its debug port for a dedicated profile, so this separate instance is required — not just tidier.
- Any web app you log into there is fair game (Teams, Gmail, Jira …), which is why there are no per-service integrations.
- `--vision` attaches a screenshot of the viewport for the model to look at; pages with no readable text (canvas charts, the built-in PDF viewer) get one automatically.

## Clipboard (`@clip`)

Reads whatever you last copied: text, or an image (a screenshot you took with ⌘⇧4 goes straight to the model). No app integration needed, so it covers everything the other tools don't.

## Office (`@word`, `@excel`, `@ppt`, `@outlook`)

macOS only, via AppleScript, read-only. These read the **live** app: the open, possibly-unsaved document, the cells you selected, the slide you're editing, the mail you have selected — not a file on disk.

- `@word` and `@excel` take `--sel` to read only your selection — your cursor's text, or the selected cell range.
- `@excel` hands the model a markdown table. Big sheets are capped at 200×40 cells (the top-left block) and the chat says when it clipped.
- Each app asks for automation permission the first time; `@ppt`'s slide picture also needs Accessibility + Screen Recording (without them it quietly falls back to text).
- Outlook must be in **Legacy** mode — "New Outlook" removed scripting support. Images in an email are shown in the chat for you but are not sent to the model.
