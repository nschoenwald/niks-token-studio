import { MODULE_ID, DEFAULT_FRAME } from "./const.mjs";
import { QuickTokenStudio } from "./token-studio.mjs";
import { DEFAULT_STORAGE_FOLDER } from "./storage.mjs";

Hooks.once("init", () => {
    game.settings.register(MODULE_ID, "tokenLocation", {
        name: `${MODULE_ID}.settings.tokenLocation.Name`,
        hint: `${MODULE_ID}.settings.tokenLocation.Hint`,
        scope: "world",
        config: true,
        type: String,
        choices: {
            portrait: `${MODULE_ID}.settings.tokenLocation.Portrait`,
            storage: `${MODULE_ID}.settings.tokenLocation.Storage`
        },
        default: "portrait"
    });

    game.settings.register(MODULE_ID, "storagePath", {
        name: `${MODULE_ID}.settings.storagePath.Name`,
        hint: `${MODULE_ID}.settings.storagePath.Hint`,
        scope: "world",
        config: true,
        type: String,
        filePicker: "folder",
        default: DEFAULT_STORAGE_FOLDER
    });

    game.settings.register(MODULE_ID, "outputResolution", {
        name: `${MODULE_ID}.settings.outputResolution.Name`,
        hint: `${MODULE_ID}.settings.outputResolution.Hint`,
        scope: "client",
        config: true,
        type: Number,
        choices: {
            128: "128 px",
            256: "256 px",
            512: "512 px",
            1024: "1024 px",
            2048: "2048 px"
        },
        default: 512
    });

    game.settings.register(MODULE_ID, "defaultFrame", {
        name: `${MODULE_ID}.settings.defaultFrame.Name`,
        hint: `${MODULE_ID}.settings.defaultFrame.Hint`,
        scope: "world",
        config: true,
        type: String,
        filePicker: "image",
        default: DEFAULT_FRAME
    });
});

/**
 * Token Studio needs the actor's owner and the right to upload files (it saves the finished images to the server).
 * @param {Actor} actor
 * @returns {boolean}
 */
function canOpenStudio(actor) {
    return (actor instanceof Actor) && actor.isOwner && game.user.can("FILES_UPLOAD");
}

function openStudio(actor) {
    new QuickTokenStudio({ actor }).render({ force: true });
}

const ACTION = "niksTokenStudioOpen";

/**
 * D&D 5e actor sheets: an entry in the window's header controls menu (the ⋮ button).
 */
Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
    const actor = app.document;
    if ( !canOpenStudio(actor) ) return;
    if ( controls.some(c => c.action === ACTION) ) return;
    controls.unshift({
        action: ACTION,
        icon: "fa-solid fa-user-pen",
        label: `${MODULE_ID}.OpenStudio`,
        onClick: () => openStudio(app.document)
    });
});
