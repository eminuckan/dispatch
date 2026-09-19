# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

Pasting 32 KiB or more of text adds that fragment as a text-file attachment so
the agent can inspect it without filling the model context. A smaller paste also
becomes an attachment when inserting it would exceed the message limit. On a
hardware keyboard, use `Cmd+Shift+V` on Apple devices or `Ctrl+Shift+V` elsewhere
to keep a large paste editable in the composer instead.

## Attach files

Attach up to eight files per message. Images can be up to 10 MB; other files can
be up to 50 MB, subject to the environment's upload support and limit. The agent
receives them on the environment's machine.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the mobile photo
library; photos over the image limit are also resized to fit. On mobile, you can
also send files to T3 Code through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, a message sent during a running turn waits at the end of the conversation as a
dashed bubble. It goes out on its own when the agent finishes its next tool
call, or when the turn ends. Use the arrow under the bubble to send it right
away, or the X to move it back into the composer. Stop returns every queued
message to the composer.

In **Settings → General → Follow-up behavior**, choose **Queue** to keep this
behavior or **Steer** to send new messages immediately. This setting applies to
the current client. Messages already queued keep their place.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message now. Change `thread.steerQueuedMessage` in
**Settings → Keybindings** to use another shortcut. It leaves the current draft
in the composer and waits if the agent needs an approval or an answer.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

## Model defaults

T3 Code remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Jev routing and managed teams (experimental)

On this fork's web and desktop clients, configure Jev in Settings → Orchestration.
Add your own Jev API key and explicitly choose the allowed model profiles and
reasoning options. Models in the ordinary picker are not automatically eligible.
**Build model pool** collects models from every ready configured provider and reuses
explicitly approved profiles. New models are inactive until you choose their task
group and agent roles; no capability or price ranking is inferred from model names.
Jev may select between approved profiles using the supplied groups and quota, but
its confidence is not a measurement of model ability. Terra is excluded from generated
presets by product preference and remains available for manual configuration.
Reported exhausted quota is excluded at recommendation and admission time, including
family-specific Claude windows. Unknown quota is labeled, not treated as verified
spare quota. Save to apply. This is not a benchmark-proven optimum or a hard
subscription quota guarantee. Use Customize to review effort and lead/worker roles.
Choose a lead for complex or uncertain tasks; an absent model cannot be
recommended. Enabling routing sends draft text to TypeSafe after a typing pause.
The key is saved in the environment's private secret store.

The composer’s Orchestration switch controls draft assessment and team launch.
Selecting a model manually turns it off for that draft. Existing lead and worker
models remain fixed throughout their conversations.
Confidence describes classification certainty, not the chance that the code is correct.

Enable **Orchestration** in a new composer, then use the normal send button or
Enter to start a managed coding run. With the switch off, draft classification,
automatic model selection, and team creation are disabled for that draft; normal
send uses your selected model. Teams currently support
ready configured provider adapters, use isolated worktrees from committed HEAD, and preserve the
original checkout. Uncommitted changes and attachments are not included. The lead
plans work, workers receive persistent task contracts, and the lead reviews their
results before integrating and verifying the combined change. Native subagent
tools are disabled in managed Codex, Claude, and OpenCode sessions. Other adapters
receive the same no-delegation instruction, but do not yet enforce a native-tool
block; the active-agent limit counts scheduler-managed agents.

Only the lead appears in the sidebar; worker conversations remain accessible from
the team. Open **Agents** in the right panel to see the team hierarchy, assignments, model
and effort, attempts, and review details. The chat shows compact activity and the
current agent’s result. Click an agent name to open its conversation. Agent names
come from a fixed science-inspired catalog and stay the same across retries and
reloads; replacement workers receive separate names. Active teams refresh
automatically. Internal coordination messages stay out of chat; messages you send
yourself remain in Conversation.

The active-agent limit includes the lead. Teams finish when all planned acceptance
criteria pass independent checks in the combined lead worktree; there is no total
turn limit. Repeated corrections or unchanged failed results pause work instead
of starting an automatic retry loop. Failed combined checks receive one focused
correction before pausing with saved evidence. Orchestration settings use agent
and attempt limits, without dollar estimates. They do not measure or enforce your
remaining subscription quota. Saving removes legacy estimated-dollar limits for
new teams; existing runs keep their frozen policy.
The **Agents** panel’s **Pause** control lets current work settle while preventing new turns;
**Cancel** requests interruption. An uncertain dispatch keeps its reservation
until reconciled. Use the Agents panel to see the current state, open its lead
or workers, and inspect a blocker before resuming. Completion does not push
or merge the lead worktree into the original checkout.

A review formatting failure is repaired by the lead without consuming another
worker attempt. For a genuine worker failure, recovery can retain the worker,
increase effort using another allowed profile of the same model, or create a new
worker for a model change. Environment and context problems can pause the run.
Checks and model review reduce risk but do not guarantee correctness or savings;
subscription quota consumption is distinct from API prices.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

The chip shows your comment when it has one, or a short quote preview otherwise. Use the pencil
button to add or change the comment. To remove the citation, place the caret beside its chip and
delete it like other inline context. Copying, reloading, and restoring a
[stashed prompt](#prompt-stash) keep each comment
with its quote, and sending tells the agent which words were quoted and which comment you wrote.
The quoted text and comment count toward the message limit.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to restore them as well.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, since
restoring would erase their changes. A thread that works in the project directory
rewinds the conversation only. The selected prompt and its attachments return to the composer for editing and
resending. Any unsent draft stays above the restored prompt.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. The action is available only when the provider supports rewind.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft. While recording, the screen stays
awake; it can sleep normally once recording stops.

Transcription runs on your device. T3 Code deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

Provider commands must start the message to run. T3 Code commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, a preview annotation, or a file. You can type before and
after a chip, move it by cutting and pasting, and delete it like a character. Hover a chip for
its brief details. Select a terminal excerpt to open its captured output, or select a review
comment, picked element, or preview annotation to open its full details. Chips read as "Terminal
excerpt, Terminal 1 lines 3-4" and similar to screen readers.

A pull request appears as its icon and number. Its color reflects whether it was open, draft,
merged, or closed when it was attached. Select it to inspect the captured title and branches,
then choose **Open pull request** to visit the pull request. On web and desktop, type `#` to browse the newest
pull requests in the current project's repository. Continue typing digits to filter the recent list
by any part of its pull request numbers. A complete number is also resolved directly, even when that
pull request is older than the recent list. Type a single word after `#` to search pull requests in
the repository by text. Choose a result to insert it as a chip.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete T3 Code tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio files have
playback controls. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Pictures, videos and PDFs keep their native viewers, and
other document formats such as Word or Pages open in the device's own viewer when it has one.
If nothing on the device can show a format, save or share it to open it elsewhere.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your T3 Code session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
