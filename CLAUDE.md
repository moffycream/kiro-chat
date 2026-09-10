# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Bumping the version means writing a `CHANGELOG.md` entry.** `announceUpgrade` in `lifecycle.ts` offers "See what changed" and opens that file, so a version shipped without an entry points the user at a changelog that doesn't mention what they just installed. `test/changelog.test.js` enforces it.

```bash
npm test          # compiles first, then runs node --test over test/*.test.js
npm run compile   # tsc -p ./  → out/
npm run watch     # tsc -watch
npm run package   # writes kiro-chat.vsix via @vscode/vsce
npm run build     # install + compile + package
```

Running a single test — note the tests require **compiled** output, so compile first if `src/` changed:

```bash
npm run compile && node --test test/usage.test.js
```

Filter by test name across all files:

```bash
npm run compile && node --test --test-name-pattern="credit rate" "test/*.test.js"
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test`, `npm run package` on `windows-latest` and uploads the `.vsix` as a run artifact. It publishes nothing — this extension is installed from the `.vsix`, never from the Marketplace.

## Architecture

Three processes, two hops:

```
webview (media/chat.js)  ⇄  extension host (src/)  ⇄  kiro-cli acp (child process)
       postMessage                    JSON-RPC 2.0, one object per line over stdio
```

**`src/acpClient.ts`** — a minimal JSON-RPC client over the child's stdin/stdout. The key thing: ACP is **bidirectional**. Kiro sends us requests too, so `AcpClient` has both `pending` (our outbound calls) and `onRequest` (Kiro calling in).

**`src/kiroSession.ts`** — owns the ACP conversation and all Kiro-specific protocol knowledge. Translates JSON-RPC into the `SessionEvents` callback interface.

**`src/chatViewProvider.ts`** — owns the webview. Holds the HTML inline in `html()`, and translates `SessionEvents` into `postMessage` calls.

**`media/chat.js`** — the webview. No framework, no build step; it is shipped as-is.

### The two switch statements are the contract

A feature almost always means editing both:

- `resolveWebviewView`'s `onDidReceiveMessage` switch (`chatViewProvider.ts`) — webview → extension
- the `window.addEventListener("message")` switch (`chat.js`) — extension → webview

`ChatViewProvider.post()` is the only path in the outbound direction.

### Kiro calls back into us

`KiroSession.handleRequest` answers `fs/read_text_file`, `fs/write_text_file` and `session/request_permission`. **Every file path goes through `resolveInsideWorkspace`**, which accepts every root in a multi-root workspace and rejects anything outside all open folders. That function is the security boundary — don't route file access around it. Writes additionally check `kiroChat.allowFileWrites`.

**Containment is tested on real paths, not written ones.** `resolveInsideWorkspace` defers
to `isInsideAnyRoot` in `workspacePaths.ts` (free of `vscode`, so `test/workspaceBoundary.test.js`
drives it against real junctions). Comparing the resolved string defeats `../`, but a symlink
or a Windows junction *inside* the workspace pointing out of it resolves to an in-workspace
string and used to be accepted — which is not what the README promises. Both sides are put
through `realPathOf`, which handles a file that does not exist yet by resolving the nearest
existing ancestor and rejoining the rest; resolving only the child would make every file
under a symlinked workspace root look external. The path handed back is still the one that
was asked for, so a link keeps working as a link once it has been shown to lead somewhere
allowed.

**`allowFileWrites: false` and Plan mode revert; they do not prevent.** Kiro CLI 2.21 makes
its own edits, so there is no call to refuse — the file really is written and then restored
from its pre-turn snapshot. Anything watching the filesystem sees the intermediate state.
Say so plainly in any wording about read-only; the setting's description used to promise
prevention.

With `kiroChat.reviewFileWrites` enabled, `ChangeReviewer` holds the write request open and
opens a read-only virtual source document in the editor. Theme-aware decorations mark pending
deletions red and insertions green. A CodeLens provider supplies whole-file
**Accept all** / **Reject all** and per-hunk **Accept** / **Reject**.

**An editable review was tried and reverted.** The document was moved to a
`FileSystemProvider` (a `TextDocumentContentProvider` is read-only, always) so it could be
typed into and saved. That forces the buffer to hold *one* version of the file rather than
both sides — a document showing the old lines and the new ones at once has no single answer
to "what did you mean to keep" — so the red deleted lines had to leave the buffer for a
hover marker. Losing the side-by-side red/green is what killed it: it is most of why the
review is readable. Keep the merged, read-only rendering; if editing comes up again, it
needs an answer that does not cost that.

**Do not swap these for inlay hints.** A hint label part carrying a `command` is painted as
a chip and looks far more like a button, but it is only reachable through VS Code's
`ClickLinkGesture`, which fires solely while the trigger modifier is held — a plain click
does nothing at all. That was tried in 0.10.2 and shipped broken. A CodeLens cannot be
styled in any way, but it responds to an ordinary click, and that is the whole trade
VS Code offers here. Accepted hunks write through immediately via `createReviewApplier`;
the virtual document then collapses that hunk to its accepted side and clears its decorations.
Reviews are serialised. **Closing the tab keeps hunks you already accepted** and rejects
only the undecided ones — an accepted hunk was written the moment it was clicked, so
rewriting the pre-turn contents over the file would silently undo agreed work. Cancelling
the turn is the other case and really does drop everything, because the whole run is being
abandoned. That is the `keepDecided` argument to `rejectAll`. `lineDiff.ts` remains independent of VS Code and combines
the accepted hunks.

**Hunk decisions are queued, never dropped.** `decideHunk` chains onto a `decisions`
promise. It used to bail out whenever `applying` was set, so a second click arriving during
the disk write of the first was discarded with nothing on screen to say so — the count
stopped falling, the button looked dead, and because the final decision never landed the
review could never settle. Clicking two hunks in a row is the normal way to use this.

Three details in `ChangeReviewer` that are expensive to rediscover:

- **Review hunks are deliberately finer than display hunks.** `open()` calls
  `buildReviewDiff(before, after, 0)` — context `0`. The span test is
  `index - previous.end > context * 2 + 1`, so with zero context a single unchanged
  line between two edits splits them into separate decisions. The default of `3` would
  merge anything less than seven lines apart into one accept/reject, which is what 0.9.1
  fixed. Tests that call `buildReviewDiff` without the third argument are exercising the
  display default, not what review uses.
- **Serialisation is a promise queue plus a generation counter.** `review()` chains onto
  `this.queue`, and each queued task re-checks `generation === this.generation` before
  opening, so `cancelPending()` (which bumps the generation) drops work that has not
  started as well as rejecting the one on screen.
- **The keybindings are gated on a context key the reviewer sets itself.**
  `Alt+Enter` / `Shift+Alt+Enter` (decide) and `Alt+F5` / `Shift+Alt+F5` (jump) are
  `when`-clause'd on `kiroChat.hunkReviewActive`, which `open()` and `finish()` toggle
  via `setContext`. Forgetting to clear it leaves the shortcuts live over an unrelated
  editor.
- **Jumping walks `rendered.hunks`, not `diff.hunks`.** A decided hunk has already
  collapsed out of the rendered map, so `gotoChange` only ever visits changes that still
  need an answer and the walk empties as the review is worked through. It positions from
  the cursor — stepping out of the hunk it is inside, or to the nearest one in that
  direction — so it stays sane after the user has scrolled. `gotoNext` is also reachable
  from the chat bar (`gotoChange` → `KiroSession.gotoNextChange`), because the diff is
  usually behind the chat and a `when`-gated keybinding cannot be reached from there.

**Accepted content is written through `vscode.workspace.applyEdit`, not `fs.writeFile`.**
`writeThroughEditor` (with `writeFileContent` falling back to disk) exists so Ctrl+Z works
on a change the user accepted: a raw disk write is invisible to the editor, the document
reloads with no undo entry, and the change is permanent. Two consequences that are easy
to get wrong:

- **`restoreSnapshot` deliberately stays on `fs`.** Putting a file back is not an edit the
  user made and must be exact; going through the editor would save it, and saving runs
  format-on-save, so *rejecting* a change could leave the file reformatted. For accepted
  content the formatter is welcome — that is what saving the same edit by hand does.
- **The applier records what landed, not what it asked for.** `createReviewApplier` takes
  an optional `AppliedState` and re-reads the file after writing, because a save
  participant can change the bytes on the way through. Recording the request instead makes
  the next hunk look like an outside edit: every decision after the first is refused and
  the review never settles. Both post-review guards accept `landed` as a final state
  alongside `decision.content` for the same reason.

The review document's tab is named `<filename> (Working Tree)`, following git rather than
inventing a convention — a tab labelled exactly like the real file sits beside it and
invites editing the wrong one. VS Code takes the tab title from the URI's basename, so the
marker has to live there, and there is no public API to label a plain editor otherwise
(`_workbench.open` takes a label but is internal; `vscode.diff`'s title argument only
applies to a diff editor, which this is not).

**That name costs the syntax highlighting, and `applyLanguage` buys it back.** A basename
not ending in the extension matches no language, so the review would render as plain text.
`applyLanguage` reads `languageId` off the real file and calls
`vscode.languages.setTextDocumentLanguage`. Two traps in that call:

- **It recreates the document, firing `onDidCloseTextDocument` for the old one** — the same
  event the user closing the tab fires, which the reviewer treats as an answer. So it runs
  *before* `this.active = review`, and the close handler sees no active review. Moving it
  after would make every review reject itself the instant it opened.
- **Setting `active` later opens a cancellation window**, so `open()` captures the
  generation up front and re-checks it after assigning `active`; a `cancelPending()` that
  arrived while the document was opening had nothing to cancel at the time.

