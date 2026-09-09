# Changelog

## 0.30.5

- **Session context details in the usage dropdown.** Click the usage strip above the
  conversation to see the current session's context percentage, model capacity, and used
  and remaining tokens. Token counts are estimates calculated from Kiro's reported
  percentage and model capacity; category totals and the compaction buffer are unavailable.
- **Guidance as context fills up.** At 80%, the meter turns amber and suggests considering
  a fresh session for a new task. At 95%, it recommends saving a summary before using **+**
  to start a new session. These are guidance thresholds, not automatic resets.
- **Unknown usage stays unknown.** A session with no reading shows "Context not reported"
  instead of an empty or inherited meter. Invalid readings are ignored, and the panel
  updates when Kiro reports new usage, including lower readings after compaction.
- **Account usage remains available separately.** Opening the strip shows session context
  immediately; **Check account usage** fetches the plan report underneath it.

## 0.30.4

- **Kiro's reasoning now has somewhere to go.** The extension has always translated Kiro's
  thinking-out-loud into a message for the panel, and the panel had no case for it — so every
  one of those went into the switch and vanished. It appears in the steps list now, above the
  tool rows, with the header reading "Thinking…" while the turn runs and "Thought in 4s"
  after. It is kept with the chat, so reopening one still shows the working.

  Nothing was actually being lost: measured against kiro-cli 2.20.2 on `claude-opus-4.7` with
  `/effort high`, against a puzzle written to force reasoning, 22 chunks of ordinary reply
  arrived and not one thought among them. But the words are in Kiro's own program file, so a
  future release could switch this on — and it would have switched on invisibly.

- **The both-halves check now covers every message, not just the slash commands.** That is
  the guard that would have found the above without a probe, and it is the third time this
  exact failure has been paid for: a message posted into a switch with no case for it is
  dropped in silence. Both directions are checked.

## 0.30.3

- **Fixed: invalid ARIA on the message box.** 0.30.2 put `aria-expanded` on the composer to
  report whether the command menu was open. A text box does not support that state — making
  it valid needs `role="combobox"` on the same element, which would have the message box
  announce as a picker, and lose "multi-line", for the entire session in exchange for the
  moment a menu is showing. That is the wrong trade for a box that is a message composer
  almost all the time.

  The attributes that are legal on a text box already carry the part that matters: which row
  is highlighted, and — by going away — that the list has closed.

## 0.30.2

Fixes found by reviewing 0.30.0 and 0.30.1 rather than by hitting them.

- **Fixed: a command could be fired mid-turn, and Kiro would refuse it.** Sending a message
  while Kiro is working has always been blocked, but the slash menu answered Enter itself
  and went straight to running the command — so with Send greyed out, Enter on the menu
  started something the panel already knew would fail. The menu no longer opens during a
  turn, and a `/help` card clicked mid-turn says "Kiro is still working on the last message"
  instead of going quiet.

- **Fixed: two commands in quick succession left one spinning forever.** The second
  command's card replaced the first as the one waiting for an answer, so when the first
  answered it appeared as a third card — the same command shown twice, one of them saying
  "Running…" for the rest of the session.

- **The command menu now reports itself to screen readers.** The arrow keys move a highlight
  while the cursor stays in the message box, which is a state nothing was announcing. The
  menu is a listbox, each row an option, and the message box points at the highlighted one.

  The mode and model menus deliberately declare no such role, and still must not: their
  reason is that it promises arrow-key navigation they do not implement and breaks Tab,
  which is how they are used. Every one of those facts is the other way round here.

- **Removed two functions nothing called.** `parseSlashInput` and `matchCommands` had tests
  pinning the rules for reading a typed command — but the code that actually runs is the
  composer's own pair, so those tests could have stayed green over a broken panel. Once the
  composer had to recognise `/quit` in order to explain it, the two copies disagreed while
  the tests still asserted they agreed. The rules are now tested where they run.

## 0.30.1

- **Fixed: `/help` was unreadable, and so was every other listing.** A command's answer is
  terminal output, not markdown. Kiro holds its two columns apart with runs of spaces, and
  the markdown renderer turned `/help` into 51 separate paragraphs — each with a margin
  between, and with HTML collapsing the spaces so every command name ran straight into its
  description. `/tools`, `/model`, `/agent` and `/context` all arrived the same way.

  Multi-line output now keeps the alignment Kiro wrote, in a box that scrolls on its own
  rather than making the whole conversation scroll sideways. One-line answers stay prose,
  because "Conversation too short to compact." is a sentence and reads worse in a monospace
  block.

- **`/help` now answers from Kiro's command list rather than its text dump.** Even with the
  alignment preserved, Kiro's `/help` is a 70-column table that needs sideways scrolling on
  every line of a sidebar. The same information arrives structured in the announcement the
  `/` menu is already built from, so the panel lays it out to fit: names in one column,
  descriptions wrapping in the next. Click a row to run it, exactly as in the menu.

  It also names the six commands that work in the Kiro CLI but not here, each with the
  reason, instead of leaving them silently missing from a list headed "available commands".

- **Fixed: typing a command the panel cannot run sent it to the model as a message.** The
  composer was only told about the commands it offers, so it did not recognise `/quit` at
  all — and an unrecognised slash falls through to the message path. The word "/quit" went to
  Kiro as a prompt nobody wrote, was charged for, and came back with a guess at what was
  meant. Since `/help` advertises those commands, it was the natural thing to try next.

  The composer is now told the whole list with what is runnable flagged, so it can answer
  "`/quit` closes the Kiro CLI, which this panel is talking to" instead of sending anything.

## 0.30.0

- **Slash commands.** Type `/` in the message box and Kiro's own commands appear —
  `/compact`, `/context`, `/usage`, `/tools`, `/mcp`, `/knowledge`, `/help` and the rest.
  Arrow keys move, Enter runs, Escape closes. A command that takes an argument is completed
  into the box instead of run, so the next keystroke is the argument.

  Kiro has had 25 of these all along and the panel could reach none of them. It turns out it
  was being *told*: `_kiro.dev/commands/available` arrives right after `session/new` carrying
  every command with its description, argument hint and subcommands, and the panel was
  dropping the notification on the floor. So the menu is not a list anyone typed here — it is
  Kiro's own list, and a command added by a future kiro-cli appears in it without a change to
  this extension.

  Measured by driving `kiro-cli acp` directly rather than read from documentation, which is
  also how the exclusions were decided. `/paste` reads a clipboard the CLI does not have
  behind a webview, `/voice` a microphone, `/reply` opens `$EDITOR`, and `/quit` would kill
  the process the panel is talking to; `/chat` is a second conversation store competing with
  the panel's own history. Those are left out, because a menu row that hangs is worse than
  one that is absent. `/stats` is runnable by typing it in full but not advertised, because
  Kiro marks it hidden.

  A leading slash is only treated as a command when the name is one Kiro actually has — so
  "/usr/bin/env is on my PATH" is still sent as the sentence it is, rather than eaten because
  of its first character.

- **`/rewind` — go back to an earlier turn.** It lists the turns in this conversation with
  what you asked and what came back; pick one and everything after it is dropped.

  Kiro does not truncate in place. It **forks**: a rewind writes a new conversation holding
  everything up to and including the turn you chose, and hands back its id. The panel follows
  it there, loads it, and repoints this chat's record at the new session — without that last
  part, reopening the chat later would have resumed the conversation you had just rewound out
  of. The transcript is trimmed to match, because messages Kiro has forgotten must not still
  be on screen offering to be discussed.

  Which turns survive was measured, not assumed: with three turns in the log, rewinding to
  the middle one forked a session still holding the first *and* the middle. The chosen turn
  is kept.

- **A command's answer is not a reply.** `/usage` returns a table and `/tools` a list; in an
  agent bubble either reads as something the model said, in a turn nobody started. Results
  get their own card, labelled with the command that produced them, and go into the chat's
  record — so reopening a chat shows that `/compact` was run rather than a gap where the
  conversation appears to shrink for no reason.

  What a command changed is then believed rather than ignored. `/clear` empties the
  transcript, because leaving the messages up would offer a conversation Kiro can no longer be
  asked about; `/model` updates the model button. A panel that goes on displaying the state a
  command just replaced is the same failure as a permission card claiming an answer nobody
  received.

- **Fixed: a test that guarded the keep-or-undo bar by searching the whole file.** It
  asserted `messagesEl.appendChild(card)` appeared nowhere in `chat.js` at all — a proxy for
  "the change bar is not in the transcript" that held only while the change bar was the only
  card in the panel. The first card that genuinely belongs in the transcript broke it, for a
  reason with nothing to do with what it was protecting. It now asks the question of
  `renderChangeBar` itself, and was confirmed by putting the original bug back and watching it
  fail.

## 0.29.0

- **The mode picker now shows what Kiro already knows about your project.** A new group,
  **What Kiro always knows**, lists the memory files being read and opens one for editing —
  **Add project memory** for this folder, **Add global memory** for all of them. Also on
  the Command Palette as *Kiro Chat: Edit Project Memory*.

  This adds no memory system, because Kiro CLI already has one and a second would pay for
  the same text twice — once in Kiro's context and again in ours. Measured against
  `kiro-cli acp` 2.20.2 rather than read from documentation: a fact placed in
  `.kiro/steering/*.md`, in `~/.kiro/steering/*.md`, or in `AGENTS.md` is answered with
  **zero tool calls**, which is what proves the text is already in the prompt rather than
  fetched on demand. The frontmatter turns out to be optional too — a bare `.md` in the
  steering folder is loaded — and editing a file mid-chat changes the *next* answer in the
  same session, so nothing here asks you to start a new one.

  The gap was never the feature. It was that nothing in the panel said these files existed.

