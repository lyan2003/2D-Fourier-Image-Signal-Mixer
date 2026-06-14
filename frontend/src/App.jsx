// App.jsx - Fourier Mixer Frontend (React)
// ============================================================================
// PURPOSE
// - Load up to 4 images (slots).
// - Ask backend to "sync" them into unified size + FT previews (mag/phase/real/imag).
// - Let the user adjust visualization only (Window/Level) for BOTH image and FT.
// - Let the user set mixing parameters (weights + ROI mode + mixing mode + output port).
// - Manual mixing with a "Mix" button:
//    * POST /api/mix_start  -> returns job_id
//    * Poll GET /api/mix_status/{job_id} for progress + output image
//    * Cancel old job when restarting
//
// IMPORTANT DESIGN RULES
// 1) Window/Level (WL) is UI-only. It does NOT change the data sent to backend.
//    The backend always receives raw unified base64 images from sync.
// 2) Cancellation is two-layer:
//    - Backend cancel endpoint /api/mix_cancel
//    - Frontend "sequence token" to ignore stale job responses
// 3) Single shared ROI for ALL FT viewers (one ROI for the whole app).
// 4) Port 1/Port 2 selection is LOCKED at mix start to avoid race conditions:
//    if user switches ports while mixing, the output still goes to the port chosen at start.
// ============================================================================

import React, { useMemo, useRef, useState, useEffect } from "react";

/* -------------------- API Client (Encapsulated) -------------------- */
// This class wraps all backend endpoints so the rest of the UI doesn't care about URLs.
class FourierApi {
  constructor(baseUrl = "http://localhost:8000") {
    this.baseUrl = baseUrl;
  }

  // POST /api/sync
  // Uploads up to 4 images. Backend returns unified image PNG + FT previews.
  async sync(files) {
    const fd = new FormData();
    files.forEach((f, i) => {
      if (f) fd.append(`image${i}`, f);
    });

    const res = await fetch(`${this.baseUrl}/api/sync`, {
      method: "POST",
      body: fd,
    });

    if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
    return res.json();
  }