**Supervision is one choice, and the mode is derived rather than stored.** `editModes.ts`
(free of `vscode`, so `test/editModes.test.js` drives it) maps `manual` / `review` /
`autopilot` onto the four write gates, and `editModeOf` reads them back. There is
deliberately no `kiroChat.editMode` setting: a stored mode is a second source of truth that
drifts the moment someone edits the JSON. A combination matching no mode returns `custom`,
which the menu shows as a note and never offers as a choice — rounding it to the nearest
mode would display a selected row that does not describe the settings, and the next click
would then change ones the user never touched. `allowFileWrites: false` is `custom` on
purpose: restoring every file afterwards is a dry run, not a degree of care.

**Hover is a state, not a change of role.** `.permission-option:hover` and
`.permission-option.primary` shared one rule, so hovering any option painted it as the
recommended action — and since `.reject` was coloured by `:not(:hover)`, hovering **Reject**
dropped its red and turned it primary blue. The most dangerous button became the one that
looked recommended, exactly when the pointer was on it. Secondary hovers to
`button-secondaryHoverBackground`, primary to `button-hoverBackground`, reject keeps its red
and gains a red border. If a hover rule ever needs to change what a button *means*, the rule
is wrong.

**The mode picker holds all of "how is this conversation running".** Three groups in one
menu: the workflow (`chatModes.ts`), the supervision (`editModes.ts`), and the two
`MESSAGE_TOGGLES`. Supervision briefly had a settings gear of its own, which put "how
closely am I watching Kiro" somewhere quite different from "how is Kiro approaching this
task" — two halves of one question, and one of them dressed as configuration rather than a
working choice. The gear is gone.

They are separate **groups** and not one flat list because they are independent: Spec with
Autopilot and Spec with Manual are both sensible. Four details that are easy to undo:

- **Picking a workflow closes the menu; the other two rows leave it open.** A workflow is
  the whole errand. Supervision and the toggles are things you might set two of, and
  staying put is what shows the change landing.
- **One-of rows are marked by the selection highlight, toggles by a drawn switch.** Both
  wearing the highlight merged two switched-on toggles into a single blue slab, and a
  highlight on several rows at once reads as "these were all chosen" directly under a group
  that means "only this one". The switch was briefly a `✓` / `○` character, which is a glyph
  pretending to be a control: nothing about it said it could be flipped, its two states were
  different *shapes* rather than one thing moved, and it inherited whatever colour the text
  had. `.menu-switch` is a track and a knob that slides, keyed off the row's own
  `aria-checked` so the state has one source.
- **No row flips itself.** `setEditMode` / `setSetting` post and wait;
  `onDidChangeConfiguration` redraws. A failed write cannot leave a mark claiming a state
  the settings are not in — the permission card's rule again. `setSetting` also checks an
  untrusted key against `PANEL_SETTINGS` before writing, and `gatesForMode` refuses
  anything that is not a named mode.
- **`modeButtonLabel()` puts supervision on the button, but only when it is not Review.**
  Manual and Autopilot change what happens to your files with nothing else on screen to say
  so. Review is the default and Plan changes nothing, so neither is announced.

This also replaced the old `defaults` message — keeping it would have given `sendSelection`
two writers in `chat.js`.

**The live card is pinned; the settled one is history.** `#permission-bar` sits between the
transcript and the composer, above `#change-bar`, for the reason that bar gives: the turn is
blocked on the question, Kiro goes on streaming, and in the transcript the card scrolls out
of view exactly when it is needed. `addPermissionCard` branches on `settled` — live goes to
the bar, settled into the agent bubble — and `retirePermissionCard` moves one across when
the answer lands. Neither ever goes into `bubble.tools`, which folds. `.permission-done`
also drops the focus-coloured border and the primary button's fill, or an answered card goes
on looking like one waiting to be pressed.

An edit gets **one** gate by default, not two — but `askBeforeEdits` makes it two, and the
reasoning for the default is not the reasoning for a rule. `askPermission` recognises a write-like tool
through `isWriteLikeTool` (`writeTools.ts`, shared with `observeDirectFileWrite` so the
two cannot drift) and lets it through without a prompt whenever the review diff is
actually going to open — that is, `reviewFileWrites` and `allowFileWrites` are on and the
turn is not read-only. Asking "may I write this file?" before there is a diff to look at,
and then asking "keep these changes?", is largely the same question twice, and the first is
the harder one to answer. When no review will open, that prompt is the only gate there is,
so it stays.

**But the two questions are not identical, which is why `askBeforeEdits` exists.** Kiro CLI
2.21 writes files itself, so the review can only restore one afterwards — the write really
reaches disk, and anything watching the filesystem sees it. Only the prompt can stop that.
Defaulting to one gate keeps a ten-edit turn from becoming twenty prompts; the setting
exists because "stop it happening" and "let me read it afterwards" are different needs and
only the user knows which they have. `askAnyway` therefore suppresses the skip, and is read
per request rather than cached.

The keep-or-undo control is `#change-bar`, pinned between the transcript and the composer
rather than appended to the transcript. It appears the moment `ChangeReviewer` fires
`onDidChangeActiveReview`, so both routes are open at once: decide each hunk in the diff, or
take the whole file from the bar. In the transcript it would scroll away exactly when it is
needed, and it has to stay put while the diff is being read in another tab. While a review is
open the buttons call `acceptActive` / `rejectActive`; once it has settled they fall back
to the turn-level undo below. Keep and Reject disable themselves on click because their
decisions are consumed.

**While a review is open the summary line is itself the jump control** — a `<button>`
rather than a `<div>`, clicked the way a merge conflict is walked: once to reach a change,
again for the next. It therefore has to opt out of the global `button` styling exactly as
`.usage-bar` does, or the whole line paints as a solid primary block. A separate "Next
change" button was tried and removed in 0.12.1: it was a third control competing with the
two decisions beside it.

**Both halves of the bar have to exist, and only a test says so.** The webview half was
lost from `chat.js` once and nothing failed loudly — the provider went on posting
`reviewActive`, `turnChanges` and `changesUndone` into a `switch` with no cases for them,
so no card ever appeared and an edit could only be answered by hunting down the diff tab.
A posted message with no matching case is silent. `test/webview.test.js` now asserts every
one of those three types is both posted and handled.

**The one-gate rule applies at this end too.** `reportTurnChanges` skips every path in
`answeredPaths` — the files whose review the user actually worked through. They gave a
finer answer, hunk by hunk, than the card can take, and a card offering to undo what they
just accepted cannot be answered without contradicting them. A change that never opened a
review is still reported, because there the card is the only gate. Both review routes
(the ACP `fs/write_text_file` callback and the direct-write path) add to the set, so
neither can drift from the other.

After a turn, `reportTurnChanges` compares every pre-turn snapshot in `turnBaselines`
against what is on disk now and posts a **keep or undo** card into the chat. It compares
rather than trusting what Kiro said it would do: a rejected review restores the original and
Kiro sometimes rewrites a file with what it already held, and offering to undo either would
be offering to undo nothing. The snapshots for the files that really changed survive in
`lastTurnBaselines` so `undoLastTurn()` can put them back; `keepLastTurn()` drops them.
`turnChanges.ts` holds the comparison and is free of `vscode`.

`session/request_permission` belongs in the chat webview. `KiroSession.askPermission`
passes Kiro's option ids and labels through `SessionEvents.onPermission`; the provider
posts an inline permission card and resolves the request when `chat.js` returns a
`permissionDecision`. The VS Code notification is only a fallback when no panel exists.

**One question at a time, and only the part that asks a human is queued.**
`AcpClient.handleIncomingRequest` answers each incoming request on its own promise and
never waits for the last — right for reads, wrong for questions. Kiro writes several
notifications in one stdio write, so two `session/request_permission` calls dispatched out
of the same chunk both reached the panel and `permissionBar.appendChild` stacked two
cards; `livePermissionCard()` then pointed the `1`–`9` shortcuts at the newest one rather
than the one being read. `queuePermission` chains onto `permissionQueue`, and the fast
answers — no options, `autoApproveTools`, the one-gate write skip — must stay outside it,
or an auto-approval waits behind a card nobody has looked at. The generation is re-checked
at the *front* of the queue, not when the task was joined: Stop, a new session or a
disposal overtakes anything still waiting, and asking then would be asking about a turn
that no longer exists. `waiting` rides along with the request so the card can say what is
behind it — a serialised queue is otherwise indistinguishable from Kiro having hung, which
is the honest version of what the stack of cards gave away by accident.

**The card claims nothing until the extension has answered.** Clicking used to disable the
buttons and write "Selected: Allow" on the spot, whatever became of the decision — and a
request that had already gone (turn ended, stopped, errored) is dropped by the provider in
silence, so the transcript kept a card reporting an approval Kiro never received. The click
now only says "Sending…"; `permissionSettled` carries `ok: true` with the option or
`ok: false`, and the card writes the outcome — or marks itself `permission-stale` — from
that. Both halves have to exist, as ever.

**A pending permission outlives the panel being rebuilt — for thirty seconds.**
`view.onDidDispose` cannot tell a drag from a close: both destroy the webview, and only
what happens next separates them, because a drag resolves a new view within milliseconds
and a close never does. Cancelling there answered Kiro on the user's behalf every time they
rearranged their editor; not cancelling at all left Kiro waiting on a panel that was never
coming back. So `schedulePermissionCancel()` waits and sees, and `resolveWebviewView` calls
it off through `keepPermissionsAlive()`. Nothing is scheduled when nothing is outstanding,
and when the timer does fire it says so in the output channel — there is no panel left to
tell. `pendingPermissions` stores the request beside its resolver so `onWebviewReady` can
`repostPermissions()`; the `permission` case in `chat.js` ignores an id already on screen,
so re-asking cannot stack two cards. Genuine teardown — `dispose()`, `newSession()`,
`stop()` — still cancels at once, and every cancel posts `permissionSettled { ok: false }`
so no card is left looking live.