- **Fixed: the local-memory row made an ordinary committable file.** The message
  handler read `scope === "global" ? "global" : "project"` — correct while there were two
  targets, silently wrong the moment there were three. `"private"` is not `"global"`, so it
  became `"project"`: the button created a plain `memory.md`, wrote no git rule, and produced
  exactly the file it had promised not to. The target is now validated against the three
  known names and an unrecognised one is refused rather than rounded, the way `gatesForMode`
  already refuses a mode it does not know.

  The old test asserted that a `case "openMemory"` existed. It did — and was wrong inside.
  Two tests replace it: every name the panel can offer must be one the extension accepts, and
  the handler must route through that check rather than narrowing by hand. Both were
  confirmed by putting the original bug back and watching them fail.

- **Instructions — how you always want Kiro to work, with no file anywhere.** A full-width
  box opened from the **Instructions** group in the mode menu. Whatever you write there is
  put in front of every message: "always reply in Bahasa Malaysia", "use tabs, never spaces", "write the
  test before the fix".

  This is a different thing from memory, and the difference is the point. A memory file
  holds *facts* Kiro should know, and lives on disk because that is the only thing Kiro
  reads. An instruction is a *directive* it should follow, and needs no file at all — the
  extension already puts instruction text in front of a message, which is exactly how the
  Spec and Bug Fix workflows work. This is the same mechanism with the user holding the pen,
  stored in `kiroChat.instructions`, so it syncs with Settings Sync and can be edited from
  the settings UI too.

  The block wraps the workflow block rather than splitting it: `applyChatMode`'s text ends
  "The user's request follows", and anything inserted between the two makes that untrue.
  Empty instructions add no block at all — an empty one is a line of prompt saying nothing,
  charged for on every turn.

  The menu row shows the instructions themselves — the first one as its label, the rest
  beneath. There is no "Your instructions" label above them: the group heading already says
  it, and repeating it spends the row’s most readable line saying nothing while the thing
  worth reading is pushed into small grey text. With nothing set the row reads **Add
  instructions**, an invitation rather than a statement, the way the memory rows do. It clips
  between instructions rather than mid-sentence, since a preview that stops half way is a
  preview of something you did not write.

  Unlike a memory file, which Kiro reads when it wants it, this rides in *every* message, so
  there is a 4000-character cap. Past it the
  count appears and turns red rather than the tail being dropped in silence.

  Saving posts and closes; the configuration watcher posts the text back. A box that kept
  what it had just sent would show instructions the settings do not hold if the write
  failed — the permission card's rule, applied to a textarea. Enter makes a new line, since
  this is a list typed over several lines and the composer's Enter-to-send habit would throw
  away the rest; Ctrl+Enter saves and Escape closes.

  Cancel is painted as a secondary button, which needed fixing: it was first given a class
  the stylesheet does not define, so the global `button` rule made it the same primary blue
  as Save — two identical buttons, one of which throws the edit away.

- **Removed the "Remember something…" row.** It appended a typed line to a memory file as a
  bullet, and answered the wrong question: what was wanted was a standing instruction, not a
  stored fact.

- **The three rows are named project, local and global.** Two of them sit in the same folder
  and differ only by file name, and they read as near-identical if the difference is buried
  mid-label — so the one that needs a qualifier carries it where it cannot be missed:
  **Add local memory (not committed)**. Global memory is not committed either, but for
  another reason entirely, so its row says *this machine only* rather than letting that
  qualifier imply it is.

- **Local memory, which stays in the folder but never gets committed.** A third
  row makes `.kiro/steering/memory.local.md` and adds it to `.git/info/exclude`. That file
  lives inside `.git`, which is never committed by definition — so unlike a `.gitignore`
  line, the rule itself never reaches anyone. In a shared repository you get team memory and
  your own notes side by side, and only one of them is everybody's.

  Verified against real repositories rather than reasoned about: the file sits in the
  steering folder where Kiro reads it, `git status` is clean, `git add .` cannot stage it,
  and `git ls-files` shows only the shared file.

  **The exclude entry is written before the file is opened.** The gap between creating it and
  hiding it is a gap in which `git add .` commits the thing the row promised to hold back.

  **The path comes from `git rev-parse --git-common-dir`, never from joining `.git` onto the
  workspace root.** In a worktree `.git` is a *file* holding a pointer, that directory does
  not exist, and the worktree's own gitdir has no `info/` at all — git reads the common
  directory's exclude. Measured: the naive path is absent in a worktree, so a hand-built one
  would fail there while working perfectly on the machine it was written on, and the file
  would silently stay committable.

  **The row asks git rather than assuming.** A file that is already tracked is not ignored by
  any rule, which is precisely the case where a reassuring label would be false, so
  `git check-ignore` decides between "not committed" and "git can see this". Where
  the folder is not a repository at all, it says so instead of claiming privacy there was
  never anything to protect.

- **Each file is its own row, with a × to remove it.** Removing asks first, names the full
  path, and sends the file to the recycle bin rather than unlinking it — a menu is a careless
  place, this row sits directly under rows that merely open a file, and "I meant the other
  `memory.md`" must not be answered with "it is gone". Both scopes can hold a file of that
  name, so every row says which chats it steers underneath it; two identical rows with a
  delete button each is a trap, not a list.

  The panel never strikes a row out on click. It asks, and redraws from what the extension
  reports — the confirmation can be cancelled and the delete can fail, and a row that
  announced its own removal would be claiming an outcome it cannot know. The same rule the
  permission card follows.

  A path arriving in a message is not a licence to delete a file, so the extension rebuilds
  the listing at the moment of the click and refuses anything that is not in it.

- **The rows report; they do not switch anything on.** They carry neither the selection
  highlight nor a drawn switch, because a memory row is an action and not a state — the row
  says which chats its file steers, and clicking opens it. Kiro is reading them either way.

- **`kiroChat.args` now reaches `kiro-cli`.** Its own documented example could not start
  Kiro: arguments were concatenated in front of the subcommand, and `--agent` is an option
  *of* `acp`.

  ```
  kiro-cli --agent my-agent acp
  error: unexpected argument '--agent' found
    tip: 'acp --agent' exists
  ```

  They now go after `acp`, where every option anybody would put there belongs — `--agent`,
  `--model`, `--effort`, `--trust-tools`, `-v`. What it takes to *reach* the binary still
  comes first, because the WSL route runs `wsl kiro-cli acp` and the name is an argument of
  `wsl`. This matters here because an agent config is the other route to memory: its
  `resources` list names files to load.

- **`AGENTS.md` is listed even though the button never creates one.** Kiro reads it, so a
  panel saying "None yet" beside a project that has one would be exactly the confusion this
  is meant to remove. New files are made in `.kiro/steering/`, which is unambiguously Kiro's;
  creating a root-level file somebody then commits is a larger side effect than a menu click
  implies.

- **Neither dropdown calls itself a listbox any more, because neither was one.** Both the
  workflow menu and the model menu declared `role="listbox"` while holding things a listbox
  may not contain: group headings, notes, switches, a memory row carrying two buttons — and,
  in the model menu, a footer with a **Check account usage** button buried inside it. A
  screen reader was told to expect a list of options and handed something else.

  The fix is *no* container role rather than a different one. `listbox`, `menu` and
  `radiogroup` all promise arrow-key navigation this does not implement, and declaring one
  puts a reader into a mode where Tab — the navigation that does work, since every row is a
  real `<button>` — stops working. A plain container of buttons announces each control
  correctly and keeps the keyboard behaviour the code actually has.

  A one-of row now says `aria-current="true"` instead of `role="option"` with
  `aria-selected`, which meant nothing outside the listbox that was never there. Toggles keep
  `role="switch"` and `aria-checked` — valid on a button, and `.menu-switch` is still painted
  from that same attribute, so what is announced and what is drawn cannot drift apart.
  Nothing changed visually.

- **The counts are read when the menu opens, not watched.** The global folder sits outside
  every workspace root, so a file watcher would keep one scope current and let the other go
  stale — and nothing on screen would say which was which.

## 0.28.0

- **The usage strip no longer shows one chat's credits against another.** Opening a past
  chat loaded that conversation but reset nothing, so the strip went on saying "2.47 credits
  this chat" — a claim about the chat in front of you, made about the one you just left. A
  past chat's own credits are not stored anywhere, so none is shown rather than a wrong one.

- **Starting a new chat no longer wipes your plan figures.** They describe your account, not
  the conversation, so `1234/5000 credits on Pro` survives pressing **+**; only the
  session's own numbers are cleared. The two kinds shared one bag with nothing marking which
  was which, so a reset could not tell them apart and took both.

- **Credit figures are formatted.** A plan total was concatenated straight in, so it could
  arrive as `1234.5678901234 credits on Pro` on a strip sized for a sidebar. Every figure is
  now at most two decimals, with no trailing zeros on a whole number.

