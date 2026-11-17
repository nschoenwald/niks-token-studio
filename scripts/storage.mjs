import { MODULE_ID } from "./const.mjs";

/**
 * Where Token Studio writes its files.
 *
 * Finished tokens go next to the actor's portrait when that folder can be written to, otherwise into the storage
 * folder from the settings. Everything else (portraits, uploaded art, work in progress) goes into the storage folder.
 */

export const DEFAULT_STORAGE_FOLDER = `assets/${MODULE_ID}`;

/** Top-level folders under user data that hold packages; files written there are lost on package updates. */
const PACKAGE_DIRS = ["systems", "modules"];

/**
 * @typedef {object} StorageTarget
 * @property {"data"|"s3"} source   FilePicker source
 * @property {string} path          Folder within the source, decoded, without leading or trailing slashes
 * @property {string} [bucket]      S3 bucket
 */

const filePicker = () => foundry.applications.apps.FilePicker.implementation;

/**
 * Turn a stored file path or URL into the place it lives in.
 * @param {string} src                       A file path, an S3 URL, or (with `isFolder`) a folder.
 * @param {object} [options]
 * @param {boolean} [options.isFolder=false] `src` is a folder rather than a file.
 * @returns {StorageTarget|null}             Null when Token Studio can't or shouldn't write there: data and blob
 *                                           URLs, other websites, Foundry's own public folders (`icons/`…),
 *                                           system and module folders, or a source this server doesn't offer.
 */
export function parseLocation(src, { isFolder = false } = {}) {
    if (!src || /^(data|blob):/i.test(src)) return null;
    const storages = game.data.files?.storages ?? ["data"];

    let source = "data";
    let bucket;
    let key = src;
    const s3 = filePicker().matchS3URL(src);
    if (s3) {
        source = "s3";
        bucket = s3.groups.bucket;
        key = s3.groups.key;
    }
    else if (/^[a-z][a-z\d+.-]*:/i.test(src)) return null; // Another website
    if (!storages.includes(source)) return null;

    const parts = decodePath(key.split(/[?#]/)[0]).split("/").filter(Boolean);
    if (!isFolder) parts.pop();
    if ((source === "data") && parts.length) {
        const top = parts[0];
        if (CONST.FILE_PICKER_PUBLIC_DIRS.includes(top) || PACKAGE_DIRS.includes(top)) return null;
    }
    return { source, bucket, path: parts.join("/") };
}

/**
 * The storage folder from the settings, or the default one when the setting is empty or not writable.
 * @returns {StorageTarget}
 */
export function storageFolder() {
    const value = game.settings.get(MODULE_ID, "storagePath");
    return parseLocation(value, { isFolder: true }) ?? parseLocation(DEFAULT_STORAGE_FOLDER, { isFolder: true });
}

/**
 * Create the folder and its parents. Existing folders are fine.
 * @param {StorageTarget} target
 */
export async function ensureFolder(target) {
    const FP = filePicker();
    let current = "";
    for (const part of target.path.split("/").filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        try {
            await FP.createDirectory(target.source, current, target.bucket ? { bucket: target.bucket } : {});
        } catch {
            // The folder already exists
        }
    }
}

/**
 * Upload a file without Foundry's per-file notification.
 * @param {StorageTarget} target
 * @param {File} file
 * @returns {Promise<string>} The stored path (a full URL for S3).
 */
export async function uploadTo(target, file) {
    const body = target.bucket ? { bucket: target.bucket } : {};
    const res = await filePicker().upload(target.source, target.path, file, body, { notify: false });
    if (!res?.path) throw new Error(`Upload of ${file.name} to ${target.source}:${target.path} failed`);
    return res.path;
}

/**
 * The name a token file starts with: the portrait's file name without extension (and without an earlier
 * `-token-<number>` suffix), or `fallback` when the portrait has no usable file name.
 * @param {string} src       The portrait's path or URL.
 * @param {string} fallback  Used for data URLs, missing images and Foundry's default token.
 * @returns {string}
 */
export function tokenBaseName(src, fallback) {
    let name = "";
    if (src && (src !== CONST.DEFAULT_TOKEN) && !/^(data|blob):/i.test(src)) {
        name = decodePath(src.split(/[?#]/)[0].split("/").pop() ?? "");
        name = name.replace(/\.[^.]*$/, "").replace(/-token-\d+$/, "");
    }
    name = (name || fallback || "").replace(/[\\/:*?"<>|]+/g, "").trim();
    return name || "token";
}

/**
 * The next free number for `<base>-token-<number>` files in a folder. Browsing also checks that the folder can be
 * read, so a failure here means the folder can't be used.
 * @param {StorageTarget} target
 * @param {string} base
 * @returns {Promise<number>}
 */
export async function nextTokenNumber(target, base) {
    const result = await filePicker().browse(target.source, target.path, target.bucket ? { bucket: target.bucket } : {});
    const pattern = new RegExp(`^${escapeRegExp(base)}-token-(\\d+)\\.[^.]+$`, "i");
    let highest = 0;
    for (const file of result?.files ?? []) {
        const match = decodePath(file.split(/[?#]/)[0].split("/").pop()).match(pattern);
        if (match) highest = Math.max(highest, Number(match[1]));
    }
    return highest + 1;
}

/**
 * @param {string} path
 * @returns {string}
 */
function decodePath(path) {
    try {
        return decodeURIComponent(path);
    } catch {
        return path;
    }
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