**`stop()` is the only Stop.** The webview's `stop` message used to cancel pending
permissions while the `kiroChat.stop` command called `session.cancel()` alone, so stopping
from the Command Palette left a live card answering to nobody. Both go through `stop()`.

**The numbers on the options are a promise, and it is kept where it can be.** Options
render as `1  Allow`, `2  Reject`, which reads as "press that key"; nothing listened. The
document `keydown` handler answers the live card on `1`–`9` — but only when the composer is
empty, because `setBusy` disables Send and not the textarea, so the box holds focus for
most of a turn and a digit while something is being written is text. `livePermissionCard()`
is the newest card with no choice made and no `permission-done`.

**Only an allow may be the primary button.** The rule was
`kind.startsWith("allow") || index === 0`, which painted a refusal sent first as the
recommended action, with both classes at once. `reject` is decided first, and the
first-option fallback applies only when no option declares itself an allow.

**A permission goes into the chat's record.** It lived only in the DOM, so reopening a chat
left no trace that Kiro had asked to do anything. `recordPermission` stores
`role: "permission"` with the title, options and choice, and `restoreHistory` rebuilds the
same card with `settled: true`. One card renderer, not two — and `settlePermissionCard` is
the one function that turns a live card into an answered one, reached both by
`permissionSettled` and by the restore path.

**An answered card is a record, not a control.** It used to keep every option on screen as
a disabled button with the choice named underneath: three or four rows to record one word,
in a panel three inches wide, and a turn can ask several times. `settlePermissionCard`
removes the actions, the queue note and the status line, and leaves one row — a
`.permission-outcome` pill and the question in the past tense. Three details there are
load-bearing:

- **The options live on `card.dataset.options`, not on the buttons.** `recordPermission`
  used to read them back off `.permission-actions button`, which is nothing once the card
  has been answered.
- **The choice comes from the settling message, never from `button.chosen`.** The click
  and the outcome are deliberately different events — a request that had already gone is
  answered `ok: false` however it was clicked — and reading the class would put the card
  back to claiming an approval that reached nobody.
- **`ok: true` with an option id nothing matches still renders as answered.** Falling
  through to the stale branch there would report the opposite of what happened.
  `test/permissionCard.test.js` runs the function against a small DOM rather than matching
  its source, which is what that class of bug needs.

**A running turn is said in one place: a light travelling the border of the message box.**
`.composer.working .input-wrap::before` rotates a conic gradient, and the class is toggled
in `setBusy` on `status === "busy"` specifically — not the `busy` variable beside it, which
also covers connecting, and a box lit before the first message would be announcing work on
nothing. Four things there are load-bearing:

- **`@property --edge-angle` is what makes it move at all.** A plain custom property is a
  string as far as animation is concerned, so the angle would jump 0deg → 360deg in one
  frame and nothing would appear to happen.
- **The wrapper is `display: flex`.** It has to be exactly as tall as what it holds or the
  gradient shows through the surplus as a band along the bottom rather than a line along the
  edge — which is what the first attempt looked like, because a textarea is inline and a
  plain wrapper stands a few pixels taller than one. `.input-shell` is a block and has no
  such gap, but flex is what keeps the wrapper welded to whatever ends up inside it.
- **The gradient is one arc with a transparent tail, not a full ring — and one colour, the
  theme's own.** A whole spectrum all the way round is a decoration; a run of colour with
  darkness behind it is a light going round something, which is the thing being described.
  It was RGB first and that belongs to no theme in particular, so it is
  `--vscode-focusBorder` now — the light the box already wears when you click into it,
  which makes a running turn read as this box being active rather than as something bolted
  onto it. Held under full strength through `color-mix`: it should be catchable at the edge
  of vision and then ignorable, which is the difference between a progress indicator and a
  warning light. A test forbids a hardcoded hex in that rule.
- **Under `prefers-reduced-motion` the arc parks lit rather than disappearing.** Motion is
  how this speaks, so stopping it silently would remove the information instead of the
  animation.

Two earlier attempts are why it is this and not something simpler, and both are worth not
repeating: a **blinking caret** (`steps()` on `.cursor::after`) was too loud for the size it
sits at and read as cheap, and it is dark during exactly the silences that need covering —
while Kiro reads and edits, no text is arriving to blink after. A **pulsing glow** on the
textarea reads as an alarm: it takes your attention again every two seconds, when what is
wanted is something glanceable and then ignorable. `.cursor::after` is deliberately static.

**The box and its controls are one surface, and that costs an extra element.** The composer
used to be two blocks — a bordered textarea with an unbordered row of buttons floating
underneath — so the controls read as belonging to the panel rather than to the message being
written, and two edges at two widths made the foot of the panel look accidental. The border,
the background, the radius and the focus ring now live on `.input-shell`, which holds the
textarea *and* `.composer-row`; the textarea gives up all four and `:focus-within` lights the
whole box, because clicking into the text and tabbing to the workflow picker are the same act.
Three consequences:

- **`.input-shell` exists because `::before` paints above its parent's background.** The
  travelling light is `.input-wrap::before`, a positioned child, so the surface that masks
  it cannot be the wrapper — it would be covered by the very thing it hides. It has to be one
  layer up. That is the whole reason these are two elements and not one, and it is why the
  background may never move onto `.input-wrap`.
- **The textarea says `background: transparent`, not `background: none`.** A rule carrying
  both `background: none` and `border: none` is read by `test/webview.test.js` as a button
  that opted out of the global styling and owes a matching `:hover`. A textarea owes no such
  thing, and adding a hover rule to satisfy a test about buttons would be answering the wrong
  question.
- **`.mode-menu` / `.model-menu` resolve against `.input-shell` now**, since it is positioned
  and they sit inside it. They are `left: 0; right: 0; bottom: calc(100% + 6px)` rather than
  the old `var(--gap)` inset and fixed `bottom: 46px` — measuring from the box is the better
  anchor anyway, because the fixed offset drifted into the text as soon as the message ran
  past two lines. `.slash-menu` and `.instructions-panel` are direct children of `.composer`
  and still anchor there.

**A narrowing panel gets three answers, in order, and the first one was a bug.**
`.mode-wrap` / `.model-wrap` carry `min-width: 0` and shrink correctly; nothing passed
that on to the button inside, which kept its content width and drew *outside its own
wrapper* — at a sidebar width of 220px a 57px wrapper held a 118px button and the label
ran over the edge of the message box. `max-width: min(190px, 100%)` is the fix, and
`min-width: 0` beside it, or the button's own min-content width becomes the floor and
the cap has nothing to do. Then, in order of preference:

- **Icon-only, through a container query.** `.input-shell` declares
  `container-type: inline-size` and `container-name: composer-box`; below 310px of
  *content* width the labels are `display: none` and the pickers go square on
  `--control-h`. It is a container query and not a media query because the width that
  decides this is the box's, not the window's — they agree today, since the webview is
  the whole view, but a viewport query measures that coincidence, and it cannot be
  exercised against a panel rendered at a chosen width inside a larger page, which is
  how this is tested. Where container queries are unsupported it never matches and the
  labels stay, which the wrap below still catches.
- **`setMode` and `setModels` put the label's content into `title` and `aria-label`.**
  The icon is `aria-hidden`, so with the label hidden these buttons would have no
  accessible name at all. The workflow title also had to start using
  `modeButtonLabel()` rather than `mode.label`: it was dropping the supervision half,
  which is the part that changes what happens to your files.
- **`flex-wrap: wrap` on `.composer-row` is the last resort**, not the first. A sidebar
  can be dragged narrower than any arrangement of five controls in a row, so that width
  needs an answer of its own rather than a smaller version of the wide one.

**The dock floats; it does not take a row.** `#permission-bar`, `#change-bar` and the
composer live in one absolutely positioned `.dock` over the foot of the transcript.
They were three more rows of the page's flex column, so the composer's height came
out of the transcript permanently and its `border-top` ruled the panel into two
sections. Everything each of them already required — a question that blocks the turn
and a decision about what changed, neither of which may scroll away — is now paid for
out of the panel's z-order rather than its height. Four things there are load-bearing:

- **The fade is a mask on `.messages`, not a scrim on the dock.** The usual way to hide
  what scrolls behind a floating box is a gradient in the panel's own colour, and there
  is no such colour to name: this panel is dragged between the sidebar, the bottom panel
  and the secondary sidebar, each with its own background, which is exactly why `body`
  is `transparent`. Any named colour is right in one place and wrong in the other two.
  Fading the content itself needs no colour at all, and the mask is fixed to the
  scroller's own box rather than to what is inside it, so it stays at the foot of the
  panel while the conversation moves through it.
- **The ramp ends at the dock's top edge, and must not run inside it.** Fading within
  the dock leaves everything above the box at full strength and then stops it dead on
  the box's edge — the same hard cut the old border made, drawn in text instead of a
  line. That was the first attempt and it looks like no fade at all. `--dock-fade` is
  therefore added to the transcript's bottom padding as well, so the last message comes
  to rest exactly where the gradient begins: clear of the box, and at full strength.