- **The context bar empties between chats.** Its fill was only ever assigned, never reset,
  so a new conversation briefly showed the last one's fullness.

## 0.27.0

- **Manual, Review or Autopilot — in the mode picker, beside the workflow.** Choosing how
  closely you watch Kiro work belongs next to choosing how Kiro approaches the task; they are
  two halves of "how is this conversation running". The picker now holds three groups —
  the workflow, the supervision, and what rides along with each message — and the separate
  settings gear is gone.

  They stay separate groups rather than one list of eight, because they are independent:
  Spec with Autopilot and Spec with Manual are both sensible, and a flat list could not say
  that. Plan says outright that none of it applies to it, since Plan changes nothing. And
  because Manual and Autopilot change what happens to your files with nothing else on
  screen to say so, they ride on the button itself — `Default · Autopilot`. Review is the
  default and is not announced.

  The three modes:

  - **Manual** — ask before every edit, then show the diff.
  - **Review** *(default)* — make the edit, then show the diff to keep or undo.
  - **Autopilot** — edit freely. Nothing to approve, nothing to read.

  These were four booleans in the settings, and their names actively misled: turning
  `reviewFileWrites` off reads as turning safety off, when it only swaps which gate you get.
  The mode is worked out from those settings rather than stored beside them, so it cannot
  drift from what is actually configured — and a combination matching no mode is reported as
  exactly that rather than rounded to the nearest one.

  Manual is new. Asking before an edit *and* reviewing it afterwards used to be impossible,
  on the reasoning that it is the same question twice. It is not quite: Kiro CLI writes files
  itself, so the diff can only put one back after the fact, while the prompt is the only gate
  that stops a write reaching disk at all. Which of those matters is not something a rule
  should decide.

  The two message toggles are drawn switches. Every row changes because the setting changed,
  never because it was clicked, so a write that fails cannot leave one claiming
  otherwise; and editing any of it in the settings
  editor, the JSON, or another window updates the menu too. Picking a workflow closes the
  menu, since that is the whole errand; the other two groups leave it open, because they are
  things you might set two of.

- **Fixed the permission buttons turning into each other on hover.** `:hover` and `.primary`
  shared one rule, so putting the pointer on any option painted it as the recommended
  action — and because the destructive one was coloured only while *not* hovered, hovering
  **Reject** dropped its red and turned it primary blue. The most dangerous button in the
  panel looked recommended at the exact moment the pointer was on it.

  They now follow VS Code's own convention: a secondary button hovers to the secondary hover
  colour, the primary deepens, Reject stays red and gains a red border, and no button ever
  changes what it means. Keyboard focus is visible on its own, and the shortcut is drawn as a
  key rather than a number stuck to the label.

- **A permission card stays put while it waits for you.** It sat in the transcript, which
  scrolls — and scrolls exactly when it matters, because Kiro keeps streaming while the turn
  is blocked on your answer, so the question ends up somewhere above the fold. It now sits
  between the conversation and the message box, where the keep-or-undo bar sits and for the
  same reason. Once answered it moves into the conversation as a record of what was asked,
  and stops looking like a question still standing.

- **A permission card no longer reports an answer that reached nobody.** Clicking an option
  disabled the buttons and wrote "Selected: Allow" straight away, whatever became of the
  decision. If the request had already gone — the turn ended, was stopped, or errored — it
  was dropped in silence, leaving a card in the transcript claiming an approval Kiro never
  received. The click now says "Sending…", and the answer is written down only once the
  extension confirms it landed. A request that has gone says so instead.

- **Moving the chat panel no longer answers Kiro for you.** Dragging the view between the
  sidebar, the bottom panel and the secondary sidebar destroys and rebuilds the webview,
  and every pending permission was quietly cancelled on the way through — the action simply
  did not happen, and the panel that came back showed no sign there had been a question.
  The question is asked again on the other side.

  A panel closed for good is a different matter, and closing one looks exactly like moving
  one at the moment it happens — what tells them apart is that a move brings a panel back
  within milliseconds. So the answer waits half a minute before deciding: come back and the
  question is still there, stay away and it is cancelled, which is what used to happen
  immediately. The output log says when that happens, since by then there is no panel to
  say it in.

- **Stop cancels the questions the turn was asking, whichever Stop you use.** The button in
  the panel did; the `Kiro Chat: Stop` command did not, so stopping from the Command
  Palette left a card on screen answering to nobody.

- **The numbers on the options work.** They render as `1  Allow`, `2  Reject` — which reads
  as "press that key" — and nothing listened for them; with the message box focused,
  pressing `1` typed a `1`. They now answer the card whenever you are not part-way through
  writing something.

- **Permissions are kept in the chat's record.** They lived only on screen, so reopening a
  chat left no trace that Kiro had asked to do something, or what you said. The card comes
  back with your answer on it.

- **A refusal can no longer be styled as the recommended action**, if Kiro ever sends it
  first.

- **`kiroChat.autoApproveTools` writes what it approved to the output log.** It granted
  permissions silently, so with the setting on there was no record anywhere that anything
  had been approved.

## 0.26.0

- **Tables in a reply are rendered as tables.** There was no table support at all, so every
  row fell through to the paragraph branch: a table arrived as one line per row with a gap
  between each, and the `|---|---|` separator printed as literal dashes. Any "here is the
  mapping" answer — which is most long answers — came out as a wall of pipes. Alignment
  markers are honoured, short rows are padded rather than dropped, and the table scrolls
  inside its own box so a wide one does not drag the whole conversation sideways.

  Prose is not mistaken for a table: the separator row has to describe the same number of
  columns as the header, so a sentence containing a `|` above a `---` rule stays a
  sentence. Escaped pipes, optional outer pipes and over-long rows all follow GitHub's
  rules.

  A table is drawn the way a chat draws one — a rule under the header, hairlines between
  rows, rounded edge — rather than as a full bordered grid, which reads as a spreadsheet
  pasted into a conversation. Words are never broken, so an identifier stays whole rather
  than arriving as `SOURCE_NOT_REN` / `EWABLE`; a table asks for the width its own content
  needs, so a short one stays small and quiet and only a genuinely wide one scrolls.

- **Kiro's sentences no longer run into each other across a tool call.** Text said before a
  step and text said after it went into the same buffer with nothing between, so a reply
  read "…rather than guessing from names.I notice RENEWAL_WINDOW_CLOSED…" — no space, no
  break. A new step now ends the paragraph. Only a step being started counts; a status
  update for one already on screen arrives mid-sentence and is left alone.

- **Files you attach now stay attached.** The chip row was emptied after every message, so
  "add another file to the context" was true for exactly one turn: the second message
  carried strictly less than the first. Because the `◎` chip for the file you are looking
  at comes back on its own, the row still looked populated, and nothing anywhere said the
  rest had gone. Files and folders now stay until you remove them — with their ×, or with
  **Clear all**, which appears once there is more than one.

  An image is still consumed by the message it goes with. Its data rides in the prompt
  itself rather than as a link, so a sticky one would push megabytes through every turn for
  a picture Kiro has already been shown.

  Chips that have already gone cannot start a turn on their own: Enter on an empty box does
  nothing unless something on the row is new. "Look at these" with no words still works —
  once.

- **Kiro is no longer handed the same file as two different files.** The file you were
  looking at was listed by its absolute path under "Files to look at" and then again,
  relatively, by the selection block — `C:\kiro-chat\media\chat.js` and `media/chat.js`,
  two spellings that do not read as one file. The narrower mention wins now: whatever the
  selection block already names is not listed above it. The link Kiro opens the file by is
  untouched, so nothing it can act on was lost.

- **The tab that merely happens to be focused is no longer listed as a file you chose.** It
  sat among the attachments with nothing to tell it apart, so "update these files" quietly
  took in whatever was open. With `kiroChat.sendSelection` off it now gets its own line
  saying what it is; with the selection on, the selection block was already saying it.

- **Fixed a chip that promised something the panel had decided not to do.** Dismissing the
  `◎` chip with its × and then highlighting code in that same file made the file chip
  vanish behind the selection chip — whose tooltip read "Kiro gets `<file>` and the
  highlighted lines" while no link for the file was sent, and whose × was now off screen,
  so there was nothing left to put it right. A dismissed file keeps its own chip, and the
  selection chip's tooltip says which of the two situations you are in.

- **Fixed the "add it back" chip painting solid blue under the pointer.** `button:hover` is
  a type plus a pseudo-class and outranks any single class, so a button that only sets a
  background of its own is repainted the moment the pointer crosses it. The test that
  guards against this looked for `background: none`; this one says `background: transparent`
  and slipped past. A second test now reads the classes off every button `chat.js` builds
  and asks the question the right way round — it found a fifth candidate while being
  written, which turned out to be already handled.

## 0.25.1

- **A file Kiro only read no longer opens a review when something else changes it.** 0.25.0
  reviewed any snapshotted file that differed by the end of the turn, which was the right
  question for a file Kiro wrote and the wrong one for a file it merely read: a watcher, a
  formatter or a dev server rewriting one mid-turn opened a diff, and rejecting that diff
  would have clobbered a write Kiro never made.

  The snapshot is still taken either way — it costs one read, and a later unrecognised write
  to the same file needs a "before" that predates it. What a read no longer earns is the
  diff. The change is still reported in the keep-or-undo card, which is the gentler surface
  for "this changed, was that you?"; going quiet about it would be the original bug again.

