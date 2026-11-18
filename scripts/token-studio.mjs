import { MODULE_ID, BUILTIN_FRAMES, DEFAULT_FRAME } from "./const.mjs";
import { loadImage, originalSize, setSourceScale, sourceScale, withCacheBuster } from "./image-loader.mjs";
import { renderRing, ringToCanvasRatio } from "./ring-preview.mjs";
import { ensureFolder, nextTokenNumber, parseLocation, storageFolder, tokenBaseName, uploadTo } from "./storage.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const LOG = "Nik's Token Studio |";

/** @returns {typeof foundry.applications.apps.FilePicker} The configured FilePicker class. */
const filePickerClass = () => foundry.applications.apps.FilePicker.implementation;

/** The image buffers an undo step can restore. */
const BUFFER_KEYS = ["tokenBuffer", "avatarBuffer", "backgroundBuffer", "frameBuffer", "popOutBuffer", "paintBuffer"];

/** The source images the eraser restores from. */
const ORIGINAL_KEYS = ["originalImage", "originalFrameImage", "originalBackgroundImage"];

/** The parts of `uiState` that describe the picture (not tool settings or which tab is open). */
const UNDO_STATE_KEYS = ["token", "avatar", "dynamicRingScale", "useFoundryRing", "avatarAspectRatio", "hasPopOutContent", "sourcePath"];

/** Draft files kept per actor: draft key → buffer property. */
const DRAFT_BUFFERS = {
    token: "tokenBuffer", frame: "frameBuffer", background: "backgroundBuffer", popout: "popOutBuffer", paint: "paintBuffer"
};

/** Undo keeps at most this many steps, and drops the oldest when the copied images pass the memory budget. */
const UNDO_MAX_STEPS = 100;
const UNDO_BYTE_BUDGET = 512 * 1024 * 1024;

/** Click actions and change handlers that change the picture and get an undo step. */
const UNDOABLE_HANDLERS = new Set([
    "_onAutoFit", "_onRemoveFrame", "_onSelectFrame", "_onDeleteBackground", "_onRemoveBackgroundColor",
    "_onApplyChroma", "_onClearPaint", "_onClearPopout", "_onChangeAvatarRatio", "_onChangeRingScale",
    "_onToggleFoundryRing", "_onPopOutPreset"
]);

/** Slider names that change the picture (brush sizes and tolerance are tool settings). */
const UNDOABLE_SLIDERS = new Set(["x", "y", "scale", "rotation", "shadowBlur"]);

/**
 * @param {HTMLCanvasElement} source
 * @returns {HTMLCanvasElement} A copy with the same size and pixels.
 */
function cloneCanvas(source) {
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0);
    setSourceScale(copy, sourceScale(source));
    return copy;
}

/**
 * Loaded images are downscaled so their longer side is at most this many times the token resolution: twice the
 * largest image Token Studio saves (a token with 200 % padding is 2 × the resolution), so zooming in by 2× still
 * uses real pixels. At the default 512 px that's 2048 px.
 */
const MAX_IMAGE_SIDE_FACTOR = 4;

/** Shorthand for this module's localization keys. */
const loc = (key, data) => data ? game.i18n.format(`${MODULE_ID}.${key}`, data) : game.i18n.localize(`${MODULE_ID}.${key}`);

export class QuickTokenStudio extends HandlebarsApplicationMixin(ApplicationV2) {
    
    constructor(options = {}) {
        super(options);
        this.actor = options.actor;
        
        // Settings
        this.resolution = game.settings.get(MODULE_ID, "outputResolution") || 512;
        
        // State
        const defaults = QuickTokenStudio._savedSession(this.actor);
        
        this.uiState = {
            activeView: "token", // 'token' or 'avatar'
            activeLayer: "character", // 'character' or 'background'
            activeTab: "transform",
            drafts: defaults.drafts || {}, // Persistence
            sourcePath: defaults.sourcePath || null, // Track original source
            portrait: this.actor?.img ?? null, // The portrait this session belongs to
            token: {
                transforms: {
                    x: defaults.token?.transforms?.x || 0,
                    y: defaults.token?.transforms?.y || 0,
                    scale: defaults.token?.transforms?.scale || 1.0,
                    rotation: defaults.token?.transforms?.rotation || 0
                },
                frame: {
                    transforms: {
                        x: defaults.token?.frame?.transforms?.x || 0,
                        y: defaults.token?.frame?.transforms?.y || 0,
                        scale: defaults.token?.frame?.transforms?.scale || 1.0,
                        rotation: defaults.token?.frame?.transforms?.rotation || 0
                    },
                    path: defaults.token?.frame?.path || this._getDefaultFramePath()
                },
                fx: {
                    shadowBlur: defaults.token?.fx?.shadowBlur ?? 0,
                    shadowColor: defaults.token?.fx?.shadowColor ?? "#000000",
                    backgroundColor: defaults.token?.fx?.backgroundColor || null 
                },
                // dynamicRingScale & useFoundryRing moved to Root
                avatarAspectRatio: 1.0,
                
                background: {
                    active: defaults.token?.background?.active || false,
                    path: defaults.token?.background?.path || null,
                    transforms: { 
                        x: defaults.token?.background?.transforms?.x || 0, 
                        y: defaults.token?.background?.transforms?.y || 0, 
                        scale: defaults.token?.background?.transforms?.scale || 1, 
                        rotation: defaults.token?.background?.transforms?.rotation || 0 
                    }
                },
                /* framePath: REMOVED - Moved to frame.path */
            },
            avatar: { 
                layer: 'character', 
                transforms: { 
                    x: defaults.avatar?.transforms?.x || 0,
                    y: defaults.avatar?.transforms?.y || 0,
                    scale: defaults.avatar?.transforms?.scale || 1.0,
                    rotation: defaults.avatar?.transforms?.rotation || 0
                },
                fx: {
                    shadowBlur: 0,
                    shadowColor: "#000000",
                    backgroundColor: null 
                }
            },
            
            // Shared State
            frames: [], // This will be populated by _loadUserFrames
            isEraserActive: false,
            eraserMode: "remove", // remove | add
            eraserSize: 50, // Default Eraser Size

            isPopOutActive: false,
            popOutMode: "add", // add | remove
            popOutSize: 50, // Default Pop-Out Size
            
            chromaTolerance: 50,
            chromaColor: "#00ff00",
            
            // Root Level Settings
            dynamicRingScale: defaults.dynamicRingScale || 1.0,
            useFoundryRing: defaults.useFoundryRing || false,
            
            // Paint Tool State
            isPaintActive: false,
            paintMode: "add", // add | remove
            paintSize: 20,
            paintColor: "#ff0000",

            // Content Flags
            hasPopOutContent: defaults.hasPopOutContent || false
        };
        
        this.isCanvasPainting = false; // Flag to track actual canvas painting vs generic dragging
        
        // Assets
        this.frameImage = null; // CanvasImageSource
        this.sourceImage = null; // CanvasImageSource
        this.userFrames = []; // List of frame paths
        
        // Undo History
        this._undoStack = [];
        this._redoStack = [];
        this._pendingChange = null;

        // Performance: redraw batching, art layer cache, scratch canvases, buffer edit counters, draft tracking
        this._pendingDraw = null;
        this._drawFrame = null;
        this._artCache = null;
        this._scratchCanvases = {};
        this._bufferVersions = {};
        this._pristineBuffers = new WeakSet(); // Buffers that still match their source image (no draft needed)
        this._draftSources = {};                // Draft key → the buffer the stored draft file was made from
        
        // Initial load
        this._loadUserFrames();
        this.canvasToken = null;
        this.canvasAvatar = null;
        this.ctxToken = null;
        this.ctxAvatar = null;
        
        // Editable Buffers (Separated)
        this.tokenBuffer = null;
        this.avatarBuffer = null;
        this.backgroundBuffer = null;
        this.frameBuffer = null; // New Frame Buffer
        this.popOutBuffer = null; // New Pop-Out Mask
        this.paintBuffer = null; // Paint Buffer
        this.originalImage = null; // Keep raw ref (Character)
        this.originalFrameImage = null; // Frame Raw
        this.originalBackgroundImage = null; // Background Raw
        
        // Session Flag
        this._sessionRestored = false;
        
        // Bindings
        this._pasteHandler = this._onPaste.bind(this);
        this._moveHandler = this._onCanvasMouseMove.bind(this);
        this._upHandler = this._onCanvasMouseUp.bind(this);
        this._keyHandler = this._onKeyDown.bind(this);
        
        // Actions
        // This specific line should ideally be in _attachEventListeners after HTML is rendered
        // this.element.querySelector("[data-action='toggle-layer']").addEventListener("change", this._onToggleLayer.bind(this));
        
    }
    
    /**
     * The actor's saved session, or the parts of it that still apply when the portrait was changed outside the
     * studio since then: the art, its position and everything painted or erased on it start fresh from the new
     * portrait; frame, background, fill and shadow are kept.
     * @param {Actor} actor
     * @returns {object}
     */
    static _savedSession(actor) {
        const saved = foundry.utils.deepClone(actor?.getFlag(MODULE_ID, "lastState") ?? {});
        // Sessions saved before the portrait was tracked: compare with the art they used
        const knownPortrait = saved.portrait ?? saved.sourcePath;
        if (!actor || !knownPortrait || (knownPortrait === actor.img)) return saved;
        delete saved.sourcePath;
        delete saved.hasPopOutContent;
        delete saved.token?.transforms;
        delete saved.avatar?.transforms;
        const { frame, background } = saved.drafts ?? {};
        saved.drafts = { frame, background };
        return saved;
    }

    _getDefaultFramePath() {
        return game.settings.get(MODULE_ID, "defaultFrame") || DEFAULT_FRAME;
    }
    
    static DEFAULT_OPTIONS = {
        tag: "form",
        id: `${MODULE_ID}-{id}`,
        // The editor has its own fixed dark palette, so it stays dark under the light Core Apps theme as well
        classes: [MODULE_ID, "themed", "theme-dark"],
        window: {
            icon: "fa-solid fa-user-pen",
            resizable: true
        },
        position: {
            width: 1200,
            height: 750 // Optimal height for 350px canvas
        },
        form: {
            handler: QuickTokenStudio.submit,
            closeOnSubmit: false
        }
    };

    get title() {
        return this.actor ? loc("WindowTitle", { name: this.actor.name }) : loc("Title");
    }

    /**
     * EXTEND CLOSE to save state
     */
    async close(options) {
        this._ringResizeObserver?.disconnect();
        if (this._drawFrame) cancelAnimationFrame(this._drawFrame);
        this._drawFrame = null;
        // Save Draft State (Buffers)
        await this._saveDraftState();
        
        window.removeEventListener("paste", this._pasteHandler);
        window.removeEventListener("mousemove", this._moveHandler);
        window.removeEventListener("mouseup", this._upHandler);
        window.removeEventListener("keydown", this._keyHandler, { capture: true });
        return super.close(options);
    }
    
    static PARTS = {
        main: {
            template: `modules/${MODULE_ID}/templates/token-studio.hbs`
        }
    };

    async _loadUserFrames() {
        // Pre-defined defaults
        for (const path of BUILTIN_FRAMES) {
            if (!this.userFrames.includes(path)) {
                this.userFrames.push(path);
            }
        }

        // Also check settings default if different?
        const settingsDefault = game.settings.get(MODULE_ID, "defaultFrame");
        
        if (settingsDefault && !this.userFrames.includes(settingsDefault)) {
            this.userFrames.push(settingsDefault);
        }
    }

    /* ------------------------------------------- */
    /*  Lifecycle                                  */
    /* ------------------------------------------- */

    async _renderHTML(context, options) {
        const result = await super._renderHTML(context, options);
        return result;
    }
    
    _onRender(context, options) {
        super._onRender(context, options);
        
        // Canvas Setup
        this.canvasToken = this.element.querySelector("#canvas-token");
        this.canvasAvatar = this.element.querySelector("#canvas-avatar");
        
        if (this.canvasToken) this.ctxToken = this.canvasToken.getContext("2d");
        if (this.canvasAvatar) this.ctxAvatar = this.canvasAvatar.getContext("2d");
        
        this.drawAll();

        // --------------------------------------------------
        // APP LAYOUT LISTENERS
        // --------------------------------------------------

        // View Selection (Top Bar Toggle)
        // Handled via data-action="setView"


        // Tab Navigation
        const tabs = this.element.querySelectorAll(".tabs-nav .item");
        for (const tab of tabs) {
            tab.addEventListener("click", (e) => {
                this._onTabClick(e);
            });
        }
        
        // Manual Event Listeners
        this._attachEventListeners();

        // Dynamic Token Ring preview: keep the overlay on the token canvas when the window or canvas resizes
        this._ringResizeObserver?.disconnect();
        if (this.canvasToken) {
            this._ringResizeObserver = new ResizeObserver(() => this._layoutRingPreview());
            this._ringResizeObserver.observe(this.canvasToken);
        }
        this._updateRingPreview();
    }

