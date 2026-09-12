# Kiro Chat for VS Code

A chat sidebar in VS Code that talks to Kiro, the way Copilot Chat does.

## Setup on Windows

**1. Install the extension.** Double-click `install-windows.bat` in this folder.

If that says the `code` command is missing, do it by hand instead: open VS Code, click
Extensions in the left bar, click the **...** menu at the top, choose **Install from
VSIX...**, and pick `kiro-chat.vsix` from this folder.

**2. Restart VS Code and click the Kiro icon in the left bar.**

**3. Follow whatever the panel tells you.**

If Kiro's command line tool isn't on your machine yet, the panel shows a short setup screen
with buttons. Clicking them opens a terminal with the right command already typed in. You
press Enter to run it. Nothing runs behind your back.

If Kiro is already installed and you're signed in, the panel skips all of that and is ready
to chat.

## Where the panel lives

It starts in the left bar, but it does not have to stay there. **Drag the Kiro icon** to the
bottom panel or to the secondary sidebar on the right, whichever suits how you work. Or run
**Kiro Chat: Move Panel** from the command palette and pick a spot.

Your conversation is kept when you move it. VS Code rebuilds the panel from scratch on a
move, so the extension saves the transcript and puts it back.

One VS Code rule worth knowing: extensions are not allowed to place a panel in the secondary
sidebar themselves. Only you can drag it there. That is why it starts on the left.

## Using it


- Open the panel and you get a fresh chat, already connected. No button to press first.
- Type, press **Enter** to send. **Shift+Enter** for a new line.
- Press `Ctrl+Alt+K` to jump to the chat from anywhere.
- Whatever file you have open, and any text you've highlighted, is sent along so Kiro knows
  what you're looking at.
- Right-click highlighted code and choose **Kiro Chat: Explain Selection**.
- **Stop** cuts off a reply. The **+** at the top starts a fresh conversation.

## Updating to a newer version

**Short answer: it does not update itself, and that is a VS Code rule, not a choice I made.**

VS Code switches auto-update off for any extension installed from a `.vsix` file. Only
extensions installed from a marketplace update on their own. So when you get a newer
`kiro-chat.vsix`, you install it the same way you installed the first one.

That part is handled properly:

- Run `install-windows.bat` again with the newer file. It sees the version already
  installed, replaces it, and tells you the old and new version numbers.
- **Your settings are kept.** Model choice, Kiro path, tool approvals, all of it.
- On the next start, the panel tells you it updated and offers to show what changed.
- Installing by hand through **Install from VSIX...** works the same way. You do not need
  to uninstall first.

Run **Kiro Chat: About and Check Version** any time to see which version you are on.

## Context: telling Kiro what to look at

**The code you highlight is sent automatically.** Select something in the editor and a chip
appears above the message box showing the file and line numbers, like
`src/app.ts:12-40  3 lines`. It follows your cursor as you move. Click the chip to leave the
selection out of a message, and click again to put it back.

**Attach files and folders** with the **+** button next to the message box. It offers a
searchable list of everything in your project, a folder picker, or an image.

**Right-click in the Explorer** and choose **Kiro Chat: Add to Chat Context**. Select
several things first and all of them are added.

**Drag and drop** files or folders from the Explorer onto the message box. The box
highlights as you drag over it. When you drop, a reference is written into your message at
the cursor, so you can carry on typing around it:

```
explain @src/api/routes.ts and how it uses @src/models
```

The dropped items are attached as well, so Kiro can open them.

Attached items show as chips. Click a chip's name to open that file, or the **×** to remove
it. Files and folders stay attached until you remove them; images clear once sent.

One detail worth knowing: Kiro reads attached files itself rather than having their contents
pasted into the message. It reports that it will not accept file contents inlined in a
prompt, so the extension passes the paths and lets Kiro fetch what it needs. Your highlighted
selection is the exception, since that is short and goes in directly.

## Screenshots and images

Paste an image straight into the message box with `Ctrl+V`. Take a screenshot with Windows'
`Win+Shift+S`, click the message box, paste, and it attaches.

You can also use **+** then **An image** to pick image files from disk.

**Click an image thumbnail to open a larger view**, either before sending it or in a
sent message. Choose **Actual size** to inspect details and scroll around the image,
or **Fit to view** to fit it within the chat panel. Press **Escape**, click **Close**,
or click outside the viewer to return to chat. You can also Tab to a thumbnail and
press Enter or Space to open it. Available from version **0.30.6**.

If your Kiro version does not accept images, the panel says so rather than silently dropping
them. The extension checks this when it connects.

## Seeing your usage