- **`isReadOnlyTool` answers false for anything it does not recognise**, and that asymmetry
  is the whole design. An unknown tool is assumed to have written, so 0.25.0's fix for
  unreviewed edits is untouched — only a kind that positively cannot write (`read`,
  `search`, `grep`, `glob`, `list`, `fetch`, `think`) opts a file out. `execute`/`shell` are
  deliberately absent: a command can write anything, and `terminal: false` is not a proof.

## 0.25.0

- **An edit made by a tool the extension did not recognise no longer lands unreviewed.**
  `isWriteLikeTool` gated the pre-turn *snapshot*, not just the simulated result — so a tool
  shape it did not know, or a path it could not find, meant no baseline, no diff, no
  keep-or-undo card, and Kiro's edit simply appeared on disk with nothing said about it. An
  unreviewed edit is the one outcome nobody wants, and a heuristic was the only thing
  standing in its way.

  The heuristic is a hint now, the same demotion `DirectFileChange.expected` already went
  through. Every path any tool mentions gets a snapshot, whatever the tool is — reading a
  file is the strongest available signal that an edit is coming — and the end-of-turn pass
  reviews whatever actually differs from its snapshot. "Did this change?" needs no
  heuristic to answer correctly.

- **Paths are read from everywhere Kiro puts them.** Only `rawInput.path` was consulted.
  The payload captured from a real turn carries the path in `locations` *and* in
  `rawInput.operations[].path`, and in neither of the places the extractor looked — so the
  `operations` form, which the built-in edit tools use, was missed every time.

- **A file the user edits mid-turn is deliberately still not swept into a review.** A
  baseline exists for two reasons: a tool mentioned the file, or the user attached it. Only
  the first means Kiro was working on it, and only those are reviewed. A diff offering to
  undo the user's own typing would be worse than the gap it closed.

- Snapshots no longer throw. A directory, an unreadable path or something implausibly large
  comes back as "no baseline" rather than an exception — which, now that far more files are
  snapshotted, would otherwise have taken the whole keep-or-undo card down with it. Files
  over 10MB are skipped and logged.

## 0.24.0

- **The `@kiro` chat participant is gone.** It was a second way into the same Kiro session,
  aimed at VS Code's own chat box, and it was never documented in the README — so the only
  people who found it were the ones who went looking. Its real draw was that a file could
  be dragged onto the native chat box, which a webview can never accept: VS Code sets
  `pointer-events: none` on every webview for the duration of any drag.

  Attaching files is unaffected. The **+** button, **Kiro Chat: Add to Chat Context** in
  the Explorer's right-click menu, and pasting an image all work as before, and none of
  them depend on a drop landing. What goes is the ability to drag a file onto VS Code's
  chat box and have Kiro answer there.

  Removed with it: the `kiroChat.askInChat` command, `src/participant.ts`,
  `src/references.ts`, and the `TurnSink` plumbing in `KiroSession` — `sendTo`, the `sink`
  field, and the branch in every notification handler that asked whether the panel or the
  participant was the audience.

- **Two of 0.23.0's fixes are now moot, which is the better outcome.** The concurrency
  guard and the `turn_end` routing existed because one session had two front doors that
  were not aware of each other. With one door there is no such race to guard against. The
  busy check survives in a simpler form, because **Kiro Chat: Explain Selection** still
  reaches `send` without passing the webview's disabled Send button.

## 0.23.0

- **Asking a second question mid-turn no longer answers it into the wrong window.**
  `sendTo` guarded against a second turn on the session; `send` did not, and it is
  reachable without passing the panel's disabled Send button — **Kiro Chat: Explain
  Selection** goes straight to it. Right-clicking code while `@kiro` was answering in VS
  Code's own chat box put a second `session/prompt` on one session, and because the
  participant still owned the output, the panel's reply was streamed into *its* response
  instead. Both entry points now share one guard, which runs before the sink is claimed.
  A refused message is turned away before its bubble is posted, so the text stays in the
  box rather than vanishing into a transcript.
- **`turn_end` is routed the same way as everything else.** An `@kiro` turn finishing used
  to post a turn-ended message into the panel, which was not running it.
- **A long `@kiro` answer is no longer cut off after two minutes.** The idle timeout was
  armed once and never re-armed, making it a hard cap on the whole turn rather than a
  check for Kiro going quiet — so a multi-file edit was cancelled mid-sentence with
  nothing said about why. Every chunk of text and every tool step now pushes it back.
  Real silence still ends the turn.
- **Restarting the agent no longer leaves Kiro running.** When the CLI is a `.cmd` shim it
  runs through the shell, so the process being killed was `cmd.exe` and `kiro-cli` was its
  grandchild — it survived, still holding its session. Windows has no process group to
  signal, so the whole tree goes through `taskkill` now.
- **The review tab is closed wherever it is.** Pressing **Keep** on the chat bar while
  looking at another file left the `(Working Tree)` tab open and deleted the content behind
  it, so a stale, empty tab stayed until it was closed by hand. The chat bar exists so the
  diff does not have to be in front of you, which made this the ordinary path rather than
  an edge case.
- **The workspace boundary now checks where a path really leads.** It compared paths as
  written, which stops `../` but says nothing about a symlink or a junction *inside* the
  folder pointing out of it: that resolved to an in-workspace string and was allowed. Both
  sides are resolved before the containment test, with a file that does not exist yet
  handled through its nearest existing parent so creating one still works. A link that
  stays inside the workspace is unaffected.
- **Auto-approval takes the narrowest permission on offer.** Kiro sends `allow_once` and
  `allow_always` side by side and the first one won, so `kiroChat.autoApproveTools` could
  hand out a standing grant where a single-use one was available.
- The page's CSP nonce is generated with `crypto.randomBytes` rather than `Math.random`,
  which is seeded per process and recoverable from a few samples.
- Unterminated output from Kiro is capped instead of accumulating without limit. The check
  runs after complete messages have been dispatched, so a large write of real messages is
  never discarded.
- A tool step that arrives without a `toolCallId` keeps one id across its updates instead
  of taking a random one each time, which used to add a row to the steps list per
  notification.
- **The README said several things the code does not do.** Closing a review tab keeps the
  hunks you already accepted rather than rejecting everything; the CodeLens actions are
  **Accept** / **Reject** and not numbered "change N of M"; the sign-in command is
  `kiro-cli login`; images and past chats were still listed as unbuilt in a file with
  sections describing both. `kiroChat.attachActiveFile` was missing from the settings table.
- **`allowFileWrites` and Plan mode are described honestly.** Neither prevents a write:
  Kiro CLI makes its own edits, so the file is written and then restored from its pre-turn
  snapshot. That is invisible in the editor but not to a file watcher, a dev server or a
  build, and the setting used to promise a read-only chat.

## 0.22.2

- **A run of backticks inside a sentence no longer swallows the rest of the reply.** A
  code fence only opens a block at the start of a line — the renderer matched ``` anywhere,
  so a sentence like "uses longer fences (\`\`\`\`)", a shell snippet quoted mid-line, or
  any answer discussing markdown turned everything after it into one enormous code block.
  The more a reply talked about code, the more likely it was to be destroyed. Both the
  opening and closing fence are anchored to a line now.

  The unterminated case uses an end-of-*string* assertion rather than `$`, which under the
  multiline flag means end of line and would cut every block at its first newline — a
  streaming reply is unterminated for as long as it is arriving.

## 0.22.1

- **Windows line endings no longer break code blocks.** The fence pattern consumed the
  `\n` after the language but not `\r\n`, so the carriage return was captured as the first
  character of the code — and `<pre>` renders a lone `\r` as a break. Every snippet in a
  reply with CRLF endings came out with a blank line above and below it, and because the
  culprit was invisible whitespace there was nothing on screen to explain it. Line endings
  are normalised once before anything parses the text, which fixes fences, headings and
  lists together.
- A fence indented under a list no longer leaves its indent as a trailing line inside the
  code, and `` ```js `` followed by a space is recognised.

## 0.22.0

- **Kiro sends its updates under two method names, and one of them was being thrown away.**
  `session/update` carries `tool_call`, `tool_call_update` and every message chunk;
  `_kiro.dev/session/update` carries the `tool_call_chunk` — the first word that a step is
  starting. Only the unprefixed name was accepted, so every one of those was rejected
  before it reached the handler and merely written to the log as an unknown notification.
  That is exactly the window in which the panel has nothing to say but "Working…", and it
  is the longest-feeling part of a turn. Both spellings are accepted now, which is what
  `_kiro.dev/metadata` already did by naming both.

  Found by capturing a whole turn straight off `kiro-cli acp` and comparing the method
  names against what the extension accepts. `test/toolSteps.test.js` pins both spellings.

## 0.21.0

- **The log of what Kiro ran is always there, and folded.** The header is now revealed by
  the step itself rather than as a side effect of the clock starting — which did nothing
  once the clock was already running, so what guaranteed the log was visible was a call
  that had usually already happened. A step can no longer be recorded without somewhere to
  see it. It stays folded: the header names the step being run, and the rest is one click
  away. A list you open yourself stays open.