- **`--dock-h` is measured, never assumed.** The box grows with the message, chips come
  and go, a permission card can double the dock's height, and both the clearance and the
  fade are derived from it. A `ResizeObserver` rewrites it. `measureDock` reads
  `atBottom()` *before* changing the padding and restores it after, or a reply streaming
  into a box that is itself growing walks away from the bottom a line at a time.
- **Pointer events are off on `.dock` and on again for `.dock > *`.** The space around
  the box belongs to the conversation underneath, so scrolling beside it still moves the
  chat. This is also why `.composer` carries `margin` rather than `padding` — padding
  would be part of the form and would swallow the pointer. `.slash-menu` lost its
  `var(--gap)` inset in the same move, because that inset was the padding.

**`#permission-bar` and `#change-bar` are siblings of the composer, not children of it.**
They still sit between the transcript and the message box, and still for the reason each
gives — a question blocking the turn, and a decision about what it changed, neither of
which may scroll away. But inside the composer's border they read as a toolbar bolted to
the thing you type in, when they are the last word of the conversation above it. Out there
they carry their own `margin: 0 var(--gap) var(--gap)`, which the composer's padding used
to supply.

**A second live status line was tried and reverted.** The turn's progress was duplicated
onto a `.activity` line — first pinned between the transcript and the composer, then at the
foot of the agent bubble — on the reasoning that the steps header scrolls out of sight
behind a long reply. Both were worse than the header they were meant to help: the pinned
one read as part of the message box rather than as something Kiro was saying, and the
in-bubble one either repeated the header word for word or forced the header to give up
naming the step to avoid it. The header remains the single live status. If this comes up
again, the thing to fix is the header, not a second place to look.

**Neither is `isWriteLikeTool`, and for the same reason.** It used to gate the pre-turn
snapshot in `observeToolPaths` (called `observeDirectFileWrite` until 0.25.0, when it
stopped being only about writes). A tool shape it did not recognise meant no baseline, so
no review and no keep-or-undo card — the edit just appeared on disk. Every path any tool
mentions is snapshotted now, and `finishDirectFileReviews` walks `toolTouchedPaths` and
reviews whatever differs from its baseline; the heuristic only decides whether to
*simulate* a result. `pathsMentionedBy` reads `locations`, `rawInput.path` and
`rawInput.operations[].path`, because Kiro uses all three and only the middle one was
being read.

**A snapshot and a review are not the same entitlement.** Every mentioned path is
snapshotted; only a path from a tool that *might* have written joins `toolTouchedPaths` and
so earns a diff. `isReadOnlyTool` (`writeTools.ts`, beside its counterpart) returns false for
anything it does not recognise — an unknown tool is assumed to have written, which is what
keeps the paragraph above true. Only `read`/`search`/`grep`/`glob`/`list`/`fetch`/`think` opt
out, and their changes still reach the keep-or-undo card. Without that split, a file Kiro
merely read opened a diff whenever a watcher or formatter rewrote it mid-turn, and rejecting
it would have clobbered a write Kiro never made.

Baselines taken from prompt attachments are deliberately **not** in `toolTouchedPaths`. A
file gets a snapshot either because a tool touched it or because the user attached it, and
only the first means Kiro was working on it — reviewing the second would offer to undo the
user's own mid-turn edit.

**Reviews open as the edits land, and `finishDirectFileReviews` is now the sweep
rather than the whole story.** Every diff used to wait for `session/prompt` to resolve, so
a three-file turn showed nothing while it worked and then three diffs in a row, each about
an edit made some time ago. `reviewFinishedTool` acts on a `tool_call_update` carrying a
terminal status — that is the only notification carrying a status at all — and puts that
call's paths on `reviewQueue`. Four things there are load-bearing:

- **`toolCallPaths` exists because a `tool_call_update` may be little more than an id and
  a status.** The `rawInput` and `locations` that named the file arrived on the earlier
  `tool_call`, so without the map there is nothing to review when the step reports it
  finished. `settledToolCalls` is what stops a repeated terminal status reviewing twice.
- **`queueLiveReview` is deliberately not awaited.** It is reached from
  `handleNotification`, which runs inside `AcpClient.dispatch` and is synchronous by
  design; a throw there costs every remaining notification in that stdio write. The queue
  owns the errors and `finishDirectFileReviews` awaits it before sweeping.
- **Every review restores the file before opening, live ones included — and that is not
  negotiable, because Ctrl+Z depends on it.** 0.32.0 briefly had the live case leave Kiro's
  version in place, reasoning that putting a file back under a running agent leaves its
  next `strReplace` looking for text that is no longer there. It cost undo, silently: Kiro
  CLI writes the file itself and a raw disk write is invisible to the editor, so accepting
  everything produced content identical to what was already on disk, `applyDecision`
  short-circuited, no workspace edit ran, and the document gained no undo entry. The
  existing "accepted change is written through the editor" test passed throughout — it
  only drives the end-of-turn path. The desync is handled where it actually can be: the
  permission gate holds Kiro's next edit until the review queue drains. Every ending that
  *reverts* rather than reviews — cancelled, writes off, Plan mode — still stays at the end
  of the turn, which is what `liveReviewsEnabled` encodes.
- **`reviewBaselines` is not `turnBaselines`.** A turn baseline is the file before Kiro
  started and must stay that way: the keep-or-undo card and `undoLastTurn` restore from
  it. A review baseline moves forward every time a review settles, so a file edited twice
  in one turn shows its second diff against what the user just agreed to. Without the
  split the second diff re-proposes the hunks they already accepted, with nothing to tell
  those apart from the new edit. `rememberReviewBaseline` reads the file back rather than
  recording the decision, for the reason `createReviewApplier` re-reads: format-on-save
  changes the bytes on the way through.

**The one-gate skip is also what serialises Kiro.** `askPermission` awaits `reviewQueue`
before letting a write-like tool through without a prompt. Kiro is blocked on that reply,
so it is the only lever that stops the next edit starting while the last one is still on
screen — otherwise reviewing as edits land is merely a change of timing, and the applier
refuses every hunk already clicked on a file Kiro has since rewritten. It waits on the
queue *as it stands*, never as it becomes, or the edit would wait for its own review.
`kiroChat.reviewDuringTurn` is the kill switch and is deliberately **not** one of
`EditGates`: `editModeOf` reads four named keys, and adding a fifth would report every
mode as `custom`.

**`DirectFileChange.expected` is a hint, never a gate.** It simulates what a tool input
should produce, chained across every edit to a file in the turn. It used to have to match
the file byte for byte or the review was abandoned — which drifted for ordinary reasons
(several edits to one file, a replace modelled differently) and then skipped the review
*while leaving Kiro's edit on disk*. An unreviewed edit is the one outcome nobody wants.
The review now always compares what is on disk against the pre-turn snapshot; a mismatch is
logged, not acted on.

Kiro CLI 2.21 does not use that callback for its built-in `FileWrite` tool: it writes the
workspace itself. `KiroSession` therefore snapshots attached files at turn start, captures
other paths from edit tool updates, and at the end of the turn restores their baselines
before opening `ChangeReviewer`. The prompt stays busy until those reviews settle. Keep the
callback path and the built-in-tool path covered; different Kiro versions use different
ones.

The extension advertises `terminal: false` in its client capabilities, so Kiro never asks to run shell commands.

## Slash commands

**The list is Kiro's, and it announces it.** `_kiro.dev/commands/available` arrives right
after `session/new` with all 25 commands, each carrying `description` and a `meta` holding
`hint`, `subcommands`, `hidden` and `local`. It was being dropped on the floor, which is
why the panel could reach none of them. `slashCommands.ts` (free of `vscode`, so
`test/slashCommands.test.js` drives it) parses that notification; the fixture in
`test/fixtures/kiro-commands.json` is the real payload, captured by driving `kiro-cli acp`.
Hard-coding the list would go stale silently — an unknown name is refused by
`commands/execute` as a *parse error*, which is not a thing to show someone who picked it
off a menu.

**Compare the method through `bareMethod`, always.** The notification arrives prefixed.
`isSessionUpdate` already stripped `_kiro.dev/` for exactly this reason and now shares that
one helper; every new `handleNotification` branch must use it, or it works on one Kiro
build and silently stops on the next.

**`{ value }` is how an argument reaches a command**, and it took the oracle to find it.
`/help` says `Usage: /rewind` — no arguments — and `_kiro.dev/commands/options` answers with
an empty list for it, so `execute` is the only way in. Guessing `{ index: 0 }` looked like
it worked: it returned `success: true` with the turn list, because an argument Kiro does not
recognise is *ignored* and the command re-lists. Only `{ value: "0" }` actually rewound.
**A command that succeeds is not proof the argument was read** — check the effect, not the
status.

`_kiro.dev/commands/options` also takes `command` as a plain string, while
`commands/execute` takes the adjacently-tagged `{ command: { command, args } }`. Those two
are not the same shape.

**Not every command belongs in a webview.** `NOT_IN_PANEL` names them with the reason:
`paste` wants a clipboard, `voice` a microphone, `reply` `$EDITOR`, `quit` kills the process
the panel is talking to, `chat` is a competing conversation store. `local: true` marks the
ones the CLI answers itself; `hidden: true` (only `stats`) means do not advertise, not do not
run — it stays typeable. A menu row that hangs is worse than one that is absent.

**A leading slash is only a command when the name is one Kiro has.** `parseSlash` in
`chat.js` checks the known list first; without that, "/usr/bin/env is on my PATH" is eaten
instead of sent. That is an affordance for opening the menu — the gate is the provider
re-checking against `session.availableCommands`, so a `runCommand` that did not come from
the composer cannot reach `execute`.