    /* ------------------------------------------- */
    /*  Dynamic Token Ring Preview                 */
    /* ------------------------------------------- */

    /**
     * Render the ring for the current ring setting, token size and ring colors (when they changed), then place it.
     */
    async _updateRingPreview() {
        if (!this.uiState.useFoundryRing) return this._layoutRingPreview();
        const proto = this.actor?.prototypeToken;
        const options = {
            gridSize: Math.min(proto?.width ?? 1, proto?.height ?? 1),
            ringColor: proto?.ring?.colors?.ring ?? null,
            backgroundColor: proto?.ring?.colors?.background ?? null
        };
        const key = JSON.stringify([CONFIG.Token.ring.spritesheet, options.gridSize,
            String(options.ringColor ?? ""), String(options.backgroundColor ?? "")]);
        if (this._ringPreviewKey !== key) {
            this._ringPreviewKey = key;
            this._ringPreviewPending = renderRing(options).catch(err => {
                console.warn(`${LOG} Could not render the Dynamic Token Ring preview, showing a guide circle instead.`, err);
                return null;
            });
            const preview = await this._ringPreviewPending;
            if (this._ringPreviewKey !== key) return; // A newer request took over
            this._ringPreview = preview;
            this._ringPreviewPending = null;
            this.drawTokenSandwich(); // The guide circle is only drawn without a preview
        }
        else if (this._ringPreviewPending) await this._ringPreviewPending; // Same ring still loading
        this._layoutRingPreview();
    }

    /**
     * Size and center the ring overlay on the token canvas. The canvas is made smaller in ring mode so the whole
     * ring fits in the preview.
     */
    _layoutRingPreview() {
        const canvas = this.canvasToken;
        const container = canvas?.parentElement;
        const overlay = container?.querySelector(".nts-ring-preview");
        if (!overlay) return;
        const preview = this.uiState.useFoundryRing ? this._ringPreview : null;
        if (!preview) {
            overlay.hidden = true;
            container.classList.remove("ring-mode");
            canvas.style.maxWidth = canvas.style.maxHeight = "";
            return;
        }

        const ratio = ringToCanvasRatio(this.uiState.dynamicRingScale || 1);
        const fit = Math.max(1, ratio);
        canvas.style.maxWidth = canvas.style.maxHeight = `${100 / fit}%`;
        container.classList.add("ring-mode");

        if (overlay._ringSource !== preview.canvas) {
            overlay.width = preview.canvas.width;
            overlay.height = preview.canvas.height;
            overlay.getContext("2d").drawImage(preview.canvas, 0, 0);
            overlay._ringSource = preview.canvas;
        }
        if (!canvas.offsetWidth) return; // Hidden (portrait view); the resize observer calls again when shown
        const size = canvas.offsetWidth * ratio;
        overlay.style.width = overlay.style.height = `${size}px`;
        overlay.style.left = `${canvas.offsetLeft + (canvas.offsetWidth / 2)}px`;
        overlay.style.top = `${canvas.offsetTop + (canvas.offsetHeight / 2)}px`;
        overlay.hidden = false;
    }

    _attachEventListeners() {
        const html = this.element;
        
        // Click Actions
        html.querySelectorAll("[data-action]").forEach(el => {
            el.addEventListener("click", (ev) => {
                const action = el.dataset.action;
                // Convert kebab-case to camelCase (e.g. toggle-popout -> togglePopOut)
                const camelAction = action.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                const handler = this[`_on${camelAction.charAt(0).toUpperCase() + camelAction.slice(1)}`];
                
                // Inputs and selects with a data-action are handled by their change listeners below
                if (handler && (el.tagName !== "INPUT") && (el.tagName !== "SELECT")) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    this._runHandler(handler, ev, el);
                }
            });
        });


        
        // Drag & Drop for Frames
        const trash = html.querySelector(".trash-can");
        if (trash) {
            trash.addEventListener("dragover", (e) => {
                e.preventDefault();
                trash.classList.add("drag-hover");
            });
            trash.addEventListener("dragleave", (e) => {
                trash.classList.remove("drag-hover");
            });
            trash.addEventListener("drop", (e) => this._onDropTrash(e));
        }
        
        html.querySelectorAll(".frame-item.draggable").forEach(el => {
            el.addEventListener("dragstart", (e) => this._onDragStartFrame(e));
        });

        // Drop Zone (Entire Stage)
        const dropZone = this.element.querySelector("#quick-token-drop-zone");
        if (dropZone) {
            dropZone.addEventListener("dragover", (ev) => {
                ev.preventDefault();
                // dropZone.classList.add("active"); 
            });
            // The global drop listener on `this.element` handles this now.
            // dropZone.addEventListener("drop", this._onDropFile.bind(this));
        }


        // Window listeners (same function references, so re-renders don't add them twice)
        window.addEventListener("paste", this._pasteHandler);
        window.addEventListener("mousemove", this._moveHandler);
        window.addEventListener("mouseup", this._upHandler);
        // Capture phase, so Ctrl+Z reaches the studio before Foundry's own Undo keybinding
        window.addEventListener("keydown", this._keyHandler, { capture: true });
        
        // The application element survives re-renders: bind its drop listeners only once
        if (!this._elementListenersBound) {
            this.element.addEventListener("dragover", e => e.preventDefault());
            this.element.addEventListener("drop", this._onDropFile.bind(this));
            this._elementListenersBound = true;
        }
        
        // Canvas Painting State Listeners (stopped in _onCanvasMouseUp)
        const canvasToken = html.querySelector("#canvas-token");
        const canvasAvatar = html.querySelector("#canvas-avatar");
        const startPainting = () => { this.isCanvasPainting = true; };
        if(canvasToken) canvasToken.addEventListener("mousedown", startPainting);
        if(canvasAvatar) canvasAvatar.addEventListener("mousedown", startPainting);

        // Brush footprint ring
        for (const [canvas, view] of [[canvasToken, "token"], [canvasAvatar, "avatar"]]) {
            if (!canvas) continue;
            canvas.addEventListener("mousemove", ev => this._updateBrushCursor(ev, canvas, view));
            canvas.addEventListener("mouseleave", () => this._hideBrushCursor());
        }
        
        // Color Inputs (Shadow/Background) - FIX: Explicit Listeners
        html.querySelectorAll("input[type='color']").forEach(input => {
            const undoable = ["shadowColor", "backgroundColor"].includes(input.name);
            if (undoable) input.addEventListener("change", () => this._commitChange());
            input.addEventListener("input", (e) => {
                const name = e.target.name;
                const value = e.target.value;
                if (undoable) this._beginChange();
                
                if (name === "shadowColor") {
                    this.uiState.token.fx.shadowColor = value;
                    this._requestDraw();
                } else if (name === "backgroundColor") {
                    this.uiState.token.fx.backgroundColor = value;
                    this._requestDraw();
                } else if (name === "chromaColor") {
                    this.uiState.chromaColor = value;
                    this.uiState.token.chromaColor = value; // ?
                    // this.drawAll(); // Chroma is applied on click
                } else if (name === "paintColor") {
                    this.uiState.paintColor = value;
                }
            });
        });


        // TRANSFORM INPUTS (Sliders & Manual Entry)
        html.querySelectorAll("input[type='range']").forEach(input => {
            const undoable = UNDOABLE_SLIDERS.has(input.name);
            input.addEventListener("input", (event) => {
                if (undoable) this._beginChange();
                this._onTransformChange(event);
            });
            if (undoable) input.addEventListener("change", () => this._commitChange()); // One step per slider drag
        });
        