- **The composer row is compact**: 22px instead of 26, with smaller icons and tighter
  padding. One `:is()` rule hands that height to every control rather than a list naming
  each one — the old version only held the controls it happened to name, so one moved into
  a different wrapper would silently go back to sizing itself. Measured at editor font
  sizes 11, 13 and 16px: attach, workflow, model and send all 22px.

## 0.20.1

- **One shape for the steps header.** A turn that ran no steps had a second version of that
  line — the chevron slot standing empty, because there was nothing to unfold, sitting at a
  different indent from the ordinary one. Neither was wrong on its own; together they read
  as a mistake. That version is gone: a turn with no steps shows no header, so every header
  in the transcript looks the same.
- **Your bubble stops short of the left margin.** At the full width it was a paragraph
  again; the strip of ground down its left is what says somebody sent it. Long questions
  still get almost all the room.
- **The send arrow points straight right** — no tilt, no paper plane.

Also measured while checking the row: every control in it holds 26px at editor font sizes
from 11px to 18px.

## 0.20.0

- **You can watch Kiro work again.** The steps list is open while the turn is running and
  folds itself away when the turn ends — the actions were still being recorded, but behind
  a closed fold, which hid exactly the part that answers "what is it doing". Open or close
  it yourself at any point and that choice sticks for the rest of the turn.
- **Your question is a bubble on the right**, sized to what you typed and growing to the
  full width when it needs it. Both roles ran the full width before, which made a one-line
  question read as another paragraph of the conversation rather than as the thing that
  started the exchange.
- **More air between exchanges** than between a question and its own answer, so a long
  conversation reads as a stack rather than one undifferentiated column.
- **One bad notification no longer costs the rest of its batch.** Kiro often writes several
  notifications in a single stdio write, and a throw in any handler abandoned the loop that
  walks them — every message after it in that write was dropped silently, looking exactly
  like Kiro never having sent it. Each is now handled on its own and a failure is logged.

## 0.19.0

The row under the message box.

- **Everything in it is one height.** The controls were sized three different ways — the
  attach button by fixed pixels, the pickers by their own padding, Send by the global
  button padding — so nothing lined up. One `--control-h` now feeds all four.
- **Send and Stop are icons**: a paper plane and a square, both labelled for screen
  readers and both the same 26px square as the attach button. Send keeps the accent
  colour; it is the only thing in the row that has it.
- **The pickers lead with an icon instead of trailing a chevron.** The chevron said only
  "this opens" — which a click discovers anyway — while costing width in a panel that has
  none to spare, and it made the two pickers read as a pair of form fields rather than
  part of the same row of controls.

## 0.18.1

- **A finished turn reads as one sentence**: `Completed 2 steps in 7s`. While the turn is
  running the two halves stay separate — what it is doing on the left, the clock on the
  right — because those are two different things; once it is over it is a single fact, and
  splitting it left a label with a stray number after it. The "Worked for" wording is gone.
- **The ticks are gone from the step list.** A green ✓ beside every finished row was a
  column of decoration repeating what the header already said. The only step that gets a
  mark now is the one still running, and a failure is carried by the row's own colour.

## 0.18.0

Steps, measured against what kiro-cli 2.20.2 actually sends rather than guessed at.

- **The first notification for a step was being thrown away.** Kiro announces a step three
  times: `tool_call_chunk` the moment it decides to use a tool, then `tool_call` with a
  real title, then `tool_call_update` with the outcome. Only the last two were handled, so
  nothing appeared until Kiro had worked out what to call the step — the panel sat on
  "Working…" through the whole of that gap.
- **A step no longer shows up as `read`.** That first notification's title is only the
  tool's kind, so it now reads `Reading`, `Searching`, `Editing`, `Running` until the real
  title arrives and replaces it.
- **Each step says why Kiro is running it.** Kiro sends its own note — "Read package.json
  to get the version string." — which is the part worth unfolding the list for: the title
  says what, this says what for.
- **Steps are written to the log.** There was no record of them at all, so a turn that
  showed no steps could not be told from one that ran none. `Kiro Chat: Show Log` now has
  a `[tool]` line per update.

## 0.17.1

- **The sent message no longer names the same file twice.** A message sent with a
  highlight carried both `media/chat.js` and `media/chat.js:23-27` under it — the second
  says everything the first did. Only the range survives, named the way the chips are:
  the file's name, with the whole path in the tooltip. This is the same fix 0.15.1 made to
  the chip row above the box; the transcript had its own copy of the problem.
- **Code blocks take the editor's background.** `textCodeBlock` is a faint wash meant to
  sit inside prose, and against the sidebar it was nearly invisible — the block read as
  more paragraph. It is now the colour the code would have in a tab: clearly darker than
  the sidebar on a dark theme, clearly lighter on a light one.
- `Worked for 0s` no longer appears over a reply that came straight back. The line is
  worth a row only when the turn ran long enough to wonder about.
- **The working line says what Kiro is doing**, not just that it is doing something —
  `Reading src/kiroSession.ts`, `Searching for readUsage in src`, `Editing chat.js` — with
  the elapsed time beside it, updating as each step starts. It falls back to `Working…`
  before the first step, and becomes `3 steps` once the turn is over. The full list is
  still one click away on the same line, and still closed by default.

## 0.17.0

- **The turn shows its elapsed time, and the steps fold away.** One line — `Working… 14s`
  with a turning ring — sits where the answer will appear and keeps counting while the
  reply streams, which is the thing that tells a slow turn from a stuck one. The tool
  steps are behind it, closed; click to open them. When the turn ends the line becomes
  `3 steps · 14s`, still closed.
- **No ticks while the work is going on.** A column of them piling up beside steps still
  running was noise, and the row that matters is the one still going. The marks appear
  once the turn is over. A failure is always marked.
- **The blinking `▌` no longer stands in for a reply.** It appeared as soon as the first
  chunk arrived, even an empty one, so a turn that had not really started showed a bare
  cursor on an empty line. It waits for text now, and `Working…` holds the place.
- **Code blocks are syntax coloured, following your theme.** VS Code does not hand a
  webview the editor's TextMate token colours, so this cannot be identical to the editor.
  What it does expose is the theme's own colour keys for the same ideas, and comments,
  strings, numbers, keywords and function names are coloured from those — so the block
  moves with whatever theme you are running rather than fighting it. Light and dark both
  have sensible fallbacks for a theme that leaves a key undefined.
- **The copy button is smaller and has lost its border** — just the glyph, taking a ground
  only under the pointer.

## 0.16.0

The transcript.

- **The panel says when Kiro is working.** Between pressing Send and the first token —
  however long Kiro spends thinking and running tools — the transcript said nothing at
  all, so a slow turn was indistinguishable from a dead one. The only sign was the status
  dot at the very top of the panel, nowhere near where the answer appears. A "Working…"
  line now goes in the moment the message is sent, where the reply will land, and the
  reply replaces it.
- **Tool steps show their state.** "Reading chat.js — running" put the state in the same
  grey prose as the name, so a step still going looked like one that had finished. Each
  row now carries a turning ring, a green tick or a red cross. A reopened chat shows
  finished marks rather than spinning over a turn that ended last week.
- **Code blocks have a copy button.** It sits in the top-right of the block, appears on
  hover or keyboard focus, and turns into a green tick when the code is on the clipboard.
  Where a policy blocks the clipboard outright it selects the code instead and says to
  press Ctrl+C, rather than looking like a button that did nothing.
- **Your own message is a block now.** Both turns were plain full-width prose separated
  only by a small uppercase label, and the question was painted in the *muted* colour — so
  your own words were the faintest thing on screen and scrolling back through a long chat
  gave the eye nothing to catch on. The question sits on its own quiet surface at full
  contrast; the answer stays plain prose, which is what long text wants in a narrow
  column.
- The blinking cursor no longer appears on an empty reply, where it claimed a reply had
  started before the first token arrived. Both new animations stop entirely under
  `prefers-reduced-motion` — the words and marks carry the state without them.

## 0.15.1

- **The selection chip cannot be dismissed any more.** Its × switched off sending the
  highlighted code while the code stayed visibly highlighted in the editor — two places
  disagreeing about the same thing, with nothing on screen saying which was true. The chip
  reports the highlight now; clearing the highlight is what stops it being sent, which is
  the editor's job. `kiroChat.sendSelection` remains the switch for turning the whole
  behaviour off, and is now the only thing that decides it.
- **Chips show the file's name, not its path.** `media/chat.js:26-26` spent most of a
  narrow sidebar on a folder you are already working in; it reads `chat.js:26-26`, with
  the full path in the tooltip. Nothing sent to Kiro changes — it still gets the full path.
- **Chips got their hover back.** They were solid badge-grey blocks — colours meant for a
  count on a tab — with no state of their own, so a chip you can click to open a file
  looked exactly like one you cannot, and the × had only an opacity nudge to show it was
  live. Chips are now a bordered surface; the ones that open a file lift under the
  pointer, and the × is a real 18px target that turns red.

## 0.15.0

The chip row, and a review of what Kiro is actually sent.

- **One chip for a highlighted selection.** A selection always comes from the file you are
  looking at, so the row named the same file twice — `media/chat.js` beside
  `media/chat.js:26-26  1 line`. It is now just `⌗ media/chat.js:26-26`; the range already
  says how many lines it is. Switch the selection off and the file chip comes back, since
  then it is the only thing still being sent.