  // POST /api/mix_start
  // Starts async mixing job. Returns { job_id }
  async mixStart(payload) {
    const res = await fetch(`${this.baseUrl}/api/mix_start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error(`Mix start failed: ${res.status}`);
    return res.json(); // { job_id }
  }

  // GET /api/mix_status/{job_id}
  // Returns job status: { state, progress, output_png_b64?, error? }
  async mixStatus(jobId) {
    const res = await fetch(`${this.baseUrl}/api/mix_status/${encodeURIComponent(jobId)}`, {
      method: "GET",
    });

    if (!res.ok) throw new Error(`Mix status failed: ${res.status}`);
    return res.json();
  }

  // POST /api/mix_cancel/{job_id}
  // Cancels running job if possible
  async mixCancel(jobId) {
    const res = await fetch(`${this.baseUrl}/api/mix_cancel/${encodeURIComponent(jobId)}`, {
      method: "POST",
    });

    if (!res.ok) throw new Error(`Mix cancel failed: ${res.status}`);
    return res.json();
  }
}

/* -------------------- Small helper: base64 -> data URL -------------------- */
// Backend returns base64 PNG without "data:image/png;base64," prefix.
// The browser needs the prefix to render in <img src="...">.
const toDataUrl = (b64) => (b64 ? `data:image/png;base64,${b64}` : null);

/* -------------------- Window/Level Processor (Encapsulated) -------------------- */
// WL (Window/Level) is ONLY for visualization.
// Idea:
// - Convert the rendered image into grayscale array once (cache).
// - Re-apply WL mapping quickly to produce a new data URL.
// - This does NOT affect backend mixing payload.
class WindowLevelProcessor {
  constructor() {
    // Cache rawDataUrl -> { w, h, gray: Uint8ClampedArray }
    // This avoids re-reading pixels from canvas on each WL change.
    this.cache = new Map();
  }

  // Load image from a data URL into HTMLImageElement
  async _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load image for WL"));
      img.src = src;
    });
  }

  // Ensure we have grayscale pixels in cache for this rawDataUrl
  async _ensureCache(rawDataUrl) {
    if (this.cache.has(rawDataUrl)) return this.cache.get(rawDataUrl);

    const img = await this._loadImage(rawDataUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    // Draw to canvas to read pixel data
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);

    // Read RGBA pixels
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;

    // Convert to grayscale (simple average of RGB)
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = (d[i] + d[i + 1] + d[i + 2]) / 3;
    }

    const entry = { w, h, gray };
    this.cache.set(rawDataUrl, entry);
    return entry;
  }

  // Apply WL mapping:
  // window controls contrast (range), level controls brightness (center).
  async apply(rawDataUrl, window, level) {
    const { w, h, gray } = await this._ensureCache(rawDataUrl);

    // Clamp window and level to safe ranges
    const W = Math.max(1, Math.min(1024, window));
    const L = Math.max(0, Math.min(255, level));

    // Typical WL mapping:
    // low = level - window/2
    // normalized = (gray - low) * 255/window
    const low = L - W / 2;
    const invW = 255.0 / W;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const out = ctx.createImageData(w, h);
    const od = out.data;

    // Apply mapping pixel-by-pixel
    for (let p = 0; p < gray.length; p++) {
      const v = (gray[p] - low) * invW;
      // clamp to [0..255]
      const u = v < 0 ? 0 : v > 255 ? 255 : v | 0;

      const i = p * 4;
      od[i] = u;
      od[i + 1] = u;
      od[i + 2] = u;
      od[i + 3] = 255; // alpha
    }

    ctx.putImageData(out, 0, 0);
    return canvas.toDataURL("image/png");
  }
}

/* -------------------- Helpers -------------------- */
const DEFAULT_WL = { window: 255, level: 127.5 };

// Convert the selected FT component label to a key in our state objects
function modeToKey(mode) {
  if (mode === "FT Magnitude") return "mag";
  if (mode === "FT Phase") return "phase";
  if (mode === "FT Real") return "real";
  return "imag"; // FT Imaginary
}

// WL state structure:
// - For each of 4 slots:
//    image: window/level
//    ft: window/level for each component
function makeInitialWLState() {
  return Array.from({ length: 4 }, () => ({
    image: { ...DEFAULT_WL },
    ft: {
      mag: { ...DEFAULT_WL },
      phase: { ...DEFAULT_WL },
      real: { ...DEFAULT_WL },
      imag: { ...DEFAULT_WL },
    },
  }));
}

// Default weights:
// We keep 4 arrays (one per component), each has 4 values (one per slot).
// Start at 0 so the user must actively choose mixing contributions.
function makeInitialWeightsState() {
  const base = [0, 0, 0, 0];
  return {
    mag: [...base],
    phase: [...base],
    real: [...base],
    imag: [...base],
  };
}

/* -------------------- ROI region highlight overlay (UI only) -------------------- */
// This draws a hatch overlay to show "inner" region or "outer" region.
// The ROI is expressed in percentages (0..100) of the FT viewport.
function RegionHighlight({ roi, regionType }) {
  // Full mode means no highlight overlay
  if (regionType === "full") return null;

  // Hatch pattern background (purple-ish)
  const hatch =
    "repeating-linear-gradient(45deg, rgba(139,92,246,0.22) 0px, rgba(139,92,246,0.22) 6px, rgba(139,92,246,0.10) 6px, rgba(139,92,246,0.10) 12px)";
  const bg = hatch;

  // ROI boundaries in percentages
  const x0 = roi.x;
  const y0 = roi.y;
  const x1 = roi.x + roi.w;
  const y1 = roi.y + roi.h;

  // Base overlay container
  const common = { position: "absolute", inset: 0, pointerEvents: "none" };

  // Inner only: fill ROI rectangle
  if (regionType === "inner") {
    return (
      <div style={common}>
        <div
          style={{
            position: "absolute",
            left: `${roi.x}%`,
            top: `${roi.y}%`,
            width: `${roi.w}%`,
            height: `${roi.h}%`,
            background: bg,
            borderRadius: 2,
          }}
        />
      </div>
    );
  }

  // Outer only: fill everything except the ROI rectangle
  return (
    <div style={common}>
      {/* Top strip */}
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: `${y0}%`, background: bg }} />
      {/* Bottom strip */}
      <div style={{ position: "absolute", left: 0, top: `${y1}%`, width: "100%", height: `${100 - y1}%`, background: bg }} />
      {/* Left strip */}
      <div style={{ position: "absolute", left: 0, top: `${y0}%`, width: `${x0}%`, height: `${roi.h}%`, background: bg }} />
      {/* Right strip */}
      <div style={{ position: "absolute", left: `${x1}%`, top: `${y0}%`, width: `${100 - x1}%`, height: `${roi.h}%`, background: bg }} />
    </div>
  );
}

/* -------------------- Shared Viewport Component -------------------- */
// This component is used in two roles:
// 1) INPUT tile: left panel (image + weight slider) + right panel (FT view + ROI + WL)
// 2) OUTPUT tile: just shows the output image
function ImageViewport({
  variant = "input", // "input" | "output"
  outerRef = null,

  // output-only
  outputLabel = "Output",
  outputSrc = null,

  // input-only
  index,
  slot,
  onPickFile,
  weightsAll,
  onWeightChange,
  roi,
  setROI,
  wlState,
  onWLChange,
}) {
  /* -------------------- OUTPUT MODE -------------------- */
  if (variant === "output") {
    return (
      <div ref={outerRef} className="p-1 bg-purple-50 rounded-lg shadow-inner flex flex-col h-full min-h-0">
        <div className="flex-1 min-h-0 flex flex-col bg-white rounded border border-purple-300 p-1">
          <div className="flex items-center justify-between text-[10px] text-purple-700 mb-1">
            <div className="font-medium">{outputLabel}</div>
          </div>

          <div className="flex-1 min-h-0 bg-gray-100 rounded border border-purple-200 flex items-center justify-center overflow-hidden select-none">
            {outputSrc ? (
              <img src={outputSrc} alt={outputLabel} className="object-contain w-full h-full pointer-events-none" />
            ) : (
              <div className="text-purple-300">{outputLabel}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* -------------------- INPUT MODE -------------------- */
  const fileRef = useRef(null);

  // Which FT component is displayed in the right panel?
  const [componentMode, setComponentMode] = useState("FT Magnitude");
  const compKey = modeToKey(componentMode); // mag/phase/real/imag

  /* ROI drag/resize state */
  const [dragROI, setDragROI] = useState(false);
  const [resizeROI, setResizeROI] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [startROI, setStartROI] = useState({ ...roi });

  /* WL drag state:
     We store start mouse + start window/level so we can compute deltas. */
  const [wlDrag, setWlDrag] = useState(null);

  const regionType = roi?.type || "full";
  const showROI = regionType !== "full";

  // Shown images are the WL-adjusted versions in slot.disp
  const imgShown = slot?.disp?.image || null;
  const ftShown = slot?.disp?.ft?.[compKey] || null;

  // Weight for this slot and current FT component
  const weight = weightsAll?.[compKey]?.[index] ?? 0;

  /* -------------------- WL Mouse Handlers -------------------- */
  // beginWL: called on mouse down on image or FT viewport
  // target: "image" or "ft"
  // key: for FT, which component (mag/phase/real/imag)
  const beginWL = (e, target, key) => {
    // If slot has no raw image, no WL operations
    if (!slot?.raw) return;

    e.preventDefault();
    e.stopPropagation();

    // Use current WL state as a base
    const base = target === "image" ? wlState.image : wlState.ft[key];

    setWlDrag({
      target,
      compKey: key,
      sx: e.clientX,
      sy: e.clientY,
      sw: base.window,
      sl: base.level,
    });
  };

  // moveWL: while dragging, update window and level based on mouse delta
  const moveWL = (e) => {
    if (!wlDrag) return;

    const dx = e.clientX - wlDrag.sx;
    const dy = e.clientY - wlDrag.sy;

    // Horizontal drag: window (contrast)
    // Vertical drag: level (brightness)
    const window = Math.max(1, Math.min(1024, wlDrag.sw + dx * 0.8));
    const level = Math.max(0, Math.min(255, wlDrag.sl - dy * 0.5));

    onWLChange(index, wlDrag.target, wlDrag.compKey, window, level);
  };

  // endWL: stop WL dragging
  const endWL = () => setWlDrag(null);

  /* -------------------- ROI Mouse Handlers -------------------- */
  // ROI is dragged inside the FT viewport only when ROI mode is inner/outer
  const onROIMouseDown = (e) => {
    if (!showROI) return;
    e.preventDefault();
    e.stopPropagation();

    setDragROI(true);
    setResizeROI(false);
    setStartPos({ x: e.clientX, y: e.clientY });
    setStartROI({ ...roi });
  };

  // Update ROI while dragging/resizing
  const onROIMouseMove = (e) => {
    if (!showROI) return;
    if (!dragROI && !resizeROI) return;

    // Convert mouse movement (pixels) to movement in percentage of viewport size
    const dx = ((e.clientX - startPos.x) / e.currentTarget.offsetWidth) * 100;
    const dy = ((e.clientY - startPos.y) / e.currentTarget.offsetHeight) * 100;

    if (dragROI) {
      // Move ROI rectangle while keeping same w/h
      setROI(() => {
        const w = startROI.w;
        const h = startROI.h;
        return {
          ...roi,
          x: Math.min(Math.max(startROI.x + dx, 0), 100 - w),
          y: Math.min(Math.max(startROI.y + dy, 0), 100 - h),
          w,
          h,
        };
      });
    } else if (resizeROI) {
      // Resize ROI from bottom-right corner, clamp to [10..] and not outside viewport
      setROI(() => {
        const nx = startROI.x;
        const ny = startROI.y;
        const nw = Math.min(Math.max(startROI.w + dx, 10), 100 - nx);
        const nh = Math.min(Math.max(startROI.h + dy, 10), 100 - ny);
        return { ...roi, x: nx, y: ny, w: nw, h: nh };
      });
    }
  };

  const onROIMouseUp = () => {
    setDragROI(false);
    setResizeROI(false);
  };

  // Used only to show WL numbers during drag (small overlay)
  const shownWL = wlDrag?.target === "image" ? wlState.image : wlState.ft[wlDrag?.compKey || compKey];

  return (
    <div ref={outerRef} className="p-2 bg-purple-50 rounded-lg shadow-inner flex flex-col h-full min-h-0">
      <div className="flex gap-2 h-full min-h-0">
        {/* -------------------- Left panel: Input Image -------------------- */}
        <div className="flex-1 flex flex-col bg-white rounded border border-purple-300 p-2 min-h-0">
          {/* Weight slider affects mixing weight for current FT component */}
          <div className="mb-2">
            <label className="text-xs text-purple-700">Weight: {Math.round(weight * 100)}%</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={weight}
              onChange={(e) => onWeightChange(index, compKey, parseFloat(e.target.value))}
              className="w-full"
            />
          </div>

          {/* Image viewport:
              - Double click to pick file
              - Drag to adjust WL (Window/Level)
          */}
          <div
            onDoubleClick={() => fileRef.current?.click()}
            onMouseDown={(e) => beginWL(e, "image", "image")}
            onMouseMove={moveWL}
            onMouseUp={endWL}
            onMouseLeave={endWL}
            className="flex-1 min-h-0 bg-gray-100 rounded border border-purple-200 flex items-center justify-center cursor-crosshair overflow-hidden select-none"
            title="Drag: Left/Right = Contrast (Window), Up/Down = Brightness (Level)"
          >
            {imgShown ? (
              <img src={imgShown} alt={`img-${index}`} className="object-contain w-full h-full pointer-events-none" />
            ) : (
              <div className="text-purple-300">Double click to add image</div>
            )}
          </div>

          {/* Hidden file input (triggered by double click) */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickFile(index, f);
            }}
          />
        </div>

        {/* -------------------- Right panel: FT Component Viewer + ROI -------------------- */}
        <div className="flex-1 flex flex-col bg-white rounded border border-purple-300 p-2 min-h-0">
          {/* Select which FT component to visualize */}
          <select
            value={componentMode}
            onChange={(e) => setComponentMode(e.target.value)}
            className="mb-2 bg-purple-700 text-white px-2 py-1 rounded"
          >
            <option>FT Magnitude</option>
            <option>FT Phase</option>
            <option>FT Real</option>
            <option>FT Imaginary</option>
          </select>

          {/* FT viewport:
              - Drag to adjust WL for FT component
              - If ROI mode active: drag ROI box to move/resize
          */}
          <div
            className="flex-1 min-h-0 bg-gray-100 rounded border border-purple-200 relative overflow-hidden flex items-center justify-center cursor-crosshair select-none"
            onMouseDown={(e) => beginWL(e, "ft", compKey)}
            onMouseMove={(e) => {
              moveWL(e);
              if (showROI) onROIMouseMove(e);
            }}
            onMouseUp={() => {
              endWL();
              if (showROI) onROIMouseUp();
            }}
            onMouseLeave={() => {
              endWL();
              if (showROI) onROIMouseUp();
            }}
            title="Drag: Left/Right = Contrast (Window), Up/Down = Brightness (Level)"
          >
            {/* FT preview image from backend (WL-adjusted in UI) */}
            {ftShown ? (
              <img src={ftShown} alt={`ft-${index}`} className="object-contain w-full h-full pointer-events-none" />
            ) : slot?.raw?.image ? (
              <div className="text-purple-300 text-xs px-2 text-center">Computing FT preview...</div>
            ) : (
              <div className="text-purple-300">FT Display</div>
            )}

            {/* Show region shading for inner/outer */}
            <RegionHighlight roi={roi} regionType={regionType} />

            {/* ROI rectangle itself (draggable/resizable) */}
            {showROI && (
              <div
                style={{
                  position: "absolute",
                  left: `${roi.x}%`,
                  top: `${roi.y}%`,
                  width: `${roi.w}%`,
                  height: `${roi.h}%`,
                  border: "2px solid rgba(139,92,246,0.95)",
                  background: "transparent",
                  boxSizing: "border-box",
                  cursor: dragROI ? "grabbing" : "grab",
                  zIndex: 5,
                }}
                onMouseDown={onROIMouseDown}
                title="Drag to move ROI (shared for all images). Use corner to resize."
              >
                {/* Resize handle (bottom-right) */}
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    bottom: 0,
                    width: 10,
                    height: 10,
                    backgroundColor: "rgba(139,92,246,0.95)",
                    cursor: "nwse-resize",
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragROI(false);
                    setResizeROI(true);
                    setStartPos({ x: e.clientX, y: e.clientY });
                    setStartROI({ ...roi });
                  }}
                />
              </div>
            )}

            {/* WL overlay text when dragging */}
            {wlDrag && (
              <div className="absolute top-2 left-2 bg-white/80 text-purple-700 text-[10px] px-2 py-1 rounded z-10">
                W:{Math.round(shownWL.window)} L:{Math.round(shownWL.level)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Small UI Atom: Port selector dot -------------------- */
// Two ports mean we have two output buffers. User can switch active port.
// (But we lock the target port at mix-start.)
function PortDot({ active, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 px-1 py-1 rounded hover:bg-purple-50"
      title={`Select ${label}`}
    >
      <span
        className={`w-3 h-3 rounded-full border ${
          active ? "bg-purple-700 border-purple-700" : "bg-white border-purple-300"
        }`}
      />
      <span className={`text-[11px] ${active ? "text-purple-800 font-medium" : "text-purple-600"}`}>{label}</span>
    </button>
  );
}

/* -------------------- MAIN APP -------------------- */
export default function App() {
  // API wrapper instance (memoized so it is stable between renders)
  const api = useMemo(() => new FourierApi("http://localhost:8000"), []);
  // WL processor instance (memoized)
  const wlProc = useMemo(() => new WindowLevelProcessor(), []);
  // One shared ROI across the entire app (percentage-based)
  const emptyROI = useMemo(() => ({ x: 25, y: 25, w: 50, h: 50, type: "full" }), []);

  /* -------------------- Core state -------------------- */
  // files: actual File objects chosen from disk for each slot
  const [files, setFiles] = useState([null, null, null, null]);

  // slots: after /sync, each slot has:
  // - b64: unified image base64 (RAW) used for backend mixing
  // - raw: data URLs for previews (raw image + raw FT component images)
  // - disp: data URLs for WL-adjusted previews (what we render in UI)
  const [slots, setSlots] = useState([null, null, null, null]);

  // weights: 4 arrays for (mag, phase, real, imag), each length 4
  const [weights, setWeights] = useState(() => makeInitialWeightsState());

  // roi: shared ROI config (x,y,w,h) + type = full/inner/outer
  const [roi, setROI] = useState(emptyROI);

  // mixingMode chooses which two components are mixed:
  // - "real_imag": weights_a = real, weights_b = imag
  // - "mag_phase": weights_a = mag, weights_b = phase
  const [mixingMode, setMixingMode] = useState("real_imag");

  // activeOutput selects which output port the user is currently viewing
  const [activeOutput, setActiveOutput] = useState(0);

  // outputs: two output images (data URLs) for Port 1 and Port 2
  const [outputs, setOutputs] = useState([null, null]);

  /* -------------------- Busy states -------------------- */
  const [syncBusy, setSyncBusy] = useState(false);
  const [mixBusy, setMixBusy] = useState(false);

  // Progress [0..1]
  const [mixProgress, setMixProgress] = useState(0);
  const [mixJobId, setMixJobId] = useState(null);

  // WL parameters for each slot and each viewer (image + 4 FT components)
  const [wl, setWl] = useState(() => makeInitialWLState());

  /* -------------------- Refs used for polling and cancellation -------------------- */
  // pollRef stores interval ID so we can stop polling.
  const pollRef = useRef(null);

  // jobRef stores the currently running job id (if any).
  const jobRef = useRef(null);

  // mixSeqRef is a sequence token (monotonic counter).
  // Each new doMix increments it. Polling callbacks check token to avoid stale overwrite.
  const mixSeqRef = useRef(0);

  const busy = syncBusy || mixBusy;

  /* -------------------- Layout helper: match output tile height to input tile -------------------- */
  const inputTileRef = useRef(null);
  const [tileHeight, setTileHeight] = useState(null);

  // Use ResizeObserver to track tile height
  useEffect(() => {
    const el = inputTileRef.current;
    if (!el) return;

    const update = () => {
      const h = el.getBoundingClientRect().height;
      if (h && h > 0) setTileHeight(h);
    };

    update();

    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => update());
      ro.observe(el);
    }

    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      if (ro) ro.disconnect();
    };
  }, []);

  /* -------------------- Polling helpers -------------------- */
  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  // Cancel current job (if any) + reset UI state for mixing
  const cancelRunningMix = async () => {
    stopPolling();

    const jid = jobRef.current;
    jobRef.current = null;

    // Reset UI status
    setMixJobId(null);
    setMixBusy(false);
    setMixProgress(0);

    // Ask backend to cancel (best-effort)
    if (jid) {
      try {
        await api.mixCancel(jid);
      } catch {
        // Ignore errors (job may have already finished/cancelled)
      }
    }
  };

  /* -------------------- File selection -------------------- */
  const pickFile = (idx, f) => {
    setFiles((prev) => {
      const next = [...prev];
      next[idx] = f;
      return next;
    });
  };

  /* -------------------- Weight change -------------------- */
  const setWeight = (idx, compKey, val) => {
    setWeights((prev) => {
      // Clone only the affected component array to keep state updates clean
      const next = { ...prev, [compKey]: [...prev[compKey]] };
      next[compKey][idx] = val;
      return next;
    });
  };

  /* -------------------- Keys to trigger sync / detect slots presence -------------------- */
  // filesKey changes whenever any file changes (name/size/modified).
  // We use it as a dependency for the sync effect.
  const filesKey = useMemo(
    () => files.map((f) => (f ? `${f.name}-${f.size}-${f.lastModified}` : "null")).join("|"),
    [files]
  );

  // slotsB64PresenceKey is a string like "1010" representing which slots have b64 data
  const slotsB64PresenceKey = useMemo(() => slots.map((s) => (s?.b64 ? "1" : "0")).join(""), [slots]);
  const hasAnySlots = slotsB64PresenceKey.includes("1");

  /* -------------------- 1) SYNC EFFECT -------------------- */
  // Whenever selected files change, we:
  // - cancel any current mix
  // - call /api/sync
  // - store raw & disp previews + raw unified base64 for mixing
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const hasAny = files.some(Boolean);

      // If no files at all -> reset everything
      if (!hasAny) {
        await cancelRunningMix();
        setSlots([null, null, null, null]);
        setWl(makeInitialWLState());
        setWeights(makeInitialWeightsState());
        setROI(emptyROI);
        setOutputs([null, null]);
        return;
      }

      try {
        setSyncBusy(true);

        // IMPORTANT: Cancel any running mix before re-syncing inputs
        await cancelRunningMix();

        // Call backend sync
        const data = await api.sync(files);

        // Build our UI slots from response
        const nextSlots = data.slots.map((s) => {
          if (!s?.has) return null;

          // Convert backend base64 to browser renderable data URL
          const rawImage = toDataUrl(s.unified_png_b64);

          // Raw previews (used as source for WL apply)
          const raw = {
            image: rawImage,
            ft: {
              mag: toDataUrl(s.ft.mag),
              phase: toDataUrl(s.ft.phase),
              real: toDataUrl(s.ft.real),
              imag: toDataUrl(s.ft.imag),
            },
          };

          return {
            // RAW unified base64 (used in mixing payload)
            b64: s.unified_png_b64,

            // raw previews
            raw,

            // disp previews (WL-adjusted) start identical to raw
            disp: { image: raw.image, ft: { ...raw.ft } },
          };
        });

        if (!cancelled) setSlots(nextSlots);
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setSyncBusy(false);
      }
    })();

    // Cleanup if effect is re-run or unmounted
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey, api, emptyROI]);

  /* -------------------- 2) WL UPDATE (no mixing triggered) -------------------- */
  // When WL changes, we:
  // - Update WL state values
  // - Compute a WL-adjusted image and store it in slots[index].disp
  // This is purely visual; backend mixing uses slots[index].b64.
  const onWLChange = async (index, target, compKey, window, level) => {
    // Update WL numeric state first (so UI overlay updates immediately)
    setWl((prev) => {
      const next = [...prev];
      const v = { ...next[index] };
      if (target === "image") v.image = { window, level };
      else v.ft = { ...v.ft, [compKey]: { window, level } };
      next[index] = v;
      return next;
    });

    const s = slots[index];
    if (!s?.raw) return;

    try {
      // Choose which raw preview to adjust
      const rawUrl = target === "image" ? s.raw.image : s.raw.ft[compKey];
      if (!rawUrl) return;

      // Apply WL to get a new data URL
      const adjusted = await wlProc.apply(rawUrl, window, level);

      // Update only the display image (disp) of this slot
      setSlots((prev) => {
        const next = [...prev];
        const cur = next[index];
        if (!cur) return prev;

        const newDisp =
          target === "image"
            ? { ...cur.disp, image: adjusted }
            : { ...cur.disp, ft: { ...cur.disp.ft, [compKey]: adjusted } };

        next[index] = { ...cur, disp: newDisp };
        return next;
      });
    } catch (e) {
      console.error(e);
    }
  };

  /* -------------------- Manual Mixing (Mix Button) -------------------- */
  const doMix = async () => {
    // Increment sequence token for this mix request
    // Any responses from earlier sequences are ignored.
    const seq = ++mixSeqRef.current;

    try {
      // If currently running -> cancel it first, then start new
      if (jobRef.current) await cancelRunningMix();

      // Basic guards
      if (!hasAnySlots) return;
      if (syncBusy) return;

      // Lock the output port at the time we start this mix job
      const targetPort = activeOutput;

      setMixBusy(true);
      setMixProgress(0);

      // Choose the two "channels" we mix depending on mode
      // For real/imag -> weights_a = real, weights_b = imag
      // For mag/phase -> weights_a = mag, weights_b = phase
      const weights_a = mixingMode === "real_imag" ? weights.real : weights.mag;
      const weights_b = mixingMode === "real_imag" ? weights.imag : weights.phase;

      // ROI mode:
      // - inner means apply ROI weights inside ROI only
      // - outer means apply ROI weights outside ROI only
      // - full means apply weights everywhere
      const regionType = roi.type === "inner" ? "inner" : roi.type === "outer" ? "outer" : "full";

      // Backend expects a region per component key
      const regions = { mag: regionType, phase: regionType, real: regionType, imag: regionType };

      // Mixing payload
      const payload = {
        // Important: send RAW unified b64 for each slot (not WL adjusted)
        images_png_b64: slots.map((s) => s?.b64 || null),

        // weights arrays (length 4)
        weights_a,
        weights_b,

        // ROI rectangle (percentage coordinates)
        roi: { x: roi.x, y: roi.y, w: roi.w, h: roi.h },

        // region mode per component
        regions,

        // mixing mode string for backend
        mixing_mode: mixingMode,
      };

      // Start mixing job
      const { job_id } = await api.mixStart(payload);

      // If a new mix request happened while we were awaiting,
      // cancel this new job and exit.
      if (mixSeqRef.current !== seq) {
        try {
          await api.mixCancel(job_id);
        } catch {}
        return;
      }

      // Store job id
      setMixJobId(job_id);
      jobRef.current = job_id;

      // Poll status every ~140ms
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          // Ignore polling if this is not current sequence
          if (mixSeqRef.current !== seq) return;

          const st = await api.mixStatus(job_id);

          if (mixSeqRef.current !== seq) return;

          // Update progress
          const p = typeof st.progress === "number" ? st.progress : 0;
          setMixProgress(Math.max(0, Math.min(1, p)));

          if (st.state === "done") {
            // Convert output base64 to data URL and store in correct port
            const outUrl = toDataUrl(st.output_png_b64);

            setOutputs((prev) => {
              const next = [...prev];
              next[targetPort] = outUrl;
              return next;
            });

            // Stop polling and reset mix state
            stopPolling();
            jobRef.current = null;
            setMixJobId(null);
            setMixBusy(false);
            setMixProgress(1);
          } else if (st.state === "cancelled" || st.state === "error") {
            // Job ended but not with output
            stopPolling();
            jobRef.current = null;
            setMixJobId(null);
            setMixBusy(false);
            setMixProgress(0);
          }
        } catch (e) {
          // Network error or server error during polling
          console.error(e);
          stopPolling();
          jobRef.current = null;
          setMixJobId(null);
          setMixBusy(false);
          setMixProgress(0);
        }
      }, 140);
    } catch (e) {
      // Error starting job
      console.error(e);
      stopPolling();
      jobRef.current = null;
      setMixJobId(null);
      setMixBusy(false);
      setMixProgress(0);
    }
  };

  /* -------------------- Cleanup on unmount -------------------- */
  // If the component unmounts (page refresh / navigation):
  // - stop polling
  // - try to cancel the last job (best-effort)
  useEffect(() => {
    return () => {
      stopPolling();
      const jid = jobRef.current;
      jobRef.current = null;
      if (jid) api.mixCancel(jid).catch(() => {});
    };
  }, [api]);

  // Progress bar in percent
  const pct = Math.round((mixProgress || 0) * 100);

  // Checkbox logic (ROI mode):
  const isInnerOnly = roi.type === "inner";
  const isOuterOnly = roi.type === "outer";
  const isFull = !isInnerOnly && !isOuterOnly;

  // Disable mix if sync is busy or no images
  const mixDisabled = syncBusy || !hasAnySlots;

  return (
    <div className="h-screen flex p-4 bg-purple-50 gap-4 overflow-hidden">
      {/* -------------------- Left panel: 4 Inputs -------------------- */}
      <div className="flex-1 flex flex-col gap-3 bg-white p-3 rounded border-4 border-purple-500 overflow-hidden">
        <div className="flex items-center justify-between">
          <div className="text-purple-700 font-semibold">Fourier Mixer</div>
          {busy && <div className="text-xs text-purple-500">Processing...</div>}
        </div>

        {/* 2x2 grid of input viewports */}
        <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">
          {[0, 1, 2, 3].map((i) => (
            <ImageViewport
              key={i}
              outerRef={i === 0 ? inputTileRef : null} // reference tile 0 for height matching
              index={i}
              slot={slots[i]}
              onPickFile={pickFile}
              weightsAll={weights}
              onWeightChange={setWeight}
              roi={roi}
              setROI={setROI}
              wlState={wl[i]}
              onWLChange={onWLChange}
            />
          ))}
        </div>
      </div>

      {/* -------------------- Right panel: Controls + Outputs -------------------- */}
      <div className="w-96 flex flex-col gap-2 bg-white p-2 rounded border-4 border-purple-500 overflow-hidden">
        {/* Mixing mode selector */}
        <div className="flex items-center gap-2">
          <label className="text-purple-700 font-medium whitespace-nowrap">Mode</label>
          <select
            value={mixingMode}
            onChange={(e) => setMixingMode(e.target.value)}
            className="bg-purple-700 text-white px-2 py-1 rounded flex-1"
          >
            <option value="real_imag">Real/Imaginary</option>
            <option value="mag_phase">Magnitude/Phase</option>
          </select>
        </div>

        {/* ROI slider (controls ROI size w/h) */}
        <div className="flex items-center gap-2">
          <label className="text-purple-700 font-medium whitespace-nowrap">ROI</label>
          <input
            type="range"
            min={10}
            max={90}
            value={roi.w}
            disabled={isFull}
            onChange={(e) =>
              setROI((r) => ({
                ...r,
                w: Number(e.target.value),
                h: Number(e.target.value), // keep ROI square for simplicity
              }))
            }
            className={`flex-1 ${isFull ? "opacity-40 cursor-not-allowed" : ""}`}
          />
          <div className="text-[11px] text-purple-700 w-14 text-right tabular-nums">
            {isFull ? "FULL" : `${Math.round(roi.w)}%`}
          </div>
        </div>

        {/* Region mode checkboxes + Output port selector */}
        <div className="flex items-center justify-between gap-2">
          {/* ROI region type:
              - Only one checkbox can be active at a time (inner or outer).
              - If none checked -> full.
          */}
          <div className="flex items-center gap-3">
            {/* Show inner checkbox only if outer is NOT active */}
            {!isOuterOnly && (
              <label className="flex items-center gap-2 text-[11px] text-purple-700 select-none">
                <input
                  type="checkbox"
                  checked={isInnerOnly}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setROI((r) => ({ ...r, type: checked ? "inner" : "full" }));
                  }}
                />
                Inner only
              </label>
            )}

            {/* Show outer checkbox only if inner is NOT active */}
            {!isInnerOnly && (
              <label className="flex items-center gap-2 text-[11px] text-purple-700 select-none">
                <input
                  type="checkbox"
                  checked={isOuterOnly}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setROI((r) => ({ ...r, type: checked ? "outer" : "full" }));
                  }}
                />
                Outer only
              </label>
            )}
          </div>

          {/* Output port selector */}
          <div className="flex items-center gap-1">
            <PortDot active={activeOutput === 0} label="Port 1" onClick={() => setActiveOutput(0)} />
            <PortDot active={activeOutput === 1} label="Port 2" onClick={() => setActiveOutput(1)} />
          </div>
        </div>

        {/* MIX BUTTON */}
        <button
          type="button"
          onClick={doMix}
          disabled={mixDisabled}
          className={`w-full py-2 rounded text-sm font-medium ${
            mixDisabled
              ? "bg-purple-200 text-purple-500 cursor-not-allowed"
              : "bg-purple-700 text-white hover:bg-purple-800"
          }`}
          title={mixBusy ? "Click again to cancel current and start a new mix." : "Start mixing"}
        >
          {mixBusy ? `Restart Mix (Port ${activeOutput + 1})` : `Mix (Port ${activeOutput + 1})`}
        </button>

        {/* OUTPUTS (two ports) */}
        <div
          style={{
            height: tileHeight ? Math.round(tileHeight) : undefined, // match input tile height
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            overflow: "hidden",
            flex: "0 0 auto",
          }}
        >
          <ImageViewport variant="output" outputLabel="Port 1" outputSrc={outputs[0]} />
          <ImageViewport variant="output" outputLabel="Port 2" outputSrc={outputs[1]} />
        </div>

        {/* Progress Bar */}
        <div className="w-full">
          <div className="flex items-center justify-between text-[11px] text-purple-700 mb-1">
            <span>{mixBusy ? `Mix Progress (Port ${activeOutput + 1} / IFFT...)` : "Mix Progress"}</span>
            <span className="opacity-80">{mixBusy ? `${pct}%` : outputs[activeOutput] ? `Ready` : "Idle"}</span>
          </div>

          <div className="w-full h-2 bg-purple-100 rounded overflow-hidden">
            <div
              className="h-2 bg-purple-700 rounded"
              style={{
                width: `${mixBusy ? pct : outputs[activeOutput] ? 100 : 0}%`,
                transition: mixBusy ? "width 0.12s linear" : "width 0.25s ease",
              }}
            />
          </div>

          {/* Small hint to user */}
          {mixBusy && (
            <div className="text-[10px] text-purple-600 opacity-80 mt-1">
              If you change any setting, click “Restart Mix” to cancel the old job and start a new one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