**There is one parser, and it is the webview's.** `src/slashCommands.ts` briefly also held
`parseSlashInput` and `matchCommands`, with tests. Nothing called them: the shipped
behaviour was the `chat.js` pair all along, so those tests could have stayed green over a
broken panel — and once the composer had to recognise `/quit` in order to explain it, the
two copies deliberately disagreed while the tests still asserted they agreed. Both are gone
and `test/webview.test.js` drives `parseSlash` and `matchSlash` out of `chat.js` with
`sliceFrom` and a `new Function` binding for `slashCommands`. **When a rule has one
implementation, test that one** — the twin pattern (`formatCredits` / `credits()`) is for
when both copies actually run.

**A command result is not an agent message.** `/usage` returns a table and `/tools` a list;
in a reply bubble either reads as something the model said in a turn nobody started. They
get `.command-card` and `role: "command"` in the transcript, drawn by one renderer shared
with `restoreHistory` — the permission card's rule again.

**And it is not markdown either — it is terminal output.** `/help` returns 51 lines whose
two columns are held apart by runs of spaces; every one fell through `renderMarkdown` to the
paragraph branch, so it arrived as 51 `<p>`s with a margin between each *and* with the runs
of spaces collapsed by HTML, running every name into its description. `/tools`, `/model`,
`/agent` and `/context` are the same shape. `renderCommandOutput` splits on a newline —
multi-line is preformatted inside `.command-out`, which scrolls on its own the way
`.table-wrap` does; one line is prose, because every one-line answer ("Conversation too
short to compact.") is a sentence and reads worse in a monospace block. **Test the card, not
just the renderer**: the first pair of tests drove `renderCommandOutput` directly and went on
passing with `addCommandCard` switched back to `renderMarkdown`, one line away.

**`/help` is answered from the command list, not from Kiro's text dump.** Even preformatted
it is a 70-column table needing sideways scrolling on every line of a sidebar, and it
advertises the six commands the panel will not run. `addHelpCard` lays out the same data —
`commands/available`, which is where the menu comes from, so it is not a second source — and
names the unavailable ones with their reason. Rows are real buttons going through
`acceptSlash`, so a row behaves identically in the card and in the menu; the unavailable rows
are plain divs sharing `.help-line` for layout but not `.help-row`'s hover, because a tint on
something that does nothing implies it does something.

**No command is offered or sent while a turn is running.** `submit()` has always refused to
send a message while busy, but the menu answered Enter itself and went straight to
`runSlash` — so mid-turn, with Send disabled, Enter on the menu fired a command Kiro then
refused with "Kiro is still working on the last message." `setBusy` disables Send and not
the textarea, so the box keeps focus for most of a turn and this was easy to reach. Two
guards, because there are two kinds of surface: `updateSlashMenu` simply does not open (an
affordance that is not there needs no explanation), and `runSlash` answers with a card (a
`/help` card outlives the turn and its rows are real buttons — a visible control that goes
quiet when clicked looks broken).

**One "Running…" card at a time.** The provider's `onDidReceiveMessage` handler is async and
not serialised, so two commands started in quick succession both post `commandRunning`
before either answers. `runningCommand` moved to the second card, the first said "Running…"
for the rest of the session, and its result arrived as a *third* card — the same command
shown twice, one of them spinning forever. `case "commandRunning"` retires the previous card.

**The slash menu declares `role="listbox"`, and the mode and model menus still must not.**
Their objection is that a container role promises arrow-key navigation they do not implement
and puts a screen reader into a mode where Tab stops working — and Tab is their navigation.
Every fact is reversed here: focus never enters the slash menu, the arrows really are its
navigation, and `aria-activedescendant` is only meaningful pointing at an `option` inside a
listbox. The test that guarded this was global over `chat.js` and is now scoped to
`renderModeMenu` and `renderModelMenu`, which is what it was ever about.

**But the composer is not a combobox, and takes no `aria-expanded`.** That state is not one
the `textbox` role supports; the only way to make it valid is `role="combobox"` on the
textarea, which would have the message box announce as a picker — and drop "multi-line" —
for the whole session, in exchange for the moment a menu is open. `aria-autocomplete`,
`aria-controls` and `aria-activedescendant` are all legal on a textbox and carry the part
that matters: which row is current, and by going away, that the list has closed. Shipped
wrong in 0.30.2 and corrected in 0.30.3; a test now forbids both spellings.

**No backticks anywhere in `html()`.** The whole page is a TypeScript template literal, so
one inside an HTML comment ends the string — a comment naming `aria-activedescendant` in
backticks broke the build. A test asserts the markup contains none.

**The webview is sent the whole list, flagged, not just the offerable part.** It was sent
only `offerable()`, so it could not *recognise* `/quit` — which meant the message path took
it and the word "/quit" went to the model as a prompt nobody wrote, and was charged for.
`/help` advertises exactly those commands, so it is the natural thing to try next. `offered`
drives the menu, `runnable` drives the parser, and `reasonNotOffered` supplies the sentence
the card shows instead of posting anything.

**What a command changed has to be believed.** `/clear` empties the panel's transcript too,
or the user is offered a conversation Kiro can no longer be asked about; `/model` goes
through `noteModelChanged`, which updates the button but deliberately does *not* write the
setting — `setModel` remembers a choice, and a command typed into one conversation is not a
new default. Only `contextUsagePercentage` is taken off a command result, never the credit
figure: a command's own cost is not the conversation's spend, and folding it into
`sessionCredits` would inflate the strip every time the menu was used.

### Rewind forks; it does not truncate

Measured against kiro-cli 2.20.2. `/rewind` with no argument answers with
`data.turns` — `logIndex`, `label`, `group`, `responseSnippet`, newest first. `/rewind` with
that `logIndex` under `value` answers with `data: { sessionId, switchSession: true }`.

Three things follow, and each one is load-bearing:

- **The chosen turn is kept.** With ALPHA, BRAVO and CHARLIE in the log, rewinding to BRAVO
  forked a session holding ALPHA *and* BRAVO. `turnsKeptByRewind` encodes that; getting it
  backwards trims one turn too many every time.
- **The forked session is not loaded.** Running a command against the new id answers
  "Unknown session id" until `session/load` has been called, so the load is part of
  `rewindTo`, not an optional follow-up.
- **`chatSessionId` must move with it.** The conversation afterwards has a different id;
  leaving the record on the old one resumes the un-rewound original next time the chat is
  opened — the wrong-session bug `openChat` guards against from the other end.

The transcript is trimmed by counting **user messages**, not log indices: the panel's entries
and Kiro's log are two different numberings, but "the first N things I said" is the same span
in both. A transcript holding fewer user messages than Kiro kept is one whose head has been
trimmed from storage — nothing is removed, because removing anything would be guessing.

**`session/load` really does replay the conversation.** This file used to record that a load
sent no replay, with the caveat that the session under test was empty. It is not empty now:
loading a forked session sent `user_message_chunk` and `agent_message_chunk` for every
surviving turn. `KiroSession.replaying` swallowing those is what stops the panel painting
each message twice, and it is not optional.

**`session/compact` and `session/fork` are not on the ACP surface.** Both strings are in the
binary and both answer "Method not found" over `kiro-cli acp` — they belong to the v3
WebSocket engine behind `kiro-cli serve`. Compaction and rewinding go through
`_kiro.dev/commands/execute` like everything else. Grepping the binary for method names is a
good way to find candidates and a bad way to decide one exists.

**A refused `session/load` is repaired once, and only against proof.** Kiro writes
`~/.kiro/sessions/cli/<id>.lock` holding the pid that opened a session, and refuses to
load one whose pid is still alive. It stores `started_at` beside the pid and never
compares it, so a number Windows has reissued reads as the original owner and the chat
is unreachable permanently. `AcpClient.stop` kills the agent with `taskkill /t /f`, so
Kiro never removes its own lock — every session the panel opens leaves one, and it is
only the recycled ones that bite. `clearStaleSessionLock` deletes the file and retries
exactly once. Four things there are load-bearing:

- **`isStaleLock` (`sessionLocks.ts`, free of `vscode`) defaults to leaving the file
  alone.** Three findings count as proof: nothing runs under that number, what runs is
  not `kiro-cli`, or it started more than a second after the lock was written. Anything
  else — a running Kiro with no readable start time, a lock with no timestamp, a process
  we could not identify — is a refusal. Deleting a live session's lock puts two agents
  on one conversation, which is worse than the fault being fixed and invisible from the
  panel.
- **"Gone" must be said, never inferred.** `readFacts` returns `{ running: true }` for
  every answer it cannot read, because a lookup that failed is not evidence a process is
  dead. `JSON.parse("null")` succeeds and reading `running` off it gives `undefined`,
  which under the obvious `!== true` test reads as proof of death — that shape shipped
  in a first draft and a test caught it.
- **The match is on Kiro's sentence, not on the error code.** The failure arrives as
  -32603 "Internal error", which is also every other internal error, so `lockedPidFrom`
  keys on "Session is active in another process (PID n)". The pid it finds must equal
  the pid in the file, or the lock has been rewritten since the refusal and describes a
  claim nobody tested.
- **`rpcError` in `acpClient.ts` is what makes any of this possible.** A JSON-RPC error's
  real content is in `data`; only `message` was being kept, so the reason was destroyed
  at the door — the user saw "Internal error" and the repair had nothing to match on.
  It is folded into the message *and* kept on the error object.

### Kiro-specific protocol quirks

These are the things that were expensive to discover; the comments in `kiroSession.ts` cover them at length:

- **Updates arrive under two method names.** `session/update` carries `tool_call`,
  `tool_call_update` and every `agent_message_chunk`; **`_kiro.dev/session/update` carries
  the `tool_call_chunk`**. `isSessionUpdate` strips an optional `_kiro.dev/` / `kiro.dev/`
  prefix and must keep doing so — matching only the bare name rejected every
  `tool_call_chunk` at the door, so the panel had nothing to show for the whole gap before
  a step's real title arrived. `_kiro.dev/metadata` has the same shape and is why both
  spellings were already named there. **Assume any Kiro notification may carry the
  prefix.**
- **A step is announced three times, and the first one matters.** Measured by driving
  `kiro-cli acp` directly: `tool_call_chunk` fires the moment Kiro decides to use a tool
  and carries **only the kind as its title** (literally `"read"`) and no status;
  `tool_call` follows with the real title (`"Reading package.json:1"`), `locations` and
  `rawInput`; `tool_call_update` finally carries `status`. All three share a
  `toolCallId`, so they collapse to one row. Handling only the last two left the panel on
  "Working…" for the whole of the first gap, which is the part of a turn that feels
  longest. `describeTool` translates a title that is nothing but the kind through
  `TOOL_VERBS`, and a real title always wins. `rawInput.__tool_use_purpose` is Kiro's own
  note on *why*, and is the reason the steps list is worth unfolding.
  `test/toolSteps.test.js` pins all of this to the captured payloads.
- **`runCommand`** hits `_kiro.dev/commands/execute` with an adjacently-tagged enum: `{ sessionId, command: { command: "usage", args: {} } }`. A plain string, or a name with a leading `/`, is rejected outright.
- **`textSpy`** — Kiro's own commands narrate through the ordinary `agent_message_chunk` stream. The spy diverts that so command output doesn't land in the transcript as if the user had asked for it.
- **Credit rates need a second call.** The model list returned by `session/new` carries no rate; only the `model` command has `rateMultiplier` and the context window. `enrichModels()` fetches it in the background after connecting.
- **The usage meter arrives two ways** — as a `_kiro.dev/metadata` notification, and sometimes bolted onto an ordinary `session/update`. `handleNotification` reads both; dropping either leaves the usage strip blank for a whole conversation.
- `session/prompt` is sent with the payload under **both** `prompt` and `content`, because Kiro's docs and the ACP spec disagree on the field name.
- The five composer workflows live in `chatModes.ts`. They are explicit prompt instructions,
  rather than claims that Kiro ACP natively exposes all five. Plan additionally passes
  `readOnly` to `KiroSession.send`; callback writes are refused and direct CLI writes are
  restored at the end of the turn.

### What kiro-cli 2.20.2 actually reports

Measured by driving `kiro-cli acp` directly, not read from docs:

```
agentCapabilities: {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: false },
  mcpCapabilities: { http: true, sse: false },
}
```

- **`loadSession: true`, and session ids survive the CLI process dying.** A session created by one process loads in a fresh one, which is what makes chat history able to resume rather than just replay.
- On load, Kiro sent no conversation replay — only `_kiro.dev/subagent/list_update`. The session under test was empty so that isn't conclusive, which is exactly why the panel redraws from its own stored transcript and `KiroSession.replaying` swallows `session/update` during the load call. If Kiro does replay, you get it once, not twice.
- Kiro also reports three native mode ids (`kiro_default`, `kiro_planner`, `kiro_guide`).
  They do not map one-to-one to the five composer workflows, so the workflow picker remains
  explicit and deterministic instead of presenting incompatible ids as the same feature.

## Chat history

Records live in `context.globalState` under `kiroChat.history`. The transcript itself is maintained by the **webview** (it already did, for surviving panel moves) and posted up as a `transcript` message after each turn — one source of truth rather than accumulating chunks in the extension host too.

Chats are filtered to the open folder, because Kiro binds a session to its `cwd` and a chat from another project cannot meaningfully resume. `forWorkspace` normalises Windows path spellings; comparing raw strings would silently hide the user's own chats.

A chat whose `session/load` fails still shows its transcript, but the composer locks — replying would otherwise start a *different* conversation without saying so.

**A transcript the extension handed down must not be reported back.** `saveState(false)`
in the webview's `openChat` case exists for that. `openChat` posts the stored transcript
and *then* awaits `session/load`; the webview's report beats a 30-second ACP request every
time, so reporting it re-saved the record mid-load — stamping it with `updatedAt: now` (a
chat jumped to Today for being read) and with `session.currentSessionId`, which was still
the *previous* chat's. Reopening it after that resumed the wrong conversation. The
provider guards the same thing from its end: `chatSessionId` is pinned from the record
before the post, and `saveCurrentChat` prefers it over the live session.

**Three paths begin a chat and all three go through `beginFreshChat()`** — the `+` button,
`retry` on the setup screen, and `onWebviewReady` with a blank panel. It archives the
outgoing chat, rotates `chatId`, and clears the transcript. The last two used to do none
of that, so the next conversation was written into the previous chat's record and
`upsertRecord` replaced it; the old chat vanished with no delete. `test/webview.test.js`
asserts all three call it.

**Titles are sticky (`stableTitle`).** Only the last `MAX_HISTORY` messages are stored, so
re-deriving the name from the saved transcript renamed a long chat the moment its opening
message fell out of the window. Only the `New chat` placeholder may be replaced. Where the
tail is all that survives, `truncated` rides along and the panel says so rather than
appearing to begin mid-conversation.

**Only the pending chat is held in memory, never the list.** `saveCurrentChat` runs per
message and each write serialises every stored transcript, so writes are debounced through
`pendingChat` + `scheduleFlush`. `flushChats` re-reads the list with `allChats()` at write
time on purpose: caching it would let a second VS Code window's saves be overwritten by
this one's stale copy. Anything that must not lose a save — `dispose`, `deleteChat`,
`openChat`, `postHistory`, `beginFreshChat` — calls `flushChats()` first.

`pruneHistory` caps chats **per folder**, because the list only ever shows one folder's;
a global cap let a busy project evict a quiet one's history.

## Images

`postAttachments` sends a `data:` URI as `preview` for image attachments; the page's CSP already allows `data:` for `img-src`. It previously stripped `data` entirely, which is why images showed as filenames. Over `MAX_PREVIEW_BYTES` no preview is sent and the chip falls back to text — the thumbnail is rendered ~22px wide and is not worth pushing megabytes through `postMessage` for.

Image thumbnails in sent messages and composer chips open `openImagePreview` in
`media/chat.js`. It reuses the preview URI in a native modal dialog, with fit and
actual-size modes, Escape dismissal, and focus restoration. Keep the thumbnail
inside a button for keyboard access; composer chips already supply that button.
The viewer lives entirely in the webview and needs no extension-host message.

### Modules kept free of `vscode` on purpose

`src/usage.ts`, `src/setupWatcher.ts`, `src/startupError.ts`, `src/history.ts`, `src/promptBlocks.ts`, `src/editModes.ts`, `src/sessionLocks.ts`, `src/processFacts.ts` and the `needsShell`/`quote` exports of `src/acpClient.ts` have no `vscode` import so the tests can `require("../out/...")` directly. There is no VS Code test harness in this repo — that constraint is the entire testing strategy. Keep new parsing and logic modules importable without `vscode`.

`setupWatcher.ts` additionally takes its timers through an injected `Scheduler`, so `test/setupWatcher.test.js` drives the whole state machine without waiting out a real interval. Follow that pattern for anything else that polls.

**The file/selection duplication has to be fixed in three places, and they are not
independent.** `buildBlocks` (what Kiro receives), `renderChips` (the row above the box)
and `addUserBubble` (the tags under a sent message) each build that list separately, so
fixing one leaves another showing `media/chat.js` beside `media/chat.js:23-27`. The rule
is *one mention per file, narrowest wins*: a file the selection block already names is
not also listed above it. The two webview lists name files with `fileName()`, keeping the
path in the tooltip.

Two asymmetries in that rule are deliberate:

- **Only the automatic file may be stood in for on screen.** `renderChips` suppresses the
  `◎` chip, never an attachment chip: a chip is a control, and removing one because of a
  transient highlight takes away the × that removes the file. `addUserBubble` reads
  `source === "active"` for the same reason — a file attached by hand is still sent as its
  own `resource_link`, so hiding its tag would leave no record in the transcript that it
  went.
- **`buildBlocks` drops the *text* mention, never the link.** The resource_link is how Kiro
  opens the file; the list entry only makes the path visible. The entry is what duplicated,
  so the entry is what goes.

**Three sources feed one message, and `source` is what tells them apart.**
`attachmentsForMessage` appends the focused file to whatever was attached by hand, dropping
it when the same file is already there (`samePath`, so Windows spellings match). The
automatic one carries `source: "active"`, which is what stops `buildBlocks` listing the
tab that merely happens to be focused under "Files to look at" beside files the user chose
— "update these files" quietly took in the focused one. With `kiroChat.sendSelection` off
it gets its own line instead, saying what it is.

**Attachments outlive the message; images do not.** The row used to be emptied after every
send, so "add another file to the context" held for exactly one message — and because the
`◎` chip comes back on its own, the row still looked populated while the rest had silently
gone. Files and folders now stay until removed. An image is consumed, because its base64
rides in the prompt itself and a sticky one re-sends megabytes per turn for a picture Kiro
has already seen. What survives is marked `carried`, which is what stops Enter on an empty
composer starting a whole turn out of chips that already went; attaching something new
clears the mark, because "look at these" with no words is a real message — once.

**A chip may only stand in for something that is actually going.** `sendingSelection` (are
the highlighted lines going?) and `selectionCoversActiveFile` (may the selection chip stand
in for the file chip?) are two questions, and collapsing them into one shipped a lie:
dismiss the `◎` chip with its ×, then highlight something in that same file, and the file
chip vanished behind a selection chip whose tooltip promised Kiro was getting the file
while no `resource_link` went out — with the × that would have said otherwise now off
screen. The second condition therefore ANDs in `includeActiveFile`, and the selection
chip's tooltip branches on it too.

**The selection chip reports state; it is not a control.** It carried an × that stopped
the highlighted code being sent, which left the editor showing a selection the panel had
decided not to send — and no way to tell from either side which was true. Clearing the
highlight is the only way to stop it, so `includeSelection` is now driven solely by the
`kiroChat.sendSelection` setting and nothing in the webview writes to it. The chip also
shows only the basename (`fileName()`); the full path stays in the tooltip and in what is
sent to Kiro.

`promptBlocks.ts` holds the last handling of the user's own text before it leaves, so it
takes its URI maker as an argument rather than importing `vscode`. Three rules there each
fixed a way Kiro was told something untrue, and all three are load-bearing:

- **`canReadSelectionFrom` is a scheme allow-list, not a deny-list.** It used to exclude
  only `output`, so the change-review tab (`kiro-change-review:/<id>/chat.js (Working
  Tree)`) counted as the file being looked at — clicking in a diff, which is how its
  keybindings are used, then made the next message claim a path that exists nowhere. Git's
  sides and search editors are the same shape of mistake.
- **`fenceFor` beats the longest backtick run in the selection.** A fixed ``` fence is
  ended by the first such line inside the code, so a markdown file or a template literal
  spilled the rest of the message out of the block and Kiro read the user's code as prose.
- **`clipSelection` reports that it clipped**, and `buildBlocks` says so beside the line
  range. Naming lines 26–480 over the first 12k characters claims Kiro has all of it.

`usage.ts` is deliberately defensive and **never invents a number**: a multiplier is only read as a credit rate when it sits next to the word "credit", and prose parsing only considers lines that mention credits. Preserve that when touching it.

**`UsageInfo` holds two scopes, and which is which is written down.**
`contextPercent` and `sessionCredits` describe the conversation in front of you;
`planName` and the three `account*` fields describe the account and survive any number of
chats. They share one flat object because that is what the panel draws from, so
`SESSION_USAGE_KEYS` and `clearSessionUsage` are what let a reset tell them apart. Not
having that cost twice: `newSession` did `usage = {}` and wiped the plan figures you had
just fetched, and `loadSession` reset nothing, so "2.47 credits this chat" stayed on the
strip while you read a different conversation. Both call `clearSessionUsage` now. A past
chat's own credits are not stored anywhere, so nothing is put back in their place — no
number is honest where a wrong one is not.

**Every credit figure goes through one formatter.** `formatCredits` (and its twin
`credits()` in `chat.js`, which cannot import it — no build step) rounds to at most two
decimals and drops trailing zeros. Session credits used to be `toFixed(2)` and account
credits were concatenated raw, so a plan total arrived as `1234.5678901234 credits on Pro`.

**The context panel shows Kiro's own breakdown, and the category totals really are
available.** This file used to say "do not infer category totals or compaction buffers",
which was right about the *meter* — one percentage is all it carries. `/context` is a
different source and carries the rest. Measured by driving `kiro-cli acp`:
`{ command: "context", args: {} }` answers with `contextUsagePercentage`, `model`, and a
`breakdown` holding `contextFiles` (naming each file, with `matched: false` for one it
looked for and did not find), `tools` (nested one level deeper, under `groups`),
`kiroResponses`, `yourPrompts` and `sessionFiles` — each with `tokens` and `percent`.
`{ value: "show" }` returns identical numbers and only flips `initialExpanded`, so the
plain call is the one to make. `test/fixtures/kiro-context.json` is that captured payload
and `readContextCommand` in `usage.ts` (free of `vscode`) parses it.

Four things there are easy to get wrong:

- **`Number(null)` is 0, and 0 is a valid percentage.** A missing reading passed through
  the obvious coercion arrives as the confident claim that the context is empty, so
  `readContextCommand` guards the percentage exactly as `readMeter` does. A test drives
  every shape of nothing through it.
- **Only the percentage is ever taken off a command result**, never a credit figure: a
  command's own cost is not the conversation's spend, and folding it into `sessionCredits`
  inflates the strip every time the panel is opened.
- **The panel asks on every open, unlike account usage.** `/context` is answered locally
  and instantly; `/usage` is a billing round trip and stays behind its button. A breakdown
  is cleared when a chat is cleared or another is opened — it describes the conversation it
  came from.
- **A command cannot run during a turn**, so this fails while Kiro is working. The reason
  is shown under the last breakdown rather than blanking the panel, because it is temporary.

`ModelInfo.contextWindowTokens` still supplies the capacity the headline is measured
against. The 80% and 95% thresholds are one line of advice and trigger nothing. Unknown
usage still reads "not reported" rather than zero. Model and usage updates redraw an open
panel.

**The panel is figures, not prose.** It used to derive four rows from the meter percentage
times the capacity and sit them under two paragraphs explaining that the categories were
unavailable and the tokens were estimates — an apology where the numbers should have been.
The account half likewise reprinted Kiro's own `/usage` text, which is a paragraph wrapped
into a strip three inches wide, when the three figures anyone opens it for were already
parsed on the way to that strip. The raw report is shown only when nothing could be parsed
out of it, because then it is all there is.

## Webview constraints

**The webview tests are static analysis.** `test/webview.test.js` reads `media/chat.css`, `media/chat.js` and `src/chatViewProvider.ts` as *text* and asserts invariants with regex. Editing markup or CSS can therefore break tests in non-obvious ways. Current invariants:

- `[hidden] { display: none !important }` must sit **above** the component rules in `chat.css`. Author `display` rules outrank the browser's own `[hidden]`, so without the override the attach menu, drop overlay, usage strip and chip row are painted permanently. Four elements are toggled this way: `#chips`, `#usage-bar`, `#dropzone`, `#attach-menu`.
- `.dropzone`, `.chips`, `.usage-bar`, `.popup`, `.usage-panel` each get exactly one rule block.
- `.usage-bar` is a `<button>` (it toggles the account panel) and must keep opting out of the global `button` styling, or the whole strip paints in the primary colour.
- **`.composer-row` sets `--control-h` and every control in it takes that height.** They used to be sized three different ways and none of them lined up. Anything added to that row takes `--control-h` too. `.icon` also joined the `[hidden]` list above when Stop became an icon button: it is toggled with the `hidden` attribute and carries `display: inline-flex`, so it must stay below the `[hidden]` override.
- **A plain-looking button must cancel `button:hover`, not just `button`.** `background: none` on a class beats `button`, but `button:hover` is a type plus a pseudo-class — specificity (0,1,1) — and outranks any single class, so the element sits transparent at rest and then paints solid primary blue under the pointer. This shipped four times (`.usage-bar`, `button.change-summary`, `.history-open`, which covered the row's own hover tint with a blue slab, and `.chip-muted`). One test walks every rule declaring both `background: none` and `border: none` and requires a matching `:hover`.

**That test catches only the spelling, which is how the fourth one got in.** `.chip-muted`
says `background: transparent` and keeps a dashed border, so it matched neither half of
that pair. The question is not how "no background of my own" is spelled — it is whether an
element that VS Code will paint on hover has said otherwise. The second test therefore
reads the `className` off every `document.createElement("button")` in `chat.js` and
requires that, if any of its classes restyles the background, one of them carries a
`:hover`. Per element, not per class: `.chip chip-muted` is covered by `.chip-muted:hover`.
A hover rule need not be bare `.name:hover` either — `.permission-option:hover:not(:disabled)`
counts, and a descendant rule deliberately does not.
- Menus are anchored inside positioned parents (`.attach-wrap`, `.input-shell`, `.composer`) so they can't spill out of a narrow sidebar.

**CSP is nonce-based** (`script-src 'nonce-...'`), so there are no inline handlers in the HTML — everything is wired up in `chat.js`. Text from Kiro goes through `escapeHtml` before the small hand-rolled markdown renderer runs, so a reply cannot inject markup.

**`renderMarkdown`'s `FENCE` pattern is anchored to a line, and must stay that way.**
Matching ``` anywhere meant a run of backticks *inside a sentence* — "uses longer fences
(````)", a snippet quoted mid-line, any answer about markdown — opened a code block and
swallowed the remainder of the reply into it. The more a reply discussed code, the more
likely it was to be destroyed. Two details that look removable and are not: the closing
fence is anchored too, and the unterminated branch is `(?![\s\S])` rather than `$` —
under the `m` flag `$` means end of *line*, which would cut every block at its first
newline, and a streaming reply is unterminated for as long as it is arriving. Line
endings are normalised to `\n` before any of this runs, because the pattern consumed `\n`
after the language but not `\r\n`, leaving a carriage return that `<pre>` painted as a
blank line above and below every snippet.

**`renderMarkdown` handles GFM pipe tables, and the guard is the load-bearing half.**
Without table support every row fell through to the paragraph branch, so a table arrived
as one `<p>` per row with margins between and `|---|---|` printed as literal dashes —
which is most of any "here is the mapping" reply, and agents write those constantly. What
identifies a table is the **delimiter row**, exactly as GFM says, and its cell count must
match the header's: a line containing a pipe above a line of dashes is otherwise ordinary
prose over a horizontal rule, and turning that into a table is a worse bug than the one
being fixed. Rows shorter than the header are padded rather than dropped, because a
missing cell shifts every column after it. The table is wrapped in `.table-wrap`, which
scrolls on its own — a sidebar is three inches wide, and the alternative is a horizontal
scrollbar on the whole conversation.

**Text that resumes after a tool step starts a new paragraph.** Kiro says something, calls
a tool, then says something else, and all of it is appended to one `buffer` — so the two
ran together with no space at all: "…rather than guessing from names.I notice
RENEWAL_WINDOW_CLOSED…". Nothing in the stream marks where one message ends, but a step
starting is a boundary that can be seen, so `breakBeforeText` is set there and consumed by
the next chunk. It is set only where a tool row is **created**, never on a status update
for a step already listed: those arrive while text is still streaming and would split a
sentence down the middle, which is the same bug pointing the other way.

**`test/webview.test.js` can run the renderer, and should.** `loadRenderer()` slices
`escapeHtml` through `renderMarkdown` — contiguous and self-contained — and evaluates it,
so the table and fence tests assert on rendered HTML rather than on the shape of the
source. Prefer that to a regex whenever the thing under test is a behaviour.

**Do not slice a fixed number of characters out of a function to assert on it.** Nine tests
did — `slice(0, 2600)`, `slice(0, 2200)` three times, `slice(0, 1400)`, `slice(0, 1100)`,
`slice(0, 500)`, `slice(0, 400)` twice — and every one failed for a comment being added
above the line it wanted, which says nothing about whether the code is right. Slice to the
next `case`, the next `function`, the next `private`, or the end of the block.

**The code-block copy button is delegated, and it must stay that way.** A streaming reply
runs `body.innerHTML = renderMarkdown(buffer)` on every frame, so a listener bound to the
button is discarded several times a second and the control dies mid-reply. One listener
sits on `#messages` and resolves `closest(".code-copy")`. It copies `code.textContent` —
the rendered element — so what reaches the clipboard is exactly what is on screen, with no
second escaping pass to get wrong, and it re-checks `isConnected` before writing its
"copied" state because the button may have been replaced while the clipboard call was in
flight. When both clipboard routes are refused it selects the code and says to press
Ctrl+C; a button that silently does nothing is worse than no button.

**The turn's progress is shown where the answer will be, not on the status line.**
`startThinking()` runs on `userMessage` — not on the first chunk, which is the thing being
waited for — and starts a one-second interval so the header keeps counting *while the
reply streams*; the elapsed number is what separates a slow turn from a stuck one, so only
`finishAgentBubble` stops it. `finishAgentBubble` must also `clearInterval` on the bubble
it discards, or an abandoned timer ticks against a removed node forever.

The agent body must not be created with the `cursor` class, and the chunk handler toggles
it on `buffer.trim()`: a blinking block over an empty bubble claims a reply has started
when an empty first chunk is all that has arrived.

`updateStepsLabel` puts the *newest unfinished* step on that header — "Working…" answers
the wrong question while waiting; what the user wants to know is what it is doing. It runs
from the `tool` case, which also calls `startThinking()` itself, because a tool update can
arrive by a route that never posted a `userMessage`.

**The steps list was meant to be open while the turn runs and to fold when it ends** —
closed-by-default hid the one thing the list is for, watching Kiro read and edit — with
`steps.dataset.pinned` recording that the user had clicked the header so a list someone
opened on purpose would not fold itself up at the end of the turn.

**That is no longer what the code does, and it looks like a regression rather than a
decision.** `buildSteps` creates the list `hidden`, and the only thing that ever changes it
is the header's own click handler: nothing in the `tool` case opens it, nothing in
`stopThinking` closes it, and `pinned` is written but never read — which is the tell, since
`pinned` exists solely to protect an auto-fold that no longer happens. Whether to put the
behaviour back is a live question; until it is answered, **anything new in this list must
match what the rows already do and wait for a click**. Two things in one list behaving
differently is worse than either rule on its own. That is why `appendThought` unhides the
block but does not unfold it, and leans on the header — "Thinking…" during the turn,
"Thought in 4s" after — to say that something is in there.

**Kiro's reasoning is one block above the rows, on one line, with the control on that
line.** `openThought` prepends it and `appendThought` accumulates into it: one block per
turn, whatever order the chunks arrive in. `.thought` is a flex row holding `.thought-text`
and the toggle, aligned on `baseline` so the button sits on the same line as the text and
stays against the first line when the block is opened. Three things there are load-bearing:

- **The collapsed line is `white-space: nowrap` with `text-overflow: ellipsis`, not a
  clamped height.** A multi-line clamp cuts on a hard edge with nothing to say it was cut,
  and at this size the ellipsis is the entire affordance. `nowrap` also collapses the
  model's own newlines into spaces, so the line reads as one sentence instead of stopping
  wherever its first paragraph ended; `.thought-open` restores `pre-wrap`, because opened,
  those breaks matter again.
- **`syncThought` measures width, and has to be re-asked rather than answered once.** The
  test is `scrollWidth > clientWidth` while collapsed, and `open ||` keeps the button on an
  open block — which wraps, fits, and would otherwise lose the "Show less" that closes it.
  The block lives inside the folded steps list, and an element in a `hidden` container
  measures zero, so a thought that has been streaming for a minute reports that it fits.
  Unfolding the list re-asks; a `ResizeObserver` re-asks when the panel changes width.
- **`min-width: 0` on `.thought-text`**, or a flex item's floor is its own content and the
  line pushes the button off the edge instead of ellipsising — the same bug the workflow
  pickers had.

**Splitting the reasoning per step was tried in 0.34.0 and reverted.** `closeThought` ended
the open block whenever a `tool` row was created and handed its text to that step, so each
piece of reasoning sat directly above the step it led to, and it was stored per step so a
reopened chat could put it back there. The ordering was real — `kiroSession` forwards
`agent_thought_chunk` interleaved with the tool events, and flattening it does lose which
sentence went with which step. What killed it is what it looked like: prose, row, prose,
row, prose, five or six blocks each with a rule down its left and a button of its own, and
the list of steps stopped reading as a list. Watching Kiro read and edit is what the panel
is for, and a log interrupted between every line is harder to scan than the same words in
one place. If it comes back it needs a form that does not interrupt the rows. What survives
of it: `restoreHistory` still joins any per-step `thought` it finds, because chats written
by 0.34.0 hold the text in pieces and dropping them would lose reasoning the user could
read yesterday.

**`AcpClient.dispatch` is called inside a try/catch, and must stay that way.** Kiro often
writes several notifications in one stdio write; the read loop walks them in order, so a
throw in any handler used to abandon the loop and drop every remaining line in that write
— silently, and indistinguishably from Kiro never having sent them.

**The steps list folds, so nothing that needs an answer may live in it.**
`addPermissionCard` inserts before `bubble.body`, never into `bubble.tools` — a permission
card inside a closed list cannot be seen or answered, and the turn hangs waiting.
`renderToolRow(row, tool, phase)` is shared by all three paths: `"live"` shows a spinner
and *no* tick on finished steps (a column of them beside running work is noise), `"done"`
adds the ticks once the turn is over, and `"restored"` never spins, because a chat from
last week is not still working.

**Code blocks are coloured from the theme's own colour keys, not the editor's tokens.**
VS Code does not expose TextMate token colours to a webview, so `highlightCode` marks
comments, strings, numbers, keywords and call sites and paints them with
`--vscode-debugTokenExpression-*` / `--vscode-symbolIcon-*`, which are the theme's colours
for the same ideas. The tokenizer stays small on purpose — a wrong colour reads worse than
no colour — and the comment style follows the language (`//` is floor division in Python,
`#` is a colour in CSS). Everything still goes through `escapeHtml` before it reaches the
output; the spans are the only markup added.

**The webview is destroyed and rebuilt** whenever the user drags the panel between the sidebar, the bottom panel and the secondary sidebar. `chat.js` persists the transcript through `vscode.setState`, then posts `ready` with a `restored` flag; `onWebviewReady` branches on it — restored means leave the session alone, blank means hand the user a fresh connected chat. Anything that must survive a move has to live in webview state.

## Windows-only by design

Mac and Linux support was removed deliberately so there is one code path instead of three. `extension.ts` checks `process.platform` at activation and says so plainly rather than failing later.

- `findKiro.ts` searches install folders (starting `%LOCALAPPDATA%\Kiro-Cli\`), then `where kiro-cli`, then WSL.
- `acpClient.ts` routes `.cmd`/`.bat` shims through the shell — since Node 20, spawning one without a shell throws a bare `EINVAL`.
- `lifecycle.ts` clears a pinned `kiroChat.command` when the file no longer exists, since Kiro's own updates move the binary.

## Setup flow

`ChatViewProvider.runInTerminal` opens PowerShell and types the command with `sendText(command, false)` — **no trailing newline, on purpose**. The user presses Enter. Nothing runs behind their back; the README promises this. Don't "fix" it into auto-execution — the automation is in the *detection*, not the execution.

`onNeedsSetup` fires with `"missing"` (no binary found) or `"signin"` (found but the handshake failed) and shows the setup screen. From there `SetupWatcher` drives it: it polls `findKiro()` until the binary appears, then attempts the handshake itself, so the panel becomes a chat without the user clicking anything.

Three things this flow gets wrong easily:

- **`setupActive` in the provider.** Every failed handshake makes `KiroSession` fire `onNeedsSetup` again. Without the guard, each retry rebuilds the setup screen and wipes the progress the watcher just reported.
- **`leaveSetup()` hangs off the `ready` status, not off the watcher.** Pressing Connect, or restarting from the title bar, connects without the watcher saying anything. Dismissing the screen only on the watcher's `connected` strands the user on install instructions with a dead composer while Kiro is up.
- **`setBusy` defers to setup.** A `ready` status arriving mid-setup must not re-enable Send, so `setBusy` ORs in `setup !== null`.
