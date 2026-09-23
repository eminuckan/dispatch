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
also send files to Dispatch through another app's system share sheet.

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
messages survive app restarts and remain on the device while an environment is offline or
temporarily unavailable.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

## Model defaults

Dispatch remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

Leaving reasoning level or service tier unset uses the provider's own configuration.

## Dispatch Flow and managed teams (experimental)

Dispatch Flow is optional. You can choose it during onboarding or configure it later in
**Dispatch Flow** in the sidebar or **Settings → Flow**. Select which provider models Dispatch may use as **Lead**, **Worker**,
or both, then choose a Flow mode. Your saved model choices remain the authority for managed
runs, including provider-supported options such as reasoning effort or model variants.

**Standard** needs no Dispatch Connect account and does not use Dispatch's hosted routing
service. It runs with the Lead and Worker models you selected on that environment.

**Auto** requires a signed-in Dispatch Connect account and a linked environment. It uses
Dispatch-hosted Smart Routing to choose direct execution or a managed team from your selected
models. For routing, Dispatch sends the task objective and minimal selected-model metadata to
the hosted service, which may use JEV. Dispatch covers that routing service; your coding-model
usage still runs through your own provider accounts. If Smart Routing becomes unavailable,
Flow keeps Auto selected, shows the fallback, and runs that task with Standard instead.

Flow is offered for new drafts rather than converting an already-started conversation. The
composer shows **Flow · Standard** or **Flow · Auto** according to the environment setting.
Turning Flow on applies it to that draft. Selecting a model manually turns Flow off for the
draft and sends through the selected model normally.

Managed runs use isolated worktrees based on committed repository state, leaving your
original checkout untouched. Auto may keep bounded work on one selected executor or use a
managed Lead and Workers when routing calls for it. Dispatch keeps durable messages and
attempt history across retries or reloads. Worker results are reviewed before integration,
and every run is verified against persisted acceptance criteria before it can complete.
Completion does not push or merge the managed worktree into your original checkout.

Open **Agents** in the right panel to inspect the direct executor or managed Lead, Workers,
task state, attempts, messages, settlements, and blockers. **Pause** prevents new managed work
from starting while current work settles; **Cancel** requests interruption.

You can inspect worker conversations, but they are read-only; send instructions to the Lead.
The Lead and Workers exchange progress messages automatically, visible in both relevant chats.
Flow message status distinguishes a message waiting for a safe handoff from one accepted into an
active or new agent turn.

If a provider reaches a limit or becomes unavailable, Flow follows the saved provider-limit
behavior: **Ask** before switching, **Continue with another selected provider** when Dispatch
can make the allowed replacement safely, or **Pause** the run. Managed mode also blocks
provider-native delegation where the adapter can enforce that restriction deterministically;
providers without that guarantee are not treated as safe managed execution targets.

Checks, reviews, and model selection reduce risk but do not guarantee correctness or remaining
subscription quota. Uncommitted changes are not part of a new managed run; commit the state you
want Flow to work from first.

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

Transcription runs on your device. Dispatch deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

Provider commands must start the message to run. Dispatch commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Context in your message

Context you attach lands where your cursor is, as a chip inside your text: a terminal excerpt,
a review comment from a diff or file, or a preview annotation. You can type before and
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

On web and desktop, attached photos and files stay above your message instead of inserting text.
Select an attachment to preview it, or remove it from the tray to leave it out of the message.
On narrow screens, expand the attachment count to manage the files. Dispatch includes file names
and references for the agent automatically when you send. Editing message text does not remove
attachments; removing an attachment also clears any explicit references from older drafts.

Copy text that holds chips and paste it into another draft, in the same thread or another one,
and the chips come along with what they point to. Images and files are fetched again from the
environment they came from; while that happens the chip shows a dashed outline, and if it cannot
complete Dispatch tells you and leaves the chip for you to remove or replace. A chip whose
context is no longer available shows the same dashed outline; hover it for what to do.

Copying a message with the copy button, or copying text out of it, gives other apps readable
Markdown with a link in place of each chip. Older messages that were sent before chips still
show their context. Stashing a prompt keeps its chips and what they point to; restoring brings
them back.

On mobile, tap a chip to inspect its content. File references open the current file; attached
files show the copy that was attached to the message.

## Attached files

Select a file chip in your draft or a sent message to preview it. Code and JSON use syntax
highlighting; Markdown, HTML, CSV, and TSV offer rendered and raw views. SVG files open as
vector previews, and audio files have playback controls. SVG uploads use the file size limit
and keep their original format. On mobile, SVG previews are limited to 1 MB; larger SVGs can
still be saved or shared. Large text files show a limited preview; save the file to read it in full.

On web and desktop, files open beside the conversation with the same controls as a workspace
file: a header row with the view toggle, **Copy contents** and **Save file**. On mobile, documents
open in the same file screen as workspace files; its menu holds **Copy contents**, **Save or
share** and **Open in file viewer**. Photos, videos and PDFs keep their native viewers, and
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
automatically. HTML previews cannot access your Dispatch session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens a compatible installed file viewer.