A strip under the status line shows **credits used in this chat** and **how full the context
is**, when Kiro reports them. Both were broken before **0.37.0**: Kiro sends the credit
figure in a shape the panel did not read, so the strip always said none had been reported. Under each reply is **the model and what that turn
cost**, like `claude-sonnet-4.5 · 0.42 credits`, as Kiro metered it. The model is the one
selected when you sent that turn; **auto** stays **auto**, because Kiro chooses per task and
does not report which model it picked. A turn Kiro did
not report a cost for shows nothing rather than `0 credits`, since those two are not
the same thing. Available from version **0.36.0**. **Click this strip above the chat messages** to open the
session context panel. It shows the latest context percentage, model capacity, and used
and remaining tokens. Token counts are estimates based on the reported percentage and
capacity; if capacity is unavailable, the panel shows percentages only.

The meter turns amber at **80%** and suggests considering a new session for a new task.
At **95%**, it recommends saving a summary and using **+** to start a fresh session.
These are suggestions; the extension does not reset the session automatically. The reading
may decrease if Kiro compacts context. A new or reopened session with no reading shows
**Context not reported** until Kiro sends one. Individual totals for messages, tools,
system prompts, memory, and the compaction buffer are not available.

Click **Check account usage** inside the dropdown, or press **Usage** at the top, for your
account picture: plan name, credits used against your limit, renewal date, and overage
status. Those credits are account-wide, while the context percentage belongs to this
session. The account report comes from Kiro's own `usage` command. If it answers with plain
text, the panel reads what it can and shows the report in full. If the command fails, the
panel explains the error; **Kiro Chat: Show Log** has the whole exchange.

If you still see only the account report, install the updated `kiro-chat.vsix` and run
**Developer: Reload Window** from the Command Palette. Version **0.30.5** adds the session
context panel; **Kiro Chat: About and Check Version** shows your installed version.

## Changing the model

There's a dropdown at the bottom of the panel, next to the Send button. Pick a model and it
switches straight away.

It fills itself with whatever models your Kiro account actually offers, so you see real
choices rather than a guessed list. Each row shows the model's description and context
window, with its credit rate on the right, like `1x` or `2.2x`. **auto** is Kiro's default:
it picks a model per task.

The rates come from Kiro's `model` command, which the panel asks for as it connects — the
model list alone does not carry them. If a model still shows no rate, that means Kiro did
not say, not that it is free, and the list says so at the bottom rather than leaving you
guessing.

Under the list is what this chat has cost so far, plus your plan's credits once **Usage**
has fetched them, so the price is in front of you at the moment you pick a model.

Your choice is remembered and used again next time, including in new conversations.

You can also press `Ctrl+Shift+P` and run **Kiro Chat: Change Model** if you prefer a
searchable list.

Two things worth knowing:

- The dropdown locks while Kiro is mid-reply. Switching models halfway through a reply
  confuses the session, so wait for it to finish.
- If the dropdown stays greyed out saying "Model: default", your version of Kiro isn't
  reporting a model list. Everything else still works; Kiro just uses its own default.

## Choosing a workflow mode

The mode dropdown beside the attachment and model controls changes how Kiro approaches the
next request:

- **Default** — general coding assistance.
- **Spec** — structured requirements, design, tasks, and implementation.
- **Quick Spec** — clarify only blockers, then generate a concise spec and proceed.
- **Bug Fix** — investigate, diagnose the root cause, make a focused fix, and verify it.
- **Plan** — analyze and return an implementation plan without changing files.

The choice survives panel moves and reloads and is shown on the sent message. These workflows
are explicit request instructions layered over Kiro's ACP session. Plan also has a hard safety
boundary in the extension: callback writes are refused and any direct Kiro write is restored.

## Instructions: how Kiro should always work

The mode menu has a group called **Instructions**, whose row shows what is currently set.
Click it and a full-width box opens over the transcript. Whatever you write there goes in
front of every message:

```
Always reply in Bahasa Malaysia.
Use tabs, never spaces.
Write the test before the fix.
```

**No file is created.** This is not memory — it is instruction text put in front of your
message, the same way the Spec and Bug Fix workflows already work, with you holding the pen.
It lives in the `kiroChat.instructions` setting, so it follows Settings Sync.

The difference from memory is worth keeping straight:

| | Memory | Instructions |
| --- | --- | --- |
| Holds | facts Kiro should know | directives Kiro should follow |
| Example | "this project uses pnpm" | "always write the test first" |
| Lives in | a markdown file | a setting, no file |

Enter makes a new line — this is a list, not a chat box. **Ctrl+Enter** saves, **Escape**
closes. Also on the command palette as **Kiro Chat: Your Instructions**.

Keep it short. Unlike a memory file, which Kiro opens when it wants it, this text goes with
**every** message, so its length is spent on every turn. There is a 4000-character cap; past
it the box warns you rather than dropping the end in silence.

## Memory: what Kiro knows before you say anything