        html.querySelectorAll(".val-input").forEach(input => {
            // Commit on Change (Blur/Enter)
            input.addEventListener("change", (event) => {
                const target = event.currentTarget;
                const name = target.dataset.target;
                let val = parseFloat(target.value);
                if(isNaN(val)) return;

                // Sync to slider (which triggers the logic)
                const slider = this.element.querySelector(`input[type='range'][name='${name}']`);
                if (slider) {
                    slider.value = val;
                    const undoable = UNDOABLE_SLIDERS.has(name);
                    if (undoable) this._beginChange();
                    // Trigger logic, passing the INPUT as the target so we don't overwrite it
                    this._onTransformChange({ currentTarget: slider, originalTarget: target });
                    if (undoable) this._commitChange();
                } else {
                    // Direct update for non-slider inputs
                    if (name === 'chromaTolerance') {
                         this.element.querySelector("#chroma-tolerance").value = val;
                         this.uiState.chromaTolerance = val;
                         this.drawAll(); // Force redraw
                    }
                }
            });
            
            // Blur on Enter
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") event.currentTarget.blur();
            });
        });

        // Layer Selection
        html.querySelectorAll("input[name='layer']").forEach(input => {
            input.addEventListener("change", this._onLayerChange.bind(this));
        });

        // Selects and checkboxes
        const inputAvatarRatio = html.querySelector("[data-action='changeAvatarRatio']");
        if (inputAvatarRatio) inputAvatarRatio.addEventListener("change", ev => this._runHandler(this._onChangeAvatarRatio, ev));
        
        const inputRingScale = html.querySelector("[data-action='changeRingScale']");
        if (inputRingScale) inputRingScale.addEventListener("change", ev => this._runHandler(this._onChangeRingScale, ev));

        const checkFoundryRing = html.querySelector("[data-action='toggleFoundryRing']");
        if (checkFoundryRing) checkFoundryRing.addEventListener("change", ev => this._runHandler(this._onToggleFoundryRing, ev));




        // Layer Toggle Listener
        const layerToggles = this.element.querySelectorAll("[data-action='toggle-layer']");
        layerToggles.forEach(toggle => {
            toggle.addEventListener("change", this._onLayerChange.bind(this));
        });
        
        // Interactive Canvas Listeners (Bind to BOTH)
        this._bindCanvasEvents(this.canvasToken, "token");
        this._bindCanvasEvents(this.canvasAvatar, "avatar");
        
        // Load Initial Images if not loaded
        const loadPromises = [];

        if (!this.originalImage) {
            if (this.uiState.sourcePath) {
                 loadPromises.push(this._loadSourceImage(this.uiState.sourcePath));
            } else if (this.actor?.img) {
                 this.uiState.sourcePath = this.actor.img;
                 loadPromises.push(this._loadSourceImage(this.actor.img));
            }
        }
        
        // Frame Load
        if (!this.frameBuffer) {
             loadPromises.push(this._loadFrameImage(this.uiState.token.frame.path));
        }
        
        // Background Load
        if (this.uiState.token.background?.path && !this.backgroundBuffer) {
             loadPromises.push(this._loadBackground(this.uiState.token.background.path));
        }

        // Wait for ALL assets to be ready before restoring session
        Promise.all(loadPromises).then(() => {
             this.drawAll(); 
             // Restore Drafts only after buffers exist
             this._restoreSession();
             // Initial View
             this._updateViewVisibility(this.uiState.activeView);
        });

        this._isDragging = false;
        this._dragStart = { x: 0, y: 0 };
    }
    
    async _restoreSession() {
        if (this._sessionRestored) return;
        
        if (this.uiState.drafts) {
            await this._loadDraftState();
            this.drawAll();
        }
        
        this._sessionRestored = true;
        this._clearHistory(); // Undo starts from the picture as it was when the studio opened
        // Closing without changes then skips the actor update (compared in _saveDraftState)
        this._savedStateJSON = JSON.stringify({ ...foundry.utils.deepClone(this.uiState), drafts: this._currentDraftPaths() });
    }
    
    _onTabClick(e) {
        const target = e.currentTarget;
        const group = target.dataset.tab;
        
        this.uiState.activeTab = group;
        // Optimization: Do NOT full re-render on tab switch, just toggle classes
        // this.render(); 

        // Update Nav
        this.element.querySelectorAll(".tabs-nav .item").forEach(t => t.classList.remove("active"));
        target.classList.add("active");
        
        // Update Content
        this.element.querySelectorAll(".tab-content .tab").forEach(t => t.classList.remove("active"));
        this.element.querySelector(`.tab-content .tab[data-tab='${group}']`)?.classList.add("active");
        
        // Update context controls if needed (e.g. if we switch to Style for Avatar)
        this._updateContextControls(this.uiState.activeView);
    }

    _bindCanvasEvents(canvas, viewName) {
         if (!canvas) return;
         // Zoom listeners on the container, so the wheel and pinching work anywhere in the preview
         const zoomArea = canvas.parentElement ?? canvas;
         zoomArea.addEventListener("wheel", (e) => this._onCanvasWheel(e, viewName), { passive: false });
         canvas.addEventListener("mousedown", (e) => this._onCanvasMouseDown(e, viewName));
    }

    _setActiveView(view) {
        if (this.uiState.activeView === view) return;
        this.uiState.activeView = view;
        
        // Update Canvas Highlighting
        this._updateViewVisibility(view);
        this.drawAll(); // The hidden view isn't kept up to date
        
        // Update Sliders to match new view's transforms
        this._updateTransformUI();
        
        // Update Context-Specific UI (Disable Frame controls if Avatar)
        this._updateContextControls(view);
    }
    
    _updateContextControls(view) {
        const isToken = view === 'token';
        
        // Frame Selector
        const frameGroup = this.element.querySelector(".control-group:has(.frame-selector)") || 
                          this.element.querySelector(".frame-selector")?.closest(".control-group");
                          
        if (frameGroup) {
            frameGroup.classList.toggle("disabled", !isToken);
        }
        
        // Scene BG (already handled in _updateViewVisibility somewhat, but good to be explicit)
    }
    
    _updateViewVisibility(view) {
        const tokenContainer = this.element.querySelector("#container-token");
        const avatarContainer = this.element.querySelector("#container-avatar");
        const tokenBtn = this.element.querySelector("button[data-view='token']");
        const avatarBtn = this.element.querySelector("button[data-view='avatar']");
        
        if (tokenContainer) tokenContainer.classList.toggle("hidden", view !== "token");
        if (avatarContainer) avatarContainer.classList.toggle("hidden", view !== "avatar");
        
        if (tokenBtn) tokenBtn.classList.toggle("active", view === "token");
        if (avatarBtn) avatarBtn.classList.toggle("active", view === "avatar");

    }

    // async close(options) moved up
    /* ------------------------------------------- */
    /*  Data Preparation                           */
    /* ------------------------------------------- */

    /* ------------------------------------------- */
    /*  Data Preparation                           */
    /* ------------------------------------------- */

    async _onDragStartFrame(e) {
        const path = e.currentTarget.dataset.path;
        e.dataTransfer.setData("text/plain", path);
    }
    
    async _onDropTrash(e) {
        e.preventDefault();
        e.currentTarget.classList.remove("drag-hover");
        const path = e.dataTransfer.getData("text/plain");
        
        if (!path || path === "default") return;
        
        const { DialogV2 } = foundry.applications.api;
        
        const confirm = await DialogV2.confirm({
            window: { title: loc("RemoveFrameTitle") },
            content: `<p>${loc("RemoveFrameConfirm")}</p><small>${path}</small>`,
            rejectClose: false,
            modal: true
        });
        
        if (confirm) {
            // Remove from list
            this.userFrames = this.userFrames.filter(p => p !== path);
            
            // If active, reset
            if (this.uiState.token.frame.path === path) {
                this.uiState.token.frame.path = this._getDefaultFramePath();
                await this._loadFrameImage(this.uiState.token.frame.path);
            }
            
            this.render();
            this.render();
            ui.notifications.info(loc("FrameRemoved"));
        }
    }

    async _prepareContext(options) {

        const view = this.uiState.activeView;
        const activeState = this.uiState[view];
        
        // Determine which transforms to show based on Layer
        let currentTransforms = activeState.transforms;
        if (view === 'token') {
             if (this.uiState.activeLayer === 'background') {
                 currentTransforms = this.uiState.token.background.transforms;
             } else if (this.uiState.activeLayer === 'frame') {
                 currentTransforms = this.uiState.token.frame.transforms;
             }
        }

        return {
            activeView: view,
            isTokenActive: view === 'token',
            isAvatarActive: view === 'avatar',
            
            // Layer State
            activeLayer: this.uiState.activeLayer,
            isCharacterLayer: this.uiState.activeLayer === 'character',
            isBackgroundLayer: this.uiState.activeLayer === 'background',
            isFrameLayer: this.uiState.activeLayer === 'frame',
            
            hasSourceImage: !!this.originalImage,
            
            // Sliders (Mapped to current layer), rounded for display; the state keeps exact values from zooming
            transforms: {
                x: Math.round(currentTransforms.x),
                y: Math.round(currentTransforms.y),
                scale: Math.round(currentTransforms.scale * 100) / 100,
                rotation: Math.round(currentTransforms.rotation)
            },
            fx: this.uiState.token.fx, // Background color/shadow is global to token for now? Or per layer? Usually global.
            
            frames: (this.userFrames || []).map(f => ({
                name: f.split("/").pop(),
                path: f,
                active: f === this.uiState.token.frame.path
            })),
            /* showSceneBackground: REMOVED */         
            
            // Tools
            eraserSize: this.uiState.eraserSize,
            popOutSize: this.uiState.popOutSize,
            eraserMode: this.uiState.eraserMode,
            popOutMode: this.uiState.popOutMode,
            isEraserActive: this.uiState.isEraserActive,
            isPopOutActive: this.uiState.isPopOutActive,
            chromaTolerance: this.uiState.chromaTolerance,
            chromaColor: this.uiState.chromaColor,

            // Paint Tool
            isPaintActive: this.uiState.isPaintActive,
            paintMode: this.uiState.paintMode,
            paintSize: this.uiState.paintSize,
            paintColor: this.uiState.paintColor,

            // Tab State (Booleans for HBS)
            isTabTransform: (this.uiState.activeTab || "transform") === "transform",
            isTabStyle: this.uiState.activeTab === "style",

            // New State
            // New State
            dynamicRingScale: this.uiState.dynamicRingScale,
            useFoundryRing: this.uiState.useFoundryRing,
            avatarAspectRatio: this.uiState.avatarAspectRatio,
            canUndo: this._undoStack.length > 0,
            canRedo: this._redoStack.length > 0
        };
    }
    

    async _loadFrameImage(src) {
        if (!src) {
            this.frameImage = null;
            this.drawAll();
            return;
        }
        try {
            const img = await loadImage(src, { maxSide: this._maxImageSide });
            // this.frameImage = img; // We don't use the raw image anymore for drawing
            this.originalFrameImage = img; // Keep for restore
            
            // Create Buffer
            this.frameBuffer = this._createBufferFromImage(img);
            
            // Ensure state matches
            this.uiState.token.frame.path = src;
            this.drawAll();
        } catch (err) {
            console.error(`${LOG} Failed to load frame:`, err);
            // Don't break the app, just don't show frame
            this.frameImage = null;
            this.frameBuffer = null;
            this.drawAll();
        }
    }

    async _loadSourceImage(src) {
        if (!src) return;
        
        try {
            // Load the raw image first, downscaled when it's much larger than anything Token Studio saves
            const img = await loadImage(src, { maxSide: this._maxImageSide });
            
            this.originalImage = img;
            
            // Create SEPARATE Buffers
            this.tokenBuffer = this._createBufferFromImage(img);
            this.avatarBuffer = this._createBufferFromImage(img);
            
            // Initialize Pop-Out Buffer (Matches Resolution)
            if (!this.popOutBuffer) {
                this.popOutBuffer = this._createPopOutBuffer();
            }
            if (!this.paintBuffer) {
                this.paintBuffer = this._createPopOutBuffer(); // Same size/logic
            }
            
            
            this.drawAll();

            // Note: Draft loading is now handled in _restoreSession called by _onRender
            // to ensure it happens AFTER initial load but not on every image swap.
            
            this.render();
            return true;
        } catch (err) {
            console.error(`${LOG} Failed to load source:`, err);
            this._notifyLoadError(err);
        }
    }

    _createPopOutBuffer() {
        const canvas = document.createElement("canvas");
        const scale = this.uiState.dynamicRingScale || 1.0;
        const size = Math.round(this.resolution * scale);
        canvas.width = size;
        canvas.height = size;
        this._pristineBuffers.add(canvas); // Empty
        return canvas;
    }

    async _loadBackground(src) {
        if (!src) return;
        try {
            const img = await loadImage(src, { maxSide: this._maxImageSide });

            this.originalBackgroundImage = img; // Keep for restore

            this.uiState.token.background.path = src;
            this.uiState.token.background.active = true;
            this.backgroundBuffer = this._createBufferFromImage(img);
            
            this.drawToken(); // Only affects token
            
            // Auto-activate background layer to show it?
            // this.uiState.activeLayer = 'background';
            // this.render();
        } catch (err) {
            console.error(`${LOG} Failed to load background:`, err);
            this._notifyLoadError(err);
            return false;
        }
        return true;
    }

    _createBufferFromImage(img) {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        setSourceScale(canvas, sourceScale(img));
        this._pristineBuffers.add(canvas); // Copies made for edits (`_editBuffer`) aren't pristine
        return canvas;
    }

    /** @returns {number} The longest side, in pixels, that loaded images keep. */
    get _maxImageSide() {
        return MAX_IMAGE_SIDE_FACTOR * this.resolution;
    }

    /**
     * Draw a layer buffer centred on the current origin at the size of its original image.
     * @param {CanvasRenderingContext2D} ctx
     * @param {HTMLCanvasElement} buffer
     */
    _drawLayerBuffer(ctx, buffer) {
        const { width, height } = originalSize(buffer);
        ctx.drawImage(buffer, -width / 2, -height / 2, width, height);
    }

    _onDropFile(ev) {
        ev.preventDefault();
        
        const file = ev.dataTransfer.files[0];
        if (file && file.type.startsWith("image/")) {
            const reader = new FileReader();
            reader.onload = (e) => this._recordImageLoad(async () => {
                if (this.uiState.activeLayer === 'background') {
                    // Load as background (no storage change yet, just visual)
                    await this._loadBackground(e.target.result);
                } else {
                    this.uiState.sourcePath = null; // Clear old path
                    this._isLocalSource = true; // Mark as needing upload
                    await this._loadSourceImage(e.target.result);
                }
            });
            reader.readAsDataURL(file);
        }
    }

    _onPaste(ev) {
        const items = (ev.clipboardData || ev.originalEvent.clipboardData).items;
        for (const item of items) {
            if (item.type.indexOf("image") !== -1) {
                const blob = item.getAsFile();
                const reader = new FileReader();
                reader.onload = (e) => this._recordImageLoad(async () => {
                    if (this.uiState.activeLayer === 'background') {
                        await this._loadBackground(e.target.result);
                    } else {
                        this.uiState.sourcePath = null; 
                        this._isLocalSource = true; 
                        await this._loadSourceImage(e.target.result);
                    }
                });
                reader.readAsDataURL(blob);
                ev.preventDefault(); 
                break;
            }
        }
    }

    async _onPickSourceFile() {
        try {

            const FilePickerClass = filePickerClass();
            new FilePickerClass({
                type: "image",
                callback: (path) => this._recordImageLoad(async () => {
                    this.uiState.sourcePath = path; // Save the source!
                    await this._loadSourceImage(path);
                })
            }).browse();
        } catch (err) {
            console.error(`${LOG} FilePicker Error:`, err);
            ui.notifications.error(loc("FilePickerFailed"));
        }
    }

    async _onUploadBackground() {
        try {

            const FilePickerClass = filePickerClass();
            new FilePickerClass({
                type: "image",
                callback: (path) => this._recordImageLoad(() => this._loadBackground(path))
            }).browse();
        } catch (err) {
            console.error(`${LOG} FilePicker Error:`, err);
            ui.notifications.error(loc("FilePickerFailed"));
        }
    }

    /**
     * Tell the user why an image didn't load. Images on another host (S3, a CDN) need CORS.
     * @param {Error} err
     */
    _notifyLoadError(err) {
        if (err?.corsBlocked) ui.notifications.error(loc("ImageCorsBlocked", { host: err.host }));
        else ui.notifications.error(loc("FailedLoadImage"));
    }

    /* ------------------------------------------- */
    /*  Canvas Rendering                           */
    /* ------------------------------------------- */

    /**
     * Draw the visible view. The hidden one is drawn when it's shown (`_setActiveView`) or exported.
     */
    drawAll() {
        if (this.uiState.activeView === "avatar") this.drawAvatar();
        else this.drawTokenSandwich();
    }

    /**
     * Redraw on the next animation frame. Mouse moves, wheel events and slider input can fire far more often than
     * the screen refreshes; requests within one frame draw once.
     * @param {object} [options]
     * @param {boolean} [options.syncUI=false]  Also update the sliders and number fields.
     */
    _requestDraw({ syncUI = false } = {}) {
        this._pendingDraw ??= { ui: false };
        if (syncUI) this._pendingDraw.ui = true;
        this._drawFrame ??= requestAnimationFrame(() => this._flushDraw());
    }

    /** Run a requested redraw now. */
    _flushDraw() {
        if (this._drawFrame) cancelAnimationFrame(this._drawFrame);
        this._drawFrame = null;
        const pending = this._pendingDraw;
        this._pendingDraw = null;
        if (!pending) return;
        this.drawAll();
        if (pending.ui) this._updateTransformUI();
    }

    /**
     * A reusable full-size canvas for compositing, so redraws don't allocate new canvases.
     * @param {string} name
     * @param {number} size
     * @returns {HTMLCanvasElement} Cleared, `size` × `size`.
     */
    _scratch(name, size) {
        let canvas = this._scratchCanvases[name];
        if (!canvas) canvas = this._scratchCanvases[name] = document.createElement("canvas");
        if ((canvas.width !== size) || (canvas.height !== size)) {
            canvas.width = size;
            canvas.height = size;
        }
        else canvas.getContext("2d").clearRect(0, 0, size, size);
        return canvas;
    }

    /** Count an in-place change to a buffer (invalidates caches built from it). */
    _bumpBuffer(key) {
        this._bufferVersions[key] = (this._bufferVersions[key] ?? 0) + 1;
    }

    /**
     * The art layer with its shadow and transforms on a token-sized canvas. Rendering it (the shadow blur in
     * particular) is the most expensive part of a redraw, so it's kept until the art, its transforms or its shadow
     * change. Brush strokes on other layers, Break Out painting and frame or background drags reuse it.
     * @param {number} canvasSize
     * @returns {HTMLCanvasElement}
     */
    _artLayer(canvasSize) {
        const state = this.uiState.token;
        const { x, y, scale, rotation } = state.transforms;
        const key = [canvasSize, this._bufferVersions.tokenBuffer ?? 0, x, y, scale, rotation,
            state.fx.shadowBlur, state.fx.shadowColor].join("|");
        const cache = this._artCache;
        if (cache && (cache.key === key) && (cache.buffer === this.tokenBuffer)) return cache.canvas;
        const canvas = this._scratch("art", canvasSize);
        this._drawCharacter(canvas.getContext("2d"), state, canvasSize);
        this._artCache = { key, buffer: this.tokenBuffer, canvas };
        return canvas;
    }
    
    // Listeners for Paint Tool
    _onTogglePaint(ev) {
        // Toggle Paint
        this.uiState.isPaintActive = !this.uiState.isPaintActive;
        
        // Disable others
        if(this.uiState.isPaintActive) {
            this.uiState.isEraserActive = false;
            this.uiState.isPopOutActive = false;
        }
        this.render();
    }
    
    _onSetPaintMode(ev, el) {
        this.uiState.paintMode = el.dataset.mode;
        this.render();
    }
    
    /**
     * Load an image as one undo step.
     * @param {Function} load  Async function that loads the image.
     */
    async _recordImageLoad(load) {
        this._commitChange(); // Don't merge into a change that's still open
        this._beginChange();
        try {
            await load();
        } finally {
            this._commitChange();
        }
    }

    _onClearPaint(ev) {
        if(!this.paintBuffer) return;
        const ctx = this._editBuffer("paintBuffer").getContext("2d");
        ctx.clearRect(0, 0, this.paintBuffer.width, this.paintBuffer.height);
        this.drawAll();
    }

    drawTokenSandwich(targetCtx = null, isExport = false) {
        // if (!this.canvasToken || !this.ctxToken) return;
        // Allow rendering to offscreen canvas
        if (!targetCtx && (!this.canvasToken || !this.ctxToken)) return;
        
        const ctx = targetCtx || this.ctxToken;
        const state = this.uiState.token;
        const size = this.resolution;
        
        // ----------------------------------------------------
        // PREPARE GEOMETRY
        // ----------------------------------------------------
        // Dynamic Ring Scale:
        // By default, Resolution = 1 Grid Unit.
        // If scale is 1.5, Canvas Size = Resolution * 1.5.
        // But the RING itself must remain at Resolution size (centered).
        
        const ringScale = this.uiState.dynamicRingScale || 1.0;
        const canvasSize = Math.round(size * ringScale);
        
        if (this.canvasToken.width !== canvasSize || this.canvasToken.height !== canvasSize) {
            this.canvasToken.width = canvasSize;
            this.canvasToken.height = canvasSize;
        }
        
        // Clean Slate (New Size)
        ctx.clearRect(0, 0, canvasSize, canvasSize);

        const fState = state.frame;
        // Center acts as the anchor (Offset by canvas center)
        const cx = canvasSize/2 + fState.transforms.x;
        const cy = canvasSize/2 + fState.transforms.y;
        
        // Ring Radius is based on BASE RESOLUTION (Grid Unit), not canvas size
        const r = (size/2) * fState.transforms.scale; 

        // ----------------------------------------------------
        // RENDER LAYERS (Order: BG -> Char-In-Hole -> Frame -> Char-Pop-Out)
        // ----------------------------------------------------
        
        ctx.save();
        
        // 1. Background (Clipped to Circle)
        if (state.fx.backgroundColor || (state.background?.active && this.backgroundBuffer)) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
            ctx.clip();
            
            if (state.fx.backgroundColor && !this.uiState.isEraserActive) {
                 ctx.fillStyle = state.fx.backgroundColor;
                 ctx.fill();
            }
            if (state.background?.active && this.backgroundBuffer) {
                const bgState = state.background;
                ctx.translate(canvasSize/2 + bgState.transforms.x, canvasSize/2 + bgState.transforms.y);
                ctx.rotate((bgState.transforms.rotation * Math.PI) / 180);
                ctx.scale(bgState.transforms.scale, bgState.transforms.scale);
                this._drawLayerBuffer(ctx, this.backgroundBuffer);
            }
            ctx.restore();
        }

        // 1.5 PAINT LAYER (Painted manually) - Merged on top of Background
        if (this.paintBuffer && this._bufferHasContent(this.paintBuffer)) {
            ctx.save();
             // CLIP to Circle (same as BG)
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
            ctx.clip();
            
            // Draw Paint
            ctx.drawImage(this.paintBuffer, 0, 0); // Paint buffer is canvasSize
            
            ctx.restore();
        }

        // 2. Character (Part 1: Inside the Hole)
        // This draws the character UNDER the frame, so edges are hidden by the ring.
        if (this.tokenBuffer) {
            ctx.save();
            // CLIP to Circle
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(0, r), 0, Math.PI * 2);
            ctx.clip();
            
            // Draw Character (cached art layer)
            const art = this._artLayer(canvasSize);
            const breaksOut = this.popOutBuffer && this.uiState.hasPopOutContent;
            if (breaksOut) {
                // Leave out the Break Out areas: step 4 draws them over the frame, and drawing them twice would
                // darken soft edges and the shadow (a visible seam along a preset's edge)
                if ((this.popOutBuffer.width !== canvasSize) || (this.popOutBuffer.height !== canvasSize)) {
                    this.popOutBuffer.width = canvasSize;
                    this.popOutBuffer.height = canvasSize;
                }
                const hole = this._scratch("hole", canvasSize);
                const holeCtx = hole.getContext("2d");
                holeCtx.drawImage(art, 0, 0);
                holeCtx.globalCompositeOperation = "destination-out";
                holeCtx.drawImage(this.popOutBuffer, 0, 0);
                holeCtx.globalCompositeOperation = "source-over";
                ctx.drawImage(hole, 0, 0);
            }
            else ctx.drawImage(art, 0, 0);
            
            ctx.restore();
        }

        // 3. Draw The Frame (The Ring)
        // SKIP if Exporting OR if using Foundry Ring (since we only show guide)
        const usingFoundryRing = this.uiState.useFoundryRing;
        
        // VISUAL GUIDE: If using Foundry Ring use dashed line
        if (usingFoundryRing && !isExport && !this._ringPreview) {
             ctx.save();
             ctx.translate(canvasSize/2 + fState.transforms.x, canvasSize/2 + fState.transforms.y);
             ctx.rotate((fState.transforms.rotation * Math.PI) / 180);
             ctx.scale(fState.transforms.scale, fState.transforms.scale);
             
             ctx.beginPath();
             ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
             ctx.lineWidth = 2;
             ctx.setLineDash([5, 5]); // Dashed Line
             ctx.arc(0, 0, size/2 - 2, 0, Math.PI * 2); // Slightly inside
             ctx.stroke();
             
             ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
             ctx.lineWidth = 1;
             ctx.setLineDash([]); // Solid contrast
             ctx.stroke();
             
             ctx.restore();
        }

        // Only draw the ACTUAL frame buffer if we are NOT using Foundry Ring
        // (And implicitly not exporting with skipFrame logic, but usingFoundryRing covers both now)
        if (this.frameBuffer && !usingFoundryRing) {
            ctx.save();
            ctx.translate(canvasSize/2 + fState.transforms.x, canvasSize/2 + fState.transforms.y);
            ctx.rotate((fState.transforms.rotation * Math.PI) / 180);
            ctx.scale(fState.transforms.scale, fState.transforms.scale);
            // Draw Buffer instead of Image
            // We draw it at SIZE (Rez), centered.
            ctx.drawImage(this.frameBuffer, -size/2, -size/2, size, size); 
            ctx.restore();
        }
        
        // 4. Character (Part 2: Pop-Out / Brush Only)
        // This draws ONLY the parts painted by the brush, ON TOP of the frame.
        // We now check uiState.hasPopOutContent to avoid running this on empty buffers
        if (this.tokenBuffer && this.popOutBuffer && this.uiState.hasPopOutContent) {
             ctx.save();
             
             // Art layer (cached, with shadow) on a reusable scratch canvas
             const charC = this._scratch("popout", canvasSize);
             const charCtx = charC.getContext("2d");
             charCtx.drawImage(this._artLayer(canvasSize), 0, 0);
             
             // Apply MASK (Destination-In) using ONLY the Brush Buffer
             charCtx.globalCompositeOperation = "destination-in";
             // PopOut Buffer defaults to Resolution Size currently. 
             // We align it to center.
             // Ensure PopOut Buffer matches Canvas Size (Resize clears it!)
             if (this.popOutBuffer.width !== canvasSize || this.popOutBuffer.height !== canvasSize) {
                 this.popOutBuffer.width = canvasSize;
                 this.popOutBuffer.height = canvasSize;
             }
             
             charCtx.drawImage(this.popOutBuffer, 0, 0);
             charCtx.globalCompositeOperation = "source-over";
             
             // Draw Result onto Main Canvas (Over Frame)
             ctx.drawImage(charC, 0, 0);
             
             ctx.restore();
        }
        
        // Pop-Out Mask Overlay (Visual Guide)
        if (this.uiState.isPopOutActive && this.popOutBuffer && !isExport) {
            ctx.save();
            ctx.globalAlpha = 0.3;
             // Ensure alignment (resize only if needed, though usually handled above)
             if (this.popOutBuffer.width !== canvasSize) {
                 this.popOutBuffer.width = canvasSize;
                 this.popOutBuffer.height = canvasSize;
             }
             ctx.drawImage(this.popOutBuffer, 0, 0);
            ctx.restore();
        }


        ctx.restore();
    }

    /**
     * Draw the art layer with its shadow and transforms, centred on the token canvas.
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} state      `uiState.token`
     * @param {number} canvasSize
     */
    _drawCharacter(ctx, state, canvasSize) {
        ctx.save();
        if (state.fx.shadowBlur > 0) {
            ctx.shadowColor = state.fx.shadowColor;
            ctx.shadowBlur = state.fx.shadowBlur;
        }
        ctx.translate(canvasSize/2 + state.transforms.x, canvasSize/2 + state.transforms.y);
        ctx.rotate((state.transforms.rotation * Math.PI) / 180);
        ctx.scale(state.transforms.scale, state.transforms.scale);
        this._drawLayerBuffer(ctx, this.tokenBuffer);
        ctx.restore();
    }

    /**
     * Fill the Break Out mask with a preset area, replacing what was painted. Refine it with the brush afterwards.
     * - top: everything above the frame's centre line
     * - bottom: everything below it
     * - all: the whole image
     * @param {Event} event
     * @param {HTMLElement} target  Carries `data-preset`.
     */
    _onPopOutPreset(event, target) {
        if (!this.popOutBuffer) return ui.notifications.warn(loc("NoImageForLayer"));
        const ringScale = this.uiState.dynamicRingScale || 1.0;
        const canvasSize = Math.round(this.resolution * ringScale);
        const buffer = this._editBuffer("popOutBuffer");
        if ((buffer.width !== canvasSize) || (buffer.height !== canvasSize)) {
            buffer.width = canvasSize;
            buffer.height = canvasSize;
        }
        const ctx = buffer.getContext("2d");
        ctx.clearRect(0, 0, canvasSize, canvasSize);
        ctx.fillStyle = "#ffffff";
        const cy = (canvasSize / 2) + this.uiState.token.frame.transforms.y;
        const centre = Math.min(Math.max(Math.round(cy), 0), canvasSize);
        switch (target.dataset.preset) {
            case "top": ctx.fillRect(0, 0, canvasSize, centre); break;
            case "bottom": ctx.fillRect(0, centre, canvasSize, canvasSize - centre); break;
            case "all": ctx.fillRect(0, 0, canvasSize, canvasSize); break;
            default: return;
        }
        this.uiState.hasPopOutContent = true;
        this.drawTokenSandwich();
    }

    drawToken() {
        this.drawTokenSandwich();
    }

    _bufferHasContent(canvas) {
        // Quick check if canvas is empty? 
        // For now assume yes if we are using it.
        // Performance heavy to check pixels every frame.
        return true; 
    }

    drawAvatar() {
        if (!this.canvasAvatar || !this.ctxAvatar) return;
        const ctx = this.ctxAvatar;
        const state = this.uiState.avatar;
        
        const ratio = this.uiState.avatarAspectRatio || 1.0;
        const width = this.resolution;
        const height = this.resolution * ratio;
        
        if (this.canvasAvatar.width !== width || this.canvasAvatar.height !== height) {
             this.canvasAvatar.width = width;
             this.canvasAvatar.height = height;
        }

        ctx.clearRect(0, 0, width, height);
        ctx.save();

        // Background
        if (state.fx.backgroundColor) {
             ctx.fillStyle = state.fx.backgroundColor;
             ctx.fillRect(0, 0, width, height);
        }

        // Image
        if (this.avatarBuffer) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, width, height);
            ctx.clip();
            
            // Center is width/2, height/2
            ctx.translate(width/2 + state.transforms.x, height/2 + state.transforms.y);
            ctx.rotate((state.transforms.rotation * Math.PI) / 180);
            ctx.scale(state.transforms.scale, state.transforms.scale);
            
            this._drawLayerBuffer(ctx, this.avatarBuffer);
            ctx.restore();
        }
        ctx.restore();
    }

    /* ------------------------------------------- */
    /*  Interactive Canvas                         */
    /* ------------------------------------------- */

    _onCanvasMouseDown(event, viewName) {
        event.preventDefault(); 
        this._isDragging = true;
        this._activeDragView = viewName;
        this._dragStart = { x: event.clientX, y: event.clientY };
        
        // Everything until the mouse is released (a brush stroke or a drag) is one undo step
        this._beginChange();
        this._pointerChange = true;

        // Store initial transform of the Dragged View, respecting Active Layer
        if (viewName === 'token') {
             if (this.uiState.activeLayer === 'background') {
                 this._lastTransform = { ...this.uiState.token.background.transforms };
             } else if (this.uiState.activeLayer === 'frame') {
                 this._lastTransform = { ...this.uiState.token.frame.transforms };
             } else {
                 this._lastTransform = { ...this.uiState.token.transforms };
             }
        } else {
             this._lastTransform = { ...this.uiState[viewName].transforms };
        }
        
        // Auto-activate this view if needed
        // this._setActiveView(viewName); // Maybe redundant if we are already seeing it
    }

    /* ------------------------------------------- */
    /*   Canvas Interaction (Brush / Eraser)       */
    /* ------------------------------------------- */

    _onCanvasMouseMove(event) {
        // Painting Security Check: Only paint if we started clicking ON the canvas
        // This prevents sliders from triggering paint logic when dragging over canvas
        if (!this.isCanvasPainting) return;
        
        // Double Check: If we are hovering an input, ignore (Safety Net)
        if (event.target.tagName === 'INPUT' || event.target.closest('.control-group')) return;

        // 0.5 paint brush (Color)
        if (this.uiState.isPaintActive && (event.buttons === 1)) {
             event.preventDefault();
             // Only works on Token View
             if (this.uiState.activeView !== 'token') return;
             
             if (!this.canvasToken || !this.paintBuffer) return;
             const r = this.canvasToken.getBoundingClientRect();
             const mx = event.clientX - r.left;
             const my = event.clientY - r.top;
             
             // Map Mouse -> Canvas Coords
             const width = this.canvasToken.width;
             const height = this.canvasToken.height;
             const scaleX = width / r.width;
             const scaleY = height / r.height;
             
             const canvasX = mx * scaleX;
             const canvasY = my * scaleY;
             
             const ctx = this._editBuffer("paintBuffer").getContext("2d");
             ctx.save();
             
             // MODE LOGIC
             if (this.uiState.paintMode === 'remove') {
                 ctx.globalCompositeOperation = "destination-out"; // Erase paint
             } else {
                 ctx.globalCompositeOperation = "source-over"; // Add paint
                 ctx.fillStyle = this.uiState.paintColor;
             }
             
             ctx.beginPath();
             ctx.arc(canvasX, canvasY, this.uiState.paintSize / 2, 0, Math.PI * 2);
             ctx.fill();
             ctx.restore();
             
             this._requestDraw();
             return;
        }

        // 0. POP-OUT BRUSH (Handle if Token View + PopOut Active + Button Down)
        // This is a "Masking" brush. Painting White reveals the image on top of frame.
        if (this.uiState.isPopOutActive && (event.buttons === 1)) {
             // console.log("PopOut Brush Active"); 
             event.preventDefault();
             // Only works on Token View
             if (this.uiState.activeView !== 'token') return;
             
             if (!this.canvasToken || !this.popOutBuffer) return;
             const r = this.canvasToken.getBoundingClientRect();
             const mx = event.clientX - r.left;
             const my = event.clientY - r.top;
             
             // Map Mouse -> Canvas Coords
             const width = this.canvasToken.width;
             const height = this.canvasToken.height;
             const scaleX = width / r.width;
             const scaleY = height / r.height;
             
             const canvasX = mx * scaleX;
             const canvasY = my * scaleY;
             
             const ctx = this._editBuffer("popOutBuffer").getContext("2d");
             ctx.save();
             
             // MODE LOGIC
             if (this.uiState.popOutMode === 'remove') {
                 ctx.globalCompositeOperation = "destination-out"; // Erase mask
             } else {
                 ctx.globalCompositeOperation = "source-over"; // Add mask (White)
                 ctx.fillStyle = "#ffffff";
             }
             
             ctx.beginPath();
             ctx.arc(canvasX, canvasY, this.uiState.popOutSize / 2, 0, Math.PI * 2);
             ctx.fill();
             ctx.restore();
             
             this.uiState.hasPopOutContent = true; // Mark as dirty
             this._requestDraw();
             return;
        }

        // 1. STANDARD ERASER (Handle regardless of Drag state if Eraser is Active + Button Down)
        // Only if PopOut is NOT active
        if (this.uiState.isEraserActive && (event.buttons === 1) && !this.uiState.isPopOutActive) {
            event.preventDefault();
            
            // Geometric Detection for Robustness
            const mx = event.clientX;
            const my = event.clientY;
            
            let viewName = null;
            let canvas = null;
            
            // Check Token Canvas
            if (this.canvasToken) {
                const r = this.canvasToken.getBoundingClientRect();
                if (mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) {
                    viewName = 'token';
                    canvas = this.canvasToken;
                }
            }
            
            // Check Avatar Canvas (if not found yet)
            if (!viewName && this.canvasAvatar) {
                const r = this.canvasAvatar.getBoundingClientRect();
                if (mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom) {
                    viewName = 'avatar';
                    canvas = this.canvasAvatar;
                }
            }
            
            if (!viewName) return;

        // Select active buffer based on DETECTED view AND Active Layer
        let bufferKey;
        let state = null;

        if (viewName === 'token') {
            if (this.uiState.activeLayer === 'background') {
                 bufferKey = "backgroundBuffer";
                 state = this.uiState.token.background;
            } else if (this.uiState.activeLayer === 'frame') {
                 bufferKey = "frameBuffer";
                 state = this.uiState.token.frame;
            } else {
                 bufferKey = "tokenBuffer";
                 state = this.uiState.token; // Character state
            }
        } else {
             bufferKey = "avatarBuffer";
             state = this.uiState.avatar;
        }
        const targetBuffer = this._editBuffer(bufferKey);

        if (!targetBuffer) return;
        if (!canvas) return;

        const rect = canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        
        // Map Mouse -> Canvas Internal Coordinates
        const width = canvas.width; 
        const height = canvas.height;
        const scaleX = width / rect.width;
        const scaleY = height / rect.height;
        
        const canvasX = mouseX * scaleX;
        const canvasY = mouseY * scaleY;

        // Map Canvas -> Source Image Coordinates (Inverse Transform)
        // Center depends on View Size
        let cx = 0;
        let cy = 0;
        
        if (viewName === 'token') {
             const ringScale = this.uiState.dynamicRingScale || 1.0;
             cx = (this.resolution * ringScale) / 2;
             cy = (this.resolution * ringScale) / 2;
        } else {
             // Avatar
             const ratio = this.uiState.avatarAspectRatio || 1.0;
             cx = this.resolution / 2;
             cy = (this.resolution * ratio) / 2;
        }

        // Apply Inverse Translation
        let dx = canvasX - (cx + state.transforms.x);
        let dy = canvasY - (cy + state.transforms.y);
        
        // Apply Inverse Rotation
        const rad = (-state.transforms.rotation * Math.PI) / 180;
        const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
        const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
        
        // Map to Image Coordinates (Center origin -> TopLeft origin)
        // CRITICAL FIX: We must account for the ratio between the "Rendered Size" (e.g. 512px) and the "Actual Buffer Size" (e.g. 2048px).
        // The previous logic assumed 1:1 mapping (or depended on user scaling), which broke high-res frames forced into 512px boxes.

        let renderW, renderH;

        if (viewName === 'token') {
             // 1. Determine how this layer was drawn (Logic matches drawTokenSandwich)
             const size = this.resolution; // 512
             
             if (this.uiState.activeLayer === 'frame') {
                 // Frame is uniquely forced to Square (size x size)
                 renderW = size;
                 renderH = size;
             } else {
                 // Character and Background are drawn at their original image size (centered)
                 ({ width: renderW, height: renderH } = originalSize(targetBuffer));
             }
        } else {
            // Avatar View: drawn at the original image size, centered
             ({ width: renderW, height: renderH } = originalSize(targetBuffer));
        }

        const ratioX = targetBuffer.width / renderW;
        const ratioY = targetBuffer.height / renderH;

        // Apply Ratio
        const rxScaled = rx * ratioX; // Scale the "rotated distance" by the resolution ratio
        const ryScaled = ry * ratioY;

        // Apply User Scale (Inverse)
        // Note: state.transforms.scale was applied to the Rendered output. 
        // So zooming IN (2.0) means we see LESS pixels. 
        // Mouse moves 10px -> matches 5px of image.
        const sx = rxScaled / state.transforms.scale;
        const sy = ryScaled / state.transforms.scale;
        
        const imgX = sx + (targetBuffer.width / 2);
        const imgY = sy + (targetBuffer.height / 2);

        // Adjust Brush Radius to match Buffer Resolution
        // If buffer is HUGE, a 50px brush needs to be larger in pixel-space to look same size?
        // Wait, if I zoom in, brush stays screen-relative (constant visual size)?
        // Yes, usually.
        // So brushRadius (pixels on buffer) = (ScreenBrushSize * Ratio) / Zoom
        const eSize = this.uiState.eraserSize;
        let brushRadius = (eSize / 2);
        
        // We take the average ratio if non-square? usually square brush.
        // Just use X ratio
        brushRadius = (brushRadius * ratioX) / state.transforms.scale;

        const ctx = targetBuffer.getContext("2d");
        ctx.save();

            if (this.uiState.eraserMode === 'add') {
                // RESTORE (Magic!)
                // Determine Source based on Layer
                let sourceImg = null;
                if (viewName === 'token') {
                    if (this.uiState.activeLayer === 'background') sourceImg = this.originalBackgroundImage;
                    else if (this.uiState.activeLayer === 'frame') sourceImg = this.originalFrameImage;
                    else sourceImg = this.originalImage;
                } else {
                    sourceImg = this.originalImage;
                }

                if (sourceImg) {
                     ctx.globalCompositeOperation = "source-over"; // Default
                     ctx.beginPath();
                     ctx.arc(imgX, imgY, brushRadius, 0, Math.PI * 2);
                     ctx.clip(); // Restrict drawing to this circle
                     
                     // Draw ORIGINAL image
                     // Note: We assume the buffer size matches the original image size exactly
                     // which it does because _createBufferFromImage sets canvas size to img size.
                     
                     // Optimization: Use Source-In or just drawImage
                     // For 'frame', the buffer might be different size if we swapped frames? 
                     // No, _loadFrameImage resets buffer.
                     
                     ctx.drawImage(sourceImg, 0, 0, targetBuffer.width, targetBuffer.height);
                }
            } else {
                 // ERASE (remove)
                ctx.globalCompositeOperation = "destination-out";
                ctx.beginPath();
                ctx.arc(imgX, imgY, brushRadius, 0, Math.PI * 2); 
                ctx.fill();
            }

            ctx.restore();

            // Repaint on the next frame (only the visible view is drawn)
            this._requestDraw();
            
            return;
        }

        // 2. DRAG (Pan) - Only if NOT erasing
        if (!this._isDragging || !this._activeDragView) return;
        // If Eraser is active, do NOT drag
        if (this.uiState.isEraserActive) return;

        event.preventDefault();
        
        const view = this._activeDragView;
        let targetTransforms;

        if (view === 'token') {
             if (this.uiState.activeLayer === 'background') {
                 targetTransforms = this.uiState.token.background.transforms;
             } else if (this.uiState.activeLayer === 'frame') {
                 targetTransforms = this.uiState.token.frame.transforms;
             } else {
                 targetTransforms = this.uiState.token.transforms;
             }
        } else {
            targetTransforms = this.uiState[view].transforms;
        }

        const dx = event.clientX - this._dragStart.x;
        const dy = event.clientY - this._dragStart.y;
        
        targetTransforms.x = this._lastTransform.x + dx;
        targetTransforms.y = this._lastTransform.y + dy;
        
        this._requestDraw({ syncUI: true });
    }
    
    _onCanvasMouseUp(event) {
        this.isCanvasPainting = false;
        if (this._pointerChange) {
            this._pointerChange = false;
            this._commitChange();
        }
        this._isDragging = false;
        this._activeDragView = null;
    }

    /**
     * Zoom the active layer with the mouse wheel or the trackpad. The change follows the size of the gesture
     * (trackpads send many small events, a mouse wheel few large ones), so it feels the same on both. Pinching
     * arrives as ctrl+wheel with small deltas and zooms faster per pixel.
     * @param {WheelEvent} event
     * @param {"token"|"avatar"} viewName
     */
    _onCanvasWheel(event, viewName) {
        event.preventDefault();
        // One undo step per burst of wheel events
        this._beginChange();
        clearTimeout(this._wheelTimer);
        this._wheelTimer = setTimeout(() => this._commitChange(), 400);

        let delta = event.deltaY;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
        else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= 400;
        delta = Math.max(-200, Math.min(200, delta)); // One very large event shouldn't jump
        const perPixel = event.ctrlKey ? 0.01 : 0.001; // About 10 % per mouse wheel notch
        this._zoomLayer(viewName, Math.exp(-delta * perPixel), event.clientX, event.clientY);
    }

    /**
     * @param {"token"|"avatar"} viewName
     * @returns {{x: number, y: number, scale: number, rotation: number}} The transforms of the layer being edited.
     */
    _layerTransforms(viewName) {
        if (viewName === 'token') {
             if (this.uiState.activeLayer === 'background') return this.uiState.token.background.transforms;
             if (this.uiState.activeLayer === 'frame') return this.uiState.token.frame.transforms;
             return this.uiState.token.transforms;
        }
        return this.uiState[viewName].transforms;
    }

    /**
     * Scale the active layer by `factor`, keeping the point under the mouse in place (the frame always scales
     * around its centre).
     * @param {"token"|"avatar"} viewName
     * @param {number} factor
     * @param {number} [clientX]
     * @param {number} [clientY]
     */
    _zoomLayer(viewName, factor, clientX, clientY) {
        if (!Number.isFinite(factor) || (factor <= 0)) return;
        const t = this._layerTransforms(viewName);
        const newScale = Math.min(Math.max(t.scale * factor, 0.1), 5.0);
        const applied = newScale / t.scale;
        if (applied === 1) return;

        const canvas = (viewName === 'token') ? this.canvasToken : this.canvasAvatar;
        const isFrame = (viewName === 'token') && (this.uiState.activeLayer === 'frame');
        if (canvas?.width && !isFrame && Number.isFinite(clientX)) {
            const rect = canvas.getBoundingClientRect();
            const inside = rect.width && (clientX >= rect.left) && (clientX <= rect.right) && (clientY >= rect.top) && (clientY <= rect.bottom);
            if (inside) {
                // Mouse position and layer origin in canvas pixels
                const px = (clientX - rect.left) * (canvas.width / rect.width);
                const py = (clientY - rect.top) * (canvas.height / rect.height);
                const ox = (canvas.width / 2) + t.x;
                const oy = (canvas.height / 2) + t.y;
                t.x = (px - ((px - ox) * applied)) - (canvas.width / 2);
                t.y = (py - ((py - oy) * applied)) - (canvas.height / 2);
            }
        }
        t.scale = newScale;
        this._requestDraw({ syncUI: true });
    }

    _getLayerState() {
        const view = this.uiState.activeView;
        let state = this.uiState[view];
        if (view === 'token') {
            if (this.uiState.activeLayer === 'background') return this.uiState.token.background;
            else if (this.uiState.activeLayer === 'frame') return this.uiState.token.frame;
            else return this.uiState.token; // Character layer
        }
        return state; // Avatar view
    }

    _updateTransformUI() {
        // Updates the sliders/inputs to match the current state (called after switching layers/views)
        const state = this._getLayerState();
        if (!state) return; // Should handle avatar vs token logic
        
        const html = this.element;
        
        const setVal = (name, val) => {
            // Zooming and dragging keep exact values; show them rounded
            if (typeof val === "number") val = (name === "scale") ? Math.round(val * 100) / 100 : Math.round(val);
            const input = html.querySelector(`input[name='${name}']`);
            if (input) input.value = val;
            
            // Update Number Input
            const numInput = html.querySelector(`.val-input[data-target='${name}']`);
            if (numInput) numInput.value = val;
        };
        
        setVal("x", state.transforms.x);
        setVal("y", state.transforms.y);
        setVal("scale", state.transforms.scale);
        setVal("rotation", state.transforms.rotation);
        
        // Update Brush Sizes inputs too if they exist
        setVal("eraserSize", this.uiState.eraserSize);
        setVal("popOutSize", this.uiState.popOutSize);
        
        // Special handle for Chroma since it's ID based
        const chromaSlider = html.querySelector("#chroma-tolerance");
        if(chromaSlider) chromaSlider.value = this.uiState.chromaTolerance || 50;
        const chromaInput = html.querySelector(".val-input[data-target='chromaTolerance']");
        if(chromaInput) chromaInput.value = this.uiState.chromaTolerance || 50;

        // FX are always on the view root (token/avatar), not sub-layers
        const fxState = this.uiState[this.uiState.activeView].fx;
        setVal("shadowBlur", fxState.shadowBlur);
        
        const shadowColorPicker = this.element.querySelector("color-picker[name='shadowColor']");
        if (shadowColorPicker) shadowColorPicker.value = fxState.shadowColor;
        
        const bgColorPicker = this.element.querySelector("color-picker[name='backgroundColor']");
        if (bgColorPicker) bgColorPicker.value = fxState.backgroundColor;
    }

    /* ------------------------------------------- */
    /*  Actions                                    */
    /* ------------------------------------------- */
    
    _onClose(event, target) {
        this.close();
    }

    _onMinimize(event, target) {
        this.minimize();
    }
    
    _onToggleEraser(event, target) {
        this.uiState.isEraserActive = !this.uiState.isEraserActive;
        // Exclusive: Turn off PopOut if Eraser ON
        if (this.uiState.isEraserActive) this.uiState.isPopOutActive = false;
        this.render();
    }
    
    _onTogglePopout(event, target) {
        this.uiState.isPopOutActive = !this.uiState.isPopOutActive;
        // Exclusive: Turn off Eraser if PopOut ON
        if (this.uiState.isPopOutActive) {
            this.uiState.isEraserActive = false;
            this.uiState.activeView = 'token';
            this._setActiveView('token');
        }
        this.render();
    }
    
    _onSetEraserMode(event, target) {
        const mode = target.dataset.mode;
        this.uiState.eraserMode = mode;
        this.render();
    }
    _onSetPopOutMode(event, target) {
        const mode = target.dataset.mode;
        this.uiState.popOutMode = mode;
        this.render();
    }

    _onTransformChange(event) {
        const target = event.currentTarget; // The Slider
        const sourceInput = event.originalTarget; // The Manual Input (if applicable)
        
        const prop = target.name;
        const val = parseFloat(target.value);
        const view = this.uiState.activeView;
        
        // Update Number Display (Manual Input)
        // Only update if the source was NOT this input (to prevent cursor jumps/overwrites while typing)
        const numInput = this.element.querySelector(`.val-input[data-target='${prop}']`);
        if (numInput && numInput !== sourceInput) { 
             numInput.value = val;
        }

        // Special handling for brush sizes (Action-less sliders)
        if (prop === "eraserSize") {
             this.uiState.eraserSize = val;
             return;
        }
        if (prop === "paintSize") {
             this.uiState.paintSize = val;
             return;
        }
        if (prop === "popOutSize") {
             this.uiState.popOutSize = val;
             return;
        }
        if (prop === "chromaTolerance") {
            this.uiState.chromaTolerance = val;
            return;
        }

        // Route based on name
        if (["scale", "rotation", "x", "y"].includes(prop)) {
            // Target Background Logic
            let state = this.uiState[view];
            if (view === 'token') {
                if (this.uiState.activeLayer === 'background') state = this.uiState.token.background;
                else if (this.uiState.activeLayer === 'frame') state = this.uiState.token.frame;
            }

            state.transforms[prop] = val;
            
            this._requestDraw();
        } else if (["shadowBlur", "shadowColor", "backgroundColor"].includes(prop)) {
            this._onUpdateFX(event, target);
        }
    }
    
    _onLayerChange(event) {
        const val = event.target.value; // 'character' or 'background'
        this.uiState.activeLayer = val;
        
        // Sync sliders to show correct values for the new layer
        this._updateTransformUI();
        
        // If we switch to background, and no background exists, we might want to prompt? 
        // nah, just let them see 0 values or upload one.
        
        // Force re-render to update UI toggles (if HBS relies on activeLayer for other things)
        this.render();
    }
    



    _onSetLayer(event, target) {
        const layer = target.dataset.layer;
        if (!layer) return;
        this.uiState.activeLayer = layer;
        this.render(); // Re-render to update UI states (buttons and radio slots)
    }
    
    _onSetView(event, target) {
        const view = target.dataset.view;
        this._setActiveView(view);
    }

    /* ------------------------------------------- */
    /*  History & Undo                             */
    /* ------------------------------------------- */

    /**
     * Copy the picture: the drawing-relevant parts of `uiState` and references to the image buffers. Buffers are
     * never changed in place while they are part of a snapshot: `_editBuffer` swaps in a copy first.
     * @returns {object}
     */
    _captureSnapshot() {
        const snapshot = { state: {}, buffers: {}, originals: {}, isLocalSource: this._isLocalSource, bytes: 0 };
        for (const key of UNDO_STATE_KEYS) snapshot.state[key] = foundry.utils.deepClone(this.uiState[key]);
        for (const key of BUFFER_KEYS) snapshot.buffers[key] = this[key];
        for (const key of ORIGINAL_KEYS) snapshot.originals[key] = this[key];
        return snapshot;
    }

    _applySnapshot(snapshot) {
        for (const key of UNDO_STATE_KEYS) this.uiState[key] = foundry.utils.deepClone(snapshot.state[key]);
        for (const key of BUFFER_KEYS) this[key] = snapshot.buffers[key];
        for (const key of ORIGINAL_KEYS) this[key] = snapshot.originals[key];
        this._isLocalSource = snapshot.isLocalSource;
    }

    /**
     * Start an undoable change, remembering the picture as it is now. Calls while a change is open join it.
     */
    _beginChange() {
        this._pendingChange ??= { snapshot: this._captureSnapshot(), cloned: new Set() };
    }

    /**
     * Close the open change. It becomes an undo step only if the picture actually changed.
     */
    _commitChange() {
        const change = this._pendingChange;
        this._pendingChange = null;
        clearTimeout(this._wheelTimer);
        if (!change || !this._differsFromCurrent(change.snapshot)) return;
        this._pushStep(this._undoStack, change.snapshot);
        this._redoStack.length = 0;
        this._updateUndoButtons();
    }

    /**
     * @param {object} snapshot
     * @returns {boolean} Whether the current picture differs from the snapshot.
     */
    _differsFromCurrent(snapshot) {
        if (BUFFER_KEYS.some(key => snapshot.buffers[key] !== this[key])) return true;
        if (ORIGINAL_KEYS.some(key => snapshot.originals[key] !== this[key])) return true;
        return UNDO_STATE_KEYS.some(key => JSON.stringify(snapshot.state[key]) !== JSON.stringify(this.uiState[key]));
    }

    /**
     * Get a buffer for drawing into it. The first edit during a change swaps in a copy, so the undo snapshot keeps
     * the untouched original.
     * @param {string} key  One of BUFFER_KEYS.
     * @returns {HTMLCanvasElement|null}
     */
    _editBuffer(key) {
        const buffer = this[key];
        if (!buffer) return null;
        this._beginChange();
        const change = this._pendingChange;
        if (!change.cloned.has(key)) {
            this[key] = cloneCanvas(buffer);
            change.cloned.add(key);
            change.snapshot.bytes += buffer.width * buffer.height * 4;
        }
        this._bumpBuffer(key); // The caller draws into it now
        return this[key];
    }

    /**
     * Run a click or change handler as one undo step (if it changes the picture).
     * @param {Function} handler
     * @param {...any} args
     */
    async _runHandler(handler, ...args) {
        if (!UNDOABLE_HANDLERS.has(handler.name)) return handler.call(this, ...args);
        this._beginChange();
        try {
            return await handler.call(this, ...args);
        } finally {
            this._commitChange();
        }
    }

    _pushStep(stack, snapshot) {
        stack.push(snapshot);
        let bytes = stack.reduce((sum, step) => sum + step.bytes, 0);
        while ((stack.length > UNDO_MAX_STEPS) || ((bytes > UNDO_BYTE_BUDGET) && (stack.length > 1))) {
            bytes -= stack.shift().bytes;
        }
    }

    /**
     * Step back (or forward) in the history. The current picture goes onto the opposite stack.
     * @param {object[]} from
     * @param {object[]} to
     * @returns {boolean} Whether there was a step.
     */
    _stepHistory(from, to) {
        this._commitChange();
        const snapshot = from.pop();
        if (!snapshot) return false;
        const current = this._captureSnapshot();
        this._applySnapshot(snapshot);
        for (const key of BUFFER_KEYS) {
            const buffer = current.buffers[key];
            if (buffer && (buffer !== this[key])) current.bytes += buffer.width * buffer.height * 4;
        }
        this._pushStep(to, current);
        this.drawAll();
        this.render(); // Sliders, frame list and layer controls follow the restored picture
        return true;
    }

    _onUndo() {
        if (!this._stepHistory(this._undoStack, this._redoStack)) ui.notifications.info(loc("NothingToUndo"));
    }

    _onRedo() {
        if (!this._stepHistory(this._redoStack, this._undoStack)) ui.notifications.info(loc("NothingToRedo"));
    }

    _clearHistory() {
        this._undoStack.length = 0;
        this._redoStack.length = 0;
        this._pendingChange = null;
        this._updateUndoButtons();
    }

    _updateUndoButtons() {
        const undo = this.element?.querySelector("[data-action='undo']");
        const redo = this.element?.querySelector("[data-action='redo']");
        if (undo) undo.disabled = !this._undoStack.length;
        if (redo) redo.disabled = !this._redoStack.length;
    }

    /**
     * Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo, while the studio is the active window and no text
     * field has focus.
     * @param {KeyboardEvent} event
     */
    _onKeyDown(event) {
        if (!this.rendered || (ui.activeWindow !== this)) return;
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const target = event.target;
        const textInput = target.isContentEditable || (target.tagName === "TEXTAREA")
            || ((target.tagName === "INPUT") && !["range", "checkbox", "radio", "color", "button"].includes(target.type));
        if (textInput) return;
        const key = event.key.toLowerCase();
        let action = null;
        if (key === "z") action = event.shiftKey ? "redo" : "undo";
        else if (key === "y") action = "redo";
        if (!action) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (action === "undo") this._onUndo();
        else this._onRedo();
    }

    /* ------------------------------------------- */
    /*  Brush Cursor                               */
    /* ------------------------------------------- */

    /**
     * @param {"token"|"avatar"} view
     * @returns {number|null} The active brush's diameter in canvas pixels, or null when no brush paints here.
     */
    _brushSize(view) {
        if (view !== this.uiState.activeView) return null;
        const s = this.uiState;
        if (view === "token") {
            if (s.isPaintActive) return s.paintSize;
            if (s.isPopOutActive) return s.popOutSize;
        }
        if (s.isEraserActive && !s.isPopOutActive) return s.eraserSize;
        return null;
    }

    /**
     * Show a ring the size of the brush under the mouse.
     * @param {MouseEvent} event
     * @param {HTMLCanvasElement} canvas
     * @param {"token"|"avatar"} view
     */
    _updateBrushCursor(event, canvas, view) {
        const ring = this.element.querySelector(".nts-brush-cursor");
        const stage = ring?.parentElement;
        const size = this._brushSize(view);
        if (!ring || !size || !canvas.width) return this._hideBrushCursor();
        const rect = canvas.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        const diameter = size * (rect.width / canvas.width);
        ring.style.width = ring.style.height = `${diameter}px`;
        ring.style.left = `${event.clientX - stageRect.left}px`;
        ring.style.top = `${event.clientY - stageRect.top}px`;
        ring.classList.toggle("remove", this._brushRemoves(view));
        ring.hidden = false;
        canvas.classList.add("brush-active");
    }

    /** @returns {boolean} Whether the active brush takes something away (shown as a dashed ring). */
    _brushRemoves(view) {
        const s = this.uiState;
        if ((view === "token") && s.isPaintActive) return s.paintMode === "remove";
        if ((view === "token") && s.isPopOutActive) return s.popOutMode === "remove";
        return s.eraserMode !== "add";
    }

    _hideBrushCursor() {
        const ring = this.element?.querySelector(".nts-brush-cursor");
        if (ring) ring.hidden = true;
        this.element?.querySelectorAll("canvas.brush-active").forEach(c => c.classList.remove("brush-active"));
    }

    _onUpdateFX(event, target) {
        const prop = target.name;
        const val = target.type === 'range' ? Number(target.value) : target.value;
        const view = this.uiState.activeView;
        
        this.uiState[view].fx[prop] = val;
        
        if (target.type === 'range') {
             const label = this.element.querySelector(`#val-${prop}`);
             if(label) label.innerText = `${val}px`;
        }
        
        // Update numeric input for chroma
        if (prop === 'chromaColor') {
            const cInput = this.element.querySelector(".val-input[data-target='chromaColor']");
            if(cInput) cInput.value = val;
        }
        
        this._requestDraw();
    }

    async _onAutoFit() {
        if (!this.originalImage) return;
        
        const size = this.resolution;
        const { width: imgW, height: imgH } = originalSize(this.originalImage);
        const imgMax = Math.max(imgW, imgH);
        
        // Scale to Fit Canvas (0.9 margin)
        let scale = (size / imgMax) * 0.9;
        
        // If Frame is present, scale to fit the FRAME (approximate)
        if (this.frameImage) {
            const frameScale = this.uiState.token.frame.transforms.scale || 1;
            scale = scale * frameScale;
        }
        
        // Apply to CURRENT View (usually Token or Character Layer)
        const view = this.uiState.activeView;
        
        // If we are editing Frame, Auto-Fit resets Frame to 1.0? 
        // Or fits Frame to Canvas?
        if (view === 'token' && this.uiState.activeLayer === 'frame') {
            // Fit Frame to Canvas
             this.uiState.token.frame.transforms.scale = 1.0;
             this.uiState.token.frame.transforms.x = 0;
             this.uiState.token.frame.transforms.y = 0;
        } else {
             // Fit Character/Background
             this.uiState[view].transforms.scale = parseFloat(scale.toFixed(2));
             this.uiState[view].transforms.x = 0;
             this.uiState[view].transforms.y = 0;
        }
        
        this.drawAll();
        this._updateTransformUI();
    }
    
    _onReset() {
        const view = this.uiState.activeView;
        this.uiState[view].transforms = { x: 0, y: 0, scale: 1, rotation: 0 };
        this.drawAll();
        this._updateTransformUI();
    }


    
    async _onPickFrameFile() {
        try {
            const FilePickerClass = filePickerClass();
            new FilePickerClass({
                type: "image",
                callback: (path) => this._recordImageLoad(async () => {
                     this.uiState.token.frame.path = path;
                     if (!this.userFrames.includes(path)) {
                         this.userFrames.push(path);
                     }
                     await this._loadFrameImage(path);
                     this.render(); 
                })
            }).browse();
        } catch (err) {
            console.error(`${LOG} FilePicker Error:`, err);
            ui.notifications.error(loc("FilePickerFailed"));
        }
    }
    
    _onRemoveFrame(event, target) {
        this.uiState.token.frame.path = null;
        this.frameBuffer = null;
        this.originalFrameImage = null;
        this.drawAll();
        // Do not render here if we want to avoid flicker, but we need to update the active state of the list.
        this.render();
    }

    _onSelectFrame(event, target) {
        const path = target.dataset.path;
        // Handle "default" keyword which might be passed safely
        if (path === "default") {
             const defaultFrame = game.settings.get(MODULE_ID, "defaultFrame");
             this.uiState.token.frame.path = defaultFrame;
             this._loadFrameImage(defaultFrame);
        } else {
             this.uiState.token.frame.path = path;
             this._loadFrameImage(path);
        }
        this.render();
    }

    async _onClearPopout(event, target) {
        if (!this.popOutBuffer) return;
        const ctx = this._editBuffer("popOutBuffer").getContext("2d");
        ctx.clearRect(0, 0, this.popOutBuffer.width, this.popOutBuffer.height);
        this.drawTokenSandwich();
    }

    async _onSaveToken(event, target) {
        if (!this.canvasToken) return;
        
        try {
            // ui.notifications.info("Updating Token...");

            // 1. Upload Source if it's local (dropped/pasted)
            if (this._isLocalSource && this.originalImage) {
                // The art as loaded (downscaled if it was very large), saved as WebP
                const source = (this.originalImage instanceof HTMLCanvasElement)
                    ? this.originalImage : this._createBufferFromImage(this.originalImage);
                const blob = await new Promise(resolve => source.toBlob(resolve, "image/webp", 0.92));
                const fileName = `source_${this.actor.id}_${Date.now()}.webp`;
                const file = new File([blob], fileName, { type: "image/webp" });
                
                const upPath = await this._uploadFile(file);
                this.uiState.sourcePath = upPath;
                this._isLocalSource = false;
            }

            const newScale = this.uiState.dynamicRingScale || 1.0;
            
            // Create Export Blob using Temp Canvas
            // This ensures we can skip the ring if needed
            const size = Math.round(this.resolution * newScale);
            const tempC = document.createElement("canvas");
            tempC.width = size;
            tempC.height = size;
            const tempCtx = tempC.getContext("2d");
            
            // Draw Scoped
            this.drawTokenSandwich(tempCtx, true);

            const blob = await new Promise(resolve => tempC.toBlob(resolve, "image/webp", 0.9));
            const { path: result, fallback } = await this._uploadToken(blob);
            
            // Update Prototype & Active Tokens
            const updates = {
                "prototypeToken.texture.src": result
            };
            

            // Auto-Configure Dynamic Token Ring if enabled
            if (this.uiState.useFoundryRing) {
                 // DYNAMIC RING MODE:
                 // Normalize scale based on padding ratio (0.8 / 1.2) to maintain consistent ring size.
                 const targetRatio = 0.6666666;
                 const finalScale = newScale * targetRatio;

                 // 1. Enable Ring
                 updates["prototypeToken.ring.enabled"] = true;
                 
                 // 2. Set Subject Scale
                 updates["prototypeToken.ring.subject.scale"] = finalScale;
                 
                 // 2.5 Ensure Subject Texture uses Main Texture (Set to result explicitly)
                 updates["prototypeToken.ring.subject.texture"] = result;

                 // 3. Set Global Scale
                 updates["prototypeToken.texture.scaleX"] = finalScale;
                 updates["prototypeToken.texture.scaleY"] = finalScale;
                 
            } else {
                 // BAKED RING MODE:
                 // 1. Disable Ring
                 updates["prototypeToken.ring.enabled"] = false;
                 
                 // 2. Apply Scale to Global Token
                 updates["prototypeToken.texture.scaleX"] = newScale;
                 updates["prototypeToken.texture.scaleY"] = newScale;
            }
            
            await this.actor.update(updates);
            
            const activeTokens = this.actor.getActiveTokens();
            const tokenUpdates = activeTokens.map(t => {
                const update = { 
                    _id: t.id, 
                    "texture.src": result
                };
                
                if (this.uiState.useFoundryRing) {
                    // Normalize scale based on padding ratio
                    const targetRatio = 0.6666666;
                    const finalScale = newScale * targetRatio;

                    update["ring.enabled"] = true;
                    update["ring.subject.scale"] = finalScale;
                    update["ring.subject.texture"] = result; 
                    update["texture.scaleX"] = finalScale;
                    update["texture.scaleY"] = finalScale;
                } else {
                    update["ring.enabled"] = false;
                    update["texture.scaleX"] = newScale; 
                    update["texture.scaleY"] = newScale;
                }
                return update;
            });
            
            if (tokenUpdates.length > 0 && canvas.scene) await canvas.scene.updateEmbeddedDocuments("Token", tokenUpdates);
            
            // ui.notifications.info("Token Updated!");
            
            // Save state but don't close
            await this.actor.setFlag(MODULE_ID, "lastState", this.uiState);

            let shownPath = result;
            try { shownPath = decodeURIComponent(result); } catch { /* keep as stored */ }
            ui.notifications.info(loc(fallback ? "TokenSavedFallback" : "TokenSaved", { path: shownPath }));
            
        } catch (err) {
            console.error(err);
            ui.notifications.error(loc("TokenSaveFailed"));
        }
    }
    
    async _onApplyChroma(event, target) {
        
        const view = this.uiState.activeView;
        let buffer;
        
        // Target Logic
        let bufferKey;
        if (view === 'token') {
             bufferKey = (this.uiState.activeLayer === 'background') ? "backgroundBuffer" : "tokenBuffer";
        } else {
             bufferKey = "avatarBuffer";
        }
        
        if (!this[bufferKey]) return ui.notifications.warn(loc("NoImageForLayer"));
        buffer = this._editBuffer(bufferKey);
        
        const colorInput = this.element.querySelector("#chroma-color");
        const toleranceInput = this.element.querySelector("#chroma-tolerance");
        
        const hex = colorInput.value;
        const tolerance = parseInt(toleranceInput.value);
        
        // Convert Hex to RGB
        const rTarget = parseInt(hex.substring(1,3), 16);
        const gTarget = parseInt(hex.substring(3,5), 16);
        const bTarget = parseInt(hex.substring(5,7), 16);
        
        const ctx = buffer.getContext("2d");
        const width = buffer.width;
        const height = buffer.height;
        
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        // Euclidean color distance, compared squared (no square root per pixel)
        const limit = tolerance * tolerance;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 0) continue; // Already transparent
            const dr = data[i] - rTarget;
            const dg = data[i + 1] - gTarget;
            const db = data[i + 2] - bTarget;
            if (((dr * dr) + (dg * dg) + (db * db)) < limit) data[i + 3] = 0;
        }
        
        ctx.putImageData(imageData, 0, 0);
        
        // Update View
        // Update View
        this.drawAll();
        // ui.notifications.info(`Chroma Key Applied to ${view}.`);
    }
    
    async _onSaveAvatar(event, target) {
        if (!this.canvasAvatar) return;
        
        try {
            // ui.notifications.info("Updating Avatar...");
            this.drawAvatar(); // Not redrawn while hidden
            const blob = await new Promise(resolve => this.canvasAvatar.toBlob(resolve, "image/webp", 0.9));
            const fileName = `avatar_${this.actor.id}_${Date.now()}.webp`;
            const file = new File([blob], fileName, { type: "image/webp" });
            const result = await this._uploadFile(file);
            
            // Update Actor Image
            await this.actor.update({ "img": result });
            this.uiState.portrait = result; // Changed by the studio itself: keep the session's art

            // ui.notifications.info("Avatar Updated!");
             // Save state but don't close
            await this.actor.setFlag(MODULE_ID, "lastState", this.uiState);

        } catch (err) {
            console.error(err);
            ui.notifications.error(loc("AvatarSaveFailed"));
        }
    }

    _onDeleteBackground(event) {
        if (this.uiState.token.background) {
            this.uiState.token.background.active = false;
            this.uiState.token.background.path = null;
        }
        this.backgroundBuffer = null;
        this.drawToken();
        this.render();
    }

    _onRemoveBackgroundColor(event) {
        // Clear value
        this.uiState.token.fx.backgroundColor = null;
        
        // Update Picker if exists (Visual feedback is limited for color inputs, likely shows black)
        const picker = this.element.querySelector("input[name='backgroundColor']");
        if (picker) picker.value = "#000000"; 
        
        this.drawAll();
    }

    _onUploadPortrait(event) {
        this.uiState.activeView = 'token'; 
        this.uiState.activeLayer = 'character'; // Force character layer
        this._onPickSourceFile();
    }

    _onChangeAvatarRatio(event) {
        const val = parseFloat(event.target.value);
        this.uiState.avatarAspectRatio = val;
        this.drawAvatar(); 
    }

    _onChangeRingScale(event) {
        const val = parseFloat(event.target.value);
        this.uiState.dynamicRingScale = val;
        
        // Resize PopOut Buffer if it exists
        if (this.popOutBuffer) {
             this._editBuffer("popOutBuffer");
             const oldSize = this.popOutBuffer.width;
             const newSize = Math.round(this.resolution * val);
             
             // Create temp buffer to save content
             const temp = document.createElement("canvas");
             temp.width = oldSize;
             temp.height = oldSize;
             const tCtx = temp.getContext("2d");
             tCtx.drawImage(this.popOutBuffer, 0, 0);
             
             // Resize Main Buffer
             this.popOutBuffer.width = newSize;
             this.popOutBuffer.height = newSize;
             const ctx = this.popOutBuffer.getContext("2d");
             
             // Redraw centered
             const off = (newSize - oldSize) / 2;
             ctx.drawImage(temp, off, off);
        }

        // Resize Paint Buffer (Same Logic)
        if (this.paintBuffer) {
             this._editBuffer("paintBuffer");
             const oldSize = this.paintBuffer.width;
             const newSize = Math.round(this.resolution * val);
             
             const temp = document.createElement("canvas");
             temp.width = oldSize;
             temp.height = oldSize;
             const tCtx = temp.getContext("2d");
             tCtx.drawImage(this.paintBuffer, 0, 0);
             
             this.paintBuffer.width = newSize;
             this.paintBuffer.height = newSize;
             const ctx = this.paintBuffer.getContext("2d");
             
             const off = (newSize - oldSize) / 2;
             ctx.drawImage(temp, off, off);
        }
        
        this.drawToken(); 
        this._layoutRingPreview();
    }
    
    _onToggleFoundryRing(event) {
        this.uiState.useFoundryRing = event.target.checked;
        
        if (this.uiState.useFoundryRing) {
            // RESET Frame Settings to defaults to prevent offset bugs
            this.uiState.token.frame.transforms = {
                scale: 1.0,
                x: 0,
                y: 0,
                rotation: 0
            };
            
            // If we are currently editing the frame, switch to character layer
            if (this.uiState.activeLayer === 'frame') {
                this.uiState.activeLayer = 'character';
            }
        }
        
        this.drawAll(); 
        this.render(); // Force UI update to disable/enable controls
    }

    /**
     * Upload a file to the storage folder (portraits, uploaded art, work in progress).
     * @param {File} file
     * @returns {Promise<string>}
     */
    async _uploadFile(file) {
        const target = storageFolder();
        await ensureFolder(target);
        return uploadTo(target, file);
    }

    /**
     * Upload a finished token as `<portrait name>-token-<number>.webp`, next to the actor's portrait when the
     * "Token Location" setting asks for it and that folder can be used, otherwise in the storage folder.
     * @param {Blob} blob
     * @returns {Promise<{path: string, fallback: boolean}>} The stored path, and whether it went to the storage folder
     *                                                       although the setting asked for the portrait's folder.
     */
    async _uploadToken(blob) {
        const portrait = this.actor.img;
        const base = tokenBaseName(portrait, this.actor.name.slugify({ strict: true }));
        const targets = [];
        if (game.settings.get(MODULE_ID, "tokenLocation") === "portrait") {
            const nextToPortrait = parseLocation(portrait);
            if (nextToPortrait) targets.push({ target: nextToPortrait, create: false });
        }
        const wantsPortraitFolder = game.settings.get(MODULE_ID, "tokenLocation") === "portrait";
        targets.push({ target: storageFolder(), create: true });

        let lastError;
        for (const { target, create } of targets) {
            try {
                if (create) await ensureFolder(target);
                const number = await nextTokenNumber(target, base);
                const file = new File([blob], `${base}-token-${number}.webp`, { type: "image/webp" });
                const path = await uploadTo(target, file);
                return { path, fallback: wantsPortraitFolder && create };
            } catch (err) {
                lastError = err;
                console.warn(`${LOG} Could not save the token in ${target.source}:${target.path || "/"}, trying the next folder.`, err);
            }
        }
        throw lastError;
    }

    async _onSaveDefault() {
         // ui.notifications.info("Defaults saved.");
    }

    /* ------------------------------------------- */
    /*  DRAFT PERSISTENCE                          */
    /* ------------------------------------------- */

    /**
     * Save the work in progress when the studio closes: the settings (`lastState`) and a WebP draft of each buffer
     * that differs from its source image. Drafts that are still current aren't uploaded again, the rest upload in
     * parallel, and the actor is only updated when something changed (an actor update re-renders its sheet for
     * everyone).
     */
    async _saveDraftState() {
        if (!this.actor) return;
        try {
            const previous = this.uiState.drafts ?? {};
            // Fixed key order, so the comparison below doesn't depend on which upload finished first
            const drafts = Object.fromEntries(Object.keys(DRAFT_BUFFERS).map(key => [key, null]));
            const uploads = [];
            for (const [key, bufferKey] of Object.entries(DRAFT_BUFFERS)) {
                const buffer = this[bufferKey];
                if (!buffer || this._pristineBuffers.has(buffer)) {
                    drafts[key] = null; // Nothing to keep: the source image (or an empty layer) reproduces it
                    continue;
                }
                if (previous[key] && (this._draftSources[key] === buffer)) {
                    drafts[key] = previous[key]; // Unchanged since that draft was written or loaded
                    continue;
                }
                uploads.push((async () => {
                    const blob = await new Promise(r => buffer.toBlob(r, "image/webp", 0.9));
                    const file = new File([blob], `draft_${key === "background" ? "bg" : key}_${this.actor.id}.webp`, { type: "image/webp" });
                    drafts[key] = await this._uploadFile(file);
                    this._draftSources[key] = buffer;
                })());
            }
            await Promise.all(uploads);

            this.uiState.drafts = drafts;
            const lastState = foundry.utils.deepClone(this.uiState);
            const json = JSON.stringify(lastState);
            if (json === this._savedStateJSON) return; // Nothing changed since the studio opened or last saved
            await this.actor.update({ [`flags.${MODULE_ID}`]: { drafts, lastState } });
            this._savedStateJSON = json;
        } catch (err) {
            console.error(`${LOG} Failed to save draft:`, err);
        }
    }

    /** @returns {object} The draft paths `_saveDraftState` would keep without uploading anything. */
    _currentDraftPaths() {
        const previous = this.uiState.drafts ?? {};
        const drafts = {};
        for (const [key, bufferKey] of Object.entries(DRAFT_BUFFERS)) {
            const buffer = this[bufferKey];
            drafts[key] = (buffer && !this._pristineBuffers.has(buffer) && (this._draftSources[key] === buffer)) ? (previous[key] ?? null) : null;
        }
        return drafts;
    }

    /**
     * Load the drafts into the buffers (in parallel). Afterwards those buffers match their draft files.
     */
    async _loadDraftState() {
        const drafts = this.uiState.drafts;
        if (!drafts) return;
        await Promise.all(Object.entries(DRAFT_BUFFERS).map(async ([key, bufferKey]) => {
            const src = drafts[key];
            const buffer = this[bufferKey];
            if (!src || !buffer) return;
            try {
                const img = await loadImage(withCacheBuster(src)); // Drafts are overwritten in place
                if (this[bufferKey] !== buffer) return; // Replaced meanwhile
                const ctx = buffer.getContext("2d");
                ctx.clearRect(0, 0, buffer.width, buffer.height);
                ctx.drawImage(img, 0, 0, buffer.width, buffer.height);
                this._bumpBuffer(bufferKey);
                this._pristineBuffers.delete(buffer);
                this._draftSources[key] = buffer;
            } catch (e) {
                console.error(`${LOG} Failed to load draft:`, src, e);
            }
        }));
        this.drawAll();
    }
    
    static async submit(event, form, formData) {
    }
}
