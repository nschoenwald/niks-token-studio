# Changelog

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
