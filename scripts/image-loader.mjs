/**
 * Loading images for the editor canvases.
 *
 * Token Studio reads pixels back from its canvases (eraser, chroma key, saving), so every image has to be loaded
 * without tainting the canvas. Images on another host (S3, a CDN) used to be loaded with `<img crossOrigin>`.
 * That fails whenever the browser already has the same image cached from a request without CORS (the actor sheet
 * shows the portrait as a plain `<img>`): Chromium reuses the cached response, which has no
 * `Access-Control-Allow-Origin` header, and the load fails (https://crbug.com/409090). That's why it only
 * happened "sometimes", after the sheet had been opened.
 *
 * Images are now fetched with `foundry.utils.fetchResource`, which is how Foundry loads its own textures: a CORS
 * fetch that retries once with a cache-busting query parameter. The blob is then decoded from a same-origin
 * object URL, so the canvas stays clean.
 */

/**
 * Load an image so it can be drawn to a canvas and read back.
 * @param {string} src  A file path, a URL on another host, or a data/blob URL.
 * @returns {Promise<HTMLImageElement>}
 * @throws {Error} With `corsBlocked` and `host` set when another host refused the request.
 */
export async function loadImage(src) {
    if (!src) throw new Error("No image source");
    if (/^(data|blob):/i.test(src)) return decode(src);

    let blob;
    try {
        blob = await foundry.utils.fetchResource(src);
    } catch (err) {
        const host = foreignHost(src);
        if (host) {
            err.corsBlocked = true;
            err.host = host;
        }
        throw err;
    }

    const url = URL.createObjectURL(blob);
    try {
        return await decode(url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Add a query parameter that forces a fresh request, keeping any query the URL already has
 * (signed S3 URLs break when a second `?` is appended).
 * @param {string} src
 * @returns {string}
 */
export function withCacheBuster(src) {
    const url = URL.parse(src, window.location.href);
    if (!url) return src;
    url.searchParams.set("nts", Date.now().toString());
    return url.href;
}

/**
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
async function decode(src) {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
}

/**
 * @param {string} src
 * @returns {string|null} The host of `src` when it isn't this Foundry server.
 */
function foreignHost(src) {
    const url = URL.parse(src, window.location.href);
    if (!url || (url.origin === window.location.origin)) return null;
    return url.host;
}