Three ways Kiro was being told the wrong thing, found by reviewing that path:

- **Selecting inside a diff sent a path that exists nowhere.** The change-review tab is a
  document like any other, so clicking in it — which is how its keyboard shortcuts are
  used — made it the active editor, and the next message told Kiro "I am looking at
  `/a1b2c3/chat.js (Working Tree)`". Selections are now only read from real files;
  git's read-only sides, search results and output panes are ignored for the same reason.
- **Selected code containing ``` escaped its own code block.** Markdown ends a fenced
  block at the first line with as many backticks as opened it, so highlighting a markdown
  file, a template literal or a docstring spilled the rest of the message out of the
  block — Kiro read the user's code as prose. The fence is now always longer than the
  longest run of backticks in the selection.
- **A selection cut at 12,000 characters claimed to be whole.** Kiro was told "lines 26 to
  480" over a block holding only the first part, so an answer about the end of the
  selection was about code it never saw. It now says how much it was given.

`buildBlocks` and the selection rules moved to `src/promptBlocks.ts`, free of `vscode` so
they can be tested directly. None of this had a test before.

## 0.14.2

- **Past chats no longer flash blue when you point at a row.** The row already tints on
  hover; the blue was the global button style leaking through on top of it. A row's
  clickable area is a `<button>`, and while it cancels the button background it could not
  cancel `button:hover` — a type plus a pseudo-class outranks a single class — so the
  whole row repainted in the primary colour under the pointer. The same leak was fixed on
  attachment chips, and a test now fails for any plain-looking button that cancels the
  background without also cancelling the hover.
- **The "Ask in VS Code Chat" button is gone from the title bar.** It opened VS Code's own
  chat with `@kiro` typed, which is the only box that accepts a dragged file — still there
  in the command palette, just no longer taking up a slot in the title bar.

## 0.14.1

- **The past-chats list is quieter.** The "New chat" button is gone — the title bar
  already has one, and a second competing with the rows was a duplicate. Deleting a chat
  no longer asks first; the `×` still stays hidden until you point at the row, so it is
  never under the cursor of someone aiming at the chat beside it.
- **The list is restyled.** The open chat was painting as a solid selection block, which
  repaints its preview line and timestamp in the selection foreground — the greys that
  make them read as secondary text had nothing to be muted against, so every row was one
  flat colour. It is now a soft tint with an accent bar down the left. Rows are rounded,
  hover fades in rather than snapping, the `×` is a proper icon button that turns red
  under the pointer, and the search box takes a single focus ring.

## 0.14.0

Past chats. Three of these lost or corrupted a chat outright.

- **Reopening a chat no longer binds it to the wrong conversation.** Opening a chat sent
  its stored transcript to the panel and *then* asked Kiro to load the session. The panel
  reported that transcript straight back, which beat the load every time, so the chat was
  re-saved carrying whichever session was still running — the previous chat's. Reopening
  it after that resumed the wrong conversation. The panel no longer reports back a
  transcript it was handed, and the session a chat belongs to is pinned before anything
  can be reported.
- **Reading a chat no longer moves it to Today.** The same round trip re-saved the record
  with the current time, so browsing the list quietly reordered it.
- **Two paths silently overwrote a chat.** "Try again" on the setup screen, and a panel
  rebuilt with nothing in it, both started a new conversation without putting the old one
  away or giving the new one its own id — so the new chat was written into the old chat's
  record and replaced it. All three ways of starting a chat now go through one place.
- **A long chat no longer renames itself.** Only the last 120 messages are stored, and the
  title was re-derived from those, so a chat renamed itself the moment its opening message
  dropped out of the window. A chat now keeps the name it has. Where the older messages
  really are gone, the chat says so instead of appearing to begin in the middle.
- **The chat limit is per folder.** One busy project used to evict a quiet one's history.
- **Saving is debounced.** Every message rewrote every stored chat, transcripts and all.

And the list itself:

- **Chats show their newest line**, because titles repeat — real chats open with "fix
  this" — and a column of identical rows cannot be read.
- **A search box** appears once there are more than five.
- **Deleting asks first.** It was one click, permanent, on rows that can look identical.
  The `×` also now stays out of the way until you point at the row or tab to it.
- **Escape leaves the list**, and there is a **New chat** button in it, so getting out
  does not mean hunting for the button in the title bar.
- **The keep-or-undo bar is cleared** when you open another chat. It used to stay pinned,
  offering to undo edits made in a conversation no longer on screen.

## 0.13.1

- **The review tab is named the way git names a diff**: `chat.js (Working Tree)` rather
  than `Review chat.js`. It follows the convention the editor already teaches instead of
  inventing one. Naming it this way means the tab no longer ends in the file's extension,
  so VS Code can no longer work out the language on its own — the review now takes the
  language from the real file and sets it explicitly, and the diff keeps its syntax
  highlighting.

## 0.13.0

- **Ctrl+Z now undoes a change you accepted.** Accepted content was written straight to
  disk, which the editor never sees: the document reloaded with no undo entry, so the
  change was effectively permanent and the chat's own undo was the only way back. Accepted
  content now goes through VS Code's own edit, so it lands on the file's undo stack like
  any edit you made yourself. Putting a file back after a rejection stays a plain disk
  write — that has to be exact, and saving it would run format-on-save.
- **The review tab is named apart from the file.** It was labelled exactly like the real
  file, so two identical-looking tabs sat side by side and it was easy to start typing in
  the wrong one. It now reads `Review chat.js`, keeping the extension so syntax
  highlighting still works.
- **Format-on-save no longer breaks a review.** Saving an accepted change runs your
  formatter, so what lands on disk is not byte for byte what was accepted. That looked
  like somebody else editing the file mid-review: every decision after the first was
  refused, and the review never finished. It now reads the file back and believes it.

## 0.12.1

- **A file you answered in the diff is no longer asked about again.** Deciding every hunk
  and then being asked "keep all changes or undo?" is the same question twice, and the
  second one cannot be answered without contradicting the first. The keep-or-undo card now
  only covers changes that never went through a review — where it is the only gate there
  is. This is the same one-gate rule that already stops an edit being approved before the
  diff is shown.
- **Walking the changes works like resolving a merge conflict.** Clicking the
  "Reviewing … — 2 changes left" line takes you to a change; clicking it again takes you to
  the next. The separate **Next change** button is gone — it was a third control competing
  with the two decisions next to it. `Alt+F5` / `Shift+Alt+F5` in the review editor and the
  links at the top of the diff are unchanged.

## 0.12.0

- **The keep-or-reject card is back.** The webview half of it had gone missing from
  `media/chat.js`, so the extension announced every open review and finished turn into
  nothing: no card appeared above the message box, and the only way to answer an edit was
  to find the diff tab yourself. The card is restored, and there are now tests that fail
  if the webview stops listening for `reviewActive` or `turnChanges`.
- **You can jump between the proposed changes.** A file with several edits meant scrolling
  and hunting for the next coloured line. There is now a **Next change** button on the card
  in the chat, **Next change** / **Previous change** links at the top of the diff, and
  `Alt+F5` / `Shift+Alt+F5` in the review editor. The walk wraps round at either end and
  only visits changes still waiting for a decision, so it empties out as you work through
  them.

## 0.11.3

- **Fixes the review getting stuck part-way through.** Accepting a change writes it to
  disk, which takes a moment, and a second click arriving before that finished was thrown
  away silently. The count stopped going down, the button appeared to do nothing, and
  because the last decision never registered the review never finished — leaving the chat
  bar reporting changes that were no longer there. Decisions now wait their turn instead
  of being discarded.

## 0.11.2

- **Fixes the inline diff not appearing at all.** The extension predicted what each of
  Kiro's edits should produce and abandoned the review unless the file matched that
  prediction exactly. The prediction drifts for entirely ordinary reasons — several edits
  to one file, or a replace it models differently from Kiro — and when it drifted you got
  "no longer matches Kiro's proposed edit, so it was left untouched" **and Kiro's edit
  stayed on disk unreviewed**, which is the one outcome the review exists to prevent. The
  review now always shows what is actually on disk against the file as it was before the
  turn. A mismatch is noted in the log instead of cancelling anything.
- **Closing the review tab no longer throws away changes you already accepted.** Accepting
  a hunk writes it immediately, but closing the tab afterwards rewrote the original over
  the whole file, silently undoing it. Closing now keeps every hunk you accepted and drops
  only the ones you never decided. Cancelling the turn still discards everything, since
  the whole run is being abandoned.

## 0.11.1

- **The keep-or-undo controls now sit just above the message box** instead of in the
  conversation, so they stay put while you scroll and while you read the diff in another tab.
- **They appear the moment the inline diff opens**, not after the turn finishes. You can
  decide each change in the diff, or take **Keep all changes** / **Reject all changes** from
  the chat without walking through every hunk. The bar counts down as you decide.
- Once the review is done it becomes the after-the-turn summary, listing what changed with
  **Undo all changes** still available.

## 0.11.0

- **The chat now asks whether to keep everything a turn changed.** When Kiro finishes
  editing, a card appears with **Keep all changes** and **Undo all changes**, listing the
  files it touched and marking each as created, changed or deleted. Undo puts every one of
  them back exactly as it was before the turn.
- The card only counts files that really changed. A review you rejected, or a file Kiro
  rewrote with what it already contained, is not offered — there would be nothing to undo.
- Undo disables itself while it runs, so it cannot be fired twice, and a new turn replaces
  the card instead of stacking another.

## 0.10.3

- **Fixes Accept and Reject doing nothing in 0.10.2.** Those buttons were drawn as inlay
  hints, which VS Code paints as chips but only makes clickable while a modifier key is
  held — so an ordinary click was ignored. They are ordinary clickable actions again,
  still labelled just **Accept** and **Reject** with no icons, and **Accept all** /
  **Reject all** at the top of the file.
- The numbered badge over every hunk stays gone.

## 0.10.2

- **The "Review change N of M" badge over every hunk is gone.** The Accept and Reject
  controls already say what the block is for.
- **Per-hunk actions are now buttons, labelled just Accept and Reject.** They were plain
  text links with icons and a numbered scope. They are drawn as chips at the end of the
  changed line, using VS Code's inlay hint styling, and respond to an ordinary click.
- Whole-file actions at the top are now **Accept all** and **Reject all**, without icons.

## 0.10.1

- **An edit now asks you once, at the moment you can answer.** Kiro editing a file used to
  need two approvals: a permission card asking "may I write this file?", and then the
  review diff asking "keep these changes?". The first was asked before there was anything
  to look at, so there was no way to answer it properly. Kiro now makes the edit and the
  diff is the only gate — the first thing you see is what actually changed.
- The permission card still appears whenever no diff is coming: with
  `kiroChat.reviewFileWrites` off, `kiroChat.allowFileWrites` off, or in the read-only
  **Plan** workflow. In those cases it is the only gate there is.
- Tools that are not edits are unaffected and still ask first.

## 0.10.0

- Review hunks now carry a theme-aware blue **Review change N of M** badge, and the
  CodeLens actions use stronger bracketed **Accept / Reject** labels with their shortcuts.
- The composer now offers **Default, Spec, Quick Spec, Bug Fix, and Plan** modes, including
  a description for each mode and persistence when the panel moves or reloads.
- The selected workflow is applied to every request. **Plan** is enforced as read-only:
  callback writes are refused and direct Kiro writes are restored automatically.

## 0.9.1

- **Nearby edits no longer collapse into one file-sized review action.** Every contiguous
  changed block is now its own selectable hunk, even when only one unchanged line separates
  it from the next edit.
- Per-hunk CodeLens actions are numbered, for example **Accept change 2 of 4**, so their
  exact scope is clear and distinct from the whole-file controls at the top.

## 0.9.0

- **Reviews now render directly in a source editor tab.** Original lines have a red
  background and proposed lines have a green background, using the active VS Code theme's
  diff colours.
- Every pending hunk has prominent CodeLens actions for **Accept this change** and
  **Reject this change**. `Alt+Enter` accepts the hunk under the cursor and
  `Shift+Alt+Enter` rejects it.
- Accepting writes that hunk immediately, removes its original red lines, and clears its
  decorations. Rejecting removes its proposed green lines and restores the original block.
  External file changes still abort the review instead of being overwritten.

## 0.8.0

- **Changed sections can now be accepted or rejected independently with obvious buttons.**
  The review opens as an editor tab with a separate diff card for every hunk and large
  **Accept this change / Reject this change** controls beside it.
- **Accept entire file / Reject entire file** remain available in a sticky toolbar, and
  progress shows how many changed sections are left to review. Closing the tab safely
  rejects the proposal.

## 0.7.0

- **Tool approval now happens inside the Kiro chat.** Permission requests render as an
  inline card with Kiro's available choices instead of opening a modal VS Code popup.
- **Change review now uses VS Code's native diff editor.** The proposed side shows
  **Accept File / Reject File** actions and **Accept Hunk / Reject Hunk** actions directly
  above each changed section. The separate line-checkbox review page has been removed.
- Closing the native diff still rejects undecided changes, and reviews remain serialised
  when Kiro edits several files.

## 0.6.2

- **Change review now works in multi-root workspaces.** Version 0.6.1 checked edits
  against only the first workspace folder, so a file in another open root was mistaken
  for an outside-workspace path and skipped. All open roots are now accepted while paths
  outside every root remain blocked.

## 0.6.1

- **Review now catches Kiro CLI 2.21's real edit path.** Kiro's built-in `FileWrite`
  tool edits the workspace directly instead of calling the ACP `fs/write_text_file`
  callback. The extension now captures those tools too, restores each file to its
  pre-turn contents, and opens the same file/hunk/line review before unlocking chat.
- Cancelling a turn restores any direct edits it already made. With file writing turned
  off, direct Kiro edits are also restored instead of bypassing the read-only setting.

## 0.6.0

- **Review Kiro's edits before they touch disk.** Every proposed file write now opens a
  diff with Apply and Reject controls. Changed lines are checked individually, each diff
  hunk has a master checkbox, and you can still apply or reject the whole file at once.
- Closing a review rejects the write. If the file changes in the editor while its review
  is open, the extension refuses to overwrite the newer version.
- Review is on by default. Turn off `kiroChat.reviewFileWrites` to keep the earlier
  immediate-write behaviour, or turn off `kiroChat.allowFileWrites` for read-only chat.

## 0.5.4

- **The drop area is the whole panel, and now looks like it.** It always was — the
  handlers sit on the panel, not on the message box — but the hint said "drop on the box
  below" and the marker was a small label floating near it, so there was no way to know.
  Dragging over the panel now outlines the whole thing and says "Drop anywhere here to
  attach". Dropping on the transcript, or on the status line at the very top, attaches
  just the same.

## 0.5.3

- **You can drop files straight onto the chat panel — hold Shift while you drag.**
  VS Code makes every webview non-interactive during a drag so it can track the drag for
  its own drop targets, but it deliberately stops doing that while Shift is held. Holding
  Shift hands the drop to the panel, which has been ready to receive it since 0.4.7.
  Drop anywhere on the panel; the file attaches and shows as a chip.
- The **Drop files** row is gone for good. Shift-dragging onto the panel replaces it.
- The panel now says how, since a modifier key is not something anyone would guess.

## 0.5.2

- A new **Ask in VS Code Chat** button at the top of the panel opens the chat box with
  `@kiro` already typed. That is the box you can drag files onto — the chat panel itself
  is a webview, and VS Code makes every webview non-interactive for as long as a drag is
  in progress, so a drop can never land on it, anywhere on it.
- The log now says outright when `@kiro` has registered, so "the participant is missing"
  and "you dropped on the wrong thing" can be told apart.

## 0.5.1

- **The Drop files row is gone.** Dragging a file onto `@kiro` in VS Code's own chat box
  does the same job without taking up space in the sidebar.
- **The file you are looking at is no longer offered twice.** Attach a file — by dragging
  it in, with **+**, or from the Explorer — then open that same file, and the chip row
  showed it once as the attachment and again as "the file you are looking at". Only one
  was ever sent, so the second chip claimed something that did not happen. The same goes
  for highlighting code in a file that is already attached: you get the file once and the
  highlighted lines once. Attaching a *different* file still leaves the focused-file chip
  alone.

## 0.5.0

- **Kiro is now in VS Code's own chat box as `@kiro`** — and there, dragging a file in
  works, because that box is part of VS Code rather than a page inside it. Attach files by
  dragging them from the Explorer, by `#`-mentioning them, or with the paperclip; they
  reach Kiro as files it can open, and are echoed back so you can see what went with your
  question. Selected ranges carry their line numbers.