The same dropdown has a group called **What Kiro always knows**. It lists the markdown files
Kiro reads at the start of every turn, opens one for editing, and removes one you no longer
want.

The extension does not implement this. Kiro CLI already loads these files itself, from three
places:

| Where | Applies to |
| --- | --- |
| `.kiro/steering/*.md` | this project |
| `AGENTS.md` in the project root | this project |
| `~/.kiro/steering/*.md` | every project you open |

Measured against `kiro-cli acp` 2.20.2 rather than taken from documentation: a fact placed in
any of these is answered with **zero tool calls**, which is what shows the text was already in
the prompt rather than fetched on demand. The YAML frontmatter is optional — a bare `.md` in
the steering folder is loaded — and editing a file part-way through a chat changes the *next*
answer in that same conversation, so there is no need to start a new one.

Adding memory creates `.kiro/steering/memory.md`, never a root-level `AGENTS.md`: Kiro reads
both, but a file at the repo root is one you might commit, and that is a larger consequence
than a menu click implies. An `AGENTS.md` you already have is listed, because a panel saying
"nothing yet" beside a file Kiro is reading would be the exact confusion this is meant to fix.

Removing asks first and sends the file to the recycle bin.

### The three kinds

| Row | File | Who sees it |
| --- | --- | --- |
| **Add project memory** | `.kiro/steering/memory.md` | anyone you share the repo with |
| **Add local memory** | `.kiro/steering/memory.local.md` | only you |
| **Add global memory** | `~/.kiro/steering/memory.md` | only you, in every project |

The first two sit in the same folder and differ only by file name, so the row that needs a
qualifier gets one: **(not committed)**. Global memory is not committed either, but for a
different reason — it lives in your home folder, outside any repository — so its row says
*this machine only* rather than letting that qualifier imply otherwise.

### Local memory in a shared repository

`.kiro/steering/` is part of the project, so in a shared repo a memory file is one `git add`
away from being everybody's. **Add local memory** creates
`.kiro/steering/memory.local.md` and adds it to `.git/info/exclude`.

That file lives inside `.git`, which is never committed. So unlike a `.gitignore` line — which
would itself be committed, broadcasting the name of the file you were trying to keep to
yourself — nothing reaches your teammates: not the file, not the rule. The file stays exactly
where Kiro reads it, and `git status` stays clean.

You can keep both: `memory.md` for what the team should share, `memory.local.md` for your own
notes.

The row tells you the truth about the file rather than assuming. If git can still see it —
most often because it was committed before being excluded, and an ignore rule does nothing
to a tracked file — the row says **"git can see this"** instead of claiming it is not
committed.

For a shared agent configuration with its own `resources` list, set
`kiroChat.args` to `["--agent", "my-agent"]`.

## If it doesn't work

Open the command palette (`Ctrl+Shift+P`) and run **Kiro Chat: Show Log**. It shows exactly
what was tried.

The two usual causes:

- **Not signed in.** Run `kiro-cli login` in a terminal. This is the same command the
  setup screen's **Sign in** button types for you.
- **No folder open in VS Code.** Kiro needs a folder to work in.

If the log says it couldn't find `kiro-cli`, run `which kiro-cli` in a terminal and paste
the result into Settings, search "Kiro Chat", field **Command**.

## Which systems this works on

**Windows only.** Mac and Linux support was taken out on purpose, so the code has one path
through it instead of three. On any other system the extension says so and stops rather
than failing later with a confusing "kiro-cli not found".

