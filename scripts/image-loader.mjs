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
 * How much smaller than the source file an image or buffer is (1 = full size). Layers are drawn at their original
 * pixel size, so a downscaled image looks the same and layer transforms keep their meaning.
 * @type {WeakMap<CanvasImageSource, number>}
 */
const SOURCE_SCALES = new WeakMap();

/**
 * @param {CanvasImageSource} source
 * @returns {number} Pixels in `source` per pixel of the original image (1 when not downscaled).
 */
export function sourceScale(source) {
    return SOURCE_SCALES.get(source) ?? 1;
}

/**
 * @param {CanvasImageSource} target
 * @param {number} scale
 */
export function setSourceScale(target, scale) {
    if (scale === 1) SOURCE_SCALES.delete(target);
    else SOURCE_SCALES.set(target, scale);
}

/**
 * The size an image or buffer stands for: its size before downscaling.
 * @param {{width: number, height: number}} source
 * @returns {{width: number, height: number}}
 */
export function originalSize(source) {
    const scale = sourceScale(source);
    return { width: source.width / scale, height: source.height / scale };
}

/**
 * Load an image so it can be drawn to a canvas and read back.
 * @param {string} src                   A file path, a URL on another host, or a data/blob URL.
 * @param {object} [options]
 * @param {number} [options.maxSide]     Downscale so the longer side is at most this many pixels.
 * @returns {Promise<HTMLImageElement|HTMLCanvasElement>} A canvas when the image was downscaled.
 * @throws {Error} With `corsBlocked` and `host` set when another host refused the request.
 */
export async function loadImage(src, { maxSide = Infinity } = {}) {
    return limitSize(await fetchImage(src), maxSide);
}

/**
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
async function fetchImage(src) {
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
 * Downscale an image whose longer side exceeds `maxSide`, with high-quality smoothing. Smaller images are returned
 * unchanged (never enlarged).
 * @param {HTMLImageElement} img
 * @param {number} maxSide
 * @returns {HTMLImageElement|HTMLCanvasElement}
 */
function limitSize(img, maxSide) {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    const longSide = Math.max(width, height);
    if (!(longSide > maxSide)) return img;
    const scale = maxSide / longSide;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    setSourceScale(canvas, canvas.width / width);
    return canvas;
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
