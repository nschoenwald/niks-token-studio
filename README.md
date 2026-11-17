# Nik's Token Studio

A [Foundry VTT](https://foundryvtt.com/) module for D&D 5e that turns any portrait into a framed token or a cropped portrait without leaving Foundry. Position and scale the art, pick a frame, erase backgrounds, let parts of the art break out of the frame, and save the result straight to the actor.

> A fork of [Phil's Token Studio](https://github.com/PhilsModules/phils-token-studio) by **Phil**, maintained for Foundry VTT V14 and D&D 5e 6.1.

---

## Installation

In Foundry's **Install Module** dialog, paste this manifest URL:

```
https://github.com/nschoenwald/niks-token-studio/releases/latest/download/module.json
```

## Compatibility

- **Foundry VTT:** V14
- **Game System:** D&D 5e 6.1

## Opening Token Studio

Open an actor's sheet, click the **⋮** button in the window header and choose **Token Studio**. The entry appears for users who own the actor and are allowed to upload files, because Token Studio saves the finished images to the server.

## Features

### Token

- **Three layers:** the frame on top, the art in the middle and an optional background image at the bottom. Pick a layer and set its size, position and rotation with the sliders, drag it on the preview, or zoom it with the mouse wheel, by scrolling on a trackpad or by pinching. Zooming keeps the spot under the mouse in place.
- **Frames:** three frames come with the module (friendly, hostile and neutral). Add your own image from your files, or choose **No Frame**. To take a frame off the list, drag it onto the trash can. Frames you add stay in the list while the window is open. To always start with one of them, set it as **Default Frame** in the module settings.
- **Fill:** a solid color behind the art, inside the frame.
- **Padding:** makes the saved image larger than one grid square (up to 200 %), so art that breaks out of the frame isn't cut off.
- **Dynamic Token Ring:** saves the token without a frame and turns on Foundry's Dynamic Token Ring for it. The preview shows the actual ring: the style chosen in Foundry's settings, the ring for the token's size, and the token's ring and background colors (animations aren't shown).
- **Save Token** updates the actor's prototype token and its tokens on the scene you're viewing, and shows the file the token was saved to.
- **Where tokens are saved:** next to the actor's portrait, named after it with a running number: a portrait `Goblin Boss.webp` gets `Goblin Boss-token-1.webp`, then `Goblin Boss-token-2.webp`. This works for portraits in your user data and on S3. When the portrait's folder can't be used (Foundry's own icons, a system or module folder, another website, a pasted image), the token goes into the storage folder instead, named after the actor. You can also always save to the storage folder with the **Token Location** setting.

### Portrait

- Crop the art as a square (1:1) or upright (2:3) portrait.
- **Save Portrait** sets it as the actor's image.

### Brushes and Effects

- **Eraser:** erases parts of the selected layer, or brings erased parts back.
- **Break Out:** paint over parts of the art (a sword, a wing, a hat) to draw them on top of the frame. Presets fill the area in one click: **Top** (everything above the middle of the frame), **Bottom** or **Everything**; refine it with the brush afterwards.
- **Paint:** paints color inside the frame.
- **Remove a Color:** removes one color from the selected layer, for green-screen art or plain backgrounds. **Tolerance** sets how close a color has to be.
- **Shadow:** a colored, softened shadow behind the art.
- **Brush preview:** while a brush is on, a ring under the mouse shows where and how big it paints (dashed when it takes something away).
- **Undo and Redo** step through your changes to the picture (layer positions, sliders, brush strokes, frames, fills, loaded images). Shortcuts: Ctrl+Z to undo, Ctrl+Shift+Z or Ctrl+Y to redo (Cmd on Mac), while Token Studio is the active window.

### Images

- Drop an image onto the window, paste one from the clipboard, or browse your files. The actor's current image is loaded when you open Token Studio.
- Very large images are scaled down when they're loaded, to at most 4 times the token resolution on the longer side (2048 px at the default 512 px). That's twice the largest token Token Studio saves, so the editor stays fast while zooming in still looks sharp.
- Images from S3 or another file host work as long as that host allows cross-origin (CORS) requests from your Foundry server. If it doesn't, Token Studio tells you which host refused the image.
- Your work in progress (positions, erased areas, painted areas) is kept per actor and comes back the next time you open Token Studio for that actor. If the actor's portrait was changed outside Token Studio in the meantime, Token Studio starts from the new portrait and keeps only your frame, background, fill and shadow.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Token Location** | Next to the actor's portrait | Where finished tokens are saved: next to the portrait, or always in the storage folder |
| **Storage Folder** | `assets/niks-token-studio` | Folder for portraits, uploaded art, work in progress, and tokens that can't be saved next to the portrait. Pick it with the folder browser (user data or S3) |
| **Token Resolution** | 512 px | Width and height of saved tokens for one grid square (per user) |
| **Default Frame** | Friendly frame | Frame that Token Studio starts with for actors you haven't edited yet |

## Languages

🇬🇧 English · 🇩🇪 Deutsch

Translations into other languages by native speakers are welcome as an issue or pull request.

## Credits

Nik's Token Studio is based on [Phil's Token Studio](https://github.com/PhilsModules/phils-token-studio) by **Phil** (version 1.6.3), licensed under GPL-3.0. Thank you for the original module!

Changes in this fork: renamed module, new frames, opened from the actor sheet's header menu, Foundry V14 and D&D 5e 6.1 support, and a fix for images loaded from S3 and other file hosts. See [CHANGELOG.md](CHANGELOG.md) for details.

## License

GNU General Public License v3.0. See [LICENSE](LICENSE).

- Copyright © Phil (original code)
- Copyright © 2026 nikolai.sw (changes in this fork, frames)

The frames in `assets/frames/` were made for this fork and are licensed under GPL-3.0 as well. The frame images, portrait image and texts of the original module are not included.

---

## Modules by Nik

### 🧩 Nik's Tweaks
* **[Nik's Foundry Tweaks](https://github.com/nschoenwald/niks-foundry-tweaks)** – System-independent quality-of-life tweaks and the shared settings dashboard of Nik's Tweaks modules.

### 🎲 D&D 5e Specific
* **[Nik's DnD5e Tweaks](https://github.com/nschoenwald/niks-dnd5e-tweaks)** – Consolidated collection of quality-of-life enhancements and combat automation tweaks for DnD5e.
* **[Nik's Give & Take](https://github.com/nschoenwald/niks-give-and-take)** – Players hand items and money to other characters and the party, and take them from the party's stash.

### ⚔️ Combat & Token Tools
* **[Nik's Action HUD](https://github.com/nschoenwald/niks-action-hud)** – Sleek, modern canvas-docked Action HUD for quick access to attacks, spells, inventory, and utility rolls.
* **[Nik's Effects Panel](https://github.com/nschoenwald/niks-effects-panel)** – Floating panel next to the sidebar that shows the selected token's active effects, to check, disable or remove them without opening the character sheet.
* **[Nik's Token Tags](https://github.com/nschoenwald/niks-token-tags)** – Automatically numbers duplicate combatant NPCs (A, B, C…) with color-coded letter overlays.
* **[Nik's Shared NPC Initiative](https://github.com/nschoenwald/niks-shared-npc-initiative)** – Groups NPCs of the same type in combat so they share a single initiative roll.
* **[Nik's Movement Control](https://github.com/nschoenwald/niks-movement-control)** – GM controls to toggle player movement and automatically restrict/allow movement on combat start and end.
* **[Nik's Token Motion](https://github.com/nschoenwald/niks-token-motion)** – Tokens hop square by square like miniatures, lift and set down like chess pieces, or glide smoothly, and long moves no longer crawl across the map.
* **[Nik's Tiny Change Logs](https://github.com/nschoenwald/niks-tiny-changelogs)** – Compact, single-line chat messages logging token HP and Temp HP changes.

### 🎨 Visuals & Display
* **[Nik's Token Studio](https://github.com/nschoenwald/niks-token-studio)** – Turn any portrait into a framed token or a cropped portrait without leaving Foundry.
* **[Nik's Dynamic Roll Area](https://github.com/nschoenwald/niks-dynamic-roll-area)** – Dynamically restricts Dice So Nice 3D dice rolling area to exclude the sidebar / chat log across all screen resolutions and window sizes.

### ⚙️ Utilities & System Management
* **[Nik's Settings Locks](https://github.com/nschoenwald/niks-settings-locks)** – Soft-lock and hard-lock client settings and keybindings across all connected players.
* **[Nik's Compendium Search Tweaks](https://github.com/nschoenwald/niks-compendium-search-tweaks)** – Configure which compendium packs are included or excluded from native sidebar search.
* **[Nik's Copy Environment](https://github.com/nschoenwald/niks-copy-environment)** – Copy the list of systems, modules, and versions, and export/import game and player settings.
* **[Nik's Show & Tell](https://github.com/nschoenwald/niks-show-and-tell)** – Share popout images to chat and paste image files directly into chat messages.
* **[Nik's Zoom / Pan Options](https://github.com/nschoenwald/niks-zoom-pan-options)** – Touchpad and scroll wheel pan/zoom controls and canvas navigation enhancements.
* **[Nik's Scene Transformations](https://github.com/nschoenwald/niks-scene-transformations)** – Rotate scenes or add playable space around them, with tokens, walls, lights, tiles and regions moved along so everything stays in place.
* **[Nik's Wall Height](https://github.com/nschoenwald/niks-wall-height)** – Give walls a bottom and top elevation, so tokens, lights and sounds above or below a wall ignore it.
* **[Nik's Scene Defaults](https://github.com/nschoenwald/niks-scene-defaults)** – Set your own defaults for new scenes (grid, vision, fog, lighting, background and more), so you don't have to change them on every scene.