- This is why dropping onto the chat panel could never work: VS Code sets
  `pointer-events: none` on every webview for as long as any drag is in progress, so the
  panel never sees the drop at all. Nothing the panel does can change that; the native
  chat box is not a webview and is not affected.
- **Both boxes share one conversation.** `@kiro` and the panel talk to the same Kiro
  session, so credits, context and memory stay in one place rather than two agents running
  side by side. Asking in one while the other is mid-reply says so rather than tangling
  the two.
- Answers stream in as they arrive, tools show as progress, and stopping the reply in the
  chat box stops Kiro.
- The panel keeps everything it had — model picker with credit rates, usage, past chats,
  the focused-file chip. Nothing was removed.

## 0.4.9

- **Fixes a bad regression in 0.4.8.** Adding the drop target could fail on start —
  VS Code only picks up a new view after a full restart, so a window that had merely been
  reloaded rejected it with "No view is registered". Everything was registered as one
  statement, and the arguments to it are all evaluated before it runs, so that one failure
  meant every command after it was never registered: the panel appeared but **New
  Session**, **Restart Agent**, **Past Chats**, **Show Usage** and `Ctrl+Alt+K` all did
  nothing. The drop target is now registered on its own and cannot take anything with it.
- If it still cannot register, the panel says so in **Kiro Chat: Show Log** and everything
  else carries on working — only dragging files in is unavailable until VS Code is closed
  and opened again.

## 0.4.8

- **Dragging files from the Explorer works.** It could never work on the chat panel
  itself. VS Code makes every webview non-interactive for the duration of any drag
  anywhere in the window — it sets `pointer-events: none` on the panel the moment a drag
  starts — so no drop event ever reached it, whatever the panel did about it. There is now
  a **Drop files** row under the chat which accepts the drag instead.
