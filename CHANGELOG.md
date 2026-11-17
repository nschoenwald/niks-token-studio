# Changelog

## 14.2.0

- **Break Out presets:** three buttons in the Break Out tool fill the Break Out area in one click: **Top** (everything above the middle of the frame breaks out: heads, hats, horns), **Bottom** (feet, tails) and **Everything** (the whole figure sits over the frame). A preset replaces what you painted; refine it with the brush afterwards. Works best with cut-out art. Each preset can be undone.
- **Cleaner Break Out edges:** areas that break out were drawn twice inside the frame, which made soft edges and the shadow darker there. They're drawn once now.
- **Header icons are back with Carolingian UI:** the Undo, Redo, Save Portrait and Save Token buttons lost their icons when the Carolingian UI module was active.

## 14.1.1

- **Dynamic Token Ring preview fixed for worlds using the "Grid" fit mode:** the preview showed the art too small, with an empty gap inside the ring. Saved tokens were never affected; the preview now matches them.

## 14.1.0

- **Undo works now.** Undo steps back through every change to the picture: moving, scaling and rotating layers, slider changes, brush strokes, removed colors, frames, fills and loaded images. Before, it often seemed to do nothing. Brush sizes, tool switches and other settings aren't undo steps.
- **Redo:** a new button next to Undo brings back what you undid.
- **Keyboard shortcuts:** Ctrl+Z (Cmd+Z on Mac) undoes and Ctrl+Shift+Z or Ctrl+Y redoes while Token Studio is the active window. They no longer reach Foundry's own Undo.
- **The Undo button looks right again.** It's no longer squeezed into a thin bar, and Undo and Redo are greyed out when there's nothing to undo or redo.
- **Large images load faster and use far less memory.** Art, backgrounds and frames larger than needed are scaled down when they're loaded, to at most 4 times the token resolution on the longer side (2048 px at the default 512 px). That's twice the largest token Token Studio saves, so zooming in still looks sharp. Smaller images are never enlarged, and nothing changes in size or position on screen, also for work saved earlier. Art you drop or paste is saved at the reduced size.
- **Dynamic Token Ring preview:** with **Dynamic Token Ring** ticked, the preview now shows the real ring around the token instead of a dashed circle: the ring style from Foundry's settings (Steel, Bronze or a ring added by a module), the right ring for the token's size, the token's ring and background colors, and the art at the size Foundry will show it inside the ring. Parts painted with Break Out show on top of the ring, like on the canvas. Animated ring effects aren't shown.
- **Easier zooming on a trackpad:** scrolling and pinching now zoom smoothly instead of racing, and a mouse wheel changes the size by about 10 % per notch. Zooming keeps the spot under the mouse in place (the frame still zooms around its centre) and works anywhere in the preview, not only over the image.
- **Brush preview:** while the eraser, Break Out or Paint brush is on, a ring under the mouse shows exactly where and how big you'll paint. The ring is dashed when the brush takes something away.
- **Token saved message:** after saving a token, a message shows the file it was saved to, and says so when it went to the storage folder because the portrait's folder couldn't be used.
- **A changed portrait is picked up.** If an actor's portrait was changed outside Token Studio, opening Token Studio again starts from the new portrait. The frame, background, fill and shadow you chose are kept. Saving a portrait from inside Token Studio still keeps your art as it was.
- **Fixes:** the eraser now works on the portrait view, Fit Image no longer stops halfway, and a dropped image is loaded only once.

## 14.0.0

First release of Nik's Token Studio, a fork of Phil's Token Studio 1.6.3.

- **Foundry V14 and D&D 5e 6.1.** Token Studio now works with the current Foundry and D&D 5e versions.
- **New place to open it:** Token Studio is now an entry in the **⋮** menu in the actor sheet's header. It shows up for users who own the actor and may upload files.
- **New frames:** three new frames (friendly, hostile and neutral) replace the old ones.
- **Tokens are saved next to the portrait** and named after it with a running number, for example `Goblin Boss-token-1.webp`, also on S3. If the portrait's folder can't be used, tokens go into the storage folder. The new **Token Location** setting can always use the storage folder instead, and the storage folder can now be picked with the folder browser.
- **Images from S3 and other file hosts load reliably.** Before, an actor's image stored on S3 often failed to load into Token Studio, especially after the actor's sheet had been open. If a file host doesn't allow cross-origin requests at all, Token Studio now says which host refused the image.
- **No upload messages:** saving tokens, portraits and work in progress no longer shows an upload notification for each file.
- **Always dark:** the editor keeps its dark look when Foundry uses the light theme, so text and controls stay readable.
- **Fixes:** the **Browse Files** button on the empty preview works again, the token and portrait options sit in a compact row, and changing the padding no longer distorts areas painted with the Break Out brush.
- **Texts:** reworded labels in English and German, and the settings are now translated.
