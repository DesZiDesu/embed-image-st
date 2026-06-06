# Image Embed & Auto-Trigger (SillyTavern extension)

Store your own images — uploaded files **or** image links — together with a short
description of each one, then let the AI automatically pick the image that best
fits the current scene and attach it to the chat, the same way an expression
sprite or emoji would appear next to a character's reply.

Think of it as a reverse picture-prompt: instead of you choosing a picture for
the AI, the AI chooses one of *your* pictures for the moment.

## Features

- **Two image sources** – upload a local image file or paste a direct image URL.
- **Rich metadata per image** – name, character, scene, free-form context, and
  comma-separated keywords. These are what the matcher uses to decide.
- **Two selection methods**
  - **AI picks** – sends a tiny extra request describing the recent scene and
    your image list, and the model returns the best match.
  - **Keyword match** – no extra request; scores images against the recent
    messages using their keywords/scene/character text.
- **Automatic or manual triggering**
  - *Automatic*: after each AI message, with a configurable chance.
  - *Manual*: the **Pick scene image** button in the wand (extensions) menu, the
    **Pick now** button in settings, or the `/embedimage` slash command.
- **AI awareness (caption note)** – optionally append a short note built from the
  image's metadata (e.g. `*[Image shown: Mona Lisa, famous portrait]*`) to the
  message, so the model knows what it just showed and can reference it on later
  turns. Note: selection and this caption are based on the **text you write** for
  each image — the AI does not visually recognize the picture's contents.
- **Scoped storage** – keep image sets **global**, **per character / group**, or
  **per chat**.
- **Import / export** the current scope's collection as JSON.
- Images are stored in the browser's IndexedDB so your `settings.json` stays
  small; only lightweight metadata is saved there.

## Installation

1. In SillyTavern, open **Extensions → Install extension**.
2. Paste this repository URL:
   `https://github.com/deszidesu/embed-image-st`
3. Reload SillyTavern.

Or clone manually into
`SillyTavern/data/<user>/extensions/` (or `public/scripts/extensions/third-party/`
for older versions).

## Usage

1. Open **Extensions** and expand **Image Embed & Auto-Trigger**.
2. Choose your **Storage scope** (global / per character / per chat).
3. Add images:
   - Paste an image URL **or** choose a file.
   - Fill in *Character*, *Scene*, *Context*, and *Keywords* so the matcher has
     something to work with. The more descriptive, the better the picks.
   - Click **Add image**.
4. Pick a **Trigger mode**:
   - *Automatic* attaches an image after AI messages (tune the **Trigger chance**).
   - *Manual* only attaches when you ask for it.
5. During roleplay, the chosen image is attached to the character's message.

### Tips

- For accurate **AI picks**, write the *Scene*/*Context* the way the scene would
  read in chat (mood, location, action, expression).
- **Keyword match** is free and instant — great if you don't want extra model
  requests. Put the words you expect to appear in chat into *Keywords*.
- Use **per-character** scope to give each character their own expression set.

## Settings reference

| Setting | Description |
| --- | --- |
| Enable extension | Master on/off switch. |
| Storage scope | Where collections are stored: global, character/group, or chat. |
| Trigger mode | Automatic after AI messages, or manual only. |
| Selection method | AI request vs. local keyword scoring. |
| Trigger chance (%) | Probability of attempting a pick on each AI message (auto mode). |
| Scene context (messages) | How many recent messages describe the scene. |
| Max images per request | Caps how many candidates are sent to the AI. |
| Keyword match threshold | Minimum keyword score required for a keyword pick. |
| Allow same image twice in a row | Permit repeating the previous pick. |
| Tell the AI what the image is | Append a metadata caption note to the message so the AI knows what was shown. |