- What you drop is attached to your next message and appears as a chip above the message
  box, the same as anything you attach with **+**. The row sits collapsed under the chat
  and can stay that way.
- The **+** button and the Explorer right-click **Add to Chat Context** work as before.

## 0.4.7

- **Dragging files onto the panel is more likely to work, and says so when it does
  not.** A dragged file is offered under several format names at once, and which ones are
  filled in depends on where the drag came from — the panel read one of them and gave up
  quietly if it was empty. It now reads every format, unpacks all the shapes they arrive
  in, and drops the same file only once when two formats describe it.
- Dropped files appear as chips above the message box, alongside the file you are looking
  at, and a reference is written into your message as before.
- **Dragging a picture in from outside VS Code** — Windows Explorer, a browser — now
  attaches it as an image, the same as pasting a screenshot.
- If a drop is not understood, **Kiro Chat: Show Log** now records which formats the drag
  actually offered. A drop that reached the panel and one that never arrived used to look
  identical; they no longer do.

## 0.4.6

- **The file you are looking at goes with your message**, the way Copilot Chat does it. It
  shows as a chip above the message box and is attached, so Kiro can open it rather than
  just being told its name. Before this, a file with nothing selected was mentioned in the
  prompt as "I am looking at …" and never attached — Kiro knew the filename and could not
  read it, and nothing on screen said so or let you stop it.
- Click the chip's **×** to leave the file out. That means "not this file": switching to a
  different file brings it back, but moving around inside the same one does not. Switch it
  off for good with the new **Kiro Chat: Attach Active File** setting.
- If you have already attached the same file with **+**, it is not attached twice.
- Highlighted code still shows as its own chip alongside, so Kiro gets the file to read and
  the exact lines you meant.
- **`kiroChat.sendSelection` now works.** It was offered in settings but nothing in the
  code ever read it, so turning it off did nothing. There is now a check that every setting
  the extension advertises is actually used.

## 0.4.5

- **Reopening a past chat no longer wipes the model credit rates.** Reopening rebuilt the
  model list from what Kiro sends back when it loads a conversation — and that list, like
  the one for a new session, carries no rate. The rates come from Kiro's separate `model`
  command, which was only being asked for when connecting, so after reopening a chat every
  model showed a blank rate for the rest of the session. It is now asked for again.

## 0.4.4

- **Usage opens as a dropdown instead of landing in your conversation.** The account
  report used to be posted into the chat as messages, which shoved the transcript around
  — and, because it went through the same path as a real message, it was saved into your
  chat history as though you had asked for it there. It is now a panel under the credits
  strip: click the strip, or the graph icon at the top of the panel, and click again to
  close it. Clicking elsewhere or pressing Escape closes it too. Reopening shows what was
  already fetched rather than asking Kiro again; **Refresh** asks for fresh figures.
- The credits strip now shows a caret, so it looks like the button it has become.

## 0.4.3

- **Past chats.** The clock icon at the top of the panel lists the conversations you have
  had in this folder, grouped by Today, Yesterday and then by date. Click one to reopen
  it, or the **×** to forget it. Starting a new chat with **+** used to throw the old one
  away; it is now kept.
- Reopening a chat genuinely continues it. Kiro is asked to load the session back, so it
  has the conversation in mind and you can carry on talking rather than reading a
  transcript. Chats are listed per folder, because Kiro ties a conversation to the folder
  it happened in. If Kiro cannot take a conversation back, the chat still opens so you can
  read it, and the message box says it is read-only instead of quietly starting a
  different conversation when you reply.
- History starts empty: chats are recorded as you talk, so conversations from before this
  version are not in the list.
- **Attached images show the picture.** They were listed by filename, because the image
  data was being stripped before the panel ever saw it. Screenshots now appear as
  thumbnails, both on the chip above the message box and in the message once sent. Very
  large images still show as a filename rather than being pushed through as a thumbnail.

## 0.4.2

- **Restarting the agent no longer tells you to sign in again.** Every failure between
  starting Kiro and getting a session — a slow start, a dropped pipe, a missing session id
  — was reported as "you are not signed in", which on a restart is almost always wrong,
  since you were chatting seconds earlier. The real error is now shown, and only a genuine
  login problem sends you to sign in.
- A restart shows **Connecting to Kiro…** in the panel rather than looking like nothing is
  happening. It also retries quietly a few times first, so a temporary failure fixes itself
  without showing you anything.
- **Stop** no longer appears while Kiro is merely starting up, when there is no reply to
  stop.
- **The setup screen sets itself up.** If Kiro's command line tool is not installed, the
  panel now watches for it appearing and connects on its own — the steps tick over as it
  happens and the panel turns into a chat without you clicking anything. Clicking
  **Install Kiro** still only types the command into PowerShell for you to run; nothing
  runs behind your back. There is a **Copy the install command** link if you would rather
  do it yourself.
- The message box is disabled while setup is on screen. You could previously type a
  question and press Send into a Kiro that was not running, and nothing said why.
- **The panel is one column, top to bottom.** Your messages were right-aligned bubbles,
  which gave the transcript two things to follow at once and felt cramped in a narrow
  sidebar. Both you and Kiro now run the full width with a small label above, so the eye
  travels straight down. Fewer borders and boxes throughout.

## 0.4.1

- Fixed the panel painting things that were meant to be hidden. The attach menu, the
  "Drop to add as context" overlay, the usage strip and the attachment chip row were all
  stuck on screen permanently, because the stylesheet outranked the `hidden` attribute.
- The attach menu now opens above the **+** button instead of floating over the message
  box, and the model list stays inside the panel on a narrow sidebar.
- **Usage** works. The request was malformed — Kiro wanted the command as a tagged object
  and got the string `"/usage"`, so it rejected every attempt and the panel answered
  "Kiro would not report account usage here" every single time. It now sends the shape
  Kiro accepts and shows your real plan: name, credits used against your limit, renewal
  date, and whether overages are on. Those figures stay on the usage strip and under the
  model list afterwards.
- **Model credit rates now appear.** The model list Kiro sends with a new session carries
  no rate at all, which is why the column was always empty. The rates come from Kiro's
  `model` command instead, which the panel now asks for on connecting — so every model
  shows what it costs, like `2.2x`, along with its context window.
- The model list has a credits footer, so what this chat has cost, and what your plan has
  left, is visible from the place you pick a model.
- Credits and the context meter are read from ordinary session updates as well as from
  the metadata notification, so the strip fills in instead of staying blank.
- Kiro Chat now finds the Windows CLI at `%LOCALAPPDATA%\Kiro-Cli\`, where the current
  installer puts it, instead of relying on it being on your PATH.
- Windows: pointing `kiroChat.command` at a `.cmd` or `.bat` shim failed with a bare
  "spawn EINVAL" and the sign-in screen, because Node will not launch one directly any
  more. Those now start through the shell, quoted, so a path with spaces works too.
- Windows: no console window flashes up when the agent starts.
- Windows: with no folder open, Kiro was started in whatever directory VS Code itself was
  launched from — usually its own install folder — and file access was fenced to that.
  It now falls back to your home directory. The old fallback read `HOME`, which Windows
  does not set.
- Pressing Enter while Kiro was working started a second turn on top of the first. It no
  longer does.
- Long replies no longer flicker: the transcript repaints once per frame rather than once
  per streamed chunk.
- A code block opened part-way through a sentence rendered as raw placeholder text.

## 0.4.0

- Opening the panel now gives you a connected, empty chat straight away, instead of sitting
  at "Not connected" until you typed something.
- The panel can be moved. Drag its icon to the bottom panel or the secondary sidebar on the
  right, or run **Kiro Chat: Move Panel**. Your conversation survives the move.
- Dropping a file or folder now writes a reference into the message box at your cursor, so
  the text says what you mean, for example `explain @src/api/routes.ts`. The message box
  highlights as the drop target while you drag.

## 0.3.0

- The model list now shows each model's description, with its credit rate on the right.
  The rate appears only when Kiro reports one, never a guess.
- A usage strip shows credits spent in this chat and how full the context is, turning
  amber past 80%. The **Usage** button asks Kiro for your account picture.
- Paste a screenshot straight into the message box, or attach an image file.
- The code you highlight now shows as a live chip above the text box, with the file and
  line numbers, and goes with your message. Click the chip to leave it out.
- Attach files and folders with the **+** button, or right-click them in the Explorer and
  choose **Add to Chat Context**.
- Drag files and folders from the Explorer straight onto the panel.

## 0.2.0

- Pick your model from a dropdown at the bottom of the chat panel, or with
  **Kiro Chat: Change Model**. The list comes from your own Kiro account, and your choice
  is remembered.
- A guided setup screen now appears when Kiro is not installed or you are not signed in,
  with buttons that open a terminal with the right command already typed.
- Finds Kiro on Windows automatically, including the native install at
  `C:\Program Files\Kiro-Cli\` and installs that live inside WSL.
- Upgrading now keeps all your settings, and tells you what changed.
- If your saved path to Kiro stops working, the extension falls back to searching for it
  instead of just failing.
- Requests can no longer hang forever. A stale session used to freeze the panel with no
  error at all.

## 0.1.0

- First version. Chat sidebar, streaming replies, your open file and selection sent as
  context, explain-selection from the editor right-click menu.
