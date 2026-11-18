import { loadImage } from "./image-loader.mjs";

/**
 * Preview of Foundry's Dynamic Token Ring, drawn with 2D canvas from the ring sprite sheet in use
 * (`CONFIG.Token.ring.spritesheet`, so the Steel/Bronze setting and rings added by modules are respected).
 *
 * It follows `foundry.canvas.placeables.tokens.TokenRing` and its shader (`TokenRingSamplerShader`), without the
 * animated effects:
 * - The ring frame is picked by the token's size (`gridTarget` closest to min(width, height)).
 * - Ring color: inside the color band (or where the `-msk` frame is set) the ring shows `ringColor × red channel`.
 *   Without a ring color it's white, so the band shows the red channel as grey, like Foundry.
 * - Background: the `-bkg` frame with an overlay blend of the background color (none for white).
 * - Order from the bottom: background, ring, token art.
 */

const DEFAULT_SUBJECT_THICKNESS = 0.6666666; // TokenRing.#defaultSubjectThickness
const WHITE = 0xFFFFFF;

/** @type {Map<string, Promise<object>>} Loaded sprite sheets by path. */
const sheets = new Map();

/**
 * @param {string} path
 * @returns {Promise<{image: HTMLImageElement, frames: object, config: object}>}
 */
function loadSheet(path) {
    if (!sheets.has(path)) {
        const promise = (async () => {
            const url = new URL(path, window.location.href);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Ring sprite sheet ${path}: ${response.status}`);
            const data = await response.json();
            const image = await loadImage(new URL(data.meta?.image ?? "", url).href);
            return { image, frames: data.frames ?? {}, config: data.config ?? {} };
        })();
        promise.catch(() => sheets.delete(path)); // Try again next time
        sheets.set(path, promise);
    }
    return sheets.get(path);
}

/**
 * Copy one sprite sheet frame into its own canvas at its source size.
 * @param {HTMLImageElement} image
 * @param {object} frame  TexturePacker frame data.
 * @returns {HTMLCanvasElement}
 */
function extractFrame(image, frame) {
    const { x, y, w, h } = frame.frame;
    const source = frame.sourceSize ?? { w, h };
    const offset = frame.spriteSourceSize ?? { x: 0, y: 0 };
    const canvas = document.createElement("canvas");
    canvas.width = source.w;
    canvas.height = source.h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (frame.rotated) {
        // TexturePacker stores rotated frames turned 90° clockwise, with w/h of the unrotated frame
        ctx.save();
        ctx.translate(offset.x, offset.y + w);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(image, x, y, h, w, 0, 0, h, w);
        ctx.restore();
    }
    else ctx.drawImage(image, x, y, w, h, offset.x, offset.y, w, h);
    return canvas;
}

/**
 * @param {*} value         A color from the token data, or null.
 * @param {*} fallback      The sprite sheet's default color, or undefined.
 * @returns {number}        The color as 0xRRGGBB, white meaning "no tint".
 */
function resolveColor(value, fallback) {
    const color = (value === null) || (value === undefined) ? WHITE : Number(Color.from(value));
    if ((color === WHITE) && (fallback !== undefined) && (fallback !== null)) {
        const def = Color.from(fallback);
        if (def.valid) return Number(def);
    }
    return Number.isFinite(color) ? color : WHITE;
}

const channels = hex => [(hex >> 16) & 0xFF, (hex >> 8) & 0xFF, hex & 0xFF];

/**
 * Tint the background with an overlay blend (like `colorizeTokenBackground`), keeping its alpha.
 * @param {HTMLCanvasElement} canvas
 * @param {number} color
 */
function tintBackground(canvas, color) {
    if (color === WHITE) return;
    const ctx = canvas.getContext("2d");
    const [tr, tg, tb] = channels(color);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const overlay = (b, t) => (b < 128) ? (2 * b * t) / 255 : 255 - ((2 * (255 - b) * (255 - t)) / 255);
    for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        d[i] = overlay(d[i], tr);
        d[i + 1] = overlay(d[i + 1], tg);
        d[i + 2] = overlay(d[i + 2], tb);
    }
    ctx.putImageData(img, 0, 0);
}

/**
 * Color the ring (like `colorizeTokenRing` without animated effects).
 * @param {HTMLCanvasElement} canvas
 * @param {number} color
 * @param {{startRadius: number, endRadius: number}|null} band  Null when a mask frame is used instead.
 * @param {HTMLCanvasElement|null} mask
 */
function colorizeRing(canvas, color, band, mask) {
    const ctx = canvas.getContext("2d");
    const { width, height } = canvas;
    const img = ctx.getImageData(0, 0, width, height);
    const d = img.data;
    const m = mask ? mask.getContext("2d").getImageData(0, 0, width, height).data : null;
    const [cr, cg, cb] = channels(color);
    const cx = width / 2;
    const cy = height / 2;
    const half = Math.min(width, height) / 2;
    // Band limits as squared pixel distances (no square root per pixel)
    const start2 = band ? (band.startRadius * half) ** 2 : 0;
    const end2 = band ? (band.endRadius * half) ** 2 : 0;
    for (let y = 0, i = 0; y < height; y++) {
        const dy2 = ((y + 0.5) - cy) ** 2;
        for (let x = 0; x < width; x++, i += 4) {
            if (m && m[i + 3]) {
                // Mask: ringColor × mask red, over the ring with the mask's alpha
                const a = m[i + 3] / 255;
                const red = m[i] / 255;
                const ra = d[i + 3] / 255;
                const outA = a + (ra * (1 - a));
                if (!outA) continue;
                d[i] = ((cr * red * a) + (d[i] * ra * (1 - a))) / outA;
                d[i + 1] = ((cg * red * a) + (d[i + 1] * ra * (1 - a))) / outA;
                d[i + 2] = ((cb * red * a) + (d[i + 2] * ra * (1 - a))) / outA;
                d[i + 3] = outA * 255;
                continue;
            }
            if (!band || !d[i + 3]) continue;
            const dist2 = (((x + 0.5) - cx) ** 2) + dy2;
            if ((dist2 < start2) || (dist2 >= end2)) continue;
            const red = d[i] / 255;
            d[i] = cr * red;
            d[i + 1] = cg * red;
            d[i + 2] = cb * red;
        }
    }
    ctx.putImageData(img, 0, 0);
}

/**
 * Render the ring for a token: background and ring, as one square canvas at the frame's resolution.
 * @param {object} options
 * @param {number} options.gridSize         min(width, height) of the token in grid units.
 * @param {*} [options.ringColor]           The token's ring color (null for the default).
 * @param {*} [options.backgroundColor]     The token's ring background color (null for the default).
 * @returns {Promise<{canvas: HTMLCanvasElement}>}
 */
export async function renderRing({ gridSize = 1, ringColor = null, backgroundColor = null } = {}) {
    const sheet = await loadSheet(CONFIG.Token.ring.spritesheet);
    const rings = Object.entries(sheet.frames)
        .filter(([name]) => !name.includes("-bkg") && !name.includes("-msk"))
        .map(([name, frame]) => ({ name, frame, gridTarget: frame.gridTarget ?? 1 }))
        .sort((a, b) => a.gridTarget - b.gridTarget);
    if (!rings.length) throw new Error("No ring frames in the sprite sheet");
    const ring = rings.reduce((best, r) => Math.abs(r.gridTarget - gridSize) < Math.abs(best.gridTarget - gridSize) ? r : best);

    const ringCanvas = extractFrame(sheet.image, ring.frame);
    const bkgFrame = sheet.frames[`${ring.name}-bkg`];
    const maskFrame = sheet.frames[`${ring.name}-msk`];
    const mask = maskFrame ? extractFrame(sheet.image, maskFrame) : null;
    const band = mask ? null : (ring.frame.colorBand ?? sheet.config.defaultColorBand ?? { startRadius: 0.59, endRadius: 0.7225 });

    colorizeRing(ringCanvas, resolveColor(ringColor, ring.frame.ringColor ?? sheet.config.defaultRingColor), band, mask);

    const out = document.createElement("canvas");
    out.width = ringCanvas.width;
    out.height = ringCanvas.height;
    const ctx = out.getContext("2d");
    if (bkgFrame) {
        const bkg = extractFrame(sheet.image, bkgFrame);
        tintBackground(bkg, resolveColor(backgroundColor, ring.frame.backgroundColor ?? sheet.config.defaultBackgroundColor));
        ctx.drawImage(bkg, 0, 0, out.width, out.height);
    }
    ctx.drawImage(ringCanvas, 0, 0);
    return { canvas: out };
}

/**
 * How large the ring is compared with the saved token image, which Token Studio saves at
 * `texture.scale = ring.subject.scale = padding × 2/3`, so the ring always covers one grid square and the image
 * shows at padding × 2/3 of it.
 *
 * Foundry's "grid" fit mode (core `dynamicTokenRingFitMode`) doesn't apply: it only shrinks the art of tokens without
 * a distinct subject texture, and `TokenDocument#hasDistinctSubjectTexture` is true whenever
 * `ring.subject.texture` is set, which Token Studio always does when saving.
 * @param {number} padding  The padding factor (1 to 2).
 * @returns {number} Ring diameter ÷ canvas size.
 */
export function ringToCanvasRatio(padding) {
    return 1 / (padding * DEFAULT_SUBJECT_THICKNESS);
}