Kiro CLI 2.0 and newer installs natively on Windows. Use Kiro's PowerShell installer, then
run `kiro-cli login`. To find it, the extension checks the usual install folders — starting
with `%LOCALAPPDATA%\Kiro-Cli\` — then `where kiro-cli`, and finally WSL.

If you are on an older Kiro CLI that only runs under WSL, that still works: the extension
finds it and runs it through WSL for you. One thing to know: keep your project inside the
Linux side of WSL (`/home/you/...`) rather than a Windows drive (`/mnt/c/...`), or file
reads get slow.

If your `kiro-cli` is a `.cmd` or `.bat` shim rather than a real `.exe`, that works too —
those are started through the shell, since Node will not launch them directly.

## How this works

Kiro is its own separate app, so nothing can reach inside it. But Kiro's command line tool
can run as an agent that other editors talk to over a pipe. That's a public, documented
feature, and it's the same one Zed and JetBrains use.

```
VS Code sidebar  ->  this extension  ->  kiro-cli acp  ->  Kiro
```

Everything runs on your own machine. No extra account, no key, no server. It uses the Kiro
login you already have.

## Safety choices worth knowing

- **Reading and writing files is limited to your open workspace folders.** This includes
  every root in a multi-root workspace; a path outside all of them gets refused. The check
  is made against where a path really leads, so a symlink or a junction inside the folder
  that points out of it is refused too.
- **Tools ask first inside the chat, one question at a time.** Kiro's permission choices
  appear as an inline card in the current response instead of a separate popup. Kiro can
  ask about several tools at once; the questions are queued and put to you in turn, and a
  card says how many are behind it. Once you answer, the card collapses to one line — what
  was asked and what you chose — instead of keeping a column of spent buttons. There is a
  setting to auto-approve, off by default. Only turn it on in a folder you trust.
- **Each file is reviewed as Kiro finishes editing it**, not all of them at the end.
  The diff opens as soon as the edit lands, and Kiro waits for your answer before starting
  the next one — so you see one file at a time while the turn is still running. Set
  `kiroChat.reviewDuringTurn` to `false` to go back to reviewing everything at the end.
  A review opened while the turn is running leaves Kiro's version on disk until you decide,
  because putting a file back under a running agent breaks its next edit; rejecting still
  restores the original, at the moment you reject it.
- **File changes open for inline review before the turn finishes.** Deleted/original lines
  are red and inserted/proposed lines are green in a source editor tab. Each changed section
  gets its own **Accept** and **Reject** actions above it; **Accept all**, **Reject all**,
  **Next change** and **Previous change** sit at the top of the file. Or use `Alt+Enter` and
  `Shift+Alt+Enter` with the cursor on a hunk, and `Alt+F5` / `Shift+Alt+F5` to walk between
  them. Accepted hunks are written immediately while rejected hunks collapse back to the
  original. Kiro CLI's built-in edit tool writes directly, so the extension captures its
  result, restores the pre-turn file when the turn ends, and leaves only the lines you approve.
  **Closing the tab keeps the hunks you already accepted** and rejects only the ones you
  never answered — an accepted hunk was written the moment you clicked it, and putting the
  old file back over the top would undo work you had agreed to. Cancelling the turn is the
  other case, and that really does drop everything. This is on by default and can be
  disabled in settings.
- **No terminal access.** The extension tells Kiro it cannot run shell commands, so Kiro
  will not try.
- Text coming back from Kiro is escaped before it is shown, so a reply cannot inject
  anything into the panel.

## Settings

All optional.

| Setting | What it does |
| --- | --- |
| `kiroChat.command` | Path to `kiro-cli`. Leave empty to auto-detect. |
| `kiroChat.args` | Extra arguments for `kiro-cli acp`, e.g. `["--agent", "my-agent"]`. Added after `acp`, where its options belong. |
| `kiroChat.env` | Extra environment variables for Kiro. |
| `kiroChat.allowFileWrites` | Let Kiro keep its edits. Turn off and every edit is undone at the end of the turn — see the note below. |
| `kiroChat.autoApproveTools` | Skip the approval popup. Off by default. |
| `kiroChat.reviewFileWrites` | Inline red/green review with whole-file and per-hunk decisions. On by default. |
| `kiroChat.reviewDuringTurn` | Review each file as Kiro finishes editing it, rather than queueing every diff to the end of the turn. On by default. |
| `kiroChat.attachActiveFile` | Send the file you are looking at with each message. On by default. |
| `kiroChat.sendSelection` | Send highlighted code with each message. |
| `kiroChat.model` | The model to use. The dropdown sets this for you. |

### What "read-only" actually means

Worth being precise about, because it is not what you might assume. Kiro CLI 2.21 performs
its own built-in file edits rather than asking this extension to make them, so there is no
point at which the extension can decline one. Both `kiroChat.allowFileWrites` and **Plan**
mode work by taking a snapshot before the turn and putting the file back at the end.

The file therefore does change on disk, briefly, in the middle of the turn. Nothing you do
in the editor will see it — the contents are restored before the turn finishes — but
anything else watching the filesystem can: a dev server, a test watcher, a build, a file
sync. If you need a guarantee that nothing is written at all, don't open the folder.

Settings survive upgrades. If the saved path to Kiro ever stops working, for example
because Kiro updated itself and moved, the extension clears it, goes back to searching, and
tells you it did so, rather than just failing.

## Building it yourself

```
npm run build
```

That installs, compiles and writes `kiro-chat.vsix` next to `install-windows.bat`. Then
double-click `install-windows.bat` to install it, and restart VS Code.

`npm test` runs the checks on their own. There is one GitHub Actions workflow,
`.github/workflows/ci.yml`, which does the same three steps on Windows for every push. It
publishes nothing — the extension is installed from the `.vsix`, not from the Marketplace.

## Not built yet

Kiro's slash commands exist in the protocol but are not wired to the UI yet. The pieces are
in `src/kiroSession.ts`. Images and past chats used to be listed here; both are built now
and have their own sections above.
